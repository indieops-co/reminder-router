import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../core/config.js";
import { binDir } from "../core/paths.js";

const execFileP = promisify(execFile);
const isMac = process.platform === "darwin";

export type NotificationAction = "open" | "snooze15" | "snooze60" | "tomorrow" | "done" | "dismiss";

export interface NotificationRequest {
  id: number; // handoff id
  title: string;
  subtitle?: string;
  body?: string;
  /** Label for the click / primary action. */
  primary?: string;
  /** Secondary buttons (macOS shows up to four). */
  actions?: Array<{ id: NotificationAction; label: string }>;
  sound?: boolean;
}

export interface Notifier {
  readonly name: string;
  notify(req: NotificationRequest): Promise<void>;
  /** Remove a delivered notification (after done/snooze). */
  remove?(id: number): Promise<void>;
  close?(): Promise<void>;
}

export const DEFAULT_ACTIONS: NotificationRequest["actions"] = [
  { id: "snooze15", label: "Snooze 15m" },
  { id: "snooze60", label: "Snooze 1h" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "done", label: "Done" },
];

// ---------------------------------------------------------------- Swift helper

export function notifierAppPath(cfg: Config): string {
  return cfg.notifierApp || path.join(binDir(), "HandoffNotify.app");
}

export function notifierBinary(cfg: Config): string | null {
  const app = notifierAppPath(cfg);
  const bin = path.join(app, "Contents", "MacOS", "HandoffNotify");
  return fs.existsSync(bin) ? bin : null;
}

/**
 * Talks to the Swift helper (mac/handoff-notify). The helper is a tiny agent
 * app kept alive by the daemon; it receives JSON lines on stdin and reports
 * clicks/buttons by POSTing to the daemon's /actions endpoint.
 */
export class SwiftNotifier implements Notifier {
  readonly name = "swift";
  private child: ChildProcess | null = null;
  private restarts = 0;

  constructor(private binary: string, private port: number, private log: (msg: string) => void) {}

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(this.binary, ["--port", String(this.port)], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (d) => this.log(`[notify] ${String(d).trim()}`));
    child.stderr?.on("data", (d) => this.log(`[notify!] ${String(d).trim()}`));
    child.on("exit", (code) => {
      this.log(`[notify] helper exited (${code})`);
      this.child = null;
      this.restarts += 1;
    });
    this.child = child;
    return child;
  }

  async notify(req: NotificationRequest): Promise<void> {
    const child = this.ensure();
    const line = JSON.stringify({ op: "notify", ...req }) + "\n";
    await new Promise<void>((resolve, reject) => child.stdin!.write(line, (err) => (err ? reject(err) : resolve())));
  }

  async remove(id: number): Promise<void> {
    if (!this.child) return;
    this.child.stdin!.write(JSON.stringify({ op: "remove", id }) + "\n");
  }

  async close(): Promise<void> {
    if (this.child) {
      this.child.stdin?.end(JSON.stringify({ op: "quit" }) + "\n");
      setTimeout(() => this.child?.kill(), 500).unref();
    }
  }
}

// ---------------------------------------------------------------- terminal-notifier

export class TerminalNotifier implements Notifier {
  readonly name = "terminal-notifier";
  constructor(private openCommand: (id: number) => string) {}

  async notify(req: NotificationRequest): Promise<void> {
    const args = ["-title", req.title, "-message", req.body || req.subtitle || req.title, "-group", `handoff-${req.id}`];
    if (req.subtitle && req.body) args.push("-subtitle", req.subtitle);
    if (req.sound !== false) args.push("-sound", "default");
    args.push("-execute", this.openCommand(req.id));
    await execFileP("terminal-notifier", args);
  }

  async remove(id: number): Promise<void> {
    try {
      await execFileP("terminal-notifier", ["-remove", `handoff-${id}`]);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- osascript

export class OsascriptNotifier implements Notifier {
  readonly name = "osascript";
  async notify(req: NotificationRequest): Promise<void> {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    let script = `display notification "${esc(req.body || "")}" with title "${esc(req.title)}"`;
    if (req.subtitle) script += ` subtitle "${esc(req.subtitle)}"`;
    if (req.sound !== false) script += ` sound name "default"`;
    await execFileP("osascript", ["-e", script]);
  }
}

// ---------------------------------------------------------------- linux / log

export class LogNotifier implements Notifier {
  readonly name = "log";
  constructor(private log: (msg: string) => void) {}
  async notify(req: NotificationRequest): Promise<void> {
    this.log(`NOTIFY #${req.id}: ${req.title}${req.subtitle ? " — " + req.subtitle : ""}${req.body ? " · " + req.body : ""}`);
    if (process.platform === "linux") {
      try {
        await execFileP("notify-send", [req.title, [req.subtitle, req.body].filter(Boolean).join("\n")]);
      } catch {
        /* notify-send not available */
      }
    }
  }
}

// ---------------------------------------------------------------- selection

async function has(cmd: string): Promise<boolean> {
  try {
    await execFileP("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

export async function createNotifier(cfg: Config, opts: { port: number; log: (m: string) => void; openCommand: (id: number) => string }): Promise<Notifier> {
  const want = cfg.notifier || "auto";
  if (want === "log" || !isMac) return new LogNotifier(opts.log);
  if (want === "swift" || want === "auto") {
    const bin = notifierBinary(cfg);
    if (bin) return new SwiftNotifier(bin, opts.port, opts.log);
    if (want === "swift") opts.log(`Swift helper not found at ${notifierAppPath(cfg)} — falling back`);
  }
  if ((want === "terminal-notifier" || want === "auto") && (await has("terminal-notifier"))) {
    return new TerminalNotifier(opts.openCommand);
  }
  return new OsascriptNotifier();
}

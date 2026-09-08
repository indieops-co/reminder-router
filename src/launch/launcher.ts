import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../core/config.js";
import { loadConfig } from "../core/config.js";
import type { Destination, Handoff } from "../core/types.js";
import { expandHome } from "../core/paths.js";

// ---------------------------------------------------------------- editor deep links

const EXTENSION_ID = "indieops.reminder-router";
/** URI scheme each editor CLI answers to, and where it keeps installed extensions. */
const EDITOR_URI: Record<string, { scheme: string; extensions: string }> = {
  code: { scheme: "vscode", extensions: ".vscode/extensions" },
  "code-insiders": { scheme: "vscode-insiders", extensions: ".vscode-insiders/extensions" },
  cursor: { scheme: "cursor", extensions: ".cursor/extensions" },
  windsurf: { scheme: "windsurf", extensions: ".windsurf/extensions" },
  codium: { scheme: "vscodium", extensions: ".vscode-oss/extensions" },
};
let extensionCheck: { editor: string; at: number; installed: boolean } | null = null;

/** Is the Reminder Router extension installed for the configured editor? (cached for 30 s) */
export function editorExtensionInstalled(cfg: Config): boolean {
  const editor = cfg.editor || "code";
  if (extensionCheck && extensionCheck.editor === editor && Date.now() - extensionCheck.at < 30_000) return extensionCheck.installed;
  const info = EDITOR_URI[editor];
  let installed = false;
  if (info) {
    try {
      installed = fs.readdirSync(path.join(os.homedir(), info.extensions)).some((n) => n.startsWith(EXTENSION_ID + "-"));
    } catch {
      installed = false;
    }
  }
  extensionCheck = { editor, at: Date.now(), installed };
  return installed;
}

/**
 * `vscode://indieops.reminder-router/handoff/12` — opened after "Open Project" so the editor
 * extension shows the handoff card in the window that just came up. Null when the configured
 * editor isn't a VS Code family member or the extension isn't installed for it.
 */
export function editorDeepLink(h: Pick<Handoff, "id">, cfg: Config): string | null {
  const info = EDITOR_URI[cfg.editor || "code"];
  if (!info || !editorExtensionInstalled(cfg)) return null;
  return `${info.scheme}://${EXTENSION_ID}/handoff/${h.id}`;
}

const execFileP = promisify(execFile);

export interface LaunchResult {
  ok: boolean;
  destination: Destination;
  message: string;
}

const isMac = process.platform === "darwin";

/**
 * The destinations a handoff effectively offers. Explicit destinations come first;
 * then an implied "Open Project" for its repo, and "Resume in Claude" when there is
 * a resume prompt. Order matters: index 0 is the notification's primary action.
 */
export function effectiveDestinations(h: Handoff): Destination[] {
  const out: Destination[] = [...h.destinations];
  const dir = h.repo_path ?? h.workspace_path;
  const hasPath = out.some((d) => d.type === "path" && dir && d.uri === dir);
  const hasClaude = out.some((d) => d.type === "claude");
  if (dir && h.resume_prompt && !hasClaude) out.push({ type: "claude", uri: dir, label: "Resume in Claude" });
  if (dir && !hasPath) out.push({ type: "path", uri: dir, label: "Open Project" });
  if (h.current_file && !out.some((d) => d.type === "file" && d.uri === h.current_file)) {
    out.push({ type: "file", uri: h.current_file, label: path.basename(h.current_file) });
  }
  return out;
}

export function primaryDestination(h: Handoff): Destination | null {
  return effectiveDestinations(h)[0] ?? null;
}

/** Open a destination. Never throws; returns a result with a human message. */
export async function openDestination(h: Handoff, d: Destination, cfg: Config = loadConfig()): Promise<LaunchResult> {
  try {
    switch (d.type) {
      case "url":
      case "uri":
      case "vscode":
        await openUri(d.uri);
        return { ok: true, destination: d, message: `Opened ${d.uri}` };
      case "path": {
        const dir = expandHome(d.uri);
        await openInEditor(dir, cfg);
        // Let the editor extension land on the handoff card (the window needs a moment to exist).
        const link = editorDeepLink(h, cfg);
        if (link) {
          await new Promise((r) => setTimeout(r, 1500));
          await openUri(link).catch(() => undefined);
        }
        return { ok: true, destination: d, message: `Opened ${dir} in ${cfg.editor}${link ? " — the extension shows the handoff" : ""}` };
      }
      case "file": {
        const file = expandHome(d.uri);
        await openInEditor(file, cfg, true);
        return { ok: true, destination: d, message: `Opened ${file}` };
      }
      case "terminal": {
        const dir = expandHome(d.uri || h.repo_path || os.homedir());
        await openTerminal(dir, d.command ?? null, cfg);
        return { ok: true, destination: d, message: `Opened terminal at ${dir}` };
      }
      case "claude": {
        const dir = expandHome(d.uri && !d.uri.startsWith("claude") ? d.uri : h.repo_path ?? h.workspace_path ?? os.homedir());
        if (h.resume_prompt) await copyToClipboard(h.resume_prompt);
        // If the handoff came from a Claude Code session, resume that exact session
        // (full conversation context) instead of starting cold.
        const resumable = cfg.claudeResumeSession && h.source_session_id && /^[0-9a-f-]{8,}$/i.test(h.source_session_id);
        const cmd = resumable ? `${cfg.claudeCommand} --resume ${h.source_session_id}` : cfg.claudeCommand;
        await openTerminal(dir, cmd, cfg);
        return {
          ok: true,
          destination: d,
          message:
            `Launched ${cmd} in ${dir}.` +
            (h.resume_prompt ? " Resume prompt is on your clipboard — paste and press Enter." : ""),
        };
      }
    }
  } catch (err) {
    return { ok: false, destination: d, message: (err as Error).message };
  }
}

export async function openHandoff(h: Handoff, index = 0, cfg: Config = loadConfig()): Promise<LaunchResult | null> {
  const dests = effectiveDestinations(h);
  const d = dests[index];
  if (!d) return null;
  return openDestination(h, d, cfg);
}

// ---------------------------------------------------------------- primitives

export async function openUri(uri: string): Promise<void> {
  if (isMac) await execFileP("open", [uri]);
  else if (process.platform === "linux") await execFileP("xdg-open", [uri]);
  else throw new Error(`Don't know how to open URIs on ${process.platform}`);
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileP(isMac || process.platform === "linux" ? "which" : "where", [cmd]);
    return true;
  } catch {
    return false;
  }
}

const EDITOR_APPS: Record<string, string> = {
  code: "Visual Studio Code",
  "code-insiders": "Visual Studio Code - Insiders",
  cursor: "Cursor",
  windsurf: "Windsurf",
  codium: "VSCodium",
  zed: "Zed",
};

export async function openInEditor(target: string, cfg: Config, goto = false): Promise<void> {
  const editor = cfg.editor || "code";
  if (await commandExists(editor)) {
    const args = goto && /:\d+(?::\d+)?$/.test(target) ? ["--goto", target] : [target];
    await execFileP(editor, args);
    return;
  }
  if (isMac) {
    const app = EDITOR_APPS[editor];
    const plain = target.replace(/:\d+(?::\d+)?$/, "");
    if (app) {
      await execFileP("open", ["-a", app, plain]);
      return;
    }
    await execFileP("open", [plain]);
    return;
  }
  throw new Error(`Editor "${editor}" not found on PATH`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function detectTerminal(cfg: Config): string {
  if (cfg.terminal && cfg.terminal !== "auto") return cfg.terminal;
  if (!isMac) return "xterm";
  for (const app of ["iTerm", "Ghostty", "Warp", "kitty", "Alacritty"]) {
    if (fs.existsSync(`/Applications/${app}.app`)) return app;
  }
  return "Terminal";
}

export async function openTerminal(dir: string, command: string | null, cfg: Config): Promise<void> {
  const term = detectTerminal(cfg);
  const shellLine = `cd ${shellQuote(dir)}${command ? ` && ${command}` : ""}`;
  if (!isMac) {
    // Dev/Linux fallback: best effort.
    spawn("x-terminal-emulator", ["-e", `bash -lc ${shellQuote(shellLine + "; exec bash")}`], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  switch (term) {
    case "iTerm":
    case "iTerm2": {
      const script = [
        `tell application "iTerm"`,
        `  activate`,
        `  set newWindow to (create window with default profile)`,
        `  tell current session of newWindow`,
        `    write text ${appleScriptString(shellLine)}`,
        `  end tell`,
        `end tell`,
      ].join("\n");
      await execFileP("osascript", ["-e", script]);
      return;
    }
    case "Warp": {
      await execFileP("open", [`warp://action/new_tab?path=${encodeURIComponent(dir)}`]);
      if (command) await copyToClipboard(command);
      return;
    }
    case "Ghostty": {
      const args = ["-na", "Ghostty", "--args", `--working-directory=${dir}`];
      if (command) args.push(`--command=${command}`);
      await execFileP("open", args);
      return;
    }
    case "kitty": {
      const args = ["-na", "kitty", "--args", "--directory", dir];
      if (command) args.push("--hold", "sh", "-lc", command);
      await execFileP("open", args);
      return;
    }
    case "Alacritty": {
      const args = ["-na", "Alacritty", "--args", "--working-directory", dir];
      if (command) args.push("-e", "sh", "-lc", command);
      await execFileP("open", args);
      return;
    }
    default: {
      const script = [
        `tell application "Terminal"`,
        `  activate`,
        `  do script ${appleScriptString(shellLine)}`,
        `end tell`,
      ].join("\n");
      await execFileP("osascript", ["-e", script]);
    }
  }
}

export async function copyToClipboard(text: string): Promise<void> {
  if (!isMac) return;
  await new Promise<void>((resolve, reject) => {
    const p = spawn("pbcopy");
    p.on("error", reject);
    p.on("close", () => resolve());
    p.stdin.end(text);
  });
}

/** Bring an app to the front (used by "Open Project" when the window is already open). */
export async function activateApp(app: string): Promise<void> {
  if (!isMac) return;
  await execFileP("osascript", ["-e", `tell application ${appleScriptString(app)} to activate`]);
}

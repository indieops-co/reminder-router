import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { daemonStatePath, logPath } from "../core/paths.js";
import { Store } from "../core/store.js";
import { getDb, closeDb } from "../core/db.js";
import { createNotifier } from "../notify/notifier.js";
import { HandoffService } from "./service.js";
import { createApiServer } from "../api/server.js";

export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  notifier: string;
}

export function readDaemonState(): DaemonState | null {
  try {
    const s = JSON.parse(fs.readFileSync(daemonStatePath(), "utf8")) as DaemonState;
    return s;
  } catch {
    return null;
  }
}

export function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [path.join(here, "..", "..", "package.json"), path.join(here, "..", "package.json")]) {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8")).version ?? "0.0.0";
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

/** Path to the CLI entry, used for notification click commands. */
export function cliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "bin", "handoff.js");
}

export function makeLogger(toFile = true): (msg: string) => void {
  const file = toFile ? logPath() : null;
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    if (file) {
      try {
        fs.appendFileSync(file, line + "\n");
      } catch {
        /* ignore */
      }
    }
  };
}

/** Is a process with this pid alive? */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runDaemon(opts: { foreground?: boolean } = {}): Promise<void> {
  const cfg = loadConfig(true);
  const log = makeLogger(true);
  const version = packageVersion();

  const existing = readDaemonState();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    log(`daemon already running (pid ${existing.pid}, port ${existing.port}) — exiting`);
    return;
  }

  const store = new Store(getDb());
  const notifier = await createNotifier(cfg, {
    port: cfg.port,
    log,
    openCommand: (id) => `${process.execPath} ${cliEntry()} open ${id}`,
  });
  const service = new HandoffService({ store, notifier, config: cfg, log });
  const server = createApiServer(service, { port: cfg.port, version });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => resolve());
  });

  const state: DaemonState = { pid: process.pid, port: cfg.port, startedAt: new Date().toISOString(), version, notifier: notifier.name };
  fs.writeFileSync(daemonStatePath(), JSON.stringify(state, null, 2));
  log(`daemon v${version} listening on http://127.0.0.1:${cfg.port} (notifier: ${notifier.name}, tick ${cfg.tickSeconds}s)`);

  let stopping = false;
  let ticking = false;
  const tick = async () => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      await service.tick();
    } catch (err) {
      log(`tick error: ${(err as Error).stack ?? err}`);
    } finally {
      ticking = false;
    }
  };
  await tick();
  const timer = setInterval(tick, Math.max(5, cfg.tickSeconds) * 1000);

  // Fire promptly after the machine wakes from sleep: setInterval drifts, so also
  // watch for large clock jumps and tick immediately.
  let last = Date.now();
  const wakeWatch = setInterval(() => {
    const nowMs = Date.now();
    if (nowMs - last > 2 * Math.max(5, cfg.tickSeconds) * 1000) {
      log("clock jump detected (sleep/wake) — ticking now");
      void tick();
    }
    last = nowMs;
  }, 5000);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${signal})`);
    clearInterval(timer);
    clearInterval(wakeWatch);
    await notifier.close?.();
    server.close();
    try {
      fs.unlinkSync(daemonStatePath());
    } catch {
      /* ignore */
    }
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`));

  await new Promise(() => {
    /* run forever */
  });
}

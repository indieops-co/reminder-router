import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Everything the app stores lives under one directory (default ~/.handoff).
 * HANDOFF_HOME overrides it — used by tests and by anyone who wants the
 * database somewhere else. Nothing here ever leaves the machine.
 */
export function handoffHome(): string {
  const override = process.env.HANDOFF_HOME;
  const dir = override && override.trim() ? override : path.join(os.homedir(), ".handoff");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return path.join(handoffHome(), "handoff.db");
}

export function configPath(): string {
  return path.join(handoffHome(), "config.json");
}

export function daemonStatePath(): string {
  return path.join(handoffHome(), "daemon.json");
}

export function logPath(): string {
  return path.join(handoffHome(), "daemon.log");
}

export function binDir(): string {
  const dir = path.join(handoffHome(), "bin");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function collapseHome(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

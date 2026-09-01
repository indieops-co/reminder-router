import fs from "node:fs";
import { configPath } from "./paths.js";

export interface Config {
  /** Loopback port for the local API. */
  port: number;
  /** Scheduler tick interval in seconds. */
  tickSeconds: number;
  /** Re-notify an overdue handoff every N minutes (0 disables). */
  renotifyMinutes: number;
  /** Maximum number of re-notifications per due period. */
  renotifyMax: number;
  /** Editor used to open project paths: "code" | "cursor" | "codium" | any CLI on PATH. */
  editor: string;
  /** Terminal app for terminal destinations: "auto" | "Terminal" | "iTerm" | "Ghostty" | "Warp" | "kitty" | "Alacritty". */
  terminal: string;
  /** Command used to launch Claude Code inside a terminal. */
  claudeCommand: string;
  /** Hour used for "morning" / "tomorrow" with no explicit time. */
  morningHour: number;
  afternoonHour: number;
  eveningHour: number;
  /** Quiet hours: notifications are deferred until quietEnd. Empty string disables. e.g. "22:00" / "07:30" */
  quietStart: string;
  quietEnd: string;
  /** IANA timezone; empty = system timezone. */
  timezone: string;
}

export const DEFAULT_CONFIG: Config = {
  port: 7391,
  tickSeconds: 15,
  renotifyMinutes: 30,
  renotifyMax: 2,
  editor: "code",
  terminal: "auto",
  claudeCommand: "claude",
  morningHour: 9,
  afternoonHour: 14,
  eveningHour: 18,
  quietStart: "",
  quietEnd: "",
  timezone: "",
};

let cached: Config | null = null;

export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  const p = configPath();
  let user: Partial<Config> = {};
  if (fs.existsSync(p)) {
    try {
      user = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      throw new Error(`Could not parse ${p}: ${(err as Error).message}`);
    }
  }
  cached = { ...DEFAULT_CONFIG, ...user };
  if (process.env.HANDOFF_PORT) cached.port = Number(process.env.HANDOFF_PORT);
  return cached;
}

export function saveConfig(patch: Partial<Config>): Config {
  const current = loadConfig(true);
  const next = { ...current, ...patch };
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n");
  cached = next;
  return next;
}

export function resetConfigCache(): void {
  cached = null;
}

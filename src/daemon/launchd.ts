import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logPath, handoffHome } from "../core/paths.js";
import { cliEntry } from "./daemon.js";

const execFileP = promisify(execFile);

export const LAUNCHD_LABEL = "com.reminderrouter.handoff";

export function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(): string {
  const node = process.execPath;
  const entry = cliEntry();
  const pathEnv = [
    path.dirname(node),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(entry)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>${xml(handoffHome())}</string>
  <key>StandardOutPath</key><string>${xml(logPath())}</string>
  <key>StandardErrorPath</key><string>${xml(logPath())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
    ${process.env.HANDOFF_HOME ? `<key>HANDOFF_HOME</key><string>${xml(process.env.HANDOFF_HOME)}</string>` : ""}
  </dict>
</dict>
</plist>
`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export async function installLaunchAgent(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("launchd is macOS-only. Run `handoff daemon run` under your own supervisor instead.");
  const p = plistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderPlist());
  // Replace any existing instance.
  try {
    await execFileP("launchctl", ["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  } catch {
    /* not loaded */
  }
  await execFileP("launchctl", ["bootstrap", domain(), p]);
  await execFileP("launchctl", ["enable", `${domain()}/${LAUNCHD_LABEL}`]).catch(() => undefined);
  return p;
}

export async function uninstallLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileP("launchctl", ["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  } catch {
    /* not loaded */
  }
  try {
    fs.unlinkSync(plistPath());
  } catch {
    /* absent */
  }
}

export async function restartLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin") return;
  await execFileP("launchctl", ["kickstart", "-k", `${domain()}/${LAUNCHD_LABEL}`]);
}

export async function launchAgentInstalled(): Promise<boolean> {
  return fs.existsSync(plistPath());
}

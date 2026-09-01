import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { binDir } from "../core/paths.js";

const execFileP = promisify(execFile);

/** Runs mac/handoff-notify/build.sh and returns the .app path. */
export async function buildNotifier(log: (m: string) => void): Promise<string> {
  if (process.platform !== "darwin") throw new Error("The notification helper is macOS-only.");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(here, "..", "..", "mac", "handoff-notify", "build.sh");
  const dest = binDir();
  const { stdout, stderr } = await execFileP("bash", [script, dest], { maxBuffer: 1 << 20 });
  if (stdout.trim()) log(stdout.trim());
  if (stderr.trim()) log(stderr.trim());
  return path.join(dest, "HandoffNotify.app");
}

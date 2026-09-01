import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface CapturedContext {
  cwd: string;
  repoRoot: string | null;
  branch: string | null;
  remote: string | null; // github.com/user/repo
  projectName: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Normalize a git remote URL to host/owner/repo. */
export function normalizeRemote(url: string | null): string | null {
  if (!url) return null;
  let s = url.trim();
  s = s.replace(/^git@([^:]+):/, "$1/");
  s = s.replace(/^(ssh|https?|git):\/\//, "");
  s = s.replace(/^[^@]+@/, "");
  s = s.replace(/\.git$/, "").replace(/\/$/, "");
  return s || null;
}

/**
 * Capture project context from a directory: git root, branch, remote and a
 * sensible project name. Works without git (falls back to the directory name).
 */
export function captureContext(cwd: string = process.cwd()): CapturedContext {
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const branch = repoRoot ? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) : null;
  const remote = repoRoot ? normalizeRemote(git(["remote", "get-url", "origin"], cwd)) : null;
  const base = repoRoot ?? cwd;
  const projectName = detectProjectName(base, remote);
  return { cwd, repoRoot, branch: branch === "HEAD" ? null : branch, remote, projectName };
}

export function detectProjectName(dir: string, remote: string | null): string {
  // package.json name wins if present and not a placeholder
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name && !pkg.name.startsWith("@")) return pkg.name;
    if (typeof pkg.name === "string" && pkg.name.startsWith("@")) return pkg.name.split("/")[1] ?? pkg.name;
  } catch {
    /* no package.json */
  }
  if (remote) {
    const parts = remote.split("/");
    if (parts.length >= 2) return parts[parts.length - 1];
  }
  return path.basename(dir);
}

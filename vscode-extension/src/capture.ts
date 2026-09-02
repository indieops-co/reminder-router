import * as vscode from "vscode";
import * as path from "node:path";

export interface Captured {
  /** Workspace folder (or the active file's folder) — the project directory. */
  dir: string | null;
  projectName: string | null;
  branch: string | null;
  file: string | null; // absolute path[:line]
  fileLabel: string | null;
  terminalCwd: string | null;
  terminalName: string | null;
}

/** Folder for the active editor, else the first workspace folder. */
export function projectDir(): string | null {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder) return folder.uri.fsPath;
  }
  const first = vscode.workspace.workspaceFolders?.[0];
  return first ? first.uri.fsPath : active?.scheme === "file" ? path.dirname(active.fsPath) : null;
}

/** Current branch via the built-in Git extension API, if available. */
export function gitBranch(dir: string | null): string | null {
  try {
    const ext = vscode.extensions.getExtension<any>("vscode.git");
    const api = ext?.exports?.getAPI?.(1);
    if (!api || !dir) return null;
    const repo = api.repositories.find((r: any) => dir.startsWith(r.rootUri.fsPath)) ?? api.repositories[0];
    return repo?.state?.HEAD?.name ?? null;
  } catch {
    return null;
  }
}

export function activeFile(): { file: string; label: string } | null {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") return null;
  const line = ed.selection.active.line + 1;
  return { file: `${ed.document.uri.fsPath}:${line}`, label: `${path.basename(ed.document.uri.fsPath)}:${line}` };
}

export function activeTerminal(): { cwd: string | null; name: string } | null {
  const t = vscode.window.activeTerminal;
  if (!t) return null;
  let cwd: string | null = null;
  const si = (t as any).shellIntegration;
  if (si?.cwd?.fsPath) cwd = si.cwd.fsPath;
  else {
    const opts = t.creationOptions as vscode.TerminalOptions;
    if (typeof opts.cwd === "string") cwd = opts.cwd;
    else if (opts.cwd && typeof (opts.cwd as vscode.Uri).fsPath === "string") cwd = (opts.cwd as vscode.Uri).fsPath;
  }
  return { cwd, name: t.name };
}

export function capture(): Captured {
  const dir = projectDir();
  const f = activeFile();
  const t = activeTerminal();
  return {
    dir,
    projectName: dir ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir))?.name ?? path.basename(dir) : null,
    branch: gitBranch(dir),
    file: f?.file ?? null,
    fileLabel: f?.label ?? null,
    terminalCwd: t?.cwd ?? null,
    terminalName: t?.name ?? null,
  };
}

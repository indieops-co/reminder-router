import * as vscode from "vscode";
import { HandoffApi, DaemonDown, type Handoff } from "./api";
import { compose, type ComposerMode } from "./composer";
import { HandoffTree, HandoffNode } from "./tree";
import { projectDir } from "./capture";

let api: HandoffApi;
let tree: HandoffTree;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
const alerted = new Set<number>();

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("handoff").get<T>(key, fallback);
}

export function activate(ctx: vscode.ExtensionContext): void {
  api = new HandoffApi();
  output = vscode.window.createOutputChannel("Handoffs");
  tree = new HandoffTree(api);
  const view = vscode.window.createTreeView("handoff.tree", { treeDataProvider: tree, showCollapseAll: false });

  status = vscode.window.createStatusBarItem("handoff.status", vscode.StatusBarAlignment.Left, -10);
  status.name = "Handoffs";
  status.command = "handoff.showDue";
  status.show();

  const idOf = (arg: unknown): number | null => {
    if (arg instanceof HandoffNode) return arg.handoff.id;
    if (typeof arg === "number") return arg;
    if (arg && typeof arg === "object" && "id" in arg) return Number((arg as any).id);
    return null;
  };
  const handoffOf = (arg: unknown): Handoff | null => (arg instanceof HandoffNode ? arg.handoff : arg && typeof arg === "object" && "title" in (arg as any) ? (arg as Handoff) : null);

  const remind = (mode: ComposerMode) => async () => {
    const h = await compose(api, mode);
    if (!h) return;
    alerted.add(h.id);
    void refresh();
    const when = h.recurrence_label ? `↻ ${h.recurrence_label}` : new Date(h.trigger_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
    const pick = await vscode.window.showInformationMessage(`✓ #${h.id} ${h.title} — ${when}`, "Add next action", "Undo");
    if (pick === "Undo") {
      await api.delete(h.id).catch(() => api.cli(["rm", String(h.id)]));
      void refresh();
    } else if (pick === "Add next action") {
      const next = await vscode.window.showInputBox({ title: `#${h.id} · next action`, prompt: "What's the first thing to do when you come back?" });
      if (next) await guard(() => api.patch(h.id, { nextAction: next }));
      void refresh();
    }
  };

  ctx.subscriptions.push(
    view, status, output,
    vscode.commands.registerCommand("handoff.remindProject", remind("project")),
    vscode.commands.registerCommand("handoff.remindFile", remind("file")),
    vscode.commands.registerCommand("handoff.remindTerminal", remind("terminal")),
    vscode.commands.registerCommand("handoff.remindUrl", remind("url")),
    vscode.commands.registerCommand("handoff.refresh", () => refresh()),
    vscode.commands.registerCommand("handoff.openInbox", () => vscode.env.openExternal(vscode.Uri.parse(`${api.base}/`))),
    vscode.commands.registerCommand("handoff.showDue", showDue),
    vscode.commands.registerCommand("handoff.startDaemon", startDaemon),

    vscode.commands.registerCommand("handoff.open", async (arg) => {
      const h = handoffOf(arg) ?? (idOf(arg) ? await api.get(idOf(arg)!) : null);
      if (!h) return;
      await openDestination(h);
    }),
    vscode.commands.registerCommand("handoff.done", async (arg) => {
      const id = idOf(arg);
      if (!id) return;
      await guard(async () => {
        const r = await api.complete(id);
        vscode.window.setStatusBarMessage(`$(check) ${r.message}`, 3000);
      });
      void refresh();
    }),
    vscode.commands.registerCommand("handoff.snooze", async (arg) => {
      const id = idOf(arg);
      if (!id) return;
      const until = await pickSnooze();
      if (!until) return;
      await guard(async () => {
        const r = await api.snooze(id, until);
        vscode.window.setStatusBarMessage(`$(clock) ${r.message}`, 3000);
      });
      void refresh();
    }),
    vscode.commands.registerCommand("handoff.delete", async (arg) => {
      const id = idOf(arg);
      if (!id) return;
      const ok = await vscode.window.showWarningMessage(`Delete handoff #${id}?`, { modal: true }, "Delete");
      if (ok !== "Delete") return;
      await guard(() => api.delete(id));
      void refresh();
    }),
    vscode.commands.registerCommand("handoff.details", async (arg) => {
      const h = handoffOf(arg) ?? (idOf(arg) ? await api.get(idOf(arg)!) : null);
      if (h) await showDetails(h);
    }),
    vscode.commands.registerCommand("handoff.resumeInClaude", async (arg) => {
      const h = handoffOf(arg) ?? (idOf(arg) ? await api.get(idOf(arg)!) : null);
      if (h) await resumeInClaude(h);
    }),
    vscode.commands.registerCommand("handoff.copyResumePrompt", async (arg) => {
      const h = handoffOf(arg) ?? (idOf(arg) ? await api.get(idOf(arg)!) : null);
      if (!h?.resume_prompt) return vscode.window.showInformationMessage("This handoff has no resume prompt.");
      await vscode.env.clipboard.writeText(h.resume_prompt);
      vscode.window.setStatusBarMessage("$(clippy) Resume prompt copied", 2500);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("handoff")) void refresh(); }),
    vscode.window.onDidChangeActiveTextEditor(() => void refresh()),
  );

  const poll = setInterval(() => void refresh(), Math.max(10, cfg("pollSeconds", 30)) * 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(poll) });
  void refresh(true);
}

export function deactivate(): void {
  /* nothing to clean up */
}

// ---------------------------------------------------------------- refresh / status / alerts

async function refresh(_first = false): Promise<void> {
  const inbox = await tree.refresh();
  if (!inbox) {
    status.text = "$(bell-slash) handoffs";
    status.tooltip = "Reminder daemon isn't running — click for options";
    status.backgroundColor = undefined;
    status.color = undefined;
    return;
  }
  const due = inbox.due.length;
  const soon = inbox.today.filter((h) => new Date(h.trigger_at).getTime() - Date.now() < 60 * 60_000).length;
  if (due) {
    status.text = `$(bell-dot) ${due} due`;
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    status.tooltip = inbox.due.map((h) => `● ${h.project ? h.project.name + ": " : ""}${h.title}`).join("\n");
  } else if (soon) {
    status.text = `$(bell) ${soon} soon`;
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    status.tooltip = `${soon} handoff${soon === 1 ? "" : "s"} due within the hour`;
  } else {
    const next = inbox.today[0] ?? inbox.tomorrow[0] ?? inbox.later[0];
    status.text = "$(bell) handoffs";
    status.backgroundColor = undefined;
    status.tooltip = next ? `Next: ${next.title} ${next.when_label}` : "Nothing scheduled — ⌥⌘R to add a handoff";
  }

  // In-editor alert for this workspace's due handoffs (the native notification covers the rest).
  if (!cfg("notifyInEditor", true)) return;
  const dir = projectDir();
  for (const h of inbox.due) {
    if (alerted.has(h.id)) continue;
    // Only this workspace's project (the native notification covers other projects). On first
    // activation this is the "Open Project" landing moment, so it fires right away.
    const mine = !dir || !h.project?.path || dir.startsWith(h.project.path) || h.project.path.startsWith(dir);
    if (!mine) continue;
    alerted.add(h.id);
    void alertDue(h);
  }
}

async function alertDue(h: Handoff): Promise<void> {
  const primary = h.actions[0];
  const buttons = [primary ? `Open ${primary.label}` : null, h.resume_prompt || h.source_session_id ? "Resume in Claude" : null, "Snooze…", "Done"].filter(Boolean) as string[];
  const body = [h.project ? h.project.name : null, h.title, h.next_action ? `Next: ${h.next_action}` : h.reason_paused].filter(Boolean).join(" — ");
  const pick = await vscode.window.showInformationMessage(`$(bell-dot) ${body}`, ...buttons);
  if (!pick) return;
  if (pick.startsWith("Open ")) await openDestination(h);
  else if (pick === "Resume in Claude") await resumeInClaude(h);
  else if (pick === "Snooze…") await vscode.commands.executeCommand("handoff.snooze", h.id);
  else if (pick === "Done") await vscode.commands.executeCommand("handoff.done", h.id);
}

async function showDue(): Promise<void> {
  const up = await api.up();
  if (!up) {
    const pick = await vscode.window.showWarningMessage("The reminder daemon isn't running.", "Start daemon", "Install instructions");
    if (pick === "Start daemon") await startDaemon();
    else if (pick) vscode.env.openExternal(vscode.Uri.parse("https://github.com/davidsparrow/reminder-router#install"));
    return;
  }
  const due = await api.due();
  if (due.length === 0) {
    vscode.window.setStatusBarMessage("$(check) Nothing is waiting on you.", 3000);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    due.map((h) => ({ label: `$(circle-filled) ${h.title}`, description: `${h.project ? h.project.name + " · " : ""}${h.when_label}`, detail: h.next_action ?? h.reason_paused ?? undefined, h })),
    { title: "What needs me now", placeHolder: "Pick a handoff" },
  );
  if (pick) await showDetails(pick.h);
}

// ---------------------------------------------------------------- details card

async function showDetails(h: Handoff): Promise<void> {
  type Item = vscode.QuickPickItem & { run?: () => Thenable<unknown> };
  const items: Item[] = [];
  const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const info = (label: string, description?: string, detail?: string): Item => ({ label, description, detail });

  items.push(info(`$(clock) ${new Date(h.trigger_at).toLocaleString()}`, `${h.when_label}${h.recurrence_label ? ` · ↻ ${h.recurrence_label}` : ""}`));
  if (h.project) items.push(info(`$(folder) ${h.project.code} ${h.project.name}`, h.git_branch ? `$(git-branch) ${h.git_branch}` : h.project.path ?? ""));
  if (h.reason_paused) items.push(info("$(debug-pause) Paused", undefined, h.reason_paused));
  if (h.next_action) items.push(info("$(arrow-right) Next", undefined, h.next_action));
  if (h.context_summary) items.push(info("$(note) Context", undefined, h.context_summary.slice(0, 300)));

  items.push(sep("Open"));
  for (const a of h.actions) items.push({ label: `$(link-external) ${a.label}`, description: a.type === "url" ? a.uri : a.type, run: () => openDestination(h, a.index) });
  if (h.resume_prompt || h.source_session_id) {
    items.push({ label: "$(play) Resume in Claude (here)", description: h.source_session_id ? "claude --resume in a VS Code terminal" : "claude in a VS Code terminal", run: () => resumeInClaude(h) });
  }
  if (h.resume_prompt) items.push({ label: "$(clippy) Copy resume prompt", run: async () => { await vscode.env.clipboard.writeText(h.resume_prompt!); vscode.window.setStatusBarMessage("$(clippy) Resume prompt copied", 2500); } });
  items.push(sep("Actions"));
  items.push({ label: "$(check) Done", run: () => vscode.commands.executeCommand("handoff.done", h.id) });
  items.push({ label: "$(clock) Snooze…", run: () => vscode.commands.executeCommand("handoff.snooze", h.id) });
  items.push({ label: "$(eye-closed) Dismiss", run: async () => { await guard(() => api.dismiss(h.id)); void refresh(); } });
  items.push({ label: "$(trash) Delete", run: () => vscode.commands.executeCommand("handoff.delete", h.id) });

  const pick = await vscode.window.showQuickPick(items, { title: `#${h.id} ${h.title}`, placeHolder: "Choose an action", matchOnDescription: true, matchOnDetail: true });
  if (pick?.run) await pick.run();
}

async function pickSnooze(): Promise<string | undefined> {
  const presets = ["15m", "1h", "3h", "tomorrow morning", "next monday 9am"];
  const pick = await vscode.window.showQuickPick(
    [...presets.map((p) => ({ label: p })), { label: "Custom…", description: 'e.g. "friday at 3"' }],
    { title: "Snooze until", placeHolder: "Pick or type" },
  );
  if (!pick) return undefined;
  if (pick.label !== "Custom…") return /^\d/.test(pick.label) ? `in ${pick.label}` : pick.label;
  return vscode.window.showInputBox({ title: "Snooze until", placeHolder: "tomorrow 10am · in 2h · friday at 3" });
}

// ---------------------------------------------------------------- launching

async function openDestination(h: Handoff, index = 0): Promise<void> {
  const a = h.actions[index];
  if (!a) return void vscode.window.showInformationMessage("This handoff has no destination.");
  // Things VS Code can do itself, without the daemon:
  if (a.type === "url" || a.type === "uri" || a.type === "vscode") return void vscode.env.openExternal(vscode.Uri.parse(a.uri));
  if (a.type === "file") {
    const m = a.uri.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
    const doc = await vscode.workspace.openTextDocument(m ? m[1] : a.uri);
    const line = m && m[2] ? Number(m[2]) - 1 : 0;
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
    return;
  }
  if (a.type === "path") {
    const here = vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === a.uri);
    if (here) return void vscode.window.setStatusBarMessage("$(check) You're already in this project.", 2500);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(a.uri), { forceNewWindow: true });
    return;
  }
  if (a.type === "claude") return resumeInClaude(h);
  if (a.type === "terminal") {
    const t = vscode.window.createTerminal({ name: a.label ?? "Handoff", cwd: a.uri });
    t.show();
    if (a.command) t.sendText(a.command);
    return;
  }
  await guard(async () => {
    const r = await api.open(h.id, index);
    vscode.window.setStatusBarMessage(`$(arrow-right) ${r.message}`, 3000);
  });
}

/** Resume in a VS Code terminal: cd repo, run claude (--resume <session> when we have one), prompt on the clipboard. */
async function resumeInClaude(h: Handoff): Promise<void> {
  const dir = h.repo_path ?? h.project?.path ?? projectDir() ?? undefined;
  const claude = cfg("claudeCommand", "claude");
  const cmd = h.source_session_id && /^[0-9a-f-]{8,}$/i.test(h.source_session_id) ? `${claude} --resume ${h.source_session_id}` : claude;
  if (h.resume_prompt) await vscode.env.clipboard.writeText(h.resume_prompt);
  const t = vscode.window.createTerminal({ name: `Claude · #${h.id}`, cwd: dir });
  t.show();
  t.sendText(cmd);
  if (h.resume_prompt) vscode.window.setStatusBarMessage("$(clippy) Resume prompt copied — paste into Claude and press Enter", 6000);
}

async function startDaemon(): Promise<void> {
  const t = vscode.window.createTerminal({ name: "handoff daemon" });
  t.show();
  t.sendText(`${cfg("cliPath", "handoff")} daemon install && ${cfg("cliPath", "handoff")} daemon status`);
  setTimeout(() => void refresh(), 4000);
}

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DaemonDown) {
      const pick = await vscode.window.showWarningMessage("The reminder daemon isn't running.", "Start daemon");
      if (pick) await startDaemon();
    } else vscode.window.showErrorMessage(`Handoff: ${(err as Error).message}`);
    output.appendLine(String((err as Error).stack ?? err));
    return undefined;
  }
}

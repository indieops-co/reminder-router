import * as vscode from "vscode";
import { HandoffApi, DaemonDown, type CreateInput, type Handoff } from "./api";
import { capture, activeFile, activeTerminal, selectedText } from "./capture";

export type ComposerMode = "project" | "file" | "terminal" | "url";

/** Values a deep link (or another command) hands the composer. The human still confirms. */
export interface Prefill {
  title?: string;
  when?: string;
  url?: string;
}

const PRESETS: Array<{ label: string; when: string; detail?: string }> = [
  { label: "$(watch) In 30 minutes", when: "in 30m" },
  { label: "$(watch) In 1 hour", when: "in 1h" },
  { label: "$(watch) In 3 hours", when: "in 3h" },
  { label: "$(calendar) Tomorrow morning", when: "tomorrow morning" },
  { label: "$(calendar) Tomorrow 2 PM", when: "tomorrow 2pm" },
  { label: "$(calendar) Next Monday 9 AM", when: "next monday 9am" },
  { label: "$(calendar) Friday 3 PM", when: "friday 3pm" },
  { label: "$(sync) Every weekday 9 AM", when: "every weekday 9am" },
  { label: "$(sync) Every Monday 9 AM", when: "every monday 9am" },
];

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | undefined;
  return ((...a: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}

/**
 * Two-step composer: title (a trailing time phrase is understood and previewed live),
 * then — only if no time was typed — a quick pick of presets that also accepts free text.
 */
export async function compose(api: HandoffApi, mode: ComposerMode = "project", prefill: Prefill = {}): Promise<Handoff | null> {
  const cap = capture();
  let url: string | undefined;
  if (mode === "url") {
    url = await vscode.window.showInputBox({
      title: "Handoff · destination URL",
      prompt: "Where should the reminder take you? (GitHub PR, Vercel, Stripe, docs…)",
      placeHolder: "https://",
      value: prefill.url,
      validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? null : "Enter a full http(s) URL"),
    });
    if (!url) return null;
    url = url.trim();
  }

  const subject =
    mode === "file" && cap.fileLabel ? `${cap.fileLabel}` :
    mode === "terminal" && cap.terminalName ? `terminal "${cap.terminalName}"` :
    mode === "url" ? new URL(url!).hostname :
    cap.projectName ?? "this project";

  // ---- step 1: title with live time preview
  const step1 = await new Promise<{ title: string; when?: string } | null>((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = `Handoff · ${subject}`;
    box.placeholder = "Remind me to…   (a trailing time works: \"check the deploy in 30m\")";
    box.prompt = "Type what to come back to. Add a time at the end, or pick one next.";
    let parsed: { title: string; when?: string } | null = null;
    const preview = debounce(async (value: string) => {
      const v = value.trim();
      if (!v) { box.validationMessage = undefined; box.prompt = "Type what to come back to. Add a time at the end, or pick one next."; parsed = null; return; }
      try {
        const r = await api.parse(v);
        if (r.title && r.when) {
          parsed = { title: r.title, when: r.when };
          box.prompt = `$(check) "${r.title}" — ${r.kind === "recurring" ? "↻ " : ""}${r.label}`;
        } else {
          // whole thing is a time; no title
          parsed = null;
          box.prompt = "That's a time — add what to come back to before it.";
        }
      } catch {
        parsed = null;
        box.prompt = "No time yet — you'll pick one next.";
      }
      box.validationMessage = undefined;
    }, 220);
    box.onDidChangeValue(preview);
    let accepted = false;
    box.onDidAccept(() => {
      const v = box.value.trim();
      if (!v) { box.validationMessage = "Say what to come back to."; return; }
      accepted = true;
      resolve(parsed && parsed.title ? parsed : { title: v });
      box.hide();
    });
    box.onDidHide(() => { box.dispose(); if (!accepted) resolve(null); });
    const initial = [prefill.title, prefill.when].filter(Boolean).join(" ").trim();
    if (initial) {
      box.value = initial;
      preview(initial); // setting .value doesn't fire onDidChangeValue
    }
    box.show();
  });
  if (!step1) return null;

  // ---- step 2: when (only if not typed)
  let when = step1.when;
  if (!when) {
    when = await pickWhen(api);
    if (!when) return null;
  }

  // ---- build the input
  const input: CreateInput = { title: step1.title, capture: true, destinations: [], source: "extension" };
  const isRecurring = /^(every|daily|weekly|monthly|weekdays|yearly)/i.test(when);
  if (isRecurring) input.every = when; else input.when = when;
  if (cap.dir) input.repoPath = cap.dir;
  if (mode === "file") {
    const f = activeFile();
    if (f) input.currentFile = f.file;
    const sel = vscode.workspace.getConfiguration("handoff").get<boolean>("captureSelection", true) ? selectedText() : null;
    if (sel) input.context = `Selected ${sel.where}:\n${sel.text}`;
  }
  if (mode === "terminal") {
    const t = activeTerminal();
    const dir = t?.cwd ?? cap.dir;
    if (dir) input.destinations!.unshift({ type: "terminal", uri: dir, label: t?.name ? `Terminal · ${t.name}` : "Terminal" });
  }
  if (mode === "url" && url) input.destinations!.unshift({ type: "url", uri: url });

  try {
    return await api.create(input);
  } catch (err) {
    if (err instanceof DaemonDown) return createViaCli(api, input);
    vscode.window.showErrorMessage(`Handoff: ${(err as Error).message}`);
    return null;
  }
}

/** Preset quick pick that also accepts free text, with a live parse of what you type. */
export async function pickWhen(api: HandoffApi, title = "When?"): Promise<string | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { when?: string }>();
    qp.title = title;
    qp.placeholder = "Pick one, or type: \"tomorrow 10am\", \"friday at 3\", \"in 45m\", \"first business day of every month\"";
    qp.matchOnDescription = true;
    const base = PRESETS.map((p) => ({ label: p.label, when: p.when, description: p.when }));
    qp.items = base;
    const update = debounce(async (value: string) => {
      const v = value.trim();
      if (!v) { qp.items = base; return; }
      try {
        const r = await api.parse(v);
        if (r.title) throw new Error("that's a title");
        qp.items = [{ label: `$(check) ${r.kind === "recurring" ? "↻ " : ""}${r.label}`, description: v, when: v, alwaysShow: true }, ...base];
      } catch {
        qp.items = [{ label: `$(question) Couldn't read "${v}"`, description: "try: tomorrow 10am · in 2h · every monday 9am", alwaysShow: true }, ...base];
      }
    }, 200);
    qp.onDidChangeValue(update);
    let accepted = false;
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      const when = sel?.when ?? (qp.value.trim() || undefined);
      accepted = true;
      resolve(when);
      qp.hide();
    });
    qp.onDidHide(() => { qp.dispose(); if (!accepted) resolve(undefined); });
    qp.show();
  });
}

/** Daemon down: create through the CLI so nothing is lost; nudge to start the daemon. */
async function createViaCli(api: HandoffApi, input: CreateInput): Promise<Handoff | null> {
  const args = ["--json", "add", input.title];
  if (input.every) args.push("--every", input.every); else if (input.when) args.push("--at", input.when);
  if (input.repoPath) args.push("--path", input.repoPath); else args.push("--no-capture");
  if (input.currentFile) args.push("--file", input.currentFile.replace(/:\d+(?::\d+)?$/, ""));
  if (input.context) args.push("--context", input.context);
  for (const d of input.destinations ?? []) {
    if (d.type === "url") args.push("--url", d.uri);
    else if (d.type === "terminal") args.push("--terminal");
    else args.push("--dest", d.uri);
  }
  args.push("--source", "extension");
  try {
    const { stdout } = await api.cli(args, input.repoPath ?? undefined);
    const h = JSON.parse(stdout) as Handoff;
    vscode.window.showWarningMessage("Handoff saved, but the reminder daemon isn't running — it won't fire until it is.", "Start daemon").then((c) => {
      if (c) vscode.commands.executeCommand("handoff.startDaemon");
    });
    return h;
  } catch (err) {
    vscode.window.showErrorMessage(`Handoff: couldn't reach the daemon or the \`handoff\` CLI (${(err as Error).message}).`, "Install instructions").then((c) => {
      if (c) vscode.env.openExternal(vscode.Uri.parse("https://github.com/davidsparrow/reminder-router#install"));
    });
    return null;
  }
}

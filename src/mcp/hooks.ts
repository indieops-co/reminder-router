/**
 * Claude Code hook handlers. `handoff hook session-start` reads the hook JSON on
 * stdin and prints context Claude should know: handoffs that are due or open
 * for the project the session just opened in.
 */
import fs from "node:fs";
import { Store } from "../core/store.js";
import { getDb } from "../core/db.js";
import { captureContext } from "../core/git.js";
import { projectCode } from "../core/ids.js";
import { formatRelative, formatWhen } from "../parse/when.js";
import type { Handoff } from "../core/types.js";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  hook_event_name?: string;
}

export function readHookInput(): HookInput {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    return {};
  }
}

export function sessionStartContext(store: Store, input: HookInput, now = new Date()): string | null {
  const cwd = input.cwd ?? process.cwd();
  const ctx = captureContext(cwd);
  const project = store.findProject(ctx.repoRoot ?? cwd) ?? store.findProject(ctx.projectName);
  const dueEverywhere = store.due();
  const open = project ? store.list({ projectId: project.id }) : [];
  if (open.length === 0 && dueEverywhere.length === 0) return null;

  const fmt = (h: Handoff) => {
    const when = h.status === "due" ? `DUE ${formatRelative(new Date(h.trigger_at), now)}` : formatWhen(new Date(h.trigger_at), now);
    const parts = [`- #${h.id} ${h.title} (${when}${h.recurrence_label ? `, ${h.recurrence_label}` : ""})`];
    if (h.reason_paused) parts.push(`  paused: ${h.reason_paused}`);
    if (h.next_action) parts.push(`  next: ${h.next_action}`);
    return parts.join("\n");
  };

  const lines: string[] = [];
  if (project && open.length) {
    lines.push(`Reminder Router: ${open.length} open handoff${open.length === 1 ? "" : "s"} for ${project.name} (${projectCode(project.id)}):`);
    lines.push(...open.slice(0, 8).map(fmt));
    lines.push(`Use the handoff MCP tools (resume_handoff <id>, complete_handoff, create_handoff) or the \`handoff\` CLI. Mention due ones to the developer if relevant; don't act on them unasked.`);
  }
  const otherDue = dueEverywhere.filter((h) => !project || h.project_id !== project.id);
  if (otherDue.length) {
    lines.push(`Also due in other projects: ${otherDue.slice(0, 5).map((h) => `#${h.id} ${h.title}`).join("; ")}.`);
  }
  return lines.join("\n");
}

export function runSessionStartHook(): void {
  const input = readHookInput();
  const store = new Store(getDb());
  const context = sessionStartContext(store, input);
  if (!context) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    }) + "\n",
  );
}

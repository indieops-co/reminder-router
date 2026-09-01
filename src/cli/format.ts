import type { Handoff, Project } from "../core/types.js";
import { projectCode } from "../core/ids.js";
import { formatRelative, formatWhen } from "../parse/when.js";
import { effectiveDestinations } from "../launch/launcher.js";
import { destinationLabel } from "../core/destinations.js";
import { collapseHome } from "../core/paths.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = c("2"), bold = c("1"), red = c("31"), yellow = c("33"), green = c("32"), blue = c("34"), cyan = c("36");

export function statusDot(h: Handoff, now = new Date()): string {
  if (h.status === "due") return red("●");
  if (h.status === "completed") return dim("✓");
  if (h.status === "dismissed") return dim("–");
  const ms = new Date(h.trigger_at).getTime() - now.getTime();
  if (ms < 60 * 60_000) return yellow("●");
  return green("●");
}

export function pad(s: string, n: number): string {
  // pad by visible length (ignore ANSI)
  const vis = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, n - vis));
}

export function handoffLine(h: Handoff, project: Project | null, now = new Date()): string {
  const id = pad(dim(`#${h.id}`), 5);
  const when = h.status === "completed" || h.status === "dismissed"
    ? dim(h.completed_at ? formatRelative(new Date(h.completed_at), now) : "")
    : h.status === "due"
      ? red(formatRelative(new Date(h.trigger_at), now))
      : formatWhen(new Date(h.trigger_at), now);
  const proj = project ? `${dim(projectCode(project.id))} ${project.name}` : "";
  const rec = h.recurrence_label ? dim(` ↻ ${h.recurrence_label}`) : "";
  const snz = h.status === "snoozed" ? dim(" (snoozed)") : "";
  const dest = effectiveDestinations(h)[0];
  const arrow = dest ? dim(` → ${destinationLabel(dest)}`) : "";
  return `${statusDot(h, now)} ${id} ${pad(when, 22)} ${pad(proj, 24)} ${bold(h.title)}${rec}${snz}${arrow}`;
}

export function handoffDetail(h: Handoff, project: Project | null, now = new Date()): string {
  const lines: string[] = [];
  lines.push(`${statusDot(h, now)} ${bold(h.title)} ${dim(`#${h.id}`)}`);
  lines.push(`  ${dim("when")}     ${formatWhen(new Date(h.trigger_at), now)} ${dim(`(${formatRelative(new Date(h.trigger_at), now)})`)}${h.recurrence_label ? `  ↻ ${h.recurrence_label}` : ""}`);
  lines.push(`  ${dim("status")}   ${h.status}${h.snoozed_until ? ` until ${formatWhen(new Date(h.snoozed_until), now)}` : ""}`);
  if (project) lines.push(`  ${dim("project")}  ${projectCode(project.id)} ${project.name}${project.path ? dim("  " + collapseHome(project.path)) : ""}`);
  if (h.repo_path) lines.push(`  ${dim("repo")}     ${collapseHome(h.repo_path)}${h.git_branch ? dim(` (${h.git_branch})`) : ""}`);
  if (h.current_file) lines.push(`  ${dim("file")}     ${collapseHome(h.current_file)}`);
  if (h.agent_type) lines.push(`  ${dim("agent")}    ${h.agent_type}`);
  if (h.reason_paused) lines.push(`  ${dim("paused")}   ${h.reason_paused}`);
  if (h.next_action) lines.push(`  ${dim("next")}     ${h.next_action}`);
  const dests = effectiveDestinations(h);
  if (dests.length) {
    lines.push(`  ${dim("open")}`);
    dests.forEach((d, i) => lines.push(`    ${dim(String(i))}  ${pad(destinationLabel(d), 18)} ${dim(d.type)}  ${d.type === "path" || d.type === "file" || d.type === "claude" || d.type === "terminal" ? collapseHome(d.uri) : d.uri}`));
  }
  if (h.context_summary) lines.push(`  ${dim("context")}\n${indent(h.context_summary, 4)}`);
  if (h.resume_prompt) lines.push(`  ${dim("resume prompt")}\n${indent(h.resume_prompt, 4)}`);
  lines.push(`  ${dim("created")}  ${formatWhen(new Date(h.created_at), now)} ${dim("by " + h.created_by)}${h.occurrences ? dim(` · ${h.occurrences} occurrence${h.occurrences === 1 ? "" : "s"}`) : ""}`);
  return lines.join("\n");
}

export function indent(s: string, n: number): string {
  const p = " ".repeat(n);
  return s.split("\n").map((l) => p + l).join("\n");
}

/** Markdown block an agent can read to pick the work back up. */
export function resumeMarkdown(h: Handoff, project: Project | null): string {
  const out: string[] = [];
  out.push(`# Handoff #${h.id}: ${h.title}`);
  out.push("");
  if (project) out.push(`**Project:** ${project.name} (${projectCode(project.id)})`);
  if (h.repo_path) out.push(`**Repo:** ${h.repo_path}${h.git_branch ? ` (branch \`${h.git_branch}\`)` : ""}`);
  if (h.current_file) out.push(`**File:** ${h.current_file}`);
  out.push(`**Scheduled for:** ${new Date(h.trigger_at).toLocaleString()}${h.recurrence_label ? ` (${h.recurrence_label})` : ""}`);
  out.push(`**Created:** ${new Date(h.created_at).toLocaleString()} by ${h.created_by}`);
  if (h.reason_paused) out.push("", `## Why we stopped`, h.reason_paused);
  if (h.next_action) out.push("", `## Next action`, h.next_action);
  if (h.context_summary) out.push("", `## Context`, h.context_summary);
  const dests = effectiveDestinations(h);
  if (dests.length) {
    out.push("", "## Destinations");
    for (const d of dests) out.push(`- ${destinationLabel(d)}: ${d.uri}`);
  }
  if (h.resume_prompt) out.push("", `## Resume prompt`, "", h.resume_prompt);
  return out.join("\n");
}

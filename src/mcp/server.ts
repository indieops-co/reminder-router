/**
 * MCP server: lets Claude Code (or any MCP client) create and manage handoffs
 * natively instead of shelling out. Runs over stdio via `handoff mcp`.
 *
 * Design: tools mirror the CLI. Everything talks to the local SQLite store; the
 * daemon is only involved for actions that need it (opening destinations,
 * clearing notifications), and we fall back gracefully when it's not running.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { Store, HandoffError } from "../core/store.js";
import { getDb } from "../core/db.js";
import { loadConfig } from "../core/config.js";
import { captureContext } from "../core/git.js";
import { inferDestination, destinationLabel } from "../core/destinations.js";
import { projectCode } from "../core/ids.js";
import type { AgentType, Handoff, NewHandoffInput, Project } from "../core/types.js";
import { formatRelative, formatWhen, parseWhen } from "../parse/when.js";
import { parseEvery } from "../parse/recurrence.js";
import { effectiveDestinations } from "../launch/launcher.js";
import { HandoffService } from "../daemon/service.js";
import { LogNotifier } from "../notify/notifier.js";
import { resumeMarkdown } from "../cli/format.js";
import { apiClient, daemonUp } from "../cli/client.js";
import { packageVersion } from "../daemon/daemon.js";

export interface McpEnv {
  sessionId?: string;
  projectDir?: string;
  cwd?: string;
}

function envFromProcess(): McpEnv {
  return {
    sessionId: process.env.CLAUDE_SESSION_ID || undefined,
    projectDir: process.env.CLAUDE_PROJECT_DIR || undefined,
    cwd: process.cwd(),
  };
}

function line(h: Handoff, project: Project | null, now = new Date()): string {
  const proj = project ? `${projectCode(project.id)} ${project.name} · ` : "";
  const when = h.status === "due" ? `DUE (${formatRelative(new Date(h.trigger_at), now)})` : formatWhen(new Date(h.trigger_at), now);
  const rec = h.recurrence_label ? ` · ↻ ${h.recurrence_label}` : "";
  const dest = effectiveDestinations(h)[0];
  return `#${h.id} [${h.status}] ${when} · ${proj}${h.title}${rec}${dest ? ` → ${destinationLabel(dest)}` : ""}${h.next_action ? `\n    next: ${h.next_action}` : ""}`;
}

function text(s: string, structured?: unknown) {
  return { content: [{ type: "text" as const, text: s }], ...(structured !== undefined ? { structuredContent: structured as Record<string, unknown> } : {}) };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function createMcpServer(store: Store = new Store(getDb()), env: McpEnv = envFromProcess()): McpServer {
  const server = new McpServer({ name: "handoff", version: packageVersion() });
  const cfg = loadConfig();
  const service = () => new HandoffService({ store, notifier: new LogNotifier(() => undefined), config: cfg, log: () => undefined });
  const projectOf = (h: Handoff) => (h.project_id ? store.getProject(h.project_id) : null);

  /** Route an action through the daemon when it's up (so notifications clear and launches happen in the user's session). */
  const act = async (id: number, action: string, extra: { until?: string; index?: number } = {}) => {
    if (await daemonUp(cfg.port)) {
      const pathFor = action === "done" ? "complete" : action;
      const r = await apiClient(cfg.port).post(`/handoffs/${id}/${pathFor}`, { until: extra.until, index: extra.index });
      return { message: r.message as string, handoff: r.handoff as Handoff, launch: r.launch };
    }
    return service().handleAction(id, action, extra);
  };

  server.registerTool(
    "create_handoff",
    {
      title: "Create a handoff reminder",
      description:
        "Create a context-aware reminder that brings the developer back to this work. Give a natural-language time (\"tomorrow 10am\", \"in 3 hours\", \"friday at 3\") or a recurrence (\"every monday 9am\", \"weekdays 8:30\", \"first business day of every month\"). " +
        "Include why the work paused, the single next action, a compact context summary (100–300 words: objective, current state, relevant files, external dependency) and a resume prompt the developer can paste into a fresh agent session. " +
        "The current project directory, git repo/branch and Claude session id are captured automatically. Never dump transcripts.",
      inputSchema: {
        title: z.string().describe("Short title, e.g. \"Finish OAuth branding\""),
        when: z.string().optional().describe("When to remind: \"tomorrow 10am\", \"in 30m\", \"friday at 3\", \"sept 15 noon\". Required unless `every` is given."),
        every: z.string().optional().describe("Recurrence: \"monday 9am\", \"weekdays 8:30\", \"first business day of every month\", \"every 2 weeks on friday\""),
        why_paused: z.string().optional().describe("Why the work stopped (the blocker)"),
        next_action: z.string().optional().describe("The single most useful next step"),
        context: z.string().optional().describe("Compact handoff context: objective, current state, relevant files, external dependency"),
        resume_prompt: z.string().optional().describe("3–8 line prompt for a fresh agent session: what to read, what to verify, what to do next"),
        urls: z.array(z.string()).optional().describe("Destination URLs (GitHub PR, Vercel, Stripe, docs…). The first one is the notification's primary action."),
        destinations: z.array(z.string()).optional().describe("Other destinations: folders, files (path:line), vscode:// URIs"),
        project: z.string().optional().describe("Project name override (auto-detected from package.json / git remote / folder)"),
        repo_path: z.string().optional().describe("Project directory override (defaults to the current project)"),
        current_file: z.string().optional().describe("The file being worked on, if relevant"),
        terminal: z.boolean().optional().describe("Also offer a terminal-in-project destination"),
        notify: z.boolean().optional().describe("false = track silently, no notification"),
        no_capture: z.boolean().optional().describe("true for reminders unrelated to code (no project/repo capture)"),
      },
    },
    async (args) => {
      try {
        const input: NewHandoffInput = {
          title: args.title,
          when: args.when,
          every: args.every,
          reasonPaused: args.why_paused,
          nextAction: args.next_action,
          context: args.context,
          resumePrompt: args.resume_prompt,
          agent: "claude" as AgentType,
          createdBy: "mcp",
          notify: args.notify,
          sourceSessionId: env.sessionId,
          destinations: [],
        };
        if (!args.no_capture) {
          const dir = path.resolve(args.repo_path ?? env.projectDir ?? env.cwd ?? process.cwd());
          const ctx = captureContext(dir);
          input.repoPath = ctx.repoRoot ?? dir;
          input.gitBranch = ctx.branch ?? undefined;
          input.project = args.project ?? ctx.projectName;
          if (ctx.remote) store.upsertProject({ name: input.project, path: input.repoPath, repo: ctx.remote, agent: "claude" });
          if (args.current_file) input.currentFile = path.resolve(dir, args.current_file);
          if (args.terminal) input.destinations!.push({ type: "terminal", uri: input.repoPath!, label: "Terminal" });
        } else if (args.project) input.project = args.project;
        for (const u of args.urls ?? []) input.destinations!.push(inferDestination(u));
        for (const d of args.destinations ?? []) input.destinations!.push(inferDestination(d));
        const h = store.create(input);
        const up = await daemonUp(cfg.port);
        const p = projectOf(h);
        return text(
          `Created handoff ${line(h, p)}${up ? "" : "\n(Note: the reminder daemon is not running — run `handoff daemon install` so it fires.)"}`,
          { id: h.id, trigger_at: h.trigger_at, status: h.status, project: p?.name ?? null, daemon_running: up },
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_handoffs",
    {
      title: "List handoffs",
      description: "List handoffs, due ones first. Defaults to open (scheduled/due/snoozed) handoffs for the current project; pass all_projects=true for everything.",
      inputSchema: {
        status: z.enum(["open", "due", "scheduled", "snoozed", "completed", "dismissed", "all"]).optional().describe("Default: open"),
        all_projects: z.boolean().optional().describe("Include every project (default: only the current project, if one is detected)"),
        project: z.string().optional().describe("Filter by project name or code (P-018)"),
        query: z.string().optional().describe("Search titles / next actions / context"),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      try {
        let projectId: number | undefined;
        if (args.project) {
          const p = store.findProject(args.project);
          if (!p) return text(`No project matches "${args.project}".`);
          projectId = p.id;
        } else if (!args.all_projects) {
          const dir = env.projectDir ?? env.cwd;
          if (dir) {
            const ctx = captureContext(dir);
            const p = store.findProject(ctx.repoRoot ?? dir) ?? store.findProject(ctx.projectName);
            if (p) projectId = p.id;
          }
        }
        const status = args.status ?? "open";
        const list = store.list({ status: status === "open" || status === "all" ? status : [status], projectId, search: args.query, limit: args.limit ?? 50 });
        if (list.length === 0) return text(projectId ? "No handoffs for this project. (Use all_projects=true to see every project.)" : "No handoffs.");
        const now = new Date();
        return text(list.map((h) => line(h, projectOf(h), now)).join("\n"), { handoffs: list });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "due_now",
    { title: "What needs attention now", description: "Handoffs that are due right now, across all projects.", inputSchema: {} },
    async () => {
      const due = store.due();
      if (due.length === 0) return text("Nothing is waiting on the developer right now.");
      return text(due.map((h) => line(h, projectOf(h))).join("\n"), { handoffs: due });
    },
  );

  server.registerTool(
    "get_handoff",
    { title: "Get a handoff", description: "Full details of one handoff as Markdown (context, resume prompt, destinations).", inputSchema: { id: z.number().int() } },
    async ({ id }) => {
      try {
        const h = store.mustGet(id);
        return text(resumeMarkdown(h, projectOf(h)), { handoff: h });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "resume_handoff",
    {
      title: "Resume a handoff",
      description: "Read a handoff back to continue the work: returns why we stopped, next action, context and the resume prompt. Summarize current status before changing code. Does not complete the handoff — call complete_handoff when the work is actually done.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      try {
        const h = store.mustGet(id);
        store.addEvent(h.id, "opened", "resumed via MCP");
        return text(resumeMarkdown(h, projectOf(h)) + "\n\n(When finished, call complete_handoff with id " + h.id + ".)", { handoff: h });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "complete_handoff",
    { title: "Complete a handoff", description: "Mark a handoff done. Recurring handoffs advance to their next occurrence.", inputSchema: { id: z.number().int() } },
    async ({ id }) => {
      try {
        const r = await act(id, "done");
        return text(`#${id} completed. ${r.message}`, { handoff: r.handoff });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "snooze_handoff",
    {
      title: "Snooze a handoff",
      description: "Push a handoff back. `until` is natural language: \"15m\", \"2 hours\", \"tomorrow 9am\", \"friday at 3\".",
      inputSchema: { id: z.number().int(), until: z.string().describe("Default 15m") },
    },
    async ({ id, until }) => {
      try {
        const phrase = /^\d+\s*[smhdw]/i.test(until) ? `in ${until}` : until;
        const parsed = parseWhen(phrase, { config: cfg });
        if (!parsed) return errorResult(new Error(`Couldn't understand "${until}"`));
        const r = await act(id, "snooze", { until: parsed.at.toISOString() });
        return text(`#${id} snoozed until ${formatWhen(parsed.at)}.`, { handoff: r.handoff });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dismiss_handoff",
    { title: "Dismiss a handoff", description: "Dismiss without completing (recurring: skip this occurrence). Use stop=true to end a recurring handoff for good.", inputSchema: { id: z.number().int(), stop: z.boolean().optional() } },
    async ({ id, stop }) => {
      try {
        if (stop) {
          const h = store.stop(id);
          return text(`#${id} stopped.`, { handoff: h });
        }
        const r = await act(id, "dismiss");
        return text(`#${id} dismissed. ${r.message}`, { handoff: r.handoff });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_handoff",
    {
      title: "Update a handoff",
      description: "Change a handoff's time, recurrence, title, next action, context, resume prompt, or add a destination.",
      inputSchema: {
        id: z.number().int(),
        title: z.string().optional(),
        when: z.string().optional().describe("New time (natural language)"),
        every: z.string().optional().describe("New recurrence, or \"none\" to make it one-time"),
        why_paused: z.string().optional(),
        next_action: z.string().optional(),
        context: z.string().optional(),
        resume_prompt: z.string().optional(),
        add_url: z.string().optional().describe("Add a destination (URL, folder, file)"),
        notify: z.boolean().optional(),
      },
    },
    async (a) => {
      try {
        const h = store.update(a.id, {
          title: a.title,
          when: a.when,
          every: a.every === "none" ? null : a.every,
          reasonPaused: a.why_paused,
          nextAction: a.next_action,
          context: a.context,
          resumePrompt: a.resume_prompt,
          addDestination: a.add_url,
          notify: a.notify,
        });
        return text(`Updated ${line(h, projectOf(h))}`, { handoff: h });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "open_handoff",
    {
      title: "Open a handoff's destination",
      description: "Open a handoff's destination on the developer's machine (URL in browser, project in editor, terminal, Resume in Claude). index picks which destination (0 = primary; see get_handoff).",
      inputSchema: { id: z.number().int(), index: z.number().int().min(0).optional() },
    },
    async ({ id, index }) => {
      try {
        const r = await act(id, "open", { index: index ?? 0 });
        return text(r.message, { launch: r.launch ?? null });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_projects",
    { title: "List projects", description: "Known projects (auto-registered from handoffs) with open counts.", inputSchema: {} },
    async () => {
      const list = store.listProjects();
      if (list.length === 0) return text("No projects yet.");
      return text(list.map((p) => `${projectCode(p.id)} ${p.name}${p.path ? ` · ${p.path}` : ""}${p.repo ? ` · ${p.repo}` : ""} · ${store.list({ projectId: p.id }).length} open`).join("\n"), { projects: list });
    },
  );

  server.registerTool(
    "project_history",
    {
      title: "Project history",
      description: "What happened last time we worked on this project: recent handoffs (open and completed) with why-paused / next-action notes. Lightweight project memory across sessions. Defaults to the current project.",
      inputSchema: { project: z.string().optional().describe("Project name, code, or path. Default: current project"), limit: z.number().int().positive().optional() },
    },
    async ({ project, limit }) => {
      try {
        let p: Project | null = null;
        if (project) p = store.findProject(project);
        else {
          const dir = env.projectDir ?? env.cwd;
          if (dir) {
            const ctx = captureContext(dir);
            p = store.findProject(ctx.repoRoot ?? dir) ?? store.findProject(ctx.projectName);
          }
        }
        if (!p) return text("No known project here yet — it will appear after the first handoff.");
        const history = store.history(p.id, limit ?? 10);
        if (history.length === 0) return text(`${p.name}: no handoffs yet.`);
        const now = new Date();
        const rows = history.map((h) => {
          const stamp = h.completed_at ? `${formatWhen(new Date(h.completed_at), now)} ✓` : formatWhen(new Date(h.trigger_at), now);
          const notes = [h.reason_paused && `paused: ${h.reason_paused}`, h.next_action && `next: ${h.next_action}`].filter(Boolean).join(" · ");
          return `- ${stamp} — #${h.id} ${h.title} [${h.status}]${notes ? `\n  ${notes}` : ""}`;
        });
        return text(`## ${p.name} (${projectCode(p.id)})\n${rows.join("\n")}`, { project: p, history });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "parse_when",
    { title: "Preview a time phrase", description: "Check how a natural-language time or recurrence will be interpreted before creating a handoff.", inputSchema: { text: z.string() } },
    async ({ text: t }) => {
      const now = new Date();
      const rec = parseEvery(t, { now, morningHour: cfg.morningHour });
      if (rec) return text(`Recurring: ${rec.label}`, { kind: "recurring", ...rec });
      const one = parseWhen(t, { now, config: cfg });
      if (one) return text(`Once: ${one.at.toLocaleString()} (${one.label})`, { kind: "once", at: one.at.toISOString(), label: one.label });
      return errorResult(new HandoffError(`Couldn't understand "${t}"`));
    },
  );

  return server;
}

export async function runMcpStdio(): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep stdout clean: anything we'd normally log goes to stderr.
  console.log = (...a: unknown[]) => console.error(...a);
}

import http from "node:http";
import { URL } from "node:url";
import type { HandoffService } from "../daemon/service.js";
import { HandoffError, type HandoffPatch } from "../core/store.js";
import type { Handoff, NewHandoffInput } from "../core/types.js";
import { parseId, projectCode } from "../core/ids.js";
import { effectiveDestinations } from "../launch/launcher.js";
import { destinationLabel, inferDestination as inferDest } from "../core/destinations.js";
import { formatRelative, parseWhen, splitTitleAndWhen } from "../parse/when.js";
import { parseEvery } from "../parse/recurrence.js";
import { inboxHtml } from "./inbox.js";
import { captureContext } from "../core/git.js";

export interface ApiOptions {
  port: number;
  host?: string;
  version: string;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Serialized handoff with derived fields the UI and agents want. */
export function serializeHandoff(service: HandoffService, h: Handoff, now = new Date()) {
  const project = h.project_id ? service.store.getProject(h.project_id) : null;
  return {
    ...h,
    project: project ? { id: project.id, code: projectCode(project.id), name: project.name, path: project.path } : null,
    code: `#${h.id}`,
    when_label: formatRelative(new Date(h.trigger_at), now),
    actions: effectiveDestinations(h).map((d, i) => ({ index: i, ...d, label: destinationLabel(d) })),
  };
}

export function createApiServer(service: HandoffService, opts: ApiOptions): http.Server {
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$",
    );
    routes.push({ method, pattern, keys, handler });
  };
  const store = service.store;
  const idOf = (s: string) => {
    const id = parseId(s);
    if (!id) throw new ApiError(400, `Bad id "${s}"`);
    return id;
  };

  // ------------------------------------------------------------ routes
  route("GET", "/", ({ res }) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(inboxHtml());
    return undefined;
  });
  route("GET", "/health", () => ({ ok: true, version: opts.version, pid: process.pid, notifier: service.notifier.name, now: new Date().toISOString(), counts: store.counts() }));

  route("GET", "/handoffs", ({ query }) => {
    const status = (query.get("status") ?? "open") as any;
    const project = query.get("project");
    const projectId = project ? store.findProject(project)?.id ?? -1 : undefined;
    const list = store.list({
      status: status === "open" || status === "all" ? status : status.split(","),
      projectId,
      limit: query.get("limit") ? Number(query.get("limit")) : undefined,
      search: query.get("q") ?? undefined,
      recurringOnly: query.get("recurring") === "1",
    });
    const now = new Date();
    return list.map((h) => serializeHandoff(service, h, now));
  });
  route("GET", "/now", () => store.due().map((h) => serializeHandoff(service, h)));
  route("GET", "/inbox", () => {
    const now = new Date();
    const open = store.list({ status: "open" });
    const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
    const endOfTomorrow = new Date(endOfToday); endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    const ser = (arr: Handoff[]) => arr.map((h) => serializeHandoff(service, h, now));
    return {
      now: now.toISOString(),
      due: ser(open.filter((h) => h.status === "due")),
      today: ser(open.filter((h) => h.status !== "due" && new Date(h.trigger_at) <= endOfToday)),
      tomorrow: ser(open.filter((h) => h.status !== "due" && new Date(h.trigger_at) > endOfToday && new Date(h.trigger_at) <= endOfTomorrow)),
      later: ser(open.filter((h) => h.status !== "due" && new Date(h.trigger_at) > endOfTomorrow)),
      recurring: ser(open.filter((h) => h.recurrence)),
      completed: ser(store.list({ status: ["completed", "dismissed"], limit: 20 }).reverse()),
      counts: store.counts(),
      projects: store.listProjects().map((p) => ({ ...p, code: projectCode(p.id) })),
    };
  });

  route("POST", "/handoffs", ({ body }) => {
    const input = normalizeInput(body);
    if (body?.capture && input.repoPath) {
      // Editor extensions send a directory and ask us to fill in git root / branch / remote / name.
      const ctx = captureContext(input.repoPath);
      input.repoPath = ctx.repoRoot ?? input.repoPath;
      input.gitBranch = input.gitBranch ?? ctx.branch ?? undefined;
      input.project = input.project ?? ctx.projectName;
      if (ctx.remote) store.upsertProject({ name: input.project, path: input.repoPath, repo: ctx.remote });
    }
    if (!input.when && !input.every && !input.triggerAt && !input.recurrence) {
      // "check deployment in 30m" typed as one line
      const split = splitTitleAndWhen(input.title, { config: service.config });
      if (split.when) {
        input.title = split.title;
        input.when = split.when;
      }
    }
    const h = store.create({ ...input, createdBy: input.createdBy ?? "api" });
    return serializeHandoff(service, h);
  });
  route("GET", "/handoffs/:id", ({ params }) => serializeHandoff(service, store.mustGet(idOf(params.id))));
  route("PATCH", "/handoffs/:id", ({ params, body }) => serializeHandoff(service, store.update(idOf(params.id), body as HandoffPatch)));
  route("DELETE", "/handoffs/:id", ({ params }) => { store.delete(idOf(params.id)); return { ok: true }; });
  route("GET", "/handoffs/:id/events", ({ params }) => store.events(idOf(params.id)));

  const act = (action: string) => async ({ params, body, query }: Ctx) => {
    const r = await service.handleAction(idOf(params.id), action, {
      until: body?.until ?? body?.when ?? query.get("until") ?? undefined,
      index: body?.index ?? (query.get("index") ? Number(query.get("index")) : undefined),
    });
    return { ok: true, message: r.message, launch: r.launch ?? null, handoff: serializeHandoff(service, r.handoff) };
  };
  route("POST", "/handoffs/:id/complete", act("done"));
  route("POST", "/handoffs/:id/done", act("done"));
  route("POST", "/handoffs/:id/dismiss", act("dismiss"));
  route("POST", "/handoffs/:id/snooze", act("snooze"));
  route("POST", "/handoffs/:id/open", act("open"));
  route("POST", "/handoffs/:id/stop", ({ params }) => serializeHandoff(service, store.stop(idOf(params.id))));
  route("POST", "/handoffs/:id/reopen", ({ params }) => serializeHandoff(service, store.reopen(idOf(params.id))));
  route("POST", "/handoffs/:id/reschedule", ({ params, body }) => {
    if (!body?.when) throw new ApiError(400, "when is required");
    return serializeHandoff(service, store.reschedule(idOf(params.id), body.when));
  });

  /** Called by the Swift notification helper (and the inbox) when the user clicks something. */
  route("POST", "/actions", async ({ body }) => {
    const id = parseId(body?.id);
    if (!id) throw new ApiError(400, "id required");
    const r = await service.handleAction(id, String(body.action ?? "open"), { index: body.index });
    return { ok: true, message: r.message };
  });

  route("GET", "/projects", () => store.listProjects().map((p) => ({ ...p, code: projectCode(p.id), open: store.list({ projectId: p.id }).length })));
  route("GET", "/projects/:id", ({ params }) => {
    const p = store.findProject(params.id);
    if (!p) throw new ApiError(404, "Project not found");
    return { ...p, code: projectCode(p.id), handoffs: store.list({ projectId: p.id }).map((h) => serializeHandoff(service, h)), history: store.history(p.id).map((h) => serializeHandoff(service, h)) };
  });
  /** Resolve a directory to its project (if known) and that project's open handoffs — what an editor needs on activation. */
  route("GET", "/context", ({ query }) => {
    const dir = query.get("path");
    if (!dir) throw new ApiError(400, "path is required");
    const ctx = captureContext(dir);
    const project = store.findProject(ctx.repoRoot ?? dir) ?? store.findProject(ctx.projectName);
    const now = new Date();
    return {
      path: dir,
      repoRoot: ctx.repoRoot,
      branch: ctx.branch,
      remote: ctx.remote,
      projectName: ctx.projectName,
      project: project ? { ...project, code: projectCode(project.id) } : null,
      handoffs: project ? store.list({ projectId: project.id }).map((h) => serializeHandoff(service, h, now)) : [],
      dueElsewhere: store.due().filter((h) => !project || h.project_id !== project.id).map((h) => serializeHandoff(service, h, now)),
    };
  });
  route("PATCH", "/projects/:id", ({ params, body }) => {
    const p = store.findProject(params.id);
    if (!p) throw new ApiError(404, "Project not found");
    return store.renameProject(p.id, String(body.name));
  });

  route("POST", "/parse", ({ body }) => {
    const now = new Date();
    const text = String(body?.when ?? body?.text ?? "");
    const rec = parseEvery(text, { now, morningHour: service.config.morningHour });
    if (rec) return { kind: "recurring", label: rec.label, recurrence: rec.recurrence };
    const one = parseWhen(text, { now, config: service.config });
    if (one) return { kind: "once", at: one.at.toISOString(), label: one.label };
    // Maybe it's "title + trailing time" — tell the caller how we'd split it.
    const split = splitTitleAndWhen(text, { now, config: service.config });
    if (split.when) {
      const rec2 = parseEvery(split.when, { now, morningHour: service.config.morningHour });
      if (rec2) return { kind: "recurring", label: rec2.label, recurrence: rec2.recurrence, title: split.title, when: split.when };
      const one2 = parseWhen(split.when, { now, config: service.config })!;
      return { kind: "once", at: one2.at.toISOString(), label: one2.label, title: split.title, when: split.when };
    }
    throw new ApiError(400, `Couldn't understand "${text}"`);
  });

  route("POST", "/tick", async () => ({ fired: await service.tick() }));
  route("POST", "/test-notification", async () => {
    await service.notifier.notify({
      id: 0,
      title: "Reminder Router",
      subtitle: "Notifications are working",
      body: "This is what a handoff looks like when it lands.",
      primary: "Open",
      actions: DEFAULT_TEST_ACTIONS,
      sound: service.config.sound,
    });
    return { ok: true, notifier: service.notifier.name };
  });

  // ------------------------------------------------------------ server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    res.setHeader("access-control-allow-origin", "http://127.0.0.1:" + opts.port);
    res.setHeader("cache-control", "no-store");
    try {
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) throw new ApiError(404, `No route ${req.method} ${url.pathname}`);
      const m = url.pathname.match(match.pattern)!;
      const params: Record<string, string> = {};
      match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const body = await readJson(req);
      const result = await match.handler({ req, res, params, query: url.searchParams, body });
      if (res.writableEnded) return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result ?? { ok: true }));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : err instanceof HandoffError ? (err.code === "not_found" ? 404 : 400) : 500;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: (err as Error).message, code: (err as any).code ?? undefined }));
    }
  });
  return server;
}

const DEFAULT_TEST_ACTIONS = [
  { id: "snooze15" as const, label: "Snooze 15m" },
  { id: "done" as const, label: "Done" },
];

async function readJson(req: http.IncomingMessage): Promise<any> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "Body must be JSON");
  }
}

/** Accept both the compact PRD payload and the full NewHandoffInput shape. */
export function normalizeInput(body: any): NewHandoffInput {
  if (!body || typeof body !== "object") throw new ApiError(400, "JSON body required");
  const b = body;
  const input: NewHandoffInput = {
    title: b.title,
    when: b.when ?? b.at ?? b.in,
    triggerAt: b.triggerAt ?? b.trigger_at,
    every: b.every ?? b.repeat ?? b.recurrence_text,
    recurrence: b.recurrence && typeof b.recurrence === "object" ? b.recurrence : undefined,
    project: b.project ?? b.project_name,
    projectId: b.projectId ?? b.project_id,
    nextAction: b.nextAction ?? b.next_action ?? b.next,
    reasonPaused: b.reasonPaused ?? b.reason_paused ?? b.why ?? b.reason,
    context: b.context ?? b.context_summary ?? b.notes,
    destinations: Array.isArray(b.destinations) ? b.destinations : undefined,
    destination: typeof b.destination === "string" ? b.destination : typeof b.url === "string" ? b.url : undefined,
    repoPath: b.repoPath ?? b.repo_path ?? b.repo ?? b.path,
    workspacePath: b.workspacePath ?? b.workspace_path,
    gitBranch: b.gitBranch ?? b.git_branch ?? b.branch,
    currentFile: b.currentFile ?? b.current_file ?? b.file,
    agent: b.agent ?? b.agent_type,
    resumePrompt: b.resumePrompt ?? b.resume_prompt ?? b.resume,
    sourceSessionId: b.sourceSessionId ?? b.source_session_id ?? b.session,
    sourceTerminalId: b.sourceTerminalId ?? b.source_terminal_id,
    notify: b.notify ?? b.notification_enabled,
    createdBy: b.createdBy ?? b.created_by ?? b.source,
  };
  if (Array.isArray(b.urls)) {
    input.destinations = [...(input.destinations ?? []), ...b.urls.map((u: string) => ({ type: "url", uri: u }))];
  }
  if (!input.title || typeof input.title !== "string") throw new ApiError(400, "title is required");
  if (input.destinations) {
    input.destinations = input.destinations.map((d: any) => (typeof d === "string" ? inferDest(d) : d));
  }
  return input;
}


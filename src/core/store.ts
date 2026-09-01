import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import type {
  AgentType,
  CreatedBy,
  Destination,
  Handoff,
  HandoffEvent,
  HandoffEventKind,
  HandoffStatus,
  NewHandoffInput,
  Project,
  Recurrence,
} from "./types.js";
import { parseWhen } from "../parse/when.js";
import { parseEvery, nextOccurrence, describeRecurrence, looksRecurring } from "../parse/recurrence.js";
import { inferDestination } from "./destinations.js";
import { loadConfig } from "./config.js";

export class HandoffError extends Error {
  constructor(message: string, public code: string = "invalid") {
    super(message);
  }
}

type Row = Record<string, unknown>;

function iso(d: Date): string {
  return d.toISOString();
}

function localTimezone(): string {
  const cfg = loadConfig();
  if (cfg.timezone) return cfg.timezone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function rowToProject(r: Row): Project {
  return {
    id: r.id as number,
    name: r.name as string,
    path: (r.path as string) ?? null,
    repo: (r.repo as string) ?? null,
    preferred_agent: ((r.preferred_agent as string) ?? null) as AgentType,
    created_at: r.created_at as string,
    last_used_at: r.last_used_at as string,
  };
}

function rowToHandoff(r: Row): Handoff {
  return {
    id: r.id as number,
    title: r.title as string,
    project_id: (r.project_id as number) ?? null,
    created_at: r.created_at as string,
    trigger_at: r.trigger_at as string,
    timezone: r.timezone as string,
    recurrence: r.recurrence ? (JSON.parse(r.recurrence as string) as Recurrence) : null,
    recurrence_label: (r.recurrence_label as string) ?? null,
    status: r.status as HandoffStatus,
    next_action: (r.next_action as string) ?? null,
    reason_paused: (r.reason_paused as string) ?? null,
    context_summary: (r.context_summary as string) ?? null,
    destinations: JSON.parse((r.destinations as string) || "[]") as Destination[],
    repo_path: (r.repo_path as string) ?? null,
    workspace_path: (r.workspace_path as string) ?? null,
    git_branch: (r.git_branch as string) ?? null,
    current_file: (r.current_file as string) ?? null,
    agent_type: ((r.agent_type as string) ?? null) as AgentType,
    resume_prompt: (r.resume_prompt as string) ?? null,
    source_session_id: (r.source_session_id as string) ?? null,
    source_terminal_id: (r.source_terminal_id as string) ?? null,
    notification_enabled: Boolean(r.notification_enabled),
    created_by: (r.created_by as CreatedBy) ?? "manual",
    fired_at: (r.fired_at as string) ?? null,
    notified_count: (r.notified_count as number) ?? 0,
    last_notified_at: (r.last_notified_at as string) ?? null,
    completed_at: (r.completed_at as string) ?? null,
    snoozed_until: (r.snoozed_until as string) ?? null,
    occurrences: (r.occurrences as number) ?? 0,
  };
}

export interface ListOptions {
  status?: HandoffStatus | HandoffStatus[] | "open" | "all";
  projectId?: number;
  limit?: number;
  search?: string;
  recurringOnly?: boolean;
}

export interface HandoffPatch {
  title?: string;
  when?: string;
  triggerAt?: string | Date;
  every?: string | null;
  projectId?: number | null;
  project?: string;
  nextAction?: string | null;
  reasonPaused?: string | null;
  context?: string | null;
  destinations?: Destination[];
  addDestination?: string;
  repoPath?: string | null;
  resumePrompt?: string | null;
  agent?: AgentType;
  notify?: boolean;
}

export class Store {
  constructor(private db: DatabaseSync = getDb()) {}

  // ---------------------------------------------------------------- projects

  listProjects(): Project[] {
    return (this.db.prepare(`SELECT * FROM projects ORDER BY last_used_at DESC`).all() as Row[]).map(rowToProject);
  }

  getProject(id: number): Project | null {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    return r ? rowToProject(r) : null;
  }

  findProject(query: string): Project | null {
    const byId = query.match(/^(?:p-?)?0*(\d+)$/i);
    if (byId) {
      const p = this.getProject(Number(byId[1]));
      if (p) return p;
    }
    const r =
      (this.db.prepare(`SELECT * FROM projects WHERE path = ?`).get(query) as Row | undefined) ??
      (this.db.prepare(`SELECT * FROM projects WHERE name = ? COLLATE NOCASE`).get(query) as Row | undefined) ??
      (this.db.prepare(`SELECT * FROM projects WHERE name LIKE ? COLLATE NOCASE ORDER BY last_used_at DESC`).get(`%${query}%`) as Row | undefined);
    return r ? rowToProject(r) : null;
  }

  /**
   * Projects emerge from usage: match by path, then by name; otherwise create.
   * Enriches an existing project with a path/repo if it learns one.
   */
  upsertProject(input: { name?: string; path?: string | null; repo?: string | null; agent?: AgentType }): Project {
    const now = iso(new Date());
    let existing: Project | null = null;
    if (input.path) {
      const r = this.db.prepare(`SELECT * FROM projects WHERE path = ?`).get(input.path) as Row | undefined;
      if (r) existing = rowToProject(r);
    }
    if (!existing && input.name) {
      const r = this.db.prepare(`SELECT * FROM projects WHERE name = ? COLLATE NOCASE`).get(input.name) as Row | undefined;
      if (r) existing = rowToProject(r);
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE projects SET last_used_at = ?, path = COALESCE(path, ?), repo = COALESCE(repo, ?),
             preferred_agent = COALESCE(?, preferred_agent) WHERE id = ?`,
        )
        .run(now, input.path ?? null, input.repo ?? null, input.agent ?? null, existing.id);
      return this.getProject(existing.id)!;
    }
    const name = input.name ?? (input.path ? input.path.split("/").filter(Boolean).pop() ?? "project" : "project");
    const res = this.db
      .prepare(`INSERT INTO projects(name, path, repo, preferred_agent, created_at, last_used_at) VALUES (?,?,?,?,?,?)`)
      .run(name, input.path ?? null, input.repo ?? null, input.agent ?? null, now, now);
    return this.getProject(Number(res.lastInsertRowid))!;
  }

  renameProject(id: number, name: string): Project {
    this.db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).run(name, id);
    const p = this.getProject(id);
    if (!p) throw new HandoffError(`Project ${id} not found`, "not_found");
    return p;
  }

  deleteProject(id: number): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  // ---------------------------------------------------------------- handoffs

  /** Resolve `when` / `every` into a trigger time + recurrence. */
  resolveSchedule(input: { when?: string; triggerAt?: string | Date; every?: string; recurrence?: Recurrence }, now = new Date()) {
    const cfg = loadConfig();
    let recurrence: Recurrence | null = input.recurrence ?? null;
    let label: string | null = recurrence ? describeRecurrence(recurrence) : null;
    let triggerAt: Date | null = null;

    if (input.every) {
      // `--every "monday 9am"` → "every monday 9am"
      const text = /^(every|daily|weekly|monthly|yearly|hourly|annually)\b/i.test(input.every.trim()) ? input.every : `every ${input.every}`;
      const parsed = parseEvery(text, { morningHour: cfg.morningHour, now });
      if (!parsed) throw new HandoffError(`Couldn't understand recurrence "${input.every}"`, "bad_recurrence");
      recurrence = parsed.recurrence;
      label = parsed.label;
    }
    if (input.triggerAt) {
      const d = input.triggerAt instanceof Date ? input.triggerAt : new Date(input.triggerAt);
      if (Number.isNaN(d.getTime())) throw new HandoffError(`Invalid date "${input.triggerAt}"`, "bad_time");
      triggerAt = d;
    } else if (input.when) {
      if (!recurrence && looksRecurring(input.when)) {
        const parsed = parseEvery(input.when, { morningHour: cfg.morningHour, now });
        if (parsed) {
          recurrence = parsed.recurrence;
          label = parsed.label;
        }
      }
      if (!recurrence) {
        const parsed = parseWhen(input.when, { now, config: cfg });
        if (!parsed) throw new HandoffError(`Couldn't understand time "${input.when}"`, "bad_time");
        triggerAt = parsed.at;
      }
    }
    if (recurrence && !triggerAt) triggerAt = nextOccurrence(recurrence, now, now);
    if (!triggerAt) throw new HandoffError("A time is required (e.g. \"tomorrow 10am\", \"in 30m\", \"every Monday 9am\")", "missing_time");
    return { triggerAt, recurrence, label };
  }

  create(input: NewHandoffInput, now = new Date()): Handoff {
    const title = (input.title ?? "").trim();
    if (!title) throw new HandoffError("Title is required", "missing_title");
    const { triggerAt, recurrence, label } = this.resolveSchedule(input, now);

    let projectId: number | null = input.projectId ?? null;
    if (!projectId && (input.project || input.repoPath)) {
      projectId = this.upsertProject({ name: input.project, path: input.repoPath ?? null, agent: input.agent ?? null }).id;
    }

    const destinations: Destination[] = [...(input.destinations ?? [])];
    if (input.destination) destinations.push(inferDestination(input.destination));
    for (const d of destinations) {
      if (!d.type || !d.uri) throw new HandoffError("Each destination needs a type and uri", "bad_destination");
    }

    const res = this.db
      .prepare(
        `INSERT INTO handoffs (
          title, project_id, created_at, trigger_at, timezone, recurrence, recurrence_label, status,
          next_action, reason_paused, context_summary, destinations,
          repo_path, workspace_path, git_branch, current_file, agent_type, resume_prompt,
          source_session_id, source_terminal_id, notification_enabled, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        title,
        projectId,
        iso(now),
        iso(triggerAt),
        localTimezone(),
        recurrence ? JSON.stringify(recurrence) : null,
        label,
        "scheduled",
        input.nextAction ?? null,
        input.reasonPaused ?? null,
        input.context ?? null,
        JSON.stringify(destinations),
        input.repoPath ?? null,
        input.workspacePath ?? null,
        input.gitBranch ?? null,
        input.currentFile ?? null,
        input.agent ?? null,
        input.resumePrompt ?? null,
        input.sourceSessionId ?? null,
        input.sourceTerminalId ?? null,
        input.notify === false ? 0 : 1,
        input.createdBy ?? "manual",
      );
    const id = Number(res.lastInsertRowid);
    this.addEvent(id, "created", label ? `recurring: ${label}` : null, now);
    return this.get(id)!;
  }

  get(id: number): Handoff | null {
    const r = this.db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id) as Row | undefined;
    return r ? rowToHandoff(r) : null;
  }

  mustGet(id: number): Handoff {
    const h = this.get(id);
    if (!h) throw new HandoffError(`Handoff #${id} not found`, "not_found");
    return h;
  }

  list(opts: ListOptions = {}): Handoff[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const status = opts.status ?? "open";
    if (status === "open") where.push(`status IN ('scheduled','due','snoozed')`);
    else if (status !== "all") {
      const arr = Array.isArray(status) ? status : [status];
      where.push(`status IN (${arr.map(() => "?").join(",")})`);
      params.push(...arr);
    }
    if (opts.projectId) {
      where.push(`project_id = ?`);
      params.push(opts.projectId);
    }
    if (opts.recurringOnly) where.push(`recurrence IS NOT NULL`);
    if (opts.search) {
      where.push(`(title LIKE ? OR next_action LIKE ? OR context_summary LIKE ?)`);
      const q = `%${opts.search}%`;
      params.push(q, q, q);
    }
    const sql = `SELECT * FROM handoffs ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY CASE status WHEN 'due' THEN 0 ELSE 1 END, trigger_at ASC
                 ${opts.limit ? "LIMIT " + Number(opts.limit) : ""}`;
    return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map(rowToHandoff);
  }

  /** Handoffs whose time has come but have not been marked due yet. */
  pending(now = new Date()): Handoff[] {
    return (
      this.db
        .prepare(`SELECT * FROM handoffs WHERE status IN ('scheduled','snoozed') AND trigger_at <= ? ORDER BY trigger_at`)
        .all(iso(now)) as Row[]
    ).map(rowToHandoff);
  }

  /** Everything currently waiting on the user. */
  due(): Handoff[] {
    return (this.db.prepare(`SELECT * FROM handoffs WHERE status = 'due' ORDER BY trigger_at`).all() as Row[]).map(rowToHandoff);
  }

  markFired(id: number, now = new Date()): Handoff {
    this.db.prepare(`UPDATE handoffs SET status = 'due', fired_at = ?, snoozed_until = NULL WHERE id = ?`).run(iso(now), id);
    this.addEvent(id, "fired", null, now);
    return this.mustGet(id);
  }

  markNotified(id: number, now = new Date()): void {
    this.db
      .prepare(`UPDATE handoffs SET notified_count = notified_count + 1, last_notified_at = ? WHERE id = ?`)
      .run(iso(now), id);
    this.addEvent(id, "notified", null, now);
  }

  snooze(id: number, until: Date, now = new Date()): Handoff {
    const h = this.mustGet(id);
    if (h.status === "completed" || h.status === "dismissed") throw new HandoffError(`Handoff #${id} is ${h.status}`, "closed");
    this.db
      .prepare(`UPDATE handoffs SET status = 'snoozed', snoozed_until = ?, trigger_at = ?, notified_count = 0 WHERE id = ?`)
      .run(iso(until), iso(until), id);
    this.addEvent(id, "snoozed", `until ${until.toISOString()}`, now);
    return this.mustGet(id);
  }

  reschedule(id: number, when: string | Date, now = new Date()): Handoff {
    const h = this.mustGet(id);
    const { triggerAt } = this.resolveSchedule(when instanceof Date ? { triggerAt: when } : { when }, now);
    this.db
      .prepare(`UPDATE handoffs SET status = 'scheduled', trigger_at = ?, snoozed_until = NULL, fired_at = NULL, notified_count = 0 WHERE id = ?`)
      .run(iso(triggerAt), id);
    this.addEvent(id, "rescheduled", `${h.trigger_at} → ${triggerAt.toISOString()}`, now);
    return this.mustGet(id);
  }

  /** Complete: one-shots close; recurring ones advance to the next occurrence. */
  complete(id: number, now = new Date()): Handoff {
    const h = this.mustGet(id);
    if (h.recurrence) {
      this.advance(h, now, "completed");
    } else {
      this.db.prepare(`UPDATE handoffs SET status = 'completed', completed_at = ? WHERE id = ?`).run(iso(now), id);
      this.addEvent(id, "completed", null, now);
    }
    return this.mustGet(id);
  }

  /** Dismiss: one-shots close without completion; recurring ones skip this occurrence. */
  dismiss(id: number, now = new Date()): Handoff {
    const h = this.mustGet(id);
    if (h.recurrence) {
      this.advance(h, now, "dismissed");
    } else {
      this.db.prepare(`UPDATE handoffs SET status = 'dismissed', completed_at = ? WHERE id = ?`).run(iso(now), id);
      this.addEvent(id, "dismissed", null, now);
    }
    return this.mustGet(id);
  }

  /** Stop a recurring handoff for good. */
  stop(id: number, now = new Date()): Handoff {
    this.db.prepare(`UPDATE handoffs SET status = 'dismissed', completed_at = ? WHERE id = ?`).run(iso(now), id);
    this.addEvent(id, "dismissed", "stopped recurrence", now);
    return this.mustGet(id);
  }

  /** Move a recurring handoff to its next occurrence after `now`. */
  advance(h: Handoff, now = new Date(), because: "completed" | "dismissed" | "advanced" = "advanced"): Handoff {
    if (!h.recurrence) return h;
    const anchor = new Date(h.created_at);
    const next = nextOccurrence(h.recurrence, now, anchor);
    this.db
      .prepare(
        `UPDATE handoffs SET status = 'scheduled', trigger_at = ?, snoozed_until = NULL, fired_at = NULL,
           notified_count = 0, occurrences = occurrences + 1, completed_at = ? WHERE id = ?`,
      )
      .run(iso(next), iso(now), h.id);
    this.addEvent(h.id, because, `next ${next.toISOString()}`, now);
    return this.mustGet(h.id);
  }

  reopen(id: number, now = new Date()): Handoff {
    this.db.prepare(`UPDATE handoffs SET status = 'due', completed_at = NULL WHERE id = ?`).run(id);
    this.addEvent(id, "updated", "reopened", now);
    return this.mustGet(id);
  }

  update(id: number, patch: HandoffPatch, now = new Date()): Handoff {
    const h = this.mustGet(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.title !== undefined) set("title", patch.title.trim());
    if (patch.nextAction !== undefined) set("next_action", patch.nextAction);
    if (patch.reasonPaused !== undefined) set("reason_paused", patch.reasonPaused);
    if (patch.context !== undefined) set("context_summary", patch.context);
    if (patch.resumePrompt !== undefined) set("resume_prompt", patch.resumePrompt);
    if (patch.repoPath !== undefined) set("repo_path", patch.repoPath);
    if (patch.agent !== undefined) set("agent_type", patch.agent);
    if (patch.notify !== undefined) set("notification_enabled", patch.notify ? 1 : 0);
    if (patch.project !== undefined) set("project_id", this.upsertProject({ name: patch.project }).id);
    else if (patch.projectId !== undefined) set("project_id", patch.projectId);
    if (patch.destinations !== undefined || patch.addDestination) {
      const dests = patch.destinations ?? h.destinations;
      if (patch.addDestination) dests.push(inferDestination(patch.addDestination));
      set("destinations", JSON.stringify(dests));
    }
    if (patch.every === null) {
      set("recurrence", null);
      set("recurrence_label", null);
    }
    if (patch.when !== undefined || patch.triggerAt !== undefined || (patch.every && patch.every !== null)) {
      const { triggerAt, recurrence, label } = this.resolveSchedule(
        { when: patch.when, triggerAt: patch.triggerAt, every: patch.every ?? undefined, recurrence: patch.every ? undefined : h.recurrence ?? undefined },
        now,
      );
      set("trigger_at", iso(triggerAt));
      set("status", "scheduled");
      set("snoozed_until", null);
      set("fired_at", null);
      set("notified_count", 0);
      if (patch.every) {
        set("recurrence", recurrence ? JSON.stringify(recurrence) : null);
        set("recurrence_label", label);
      }
    }
    if (sets.length === 0) return h;
    params.push(id);
    this.db.prepare(`UPDATE handoffs SET ${sets.join(", ")} WHERE id = ?`).run(...(params as never[]));
    this.addEvent(id, "updated", Object.keys(patch).join(","), now);
    return this.mustGet(id);
  }

  delete(id: number): void {
    this.mustGet(id);
    this.db.prepare(`DELETE FROM handoffs WHERE id = ?`).run(id);
  }

  // ---------------------------------------------------------------- events

  addEvent(handoffId: number, kind: HandoffEventKind, detail: string | null = null, now = new Date()): void {
    this.db.prepare(`INSERT INTO handoff_events(handoff_id, kind, detail, at) VALUES (?,?,?,?)`).run(handoffId, kind, detail, iso(now));
  }

  events(handoffId: number, limit = 50): HandoffEvent[] {
    return this.db
      .prepare(`SELECT * FROM handoff_events WHERE handoff_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
      .all(handoffId, limit) as unknown as HandoffEvent[];
  }

  /** Recent handoffs for a project — the seed of "agent-readable project memory". */
  history(projectId: number, limit = 10): Handoff[] {
    return (
      this.db
        .prepare(`SELECT * FROM handoffs WHERE project_id = ? ORDER BY COALESCE(completed_at, fired_at, created_at) DESC LIMIT ?`)
        .all(projectId, limit) as Row[]
    ).map(rowToHandoff);
  }

  counts(): { due: number; scheduled: number; snoozed: number; recurring: number; completed: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(status = 'due') AS due,
           SUM(status = 'scheduled') AS scheduled,
           SUM(status = 'snoozed') AS snoozed,
           SUM(recurrence IS NOT NULL AND status IN ('scheduled','due','snoozed')) AS recurring,
           SUM(status = 'completed') AS completed
         FROM handoffs`,
      )
      .get() as Row;
    return {
      due: Number(row.due ?? 0),
      scheduled: Number(row.scheduled ?? 0),
      snoozed: Number(row.snoozed ?? 0),
      recurring: Number(row.recurring ?? 0),
      completed: Number(row.completed ?? 0),
    };
  }
}

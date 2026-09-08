import * as vscode from "vscode";
import { execFile } from "node:child_process";

/** Shape of a handoff as the daemon serializes it (see src/api/server.ts serializeHandoff). */
export interface Handoff {
  id: number;
  code: string;
  title: string;
  status: "scheduled" | "due" | "snoozed" | "completed" | "dismissed";
  trigger_at: string;
  when_label: string;
  recurrence_label: string | null;
  next_action: string | null;
  reason_paused: string | null;
  context_summary: string | null;
  resume_prompt: string | null;
  repo_path: string | null;
  git_branch: string | null;
  current_file: string | null;
  source_session_id: string | null;
  agent_type: string | null;
  completed_at: string | null;
  project: { id: number; code: string; name: string; path: string | null } | null;
  actions: Array<{ index: number; type: string; uri: string; label: string; command?: string }>;
  /** vscode://indieops.reminder-router/handoff/<id> when the daemon sees the extension installed. */
  deep_link?: string | null;
}

export interface Inbox {
  due: Handoff[];
  today: Handoff[];
  tomorrow: Handoff[];
  later: Handoff[];
  recurring: Handoff[];
  completed: Handoff[];
  counts: { due: number; scheduled: number; snoozed: number; recurring: number; completed: number };
}

export interface WorkspaceContext {
  path: string;
  repoRoot: string | null;
  branch: string | null;
  projectName: string;
  project: { id: number; code: string; name: string; path: string | null } | null;
  handoffs: Handoff[];
  dueElsewhere: Handoff[];
}

export interface CreateInput {
  title: string;
  when?: string;
  every?: string;
  repoPath?: string;
  project?: string;
  currentFile?: string;
  destinations?: Array<{ type: string; uri: string; label?: string; command?: string }>;
  nextAction?: string;
  reasonPaused?: string;
  context?: string;
  resumePrompt?: string;
  capture?: boolean;
  source?: string;
}

export interface ListParams {
  /** "open" (default) | "all" | comma-separated statuses ("due,snoozed"). */
  status?: string;
  q?: string;
  project?: string;
  limit?: number;
  recurring?: boolean;
}

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("handoff").get<T>(key, fallback);
}

export class DaemonDown extends Error {
  constructor() {
    super("The reminder daemon isn't running.");
  }
}

export class HandoffApi {
  get base(): string {
    return `http://127.0.0.1:${cfg("port", 7391)}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new DaemonDown();
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text };
    }
    if (!res.ok) throw new Error(json?.error ?? `${res.status} ${res.statusText}`);
    return json as T;
  }

  async up(): Promise<boolean> {
    try {
      await this.call("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }

  inbox(): Promise<Inbox> {
    return this.call("GET", "/inbox");
  }

  context(dir: string): Promise<WorkspaceContext> {
    return this.call("GET", `/context?path=${encodeURIComponent(dir)}`);
  }

  due(): Promise<Handoff[]> {
    return this.call("GET", "/now");
  }

  list(params: ListParams = {}): Promise<Handoff[]> {
    const q = new URLSearchParams();
    q.set("status", params.status ?? "open");
    if (params.q) q.set("q", params.q);
    if (params.project) q.set("project", params.project);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.recurring) q.set("recurring", "1");
    return this.call("GET", `/handoffs?${q.toString()}`);
  }

  get(id: number): Promise<Handoff> {
    return this.call("GET", `/handoffs/${id}`);
  }

  create(input: CreateInput): Promise<Handoff> {
    return this.call("POST", "/handoffs", { ...input, source: input.source ?? "extension" });
  }

  parse(when: string): Promise<{ kind: "once" | "recurring"; label: string; at?: string; title?: string; when?: string }> {
    return this.call("POST", "/parse", { when });
  }

  complete(id: number) {
    return this.call<{ message: string; handoff: Handoff }>("POST", `/handoffs/${id}/complete`);
  }

  snooze(id: number, until: string) {
    return this.call<{ message: string; handoff: Handoff }>("POST", `/handoffs/${id}/snooze`, { until });
  }

  dismiss(id: number) {
    return this.call<{ message: string; handoff: Handoff }>("POST", `/handoffs/${id}/dismiss`);
  }

  open(id: number, index = 0) {
    return this.call<{ message: string; launch: { ok: boolean; message: string } | null }>("POST", `/handoffs/${id}/open`, { index });
  }

  reschedule(id: number, when: string): Promise<Handoff> {
    return this.call("POST", `/handoffs/${id}/reschedule`, { when });
  }

  reopen(id: number): Promise<Handoff> {
    return this.call("POST", `/handoffs/${id}/reopen`);
  }

  /** End a recurring handoff for good. */
  stop(id: number): Promise<Handoff> {
    return this.call("POST", `/handoffs/${id}/stop`);
  }

  delete(id: number) {
    return this.call("DELETE", `/handoffs/${id}`);
  }

  patch(id: number, patch: Record<string, unknown>): Promise<Handoff> {
    return this.call("PATCH", `/handoffs/${id}`, patch);
  }

  /** Run the handoff CLI (fallback when the daemon is down, and for daemon install). */
  cli(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    const bin = cfg("cliPath", "handoff");
    return new Promise((resolve, reject) => {
      execFile(bin, args, { cwd, timeout: 20000, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.toString().trim() || err.message));
        else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  }
}

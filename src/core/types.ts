/**
 * Core domain types. The Handoff is the product; everything else hangs off it.
 */

export type HandoffStatus = "scheduled" | "due" | "snoozed" | "completed" | "dismissed";

export type DestinationType =
  | "url" // any http(s) link — GitHub, Stripe, Vercel, localhost…
  | "path" // a local directory, opened in the configured editor
  | "file" // a local file (optionally :line), opened in the editor
  | "vscode" // a raw vscode:// / cursor:// URI
  | "claude" // resume Claude Code in the project with the resume prompt
  | "terminal" // open a terminal in the project directory (optionally run a command)
  | "uri"; // anything else the OS knows how to open

export interface Destination {
  type: DestinationType;
  /** URL, directory, file[:line], or custom URI. For "claude"/"terminal" this is the working directory. */
  uri: string;
  label?: string;
  /** Optional shell command to run for "terminal" destinations. */
  command?: string;
}

export type AgentType = "claude" | "cursor" | "codex" | "gemini" | "copilot" | "other" | null;

export type CreatedBy = "manual" | "cli" | "claude" | "extension" | "api" | "mcp";

export interface Project {
  id: number; // displayed as P-018
  name: string;
  path: string | null;
  repo: string | null; // e.g. github.com/user/repo
  preferred_agent: AgentType;
  created_at: string;
  last_used_at: string;
}

export interface Recurrence {
  freq: "minutely" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  /** 0 = Sunday … 6 = Saturday. Used by weekly, and by monthly "first business day". */
  byWeekday?: number[];
  /** 1..31, or -1 for last day of month. */
  byMonthDay?: number;
  /** For monthly: "first" | "last" business day, or the Nth weekday (e.g. second Tuesday). */
  bySetPos?: "first" | "second" | "third" | "fourth" | "last";
  /** Month for yearly rules (1..12). */
  byMonth?: number;
  /** Local time of day. */
  hour: number;
  minute: number;
}

export interface Handoff {
  id: number;
  title: string;

  project_id: number | null;

  created_at: string;
  trigger_at: string; // ISO with offset
  timezone: string;

  recurrence: Recurrence | null;
  recurrence_label: string | null;
  status: HandoffStatus;

  next_action: string | null;
  reason_paused: string | null;
  context_summary: string | null;

  destinations: Destination[];

  repo_path: string | null;
  workspace_path: string | null;
  git_branch: string | null;
  current_file: string | null;

  agent_type: AgentType;
  resume_prompt: string | null;

  source_session_id: string | null;
  source_terminal_id: string | null;

  notification_enabled: boolean;
  created_by: CreatedBy;

  fired_at: string | null;
  notified_count: number;
  last_notified_at: string | null;
  completed_at: string | null;
  snoozed_until: string | null;
  occurrences: number;
}

export type HandoffEventKind =
  | "created"
  | "fired"
  | "notified"
  | "snoozed"
  | "completed"
  | "dismissed"
  | "opened"
  | "rescheduled"
  | "advanced"
  | "updated";

export interface HandoffEvent {
  id: number;
  handoff_id: number;
  kind: HandoffEventKind;
  detail: string | null;
  at: string;
}

export interface NewHandoffInput {
  title: string;
  /** Natural-language time ("tomorrow 10am", "in 30m"). Ignored if triggerAt given. */
  when?: string;
  triggerAt?: string | Date;
  /** Natural-language recurrence ("every Monday 9am", "weekdays", "monthly"). */
  every?: string;
  recurrence?: Recurrence;
  recurrenceLabel?: string;

  project?: string; // name; created if missing
  projectId?: number;

  nextAction?: string;
  reasonPaused?: string;
  context?: string;

  destinations?: Destination[];
  /** Shorthand: a single URL/path — type inferred. */
  destination?: string;

  repoPath?: string;
  workspacePath?: string;
  gitBranch?: string;
  currentFile?: string;

  agent?: AgentType;
  resumePrompt?: string;

  sourceSessionId?: string;
  sourceTerminalId?: string;

  notify?: boolean;
  createdBy?: CreatedBy;
}

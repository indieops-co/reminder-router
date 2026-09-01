import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { dbPath } from "./paths.js";

// Loaded through process.getBuiltinModule so bundlers/test runners that don't
// know about node:sqlite yet leave it alone. Node ≥ 22.13 ships it unflagged.
type SqliteModule = typeof import("node:sqlite");
const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as
  | SqliteModule
  | undefined;
if (!sqlite) {
  throw new Error(`Reminder Router needs Node.js 22.13 or newer (found ${process.version}) for its built-in SQLite.`);
}
const DatabaseSync = sqlite.DatabaseSync;
type DatabaseSync = DatabaseSyncType;

const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT,
    repo TEXT,
    preferred_agent TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS projects_path ON projects(path) WHERE path IS NOT NULL;
  CREATE INDEX IF NOT EXISTS projects_name ON projects(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,

    created_at TEXT NOT NULL,
    trigger_at TEXT NOT NULL,
    timezone TEXT NOT NULL,

    recurrence TEXT,
    recurrence_label TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',

    next_action TEXT,
    reason_paused TEXT,
    context_summary TEXT,

    destinations TEXT NOT NULL DEFAULT '[]',

    repo_path TEXT,
    workspace_path TEXT,
    git_branch TEXT,
    current_file TEXT,

    agent_type TEXT,
    resume_prompt TEXT,

    source_session_id TEXT,
    source_terminal_id TEXT,

    notification_enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'manual',

    fired_at TEXT,
    notified_count INTEGER NOT NULL DEFAULT 0,
    last_notified_at TEXT,
    completed_at TEXT,
    snoozed_until TEXT,
    occurrences INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS handoffs_status_trigger ON handoffs(status, trigger_at);
  CREATE INDEX IF NOT EXISTS handoffs_project ON handoffs(project_id);

  CREATE TABLE IF NOT EXISTS handoff_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handoff_id INTEGER NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS handoff_events_handoff ON handoff_events(handoff_id, at);
  `,
];

export type DB = DatabaseSync;

let shared: DatabaseSync | null = null;

export function openDb(file: string = dbPath()): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!shared) shared = openDb();
  return shared;
}

export function closeDb(): void {
  if (shared) {
    shared.close();
    shared = null;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  let version = row ? Number(row.value) : 0;
  while (version < SCHEMA_VERSION) {
    const sql = MIGRATIONS[version];
    db.exec("BEGIN");
    try {
      db.exec(sql);
      version += 1;
      db.prepare(
        `INSERT INTO meta(key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(version));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

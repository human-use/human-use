import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Durable state. The runtime only stores; judgment lives in prompts (docs/DESIGN.md §一.11).
 * Rows keep a few indexed columns and put the rest in a JSON `data` column, so the shapes can move during v0.x
 * without a migration each time.
 */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,              -- active | done | cancelled
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,               -- u_xxxxxx
  name TEXT NOT NULL UNIQUE,         -- the short name the lead gave at pairing
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  unit_id TEXT,                      -- whose phone the card goes to; null for goal checks
  tool TEXT NOT NULL,
  status TEXT NOT NULL,              -- see JobStatus in runtime.ts
  priority TEXT NOT NULL,            -- opportunistic | standard | preempt
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  send_at TEXT,                      -- scheduled jobs wait for this
  due_at TEXT,                       -- open jobs expire at this
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  job_id TEXT,
  outcome TEXT,
  response TEXT
);
CREATE INDEX IF NOT EXISTS calls_job ON calls(job_id);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  next_at TEXT NOT NULL,
  every_s INTEGER NOT NULL,
  active INTEGER NOT NULL,
  data TEXT NOT NULL                 -- the tool call to repeat
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  goal_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ref ON events(ref);
CREATE INDEX IF NOT EXISTS events_goal ON events(goal_id, seq);
CREATE TABLE IF NOT EXISTS inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  deliver_at TEXT NOT NULL,
  delivered_at TEXT,
  goal_id TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  at TEXT NOT NULL,
  why TEXT NOT NULL,
  fired_at TEXT,
  replaced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS wakes_due ON wakes(fired_at, at);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  goal_id TEXT,
  job_id TEXT,
  amount_minor INTEGER NOT NULL,     -- integer minor units; never floats for money
  currency TEXT NOT NULL,
  memo TEXT NOT NULL,
  evidence_id TEXT
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  goal_id TEXT,
  job_id TEXT,
  level INTEGER NOT NULL,            -- 1 runtime-held … 6 self-report
  kind TEXT NOT NULL,
  path TEXT,
  data TEXT NOT NULL
);
`;

export type Row = Record<string, SQLInputValue>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version > SCHEMA_VERSION) throw new Error(`runtime.sqlite is schema ${user_version}; this build knows ${SCHEMA_VERSION}. Upgrade human-use.`);
    this.db.exec(SCHEMA);
    // Schema 1 had one unit and no unit column. The daemon assigns those jobs to the unit it migrates them to.
    if (!this.all<{ name: string }>("PRAGMA table_info(jobs)").some(column => column.name === "unit_id")) this.db.exec("ALTER TABLE jobs ADD COLUMN unit_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS jobs_unit ON jobs(unit_id, status)");
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  tables(): string[] {
    return this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => row.name);
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { lastInsertRowid: number | bigint; changes: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  insert(table: string, row: Row): void {
    const keys = Object.keys(row);
    this.run(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map(key => row[key]!));
  }

  update(table: string, id: string, row: Row): void {
    const keys = Object.keys(row);
    this.run(`UPDATE ${table} SET ${keys.map(key => `${key} = ?`).join(", ")} WHERE id = ?`, ...keys.map(key => row[key]!), id);
  }

  event(at: string, kind: string, ref: string | null, goalId: string | null, data: unknown = {}): void {
    this.run("INSERT INTO events (at, kind, ref, goal_id, data) VALUES (?, ?, ?, ?, ?)", at, kind, ref, goalId, JSON.stringify(data));
  }

  private depth = 0;

  /** Run `fn` in one transaction. Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}

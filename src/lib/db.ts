import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

export interface TaskRow {
  id: string;
  prompt: string;
  title: string | null;
  plan_json: string | null;
  plan_source: string | null;
  notes_json: string | null;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  result_json: string | null;
  stdout: string | null;
  stderr: string | null;
  command_json: string | null;
  validation: string | null;
  message: string | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  title TEXT,
  plan_json TEXT,
  plan_source TEXT,
  notes_json TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,
  exit_code INTEGER,
  result_json TEXT,
  stdout TEXT,
  stderr TEXT,
  command_json TEXT,
  validation TEXT,
  message TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE TABLE IF NOT EXISTS task_events (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
`;

type G = typeof globalThis & { __taskforgeDb?: Database.Database };

export function openDb(file: string): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Anything still marked in-flight belongs to a process that no longer exists.
  db.prepare(
    `UPDATE tasks SET status='failed', completed_at=?, error=COALESCE(error,'Interrupted: the server restarted while this task was in progress.'),
     message=COALESCE(message,'Interrupted by server restart.') WHERE status IN ('planning','running')`,
  ).run(Date.now());
  return db;
}

/** Shared handle (survives Next.js dev hot reloads). */
export function getDb(): Database.Database {
  const g = globalThis as G;
  if (!g.__taskforgeDb) g.__taskforgeDb = openDb(config.dbPath);
  return g.__taskforgeDb;
}

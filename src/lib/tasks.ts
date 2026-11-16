import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { config } from "./config";
import { getDb, type TaskRow } from "./db";
import { interpretRequest, PromptError, type InterpretOptions } from "./intent";
import { approvePlan, PlanRejected } from "./plan";
import { classifyRun, parseCrawlOutput, runCrawler, type RunOptions, type RunOutcome } from "./runner";
import {
  STAGES, type CrawlResult, type StageId, type StageStatus, type TaskEvent, type TaskEventInput, type TaskPlan, type TaskStatus,
} from "./schema";
import type { UrlCheckOptions } from "./url";

/* ------------------------------------------------------------------ */
/* Types shared with the UI                                            */
/* ------------------------------------------------------------------ */
export interface TaskView {
  id: string;
  prompt: string;
  title: string | null;
  status: TaskStatus;
  plan: TaskPlan | null;
  planSource: string | null;
  notes: string[];
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  message: string | null;
  error: string | null;
  validation: string | null;
  command: string[] | null;
}

export interface TaskResultView {
  id: string;
  status: TaskStatus;
  result: CrawlResult | null;
  /** raw stdout only when it was NOT valid JSON (otherwise it equals `result`) */
  invalidStdout: string | null;
  stderr: string | null;
  command: string[] | null;
  exitCode: number | null;
  durationMs: number | null;
  validation: string | null;
  message: string | null;
}

export interface TaskDeps {
  db?: Database.Database;
  intent?: InterpretOptions;
  url?: UrlCheckOptions;
  run?: Partial<Pick<RunOptions, "extraEnv" | "pythonBin" | "timeoutMs" | "killGraceMs" | "maxOutputBytes">>;
}

const TERMINAL: TaskStatus[] = ["rejected", "success", "partial", "failed", "timeout", "cancelled"];
export const isTerminal = (s: string) => (TERMINAL as string[]).includes(s);

/* ------------------------------------------------------------------ */
/* Event bus: persisted (so history can replay) + live subscribers      */
/* ------------------------------------------------------------------ */
type Listener = (e: TaskEvent) => void;
interface Bus { seq: number; listeners: Set<Listener> }
type G = typeof globalThis & { __tfBus?: Map<string, Bus>; __tfRunning?: Map<string, AbortController> };
const g = globalThis as G;
const buses = (g.__tfBus ??= new Map());
const running = (g.__tfRunning ??= new Map());

function bus(db: Database.Database, id: string): Bus {
  let b = buses.get(id);
  if (!b) {
    const row = db.prepare("SELECT COALESCE(MAX(seq),-1) AS m FROM task_events WHERE task_id=?").get(id) as { m: number };
    b = { seq: row.m + 1, listeners: new Set() };
    buses.set(id, b);
  }
  return b;
}

export function emit(id: string, input: TaskEventInput, deps: TaskDeps = {}): TaskEvent {
  const db = deps.db ?? getDb();
  const b = bus(db, id);
  const event = { ...input, seq: b.seq++, ts: Date.now() } as TaskEvent;
  db.prepare("INSERT INTO task_events (task_id, seq, ts, payload) VALUES (?,?,?,?)").run(id, event.seq, event.ts, JSON.stringify(event));
  for (const l of b.listeners) {
    try { l(event); } catch { /* a dead SSE client must not break execution */ }
  }
  return event;
}

export function readEvents(id: string, after = -1, deps: TaskDeps = {}): TaskEvent[] {
  const db = deps.db ?? getDb();
  return (db.prepare("SELECT payload FROM task_events WHERE task_id=? AND seq>? ORDER BY seq").all(id, after) as { payload: string }[]).map((r) => JSON.parse(r.payload));
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function subscribe(id: string, fn: Listener, deps: TaskDeps = {}): () => void {
  const b = bus(deps.db ?? getDb(), id);
  b.listeners.add(fn);
  return () => { b.listeners.delete(fn); if (!b.listeners.size && !running.has(id)) buses.delete(id); };
}

const stage = (id: string, s: StageId, status: StageStatus, detail?: string, deps?: TaskDeps) =>
  emit(id, { type: "stage", stage: s, status, detail }, deps);

/* ------------------------------------------------------------------ */
/* Row mapping                                                          */
/* ------------------------------------------------------------------ */
const json = <T>(s: string | null): T | null => { try { return s ? (JSON.parse(s) as T) : null; } catch { return null; } };

export function toView(r: TaskRow): TaskView {
  return {
    id: r.id, prompt: r.prompt, title: r.title, status: r.status as TaskStatus,
    plan: json<TaskPlan>(r.plan_json), planSource: r.plan_source, notes: json<string[]>(r.notes_json) ?? [],
    createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at, durationMs: r.duration_ms,
    exitCode: r.exit_code, message: r.message, error: r.error, validation: r.validation, command: json<string[]>(r.command_json),
  };
}

const row = (db: Database.Database, id: string) => db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;

export function getTask(id: string, deps: TaskDeps = {}): TaskView | null {
  const r = row(deps.db ?? getDb(), id);
  return r ? toView(r) : null;
}

export function getResult(id: string, deps: TaskDeps = {}): TaskResultView | null {
  const r = row(deps.db ?? getDb(), id);
  if (!r) return null;
  return {
    id: r.id, status: r.status as TaskStatus, result: json<CrawlResult>(r.result_json), invalidStdout: r.stdout,
    stderr: r.stderr, command: json<string[]>(r.command_json), exitCode: r.exit_code, durationMs: r.duration_ms,
    validation: r.validation, message: r.message,
  };
}

export function listHistory(limit = 50, query = "", deps: TaskDeps = {}): TaskView[] {
  const db = deps.db ?? getDb();
  const lim = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
  const rows = query.trim()
    ? (db.prepare("SELECT * FROM tasks WHERE prompt LIKE ? OR title LIKE ? ORDER BY created_at DESC LIMIT ?").all(`%${query.trim()}%`, `%${query.trim()}%`, lim) as TaskRow[])
    : (db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(lim) as TaskRow[]);
  return rows.map(toView);
}

/* ------------------------------------------------------------------ */
/* Planning (stages 1-3). Nothing is executed here.                     */
/* ------------------------------------------------------------------ */
export async function createTask(prompt: string, deps: TaskDeps = {}): Promise<TaskView> {
  const db = deps.db ?? getDb();
  const text = (prompt ?? "").trim();
  if (!text) throw new PromptError("Please describe what you want TaskForge to do.");
  if (text.length > config.maxPromptChars) throw new PromptError(`Request is too long (max ${config.maxPromptChars} characters).`);

  const id = crypto.randomUUID();
  db.prepare("INSERT INTO tasks (id, prompt, title, status, created_at) VALUES (?,?,?,?,?)").run(id, text, text.slice(0, 60), "planning", Date.now());
  const finish = (status: TaskStatus, message: string, extra: Partial<{ error: string; title: string }> = {}) => {
    db.prepare("UPDATE tasks SET status=?, message=?, error=?, completed_at=?, title=COALESCE(?, title) WHERE id=?")
      .run(status, message, extra.error ?? null, Date.now(), extra.title ?? null, id);
    emit(id, { type: "done", status, message }, deps);
  };

  try {
    stage(id, 1, "running", "Reading your request", deps);
    const interp = await interpretRequest(text, deps.intent);
    db.prepare("UPDATE tasks SET plan_source=?, notes_json=? WHERE id=?").run(interp.source, JSON.stringify(interp.notes), id);
    stage(id, 1, "done", `Interpreted by ${interp.source}`, deps);

    stage(id, 2, "running", "Building a structured plan", deps);
    if (interp.intent.taskType === "UNSUPPORTED") {
      stage(id, 2, "error", "Unsupported task", deps);
      finish("rejected", interp.intent.reason, { error: "UNSUPPORTED_TASK" });
      return getTask(id, deps)!;
    }
    const plan = interp.intent;
    stage(id, 2, "done", `${plan.taskType} · ${plan.maxPages} pages · depth ${plan.maxDepth}`, deps);

    stage(id, 3, "running", `Checking ${plan.url}`, deps);
    let approved;
    try {
      approved = await approvePlan(plan, deps.url);
    } catch (e) {
      if (e instanceof PlanRejected) {
        stage(id, 3, "error", e.message, deps);
        // an unresolvable host is "website not reachable" rather than a rejected request
        finish(e.code === "DNS_FAILURE" ? "failed" : "rejected", e.message, { error: e.code, title: safeHost(plan.url) ?? undefined });
        return getTask(id, deps)!;
      }
      throw e;
    }
    db.prepare("UPDATE tasks SET plan_json=?, status='planned', title=? WHERE id=?").run(JSON.stringify(approved), safeHost(approved.url) ?? text.slice(0, 60), id);
    emit(id, { type: "plan", plan: approved, source: interp.source }, deps);
    stage(id, 3, "done", "URL is public and allowed", deps);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finish("failed", `Planning failed: ${msg}`, { error: "PLANNING_ERROR" });
  }
  return getTask(id, deps)!;
}

const safeHost = (u: string) => { try { return new URL(u).hostname; } catch { return null; } };

/* ------------------------------------------------------------------ */
/* Execution (stages 4-9)                                               */
/* ------------------------------------------------------------------ */
export class TaskStateError extends Error {}

/** Atomically claims a planned task; throws if it is not in the 'planned' state. */
export function claimForExecution(id: string, deps: TaskDeps = {}): TaskView {
  const db = deps.db ?? getDb();
  const res = db.prepare("UPDATE tasks SET status='running', started_at=? WHERE id=? AND status='planned'").run(Date.now(), id);
  if (res.changes !== 1) {
    const r = row(db, id);
    if (!r) throw new TaskStateError("Task not found.");
    throw new TaskStateError(`Task is '${r.status}', only a 'planned' task can be executed.`);
  }
  return getTask(id, deps)!;
}

export async function executeClaimed(id: string, deps: TaskDeps = {}): Promise<TaskView> {
  const db = deps.db ?? getDb();
  const r = row(db, id)!;
  const ctl = new AbortController();
  running.set(id, ctl);
  const finish = (status: TaskStatus, message: string, f: Partial<{ run: RunOutcome; result: string | null; stdout: string | null; validation: string; error: string }> = {}) => {
    const now = Date.now();
    db.prepare(
      `UPDATE tasks SET status=?, message=?, completed_at=?, duration_ms=?, exit_code=?, result_json=?, stdout=?, stderr=?, command_json=?, validation=?, error=? WHERE id=?`,
    ).run(
      status, message, now, f.run?.durationMs ?? now - (r.started_at ?? now), f.run?.exitCode ?? null, f.result ?? null,
      f.stdout ?? null, f.run ? f.run.stderr.slice(0, 100_000) : null, f.run ? JSON.stringify(f.run.command) : null,
      f.validation ?? null, f.error ?? null, id,
    );
    emit(id, { type: "done", status, message }, deps);
  };

  try {
    // Re-approve from the STORED plan immediately before spawning: strict schema + fresh DNS/SSRF check.
    const stored = json<unknown>(r.plan_json);
    let plan;
    try {
      plan = await approvePlan(stored, deps.url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stage(id, 4, "error", msg, deps);
      finish("rejected", msg, { error: e instanceof PlanRejected ? e.code : "PLAN_INVALID" });
      return getTask(id, deps)!;
    }

    stage(id, 4, "running", "Looking up the tool for WEBSITE_CRAWL", deps);
    stage(id, 4, "done", "taskforge-crawler (python -m crawler.cli)", deps);
    stage(id, 5, "running", "Spawning Python process (shell: false)", deps);

    let fetching = false;
    let extracting = false;
    const run = await runCrawler({
      plan,
      signal: ctl.signal,
      ...deps.run,
      onEvent: (e) => {
        if (e.type === "spawned") {
          emit(id, { type: "process", pid: e.pid, command: e.command }, deps);
          stage(id, 5, "done", `PID ${e.pid ?? "?"}`, deps);
          stage(id, 6, "running", "Waiting for the first response", deps);
          fetching = true;
        } else if (e.type === "progress") {
          emit(id, { type: "progress", event: e.event, data: e.data }, deps);
          if (e.event === "page_fetching") stage(id, 6, "running", `${e.data.index}/${e.data.max_pages} · ${e.data.url}`, deps);
          if (e.event === "page_extracted" && !extracting) { extracting = true; stage(id, 7, "running", `Extracting ${e.data.url}`, deps); }
          if (e.event === "crawl_complete") {
            stage(id, 6, "done", `${e.data.pages_crawled} fetched, ${e.data.pages_failed} failed`, deps);
            if (extracting) stage(id, 7, "done", `${e.data.total_words} words extracted`, deps); else stage(id, 7, "skipped", "No page content to extract", deps);
            fetching = false; extracting = false;
          }
        } else if (e.type === "stderr") {
          emit(id, { type: "log", stream: "stderr", line: e.line }, deps);
        }
      },
    });

    // Close any stage left open if the process ended abnormally.
    if (fetching) stage(id, 6, run.reason === "exited" ? "done" : "error", run.reason === "exited" ? undefined : `Stopped: ${run.reason}`, deps);
    if (extracting) stage(id, 7, run.reason === "exited" ? "done" : "error", undefined, deps);

    if (run.reason === "cancelled") {
      const c = classifyRun(run, null);
      finish("cancelled", c.message, { run, validation: c.validation });
      return getTask(id, deps)!;
    }

    stage(id, 8, "running", "Parsing stdout and validating against the schema", deps);
    const exited = run.reason === "exited";
    const parsed = exited ? parseCrawlOutput(run.stdout) : null;
    const cls = classifyRun(run, parsed);
    if (exited && parsed?.ok) stage(id, 8, "done", "stdout is valid JSON matching the schema", deps);
    else if (exited) stage(id, 8, "error", parsed && !parsed.ok ? parsed.error : "No output", deps);
    else stage(id, 8, "skipped", `Process ended early: ${run.reason}`, deps);

    stage(id, 9, "running", "Composing the result", deps);
    const status = cls.status as TaskStatus;
    const usable = status === "success" || status === "partial";
    stage(id, 9, usable ? "done" : "error", cls.message, deps);
    // 'done' is emitted last (inside finish) so SSE clients see every stage first
    finish(status, cls.message, {
      run,
      validation: exited ? cls.validation : "not_run",
      result: exited && parsed?.ok ? run.stdout.trim() : null,
      stdout: exited && parsed?.ok ? null : run.stdout.slice(0, 100_000),
      error: usable ? undefined : cls.message,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finish("failed", `Execution error: ${msg}`, { error: "EXECUTION_ERROR" });
  } finally {
    running.delete(id);
  }
  return getTask(id, deps)!;
}

export function cancelTask(id: string): boolean {
  const ctl = running.get(id);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

export const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

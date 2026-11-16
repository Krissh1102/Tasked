"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskEvent, TaskStatus, StageId, StageStatus } from "./schema";
import type { TaskResultView, TaskView } from "./tasks";

export type { TaskEvent, TaskResultView, TaskView, TaskStatus };

export interface AppStatus {
  aiProvider: "gemini" | "openai" | "heuristic";
  privateNetworkOverride: boolean;
  execTimeoutMs: number;
}

export async function createTask(prompt: string): Promise<TaskView> {
  const r = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Could not create the task.");
  return j;
}

export async function fetchHistory(q = ""): Promise<TaskView[]> {
  const r = await fetch(`/api/tasks/history?limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" });
  return r.ok ? (await r.json()).tasks : [];
}

export interface StageState { status: StageStatus | "pending"; detail?: string; ts?: number }

/** Everything the UI needs for one task, derived from real server events. */
export interface Snapshot {
  id: string;
  task: TaskView | null;
  events: TaskEvent[];
  result: TaskResultView | null;
  stages: Record<StageId, StageState>;
  pages: { url: string; status: "fetching" | "ok" | "failed"; detail?: string }[];
  stderrLines: string[];
  command: string[] | null;
  pid?: number;
  live: boolean;
  error: string | null;
}

const EMPTY_STAGES = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, { status: "pending" }])) as Record<StageId, StageState>;

export function derive(id: string, task: TaskView | null, events: TaskEvent[], result: TaskResultView | null, error: string | null): Snapshot {
  const stages = { ...EMPTY_STAGES };
  const pageMap = new Map<string, Snapshot["pages"][number]>();
  const stderrLines: string[] = [];
  let command: string[] | null = null;
  let pid: number | undefined;
  let done = false;
  for (const e of events) {
    if (e.type === "stage") stages[e.stage] = { status: e.status, detail: e.detail, ts: e.ts };
    else if (e.type === "process") { command = e.command; pid = e.pid; }
    else if (e.type === "log") stderrLines.push(e.line);
    else if (e.type === "done") done = true;
    else if (e.type === "progress") {
      const d = e.data as Record<string, unknown>;
      const url = String(d.url ?? "");
      if (e.event === "page_fetching") pageMap.set(url, { url, status: "fetching" });
      if (e.event === "page_extracted") pageMap.set(url, { url, status: "ok", detail: `${d.words} words` });
      if (e.event === "page_failed") pageMap.set(url, { url, status: "failed", detail: String(d.error ?? d.code ?? "") });
      if (e.event === "robots_blocked") pageMap.set(url, { url, status: "failed", detail: "blocked by robots.txt" });
    }
  }
  return {
    id, task, events, result, stages, pages: [...pageMap.values()],
    stderrLines: result?.stderr ? result.stderr.split("\n").filter(Boolean) : stderrLines,
    command: result?.command ?? command, pid, live: !done, error,
  };
}

export function useTaskStream(id: string, opts: { autoRun: boolean; onFinished?: () => void }): { snap: Snapshot; execute: () => Promise<void>; cancel: () => Promise<void> } {
  const [task, setTask] = useState<TaskView | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [result, setResult] = useState<TaskResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const autoRun = useRef(opts.autoRun);
  const onFinished = useRef(opts.onFinished);
  onFinished.current = opts.onFinished;

  const refresh = useCallback(async () => {
    const [t, r] = await Promise.all([fetch(`/api/tasks/${id}`, { cache: "no-store" }), fetch(`/api/tasks/${id}/result`, { cache: "no-store" })]);
    if (t.ok) setTask(await t.json());
    if (r.ok) setResult(await r.json());
  }, [id]);

  const execute = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    const r = await fetch(`/api/tasks/${id}/execute`, { method: "POST" });
    if (!r.ok) {
      started.current = false;
      setError((await r.json().catch(() => ({}))).error ?? "Could not start execution.");
    } else void refresh();
  }, [id, refresh]);

  const cancel = useCallback(async () => {
    await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
  }, [id]);

  useEffect(() => {
    void refresh();
    const es = new EventSource(`/api/tasks/${id}/events`);
    es.addEventListener("task", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as TaskEvent;
      setEvents((prev) => (prev.some((x) => x.seq === e.seq) ? prev : [...prev, e]));
      if (e.type === "plan") void refresh().then(() => { if (autoRun.current) void execute(); });
      if (e.type === "stage" && e.stage >= 4 && e.status === "running") void refresh();
      if (e.type === "done") {
        es.close();
        void refresh().then(() => onFinished.current?.());
      }
    });
    return () => es.close();
  }, [id, refresh, execute]);

  const snap = useMemo(() => derive(id, task, events, result, error), [id, task, events, result, error]);
  return { snap, execute, cancel };
}

export function useAppStatus(): AppStatus | null {
  const [s, setS] = useState<AppStatus | null>(null);
  useEffect(() => { void fetch("/api/status").then((r) => r.json()).then(setS).catch(() => setS(null)); }, []);
  return s;
}

export function useNow(active: boolean, every = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

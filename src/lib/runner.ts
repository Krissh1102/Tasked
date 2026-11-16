import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config";
import { CrawlResultSchema, type ApprovedPlan, type CrawlResult } from "./schema";

export const EVENT_PREFIX = "@@TASKFORGE@@ ";
const MAX_STDERR_BYTES = 256_000;

/** Argument vector for `python -m crawler.cli` — pure, no shell, no interpolation. */
export function buildCliArgs(plan: ApprovedPlan): string[] {
  if (!/^https?:\/\//i.test(plan.url)) throw new Error("buildCliArgs: refusing a non-http(s) URL");
  if (!Number.isInteger(plan.maxPages) || !Number.isInteger(plan.maxDepth)) throw new Error("buildCliArgs: non-integer limits");
  return [
    "-m", "crawler.cli",
    "--url", plan.url,
    "--max-pages", String(plan.maxPages),
    "--max-depth", String(plan.maxDepth),
    "--output", "json",
  ];
}

/** Minimal allow-listed environment: no API keys, no inherited secrets. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const k of keep) { const v = process.env[k]; if (v) env[k] = v; }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONDONTWRITEBYTECODE = "1";
  // The only application variable forwarded to the child: the explicit, off-by-default demo switch.
  if (process.env.TASKFORGE_UNSAFE_ALLOW_PRIVATE === "1") env.TASKFORGE_UNSAFE_ALLOW_PRIVATE = "1";
  return { ...env, ...extra };
}

export type RunReason = "exited" | "timeout" | "cancelled" | "output_limit" | "spawn_error";

export interface RunOutcome {
  reason: RunReason;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  /** executable + args exactly as spawned */
  command: string[];
  pid?: number;
  error?: string;
}

export type RunnerEvent =
  | { type: "spawned"; pid?: number; command: string[] }
  | { type: "progress"; event: string; data: Record<string, unknown> }
  | { type: "stderr"; line: string };

export interface RunOptions {
  plan: ApprovedPlan;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onEvent?: (e: RunnerEvent) => void;
  pythonBin?: string;
  engineDir?: string;
  killGraceMs?: number;
  /** extra environment for the child (tests only; never contains secrets) */
  extraEnv?: Record<string, string>;
  /** replace the module/args (tests only, e.g. to run a deliberately misbehaving script) */
  argsOverride?: string[];
}

export function runCrawler(opts: RunOptions): Promise<RunOutcome> {
  const pythonBin = opts.pythonBin ?? config.pythonBin;
  const timeoutMs = opts.timeoutMs ?? config.execTimeoutMs;
  const maxOut = opts.maxOutputBytes ?? config.maxOutputBytes;
  const grace = opts.killGraceMs ?? config.killGraceMs;
  const args = opts.argsOverride ?? buildCliArgs(opts.plan);
  const command = [pythonBin, ...args];
  const started = Date.now();

  return new Promise<RunOutcome>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let reason: RunReason = "exited";
    let error: string | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let terminating = false;
    let stderrBuf = "";
    let child: ChildProcess | undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (stderrBuf) handleLine(stderrBuf);
      resolve({
        reason, exitCode, signal, error,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        stdoutTruncated, stderrTruncated,
        durationMs: Date.now() - started,
        command, pid: child?.pid,
      });
    };

    // SIGTERM first, SIGKILL if the process has not exited after the grace period.
    const terminate = (why: RunReason) => {
      if (settled || terminating || !child) return;
      terminating = true;
      reason = why;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* gone */ } }, grace);
    };

    const handleLine = (line: string) => {
      if (!line) return;
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          const { event, ...data } = JSON.parse(line.slice(EVENT_PREFIX.length));
          opts.onEvent?.({ type: "progress", event: String(event), data });
          return;
        } catch { /* fall through: show as plain stderr */ }
      }
      opts.onEvent?.({ type: "stderr", line });
    };

    let proc: ChildProcess;
    try {
      proc = spawn(pythonBin, args, {
        cwd: opts.engineDir ?? config.engineDir,
        shell: false,
        env: childEnv(opts.extraEnv) as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      reason = "spawn_error";
      error = (e as Error).message;
      return finish(null, null);
    }
    child = proc;

    timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const onAbort = () => terminate("cancelled");
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    opts.onEvent?.({ type: "spawned", pid: proc.pid, command });

    proc.stdout!.on("data", (chunk: Buffer) => {
      if (outBytes >= maxOut) return;
      const room = maxOut - outBytes;
      if (chunk.length > room) {
        out.push(chunk.subarray(0, room));
        outBytes = maxOut;
        stdoutTruncated = true;
        terminate("output_limit");
      } else {
        out.push(chunk);
        outBytes += chunk.length;
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      if (errBytes < MAX_STDERR_BYTES) {
        const room = MAX_STDERR_BYTES - errBytes;
        err.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        errBytes += Math.min(chunk.length, room);
        if (chunk.length > room) stderrTruncated = true;
      }
      stderrBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stderrBuf.indexOf("\n")) !== -1) {
        handleLine(stderrBuf.slice(0, nl).replace(/\r$/, ""));
        stderrBuf = stderrBuf.slice(nl + 1);
      }
      if (stderrBuf.length > 64_000) stderrBuf = ""; // pathological unterminated line
    });

    proc.on("error", (e) => {
      reason = "spawn_error";
      error = e.message;
      finish(null, null);
    });
    proc.on("close", (code, signal) => finish(code, signal));
  });
}

/* ---------------- output parsing & classification ---------------- */

export type ParseOutcome =
  | { ok: true; data: CrawlResult }
  | { ok: false; error: string };

/** Parse the JSON the Python process actually emitted and validate it against the schema. */
export function parseCrawlOutput(stdout: string): ParseOutcome {
  const text = stdout.trim();
  if (!text) return { ok: false, error: "The CLI produced no output on stdout." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `stdout is not valid JSON: ${(e as Error).message}` };
  }
  const parsed = CrawlResultSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: `JSON failed schema validation at "${i.path.join(".") || "root"}": ${i.message}` };
  }
  return { ok: true, data: parsed.data };
}

export type FinalStatus = "success" | "partial" | "failed" | "timeout" | "cancelled";

export interface Classification {
  status: FinalStatus;
  message: string;
  validation: "valid" | "invalid" | "not_run";
}

/** Combine process outcome + parsed JSON into one honest final verdict. */
export function classifyRun(run: RunOutcome, parsed: ParseOutcome | null): Classification {
  if (run.reason === "timeout")
    return { status: "timeout", message: `The crawler exceeded the ${Math.round(run.durationMs / 1000)}s execution limit and was terminated.`, validation: parsed ? (parsed.ok ? "valid" : "invalid") : "not_run" };
  if (run.reason === "cancelled")
    return { status: "cancelled", message: "Execution was cancelled and the process was terminated.", validation: "not_run" };
  if (run.reason === "output_limit")
    return { status: "failed", message: "The crawler output exceeded the size limit and was terminated.", validation: "not_run" };
  if (run.reason === "spawn_error")
    return { status: "failed", message: `Could not launch the Python process: ${run.error ?? "unknown error"}`, validation: "not_run" };

  if (!parsed || !parsed.ok)
    return {
      status: "failed",
      message: parsed && !parsed.ok ? parsed.error : "No result was produced.",
      validation: "invalid",
    };
  const d = parsed.data;
  if (d.status === "failure")
    return { status: "failed", message: d.error?.message ?? "The crawl failed.", validation: "valid" };
  if (run.exitCode !== 0)
    return { status: "failed", message: `The process exited with code ${run.exitCode} despite producing output.`, validation: "valid" };
  if (d.status === "partial")
    return { status: "partial", message: `${d.stats.pages_crawled} page(s) crawled, ${d.stats.pages_failed} failed.`, validation: "valid" };
  return { status: "success", message: `${d.stats.pages_crawled} page(s) crawled successfully.`, validation: "valid" };
}

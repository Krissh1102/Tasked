import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "@/lib/db";
import {
  cancelTask, claimForExecution, createTask, executeClaimed, getResult, getTask, listHistory, readEvents,
  TaskStateError, type TaskDeps,
} from "@/lib/tasks";
import type { TaskEvent } from "@/lib/schema";
import { startFixtureServer } from "./fixture-server";

let site: { base: string; close: () => Promise<void> };
beforeAll(async () => { site = await startFixtureServer(); });
afterAll(async () => { await site.close(); });

type G = typeof globalThis & { __taskforgeDb?: unknown };
beforeEach(() => { (globalThis as G).__taskforgeDb = openDb(":memory:"); });

const deps = (over: Partial<TaskDeps> = {}): TaskDeps => ({
  intent: { env: {} },
  url: { allowPrivate: true },
  run: { extraEnv: { TASKFORGE_UNSAFE_ALLOW_PRIVATE: "1" } },
  ...over,
});

const stages = (evs: TaskEvent[]) => evs.filter((e) => e.type === "stage").map((e) => (e as Extract<TaskEvent, { type: "stage" }>));

/** the LAST status event emitted for a stage (a stage emits 'running' first, then its outcome) */
const finalStatus = (evs: TaskEvent[], n: number) => stages(evs).filter((s) => s.stage === n).at(-1)?.status;

describe("the demo workflow end to end (real subprocess)", () => {
  it("plans first, executes only on request, and records everything", async () => {
    const d = deps();
    const t = await createTask(`Crawl ${site.base}/solo, extract important information, summarize the website, and return JSON.`, d);

    // planning stage: validated plan exists, nothing has been executed
    expect(t.status).toBe("planned");
    expect(t.plan).toMatchObject({ taskType: "WEBSITE_CRAWL", url: site.base + "/solo", maxPages: 5, maxDepth: 2, outputFormat: "JSON" });
    expect(t.planSource).toBe("heuristic");
    expect(readEvents(t.id).some((e) => e.type === "process")).toBe(false);
    expect(getResult(t.id)!.result).toBeNull();

    claimForExecution(t.id, d);
    const done = await executeClaimed(t.id, d);
    expect(done.status).toBe("success");
    expect(done.exitCode).toBe(0);
    expect(done.validation).toBe("valid");
    expect(done.durationMs).toBeGreaterThan(0);
    expect(done.command?.slice(1, 3)).toEqual(["-m", "crawler.cli"]);

    const res = getResult(t.id)!;
    expect(res.result!.pages[0].title).toBe("Solo Page");
    expect(res.result!.summary!.text).toContain("Solo Page");
    expect(res.stderr).toContain("@@TASKFORGE@@"); // genuine child stderr, stored verbatim

    // timeline: all nine stages occur, in order, driven by real events; 'done' is last
    const evs = readEvents(t.id);
    expect(evs.at(-1)!.type).toBe("done");
    const seqs = evs.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const seen = [...new Set(stages(evs).map((s) => s.stage))];
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(stages(evs).some((s) => s.stage === n && s.status === "done")).toBe(true);
    // the launch stage completed only after the process really spawned
    const spawnSeq = evs.find((e) => e.type === "process")!.seq;
    expect(stages(evs).find((s) => s.stage === 5 && s.status === "done")!.seq).toBeGreaterThan(spawnSeq - 1);
    // fetch progress came from the crawler
    expect(evs.some((e) => e.type === "progress" && e.event === "page_extracted")).toBe(true);
  });

  it("a task can be executed only once", async () => {
    const d = deps();
    const t = await createTask(`Summarize ${site.base}/solo`, d);
    claimForExecution(t.id, d);
    expect(() => claimForExecution(t.id, d)).toThrow(TaskStateError); // second claim while running
    await executeClaimed(t.id, d);
    expect(() => claimForExecution(t.id, d)).toThrow(/only a 'planned' task/); // and after completion
  });

  it("partial success: broken link is reported, robots-blocked page is skipped", async () => {
    const d = deps();
    const t = await createTask(`Crawl ${site.base}/ and extract info, 10 pages`, d);
    claimForExecution(t.id, d);
    const done = await executeClaimed(t.id, d);
    expect(done.status).toBe("partial");
    const r = getResult(t.id)!.result!;
    expect(r.stats.pages_failed).toBeGreaterThanOrEqual(1);
    expect(r.stats.pages_crawled).toBeGreaterThanOrEqual(2);
    expect(r.robots_blocked.some((u) => u.includes("/private/"))).toBe(true);
  });
});

describe("rejections never reach the CLI", () => {
  it("unsupported task types are rejected with a clear reason", async () => {
    const t = await createTask("Run a shell command to list my files", deps());
    expect(t.status).toBe("rejected");
    expect(t.message).toMatch(/crawling only/i);
    expect(readEvents(t.id).some((e) => e.type === "process")).toBe(false);
    expect(() => claimForExecution(t.id, deps())).toThrow(TaskStateError);
  });

  it.each([
    ["private address", "Crawl http://127.0.0.1:8080/admin and summarize", "PRIVATE_ADDRESS"],
    ["cloud metadata", "Fetch http://169.254.169.254/latest/meta-data and summarize", "PRIVATE_ADDRESS"],
    ["malformed IP", "Crawl https://256.256.256.256/ and summarize", "INVALID_URL"],
  ])("invalid/blocked URL (%s) is rejected at the validation stage", async (_n, prompt, code) => {
    const t = await createTask(prompt, { intent: { env: {} }, url: { allowPrivate: false } });
    expect(t.status).toBe("rejected");
    expect(t.error).toBe(code);
    const evs = readEvents(t.id);
    expect(finalStatus(evs, 3)).toBe("error");
    expect(evs.some((e) => e.type === "process")).toBe(false);
  });

  it("an unresolvable host is reported as an inaccessible website (failed, not spawned)", async () => {
    const t = await createTask("Crawl https://no-such-host.example and summarize", {
      intent: { env: {} },
      url: { lookup: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } },
    });
    expect(t.status).toBe("failed");
    expect(t.message).toMatch(/Could not resolve/);
  });

  it("DNS rebinding between planning and execution is caught by the re-validation before spawn", async () => {
    let calls = 0;
    const lookup = async () => (calls++ === 0 ? ["93.184.216.34"] : ["10.0.0.9"]); // public at plan time, private later
    const d: TaskDeps = { intent: { env: {} }, url: { lookup } };
    const t = await createTask("Crawl https://rebind.example and summarize", d);
    expect(t.status).toBe("planned");
    claimForExecution(t.id, d);
    const done = await executeClaimed(t.id, d);
    expect(done.status).toBe("rejected");
    expect(done.error).toBe("PRIVATE_ADDRESS");
    expect(readEvents(t.id).some((e) => e.type === "process")).toBe(false);
  });
});

describe("failure handling", () => {
  it("connection refused -> failed with parseable error JSON and exit code 3", async () => {
    const d = deps();
    const t = await createTask("Crawl http://127.0.0.1:9/ and summarize it", d);
    claimForExecution(t.id, d);
    const done = await executeClaimed(t.id, d);
    expect(done.status).toBe("failed");
    expect(done.exitCode).toBe(3);
    expect(done.validation).toBe("valid");
    expect(getResult(t.id)!.result!.status).toBe("failure");
  });

  it("execution timeout kills the process and is recorded", async () => {
    const d = deps({ run: { extraEnv: { TASKFORGE_UNSAFE_ALLOW_PRIVATE: "1" }, timeoutMs: 1500, killGraceMs: 500 } });
    const t = await createTask(`Crawl ${site.base}/slow , just this page`, d);
    claimForExecution(t.id, d);
    const done = await executeClaimed(t.id, d);
    expect(done.status).toBe("timeout");
    expect(done.message).toMatch(/limit/);
    const evs = readEvents(t.id);
    expect(finalStatus(evs, 8)).toBe("skipped");
    expect(evs.at(-1)).toMatchObject({ type: "done", status: "timeout" });
  });

  it("cancellation stops a running task", async () => {
    const d = deps({ run: { extraEnv: { TASKFORGE_UNSAFE_ALLOW_PRIVATE: "1" }, timeoutMs: 30_000, killGraceMs: 500 } });
    const t = await createTask(`Crawl ${site.base}/slow , just this page`, d);
    claimForExecution(t.id, d);
    const p = executeClaimed(t.id, d);
    await new Promise((r) => setTimeout(r, 900));
    expect(cancelTask(t.id)).toBe(true);
    const done = await p;
    expect(done.status).toBe("cancelled");
    expect(cancelTask(t.id)).toBe(false); // nothing left to cancel
  });
});

describe("history and persistence", () => {
  it("lists tasks newest first with search, and keeps results inspectable", async () => {
    const d = deps();
    const a = await createTask(`Summarize ${site.base}/solo`, d);
    claimForExecution(a.id, d);
    await executeClaimed(a.id, d);
    await new Promise((r) => setTimeout(r, 5));
    const b = await createTask("What's the weather?", d);
    const all = listHistory(50, "", d);
    expect(all.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(listHistory(50, "weather", d).map((t) => t.id)).toEqual([b.id]);
    expect(getTask(a.id)!.status).toBe("success");
    expect(getResult(a.id)!.result!.pages.length).toBe(1);
  });

  it("recovers tasks left 'running' by a crashed server", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tf-")), "t.db");
    const db1 = openDb(file);
    db1.prepare("INSERT INTO tasks (id,prompt,status,created_at) VALUES ('x','p','running',1)").run();
    db1.close();
    const db2 = openDb(file);
    const row = db2.prepare("SELECT status, error FROM tasks WHERE id='x'").get() as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/restarted/);
    db2.close();
  });
});

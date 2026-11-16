import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvePlan } from "@/lib/plan";
import { classifyRun, parseCrawlOutput, runCrawler, type RunnerEvent, type RunOutcome } from "@/lib/runner";
import { startFixtureServer } from "./fixture-server";

let site: { base: string; close: () => Promise<void> };
beforeAll(async () => { site = await startFixtureServer(); });
afterAll(async () => { await site.close(); });

// Test-only: lets the Python engine reach the loopback fixture server. The production runner never sets this.
const TEST_ENV = { TASKFORGE_UNSAFE_ALLOW_PRIVATE: "1" };

const plan = (path: string, maxPages = 5, maxDepth = 2) =>
  approvePlan(
    { taskType: "WEBSITE_CRAWL", url: site.base + path, actions: ["CRAWL", "EXTRACT", "SUMMARIZE"], outputFormat: "JSON", maxPages, maxDepth },
    { allowPrivate: true },
  );

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("real subprocess execution", () => {
  it("spawns the Python CLI, streams real progress, and returns schema-valid JSON (full success)", async () => {
    const events: RunnerEvent[] = [];
    const run = await runCrawler({ plan: await plan("/solo", 3, 1), extraEnv: TEST_ENV, onEvent: (e) => events.push(e) });
    expect(run.reason).toBe("exited");
    expect(run.exitCode).toBe(0);
    expect(run.command.slice(1, 5)).toEqual(["-m", "crawler.cli", "--url", site.base + "/solo"]);
    expect(run.durationMs).toBeGreaterThan(0);

    const parsed = parseCrawlOutput(run.stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.pages[0].title).toBe("Solo Page");
    expect(parsed.data.pages[0].text).toContain("single page without any outgoing links");
    expect(classifyRun(run, parsed)).toMatchObject({ status: "success", validation: "valid" });

    // progress events are genuine crawler events emitted by the child process
    const names = events.flatMap((e) => (e.type === "progress" ? [e.event] : []));
    expect(names).toEqual(expect.arrayContaining(["started", "url_validated", "robots", "page_fetching", "page_fetched", "page_extracted", "crawl_complete"]));
    expect(events[0].type).toBe("spawned");
  });

  it("reports partial success when some pages fail (404 link) and honours robots.txt", async () => {
    const run = await runCrawler({ plan: await plan("/", 10, 2), extraEnv: TEST_ENV });
    const parsed = parseCrawlOutput(run.stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.status).toBe("partial");
    expect(parsed.data.failures.some((f) => f.url.endsWith("/missing") && f.code === "HTTP_404")).toBe(true);
    expect(parsed.data.pages.map((p) => p.url)).toEqual(expect.arrayContaining([site.base + "/", site.base + "/good"]));
    expect(parsed.data.robots_blocked.some((u) => u.includes("/private/"))).toBe(true);
    expect(classifyRun(run, parsed)).toMatchObject({ status: "partial" });
  });

  it("an inaccessible website yields a failed (not crashed) run with parseable JSON and exit code 3", async () => {
    const p = await approvePlan(
      { taskType: "WEBSITE_CRAWL", url: "http://127.0.0.1:9/", actions: ["CRAWL"], outputFormat: "JSON", maxPages: 1, maxDepth: 0 },
      { allowPrivate: true },
    );
    const run = await runCrawler({ plan: p, extraEnv: TEST_ENV, timeoutMs: 20_000 });
    expect(run.exitCode).toBe(3);
    const parsed = parseCrawlOutput(run.stdout);
    expect(parsed.ok && parsed.data.status).toBe("failure");
    expect(classifyRun(run, parsed)).toMatchObject({ status: "failed" });
  });

  it("defence in depth: Python itself refuses a private target even if the TS layer was bypassed", async () => {
    // TS validation told to allow private, but the child is NOT given the override env var
    const run = await runCrawler({ plan: await plan("/solo") });
    expect(run.exitCode).toBe(2);
    const parsed = parseCrawlOutput(run.stdout);
    expect(parsed.ok && parsed.data.error?.code).toBe("PRIVATE_ADDRESS");
    expect(classifyRun(run, parsed).status).toBe("failed");
  });
});

describe("timeouts, cancellation, limits", () => {
  it("kills the process on timeout and reports it (nothing left running)", async () => {
    const run = await runCrawler({ plan: await plan("/slow", 1, 0), extraEnv: TEST_ENV, timeoutMs: 1500, killGraceMs: 500 });
    expect(run.reason).toBe("timeout");
    expect(run.durationMs).toBeLessThan(6000);
    expect(run.pid && alive(run.pid)).toBeFalsy();
    expect(classifyRun(run, null)).toMatchObject({ status: "timeout" });
  });

  it("cancels via AbortSignal and terminates the process", async () => {
    const ctl = new AbortController();
    const spawned = new Promise<void>((res) => {
      const t = setTimeout(() => ctl.abort(), 800);
      void t; res();
    });
    const p = runCrawler({ plan: await plan("/slow", 1, 0), extraEnv: TEST_ENV, signal: ctl.signal, timeoutMs: 30_000, killGraceMs: 500 });
    await spawned;
    const run = await p;
    expect(run.reason).toBe("cancelled");
    expect(run.pid && alive(run.pid)).toBeFalsy();
    expect(classifyRun(run, null).status).toBe("cancelled");
  });

  it("an already-aborted signal never lets the work proceed", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const run = await runCrawler({ plan: await plan("/slow", 1, 0), extraEnv: TEST_ENV, signal: ctl.signal, killGraceMs: 300 });
    expect(run.reason).toBe("cancelled");
  });

  it("caps captured stdout and terminates a runaway producer", async () => {
    const run = await runCrawler({
      plan: await plan("/solo"),
      argsOverride: ["-c", "import sys\nwhile True:\n    sys.stdout.write('x'*65536)\n    sys.stdout.flush()"],
      maxOutputBytes: 200_000, killGraceMs: 500, timeoutMs: 20_000,
    });
    expect(run.reason).toBe("output_limit");
    expect(run.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(200_000);
    expect(classifyRun(run, null).status).toBe("failed");
  });

  it("a missing interpreter is a clean spawn_error, not an unhandled exception", async () => {
    const run = await runCrawler({ plan: await plan("/solo"), pythonBin: "definitely-not-a-real-python-binary" });
    expect(run.reason).toBe("spawn_error");
    expect(classifyRun(run, null)).toMatchObject({ status: "failed" });
  });
});

describe("process hygiene", () => {
  it("does not leak parent environment variables / secrets into the child", async () => {
    process.env.GEMINI_API_KEY = "sk-super-secret-test-value";
    process.env.OPENAI_API_KEY = "sk-another-secret";
    try {
      const run = await runCrawler({
        plan: await plan("/solo"),
        argsOverride: ["-c", "import os,json;print(json.dumps(sorted(os.environ)))"],
      });
      const names: string[] = JSON.parse(run.stdout);
      expect(names).not.toContain("GEMINI_API_KEY");
      expect(names).not.toContain("OPENAI_API_KEY");
      expect(run.stdout).not.toContain("sk-super-secret");
    } finally {
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("passes shell metacharacters through literally (shell: false)", async () => {
    const nasty = "https://example.com/a; touch /tmp/taskforge_pwned $(id) `id` | cat";
    const run = await runCrawler({
      plan: await plan("/solo"),
      argsOverride: ["-c", "import sys,json;print(json.dumps(sys.argv[1:]))", nasty],
    });
    expect(JSON.parse(run.stdout)).toEqual([nasty]);
  });
});

describe("output parsing / failure handling", () => {
  it.each([
    ["empty output", "", /no output/],
    ["not JSON", "<html>oops</html>", /not valid JSON/],
    ["wrong shape", JSON.stringify({ status: "success" }), /schema validation/],
  ])("rejects %s", (_n, stdout, re) => {
    const r = parseCrawlOutput(stdout);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });

  it("classifies garbage output from a clean exit as failed/invalid", () => {
    const run: RunOutcome = { reason: "exited", exitCode: 0, signal: null, stdout: "nope", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 5, command: ["python"] };
    expect(classifyRun(run, parseCrawlOutput("nope"))).toMatchObject({ status: "failed", validation: "invalid" });
  });
});

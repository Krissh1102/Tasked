import { describe, expect, it } from "vitest";
import { validateTargetUrl, isPublicIp } from "@/lib/url";
import { approvePlan, PlanRejected } from "@/lib/plan";
import { TaskPlanSchema, IntentSchema } from "@/lib/schema";
import { buildCliArgs } from "@/lib/runner";

const publicLookup = async () => ["93.184.216.34"];

describe("isPublicIp", () => {
  it.each([
    ["93.184.216.34", true], ["8.8.8.8", true], ["2606:4700:4700::1111", true],
    ["127.0.0.1", false], ["10.0.0.1", false], ["172.20.1.1", false], ["192.168.0.1", false],
    ["169.254.169.254", false], ["100.64.0.1", false], ["0.0.0.0", false],
    ["::1", false], ["fe80::1", false], ["fd00::1", false], ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true], ["garbage", false],
  ])("%s -> %s", (ip, expected) => expect(isPublicIp(ip)).toBe(expected));
});

describe("validateTargetUrl", () => {
  it("accepts a normal https URL and normalises it", async () => {
    const r = await validateTargetUrl("https://Example.com/path#frag", { lookup: publicLookup });
    expect(r).toMatchObject({ ok: true, url: "https://example.com/path", host: "example.com" });
  });

  it.each([
    ["", "INVALID_URL"],
    ["example.com", "INVALID_URL"],
    ["not a url", "INVALID_URL"],
    ["ftp://example.com", "UNSUPPORTED_SCHEME"],
    ["file:///etc/passwd", "UNSUPPORTED_SCHEME"],
    ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
    ["http://user:pw@example.com", "CREDENTIALS_NOT_ALLOWED"],
    ["http://localhost:3000", "BLOCKED_HOST"],
    ["http://api.internal/", "BLOCKED_HOST"],
    ["http://127.0.0.1/", "PRIVATE_ADDRESS"],
    ["http://2130706433/", "PRIVATE_ADDRESS"],
    ["http://0x7f.1/", "PRIVATE_ADDRESS"],
    ["http://[::1]/", "PRIVATE_ADDRESS"],
    ["http://[::ffff:7f00:1]/", "PRIVATE_ADDRESS"],
    ["http://169.254.169.254/latest/meta-data", "PRIVATE_ADDRESS"],
    ["http://192.168.1.10:8080/admin", "PRIVATE_ADDRESS"],
  ])("rejects %s with %s", async (url, code) => {
    const r = await validateTargetUrl(url, { lookup: publicLookup });
    expect(r).toMatchObject({ ok: false, code });
  });

  it("rejects a public-looking hostname that resolves to a private IP (DNS rebinding style)", async () => {
    const r = await validateTargetUrl("https://evil.example.com", { lookup: async () => ["10.0.0.7"] });
    expect(r).toMatchObject({ ok: false, code: "PRIVATE_ADDRESS" });
  });

  it("rejects when ANY resolved address is private", async () => {
    const r = await validateTargetUrl("https://mixed.example.com", { lookup: async () => ["93.184.216.34", "127.0.0.1"] });
    expect(r).toMatchObject({ ok: false, code: "PRIVATE_ADDRESS" });
  });

  it("reports DNS failures", async () => {
    const r = await validateTargetUrl("https://nope.example.com", { lookup: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } });
    expect(r).toMatchObject({ ok: false, code: "DNS_FAILURE" });
  });
});

describe("plan schema + approvePlan", () => {
  const good = { taskType: "WEBSITE_CRAWL", url: "https://example.com", actions: ["CRAWL", "EXTRACT", "SUMMARIZE"], outputFormat: "JSON", maxPages: 5, maxDepth: 2 };

  it("accepts the canonical plan from the spec", () => {
    expect(TaskPlanSchema.safeParse(good).success).toBe(true);
  });

  it.each([
    ["extra field (e.g. a smuggled command)", { ...good, command: "rm -rf /" }],
    ["wrong task type", { ...good, taskType: "RUN_SHELL" }],
    ["too many pages", { ...good, maxPages: 5000 }],
    ["negative depth", { ...good, maxDepth: -1 }],
    ["fractional pages", { ...good, maxPages: 2.5 }],
    ["string pages", { ...good, maxPages: "5" }],
    ["unknown action", { ...good, actions: ["EXEC"] }],
    ["wrong output format", { ...good, outputFormat: "XML" }],
  ])("rejects %s", (_n, bad) => expect(TaskPlanSchema.safeParse(bad).success).toBe(false));

  it("intent union accepts an explicit rejection but not arbitrary shapes", () => {
    expect(IntentSchema.safeParse({ taskType: "UNSUPPORTED", reason: "Only crawling is supported." }).success).toBe(true);
    expect(IntentSchema.safeParse({ taskType: "UNSUPPORTED" }).success).toBe(false);
    expect(IntentSchema.safeParse({ cmd: "ls" }).success).toBe(false);
  });

  it("approvePlan normalises a valid plan", async () => {
    const plan = await approvePlan({ ...good, url: "https://Example.com#x" }, { lookup: publicLookup });
    expect(plan.url).toBe("https://example.com/");
  });

  it("approvePlan rejects private targets and malformed plans", async () => {
    await expect(approvePlan({ ...good, url: "http://127.0.0.1" }, { lookup: publicLookup })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(approvePlan({ ...good, maxPages: 99 })).rejects.toBeInstanceOf(PlanRejected);
  });
});

describe("buildCliArgs", () => {
  it("builds the exact argument vector, one element per argument", async () => {
    const plan = await approvePlan({
      taskType: "WEBSITE_CRAWL", url: "https://example.com/a?x=1&y=2", actions: ["CRAWL"], outputFormat: "JSON", maxPages: 7, maxDepth: 3,
    }, { lookup: publicLookup });
    expect(buildCliArgs(plan)).toEqual([
      "-m", "crawler.cli", "--url", "https://example.com/a?x=1&y=2",
      "--max-pages", "7", "--max-depth", "3", "--output", "json",
    ]);
  });

  it("keeps shell metacharacters inside a single argv element", async () => {
    const plan = await approvePlan({
      taskType: "WEBSITE_CRAWL", url: "https://example.com/$(id);`ls`|rm", actions: ["CRAWL"], outputFormat: "JSON", maxPages: 1, maxDepth: 0,
    }, { lookup: publicLookup });
    const args = buildCliArgs(plan);
    expect(args).toHaveLength(10);
    expect(args[3].startsWith("https://example.com/")).toBe(true);
  });
});

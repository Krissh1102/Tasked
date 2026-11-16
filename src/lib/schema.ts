import { z } from "zod";
import { config } from "./config";

/* ------------------------------------------------------------------ */
/* Task plan: the ONLY thing that may lead to a CLI invocation.        */
/* ------------------------------------------------------------------ */
export const ACTIONS = ["CRAWL", "EXTRACT", "SUMMARIZE"] as const;

export const TaskPlanSchema = z
  .object({
    taskType: z.literal("WEBSITE_CRAWL"),
    url: z.string().min(1).max(2048),
    actions: z.array(z.enum(ACTIONS)).min(1).max(3),
    outputFormat: z.literal("JSON"),
    maxPages: z.number().int().min(1).max(config.limits.maxPages),
    maxDepth: z.number().int().min(0).max(config.limits.maxDepth),
  })
  .strict();
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

/** What the AI layer returns: a supported plan, or an explicit rejection. */
export const IntentSchema = z.discriminatedUnion("taskType", [
  TaskPlanSchema,
  z
    .object({
      taskType: z.literal("UNSUPPORTED"),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);
export type Intent = z.infer<typeof IntentSchema>;

declare const approvedBrand: unique symbol;
/** A plan that passed schema + URL/SSRF validation. buildCliArgs only accepts this. */
export type ApprovedPlan = TaskPlan & { readonly [approvedBrand]: true };

/* ------------------------------------------------------------------ */
/* Crawler output contract (mirrors python-engine/crawler/schemas.py)   */
/* ------------------------------------------------------------------ */
const Headings = z.object({
  h1: z.array(z.string()), h2: z.array(z.string()), h3: z.array(z.string()),
  h4: z.array(z.string()), h5: z.array(z.string()), h6: z.array(z.string()),
});

export const PageResultSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  depth: z.number().int(),
  status_code: z.number().int(),
  title: z.string().nullable(),
  meta_description: z.string().nullable(),
  headings: Headings,
  text: z.string(),
  text_truncated: z.boolean(),
  word_count: z.number().int(),
  internal_links: z.array(z.string()),
  external_links: z.array(z.string()),
  content_truncated: z.boolean(),
  fetch_ms: z.number(),
});

export const CrawlResultSchema = z.object({
  schema_version: z.literal("1.0"),
  tool: z.string(),
  tool_version: z.string(),
  status: z.enum(["success", "partial", "failure"]),
  start_url: z.string(),
  options: z
    .object({
      max_pages: z.number(), max_depth: z.number(), timeout_s: z.number(), max_bytes: z.number(),
      same_domain_only: z.boolean(), respect_robots: z.boolean(),
    })
    .nullable()
    .optional(),
  pages: z.array(PageResultSchema),
  failures: z.array(
    z.object({
      url: z.string(), depth: z.number(), code: z.string(), error: z.string(),
      status_code: z.number().nullable().optional(),
    }),
  ),
  robots_blocked: z.array(z.string()),
  warnings: z.array(z.string()),
  stats: z.object({
    pages_discovered: z.number(), pages_crawled: z.number(), pages_failed: z.number(),
    pages_skipped_robots: z.number(), total_words: z.number(), duration_ms: z.number(),
  }),
  summary: z
    .object({
      method: z.literal("extractive"),
      text: z.string(),
      key_points: z.array(z.string()),
      keywords: z.array(z.string()),
    })
    .nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
});
export type CrawlResult = z.infer<typeof CrawlResultSchema>;

/* ------------------------------------------------------------------ */
/* Live timeline                                                        */
/* ------------------------------------------------------------------ */
export const STAGES = [
  { id: 1, key: "understanding", label: "Understanding request" },
  { id: 2, key: "planning", label: "Generating execution plan" },
  { id: 3, key: "validating_url", label: "Validating URL" },
  { id: 4, key: "selecting_tool", label: "Selecting Python crawler" },
  { id: 5, key: "launching", label: "Launching CLI process" },
  { id: 6, key: "fetching", label: "Fetching website pages" },
  { id: 7, key: "extracting", label: "Extracting content" },
  { id: 8, key: "validating_json", label: "Validating JSON" },
  { id: 9, key: "responding", label: "Generating final response" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

export type TaskStatus =
  | "planning" | "rejected" | "planned" | "running"
  | "success" | "partial" | "failed" | "timeout" | "cancelled";

export type StageStatus = "running" | "done" | "error" | "skipped";

export type TaskEvent =
  | { seq: number; ts: number; type: "stage"; stage: StageId; status: StageStatus; detail?: string }
  | { seq: number; ts: number; type: "plan"; plan: TaskPlan; source: string }
  | { seq: number; ts: number; type: "process"; pid?: number; command: string[] }
  | { seq: number; ts: number; type: "progress"; event: string; data: Record<string, unknown> }
  | { seq: number; ts: number; type: "log"; stream: "stderr"; line: string }
  | { seq: number; ts: number; type: "done"; status: TaskStatus; message: string };

export type TaskEventInput = TaskEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

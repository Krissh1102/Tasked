import { TaskPlanSchema, type ApprovedPlan, type TaskPlan } from "./schema";
import { validateTargetUrl, type UrlCheckOptions } from "./url";

export class PlanRejected extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "PlanRejected";
  }
}

/**
 * The single gate between "an AI produced some JSON" and "a process gets
 * spawned". Re-runs strict schema validation and URL/SSRF validation and
 * returns a branded ApprovedPlan with the URL normalised. Nothing else in the
 * codebase constructs that type.
 */
export async function approvePlan(input: unknown, opts: UrlCheckOptions = {}): Promise<ApprovedPlan> {
  const parsed = TaskPlanSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanRejected("INVALID_PLAN", `Plan failed validation: ${issue.path.join(".") || "plan"} — ${issue.message}`);
  }
  const check = await validateTargetUrl(parsed.data.url, opts);
  if (!check.ok) throw new PlanRejected(check.code, check.message);
  const plan: TaskPlan = { ...parsed.data, url: check.url };
  return plan as ApprovedPlan;
}

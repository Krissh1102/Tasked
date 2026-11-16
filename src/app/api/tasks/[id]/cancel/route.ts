import { NextResponse } from "next/server";
import { cancelTask } from "@/lib/tasks";
import { validId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/tasks/:id/cancel — SIGTERM (then SIGKILL after a grace period) to the crawler process. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validId(id)) return NextResponse.json({ error: "Task not found." }, { status: 404 });
  if (!cancelTask(id)) return NextResponse.json({ error: "Task is not running." }, { status: 409 });
  return NextResponse.json({ id, status: "cancelling" }, { status: 202 });
}

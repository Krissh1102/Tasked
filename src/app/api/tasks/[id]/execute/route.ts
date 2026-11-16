import { NextResponse } from "next/server";
import { claimForExecution, executeClaimed, TaskStateError } from "@/lib/tasks";
import { validId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/:id/execute — only a task that was planned AND validated can be claimed.
 * The claim is atomic (planned -> running), so double-clicks / replays cannot start two processes.
 * Execution continues in the background; follow it via GET /events.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validId(id)) return NextResponse.json({ error: "Task not found." }, { status: 404 });
  try {
    const task = claimForExecution(id);
    void executeClaimed(id).catch(() => {
      /* failures are recorded on the task itself */
    });
    return NextResponse.json({ id: task.id, status: "running" }, { status: 202 });
  } catch (e) {
    if (e instanceof TaskStateError) {
      return NextResponse.json({ error: e.message }, { status: e.message === "Task not found." ? 404 : 409 });
    }
    return NextResponse.json({ error: "Could not start execution." }, { status: 500 });
  }
}

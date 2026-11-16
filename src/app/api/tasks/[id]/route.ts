import { NextResponse } from "next/server";
import { getTask } from "@/lib/tasks";
import { validId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tasks/:id */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = validId(id) ? getTask(id) : null;
  if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
  return NextResponse.json(task);
}

import { NextResponse } from "next/server";
import { PromptError } from "@/lib/intent";
import { createTask } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/tasks — planning only (interpret, validate, persist). Nothing is executed. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON: { "prompt": "..." }' }, { status: 400 });
  }
  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof prompt !== "string") return NextResponse.json({ error: '"prompt" must be a string.' }, { status: 400 });
  try {
    const task = await createTask(prompt);
    return NextResponse.json(task, { status: 201 });
  } catch (e) {
    if (e instanceof PromptError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: "Internal error while planning the task." }, { status: 500 });
  }
}

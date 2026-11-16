import { NextResponse } from "next/server";
import { getResult } from "@/lib/tasks";
import { validId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tasks/:id/result[?download=1] */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = validId(id) ? getResult(id) : null;
  if (!res) return NextResponse.json({ error: "Task not found." }, { status: 404 });

  if (new URL(req.url).searchParams.get("download") === "1") {
    if (!res.result) {
      return NextResponse.json({ error: "This task has no validated JSON result to download." }, { status: 404 });
    }
    let host = "result";
    try {
      host = new URL(res.result.start_url).hostname.replace(/[^a-z0-9.-]/gi, "_");
    } catch {
      /* keep default */
    }
    return new NextResponse(JSON.stringify(res.result, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="taskforge-${host}-${id.slice(0, 8)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json(res);
}

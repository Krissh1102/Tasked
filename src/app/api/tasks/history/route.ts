import { NextResponse } from "next/server";
import { listHistory } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tasks/history?limit=50&q=text */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const tasks = listHistory(Number(u.searchParams.get("limit") ?? 50), (u.searchParams.get("q") ?? "").slice(0, 100));
  return NextResponse.json({ tasks });
}

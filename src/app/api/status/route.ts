import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Non-secret runtime facts for the Settings panel. Never returns keys or env values. */
export async function GET() {
  const env = process.env;
  const want = (env.AI_PROVIDER || "").toLowerCase();
  const provider =
    want === "heuristic" ? "heuristic"
    : want === "openai" && env.OPENAI_API_KEY ? "openai"
    : want === "gemini" && env.GEMINI_API_KEY ? "gemini"
    : !want && env.GEMINI_API_KEY ? "gemini"
    : !want && env.OPENAI_API_KEY ? "openai"
    : "heuristic";
  return NextResponse.json({
    aiProvider: provider,
    privateNetworkOverride: env.TASKFORGE_UNSAFE_ALLOW_PRIVATE === "1",
    execTimeoutMs: config.execTimeoutMs,
    limits: config.limits,
  });
}

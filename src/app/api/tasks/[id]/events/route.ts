import { getTask, readEvents, subscribe } from "@/lib/tasks";
import { validId } from "@/lib/ids";
import type { TaskEvent } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/:id/events — Server-Sent Events.
 * Replays persisted events (so late subscribers and history views work), then streams
 * live ones. Resume with Last-Event-ID or ?after=<seq>. Closes after the terminal 'done' event.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validId(id) || !getTask(id)) {
    return new Response(JSON.stringify({ error: "Task not found." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const afterRaw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
  const after = afterRaw !== null && Number.isFinite(Number(afterRaw)) ? Number(afterRaw) : -1;
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let lastSeq = after;
      let closed = false;
      let hb: ReturnType<typeof setInterval> | undefined;
      let unsub: (() => void) | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        if (hb) clearInterval(hb);
        unsub?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cleanup = close;
      const send = (e: TaskEvent) => {
        if (closed || e.seq <= lastSeq) return; // de-dupes replay vs live overlap
        lastSeq = e.seq;
        controller.enqueue(enc.encode(`id: ${e.seq}\nevent: task\ndata: ${JSON.stringify(e)}\n\n`));
        if (e.type === "done") close();
      };
      unsub = subscribe(id, send); // subscribe first, then replay: nothing can slip between the two
      for (const e of readEvents(id, after)) send(e);
      if (!closed) {
        controller.enqueue(enc.encode("retry: 3000\n\n"));
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": keep-alive\n\n"));
          } catch {
            close();
          }
        }, 15_000);
        req.signal.addEventListener("abort", close);
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

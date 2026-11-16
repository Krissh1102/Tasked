"use client";
import { useEffect, useState } from "react";
import { Ban, Loader2, Play } from "lucide-react";
import { STAGES } from "@/lib/schema";
import { useNow, useTaskStream, type Snapshot } from "@/lib/client";
import { JsonViewer } from "./JsonViewer";
import { Facts, Section, StatusLine, fmtMs } from "./ui";

const FINAL = ["success", "partial", "failed", "timeout", "cancelled", "rejected"];
const GLYPH: Record<string, { ch: string; cls: string }> = {
  done: { ch: "✓", cls: "text-ok" }, error: { ch: "✕", cls: "text-bad" }, skipped: { ch: "–", cls: "text-faint" }, pending: { ch: "·", cls: "text-faint" },
};

function Trace({ snap }: { snap: Snapshot }) {
  const t0 = snap.events[0]?.ts;
  return (
    <ol className="font-mono text-xs">
      {STAGES.map((st) => {
        const s = snap.stages[st.id];
        const live = s.status === "running";
        const g = GLYPH[s.status];
        return (
          <li key={st.id} className={`grid grid-cols-[3.75rem_1.25rem_1fr] items-baseline gap-x-2 border-l-2 py-1 pl-3 ${live ? "border-accent bg-accent/5" : "border-transparent"}`}>
            <span className="num text-right text-faint">{s.ts && t0 ? `+${fmtMs(s.ts - t0)}` : ""}</span>
            <span className={`text-center ${live ? "text-run" : g?.cls}`}>{live ? <Loader2 size={12} className="spin inline" /> : g?.ch}</span>
            <span className="min-w-0">
              <span className={s.status === "pending" ? "text-faint" : s.status === "error" ? "text-bad" : "text-ink"}>
                <span className="mr-2 text-faint">{String(st.id).padStart(2, "0")}</span>{st.label}
              </span>
              {s.detail && s.status !== "pending" && <span className="ml-3 break-all text-muted">{s.detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Pages({ snap }: { snap: Snapshot }) {
  if (!snap.pages.length) return null;
  return (
    <ul className="mt-3 space-y-0.5 border-l-2 border-line pl-3 font-mono text-xs">
      {snap.pages.map((p) => (
        <li key={p.url} className="flex items-baseline gap-2">
          <span className={p.status === "failed" ? "text-bad" : p.status === "ok" ? "text-ok" : "text-run"}>{p.status === "failed" ? "✕" : p.status === "ok" ? "✓" : "…"}</span>
          <span className="min-w-0 flex-1 truncate text-muted" title={p.url}>{p.url}</span>
          {p.detail && <span className={p.status === "failed" ? "text-bad" : "text-faint"}>{p.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

export function TaskCard({ id, prompt, autoRun, selected, onSelect, onSnapshot, onFinished }: {
  id: string; prompt: string; autoRun: boolean; selected: boolean;
  onSelect: () => void; onSnapshot: (s: Snapshot) => void; onFinished: () => void;
}) {
  const { snap, execute, cancel } = useTaskStream(id, { autoRun, onFinished });
  const [rawPlan, setRawPlan] = useState(false);
  useEffect(() => onSnapshot(snap), [snap, onSnapshot]);
  const t = snap.task;
  const status = t?.status ?? "planning";
  const final = FINAL.includes(status);
  const now = useNow(!final);
  const started = t?.startedAt ?? null;
  const elapsed = final ? t?.durationMs ?? null : started ? now - started : null;
  const r = snap.result?.result ?? null;
  const refused = t && (status === "rejected" || (status === "failed" && !t.command)) ? t.message : null;
  const plan = t?.plan;

  return (
    <article className="space-y-5" onClick={onSelect} aria-current={selected ? "true" : undefined}>
      <p className="border-l-2 border-accent pl-4 text-[15px] leading-6">{prompt}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <StatusLine status={status} />
        <span className="text-sm text-muted">{refused ? "" : t?.message ?? (status === "running" ? "Crawler running…" : "")}</span>
        <span className="flex-1" />
        {elapsed != null && <span className="num font-mono text-xs text-muted">{fmtMs(elapsed)}</span>}
        {status === "running" && <button onClick={(e) => { e.stopPropagation(); void cancel(); }} className="inline-flex items-center gap-1.5 rounded border border-line-strong px-2.5 py-1 text-xs text-ink hover:border-bad hover:text-bad"><Ban size={12} />Cancel</button>}
        {status === "planned" && !autoRun && <button onClick={(e) => { e.stopPropagation(); void execute(); }} className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-semibold text-bg hover:opacity-90"><Play size={12} />Run plan</button>}
      </div>

      {refused && (
        <div className="border-l-2 border-bad pl-4 text-sm">
          <p className="font-medium text-ink">{status === "rejected" ? "Nothing was run." : "The website could not be reached."}</p>
          <p className="mt-1 text-muted">{refused}</p>
          {status === "rejected" && <p className="mt-1 text-muted">TaskForge only runs validated website crawls, for example “Crawl https://example.com and summarize it.”</p>}
        </div>
      )}
      {!refused && t?.notes.map((n, i) => <p key={i} className="text-xs text-muted">{n}</p>)}

      {plan && (
        <Section title="Plan" note={<>interpreted by {t.planSource} · <button className="underline underline-offset-2 hover:text-ink" onClick={(e) => { e.stopPropagation(); setRawPlan(!rawPlan); }}>{rawPlan ? "fields" : "raw JSON"}</button></>}>
          {rawPlan ? (
            <pre className="overflow-auto rounded bg-sunk p-3 font-mono text-xs leading-5">{JSON.stringify(plan, null, 2)}</pre>
          ) : (
            <div className="rounded bg-sunk p-3">
              <Facts rows={[["task", plan.taskType], ["url", plan.url], ["actions", plan.actions.join(", ")], ["limits", `${plan.maxPages} pages · depth ${plan.maxDepth}`], ["output", plan.outputFormat]]} />
            </div>
          )}
        </Section>
      )}

      <Section title="Execution" note={snap.pid ? `pid ${snap.pid}` : undefined}>
        <Trace snap={snap} />
        <Pages snap={snap} />
      </Section>

      {r && (
        <>
          <Section title="Summary">
            <p className="max-w-[68ch] text-[15px] leading-7">{r.summary?.text}</p>
            {r.summary && r.summary.key_points.length > 0 && (
              <ul className="mt-3 max-w-[68ch] space-y-2 text-sm leading-6 text-muted">
                {r.summary.key_points.map((k, i) => <li key={i} className="border-l border-line-strong pl-3">{k}</li>)}
              </ul>
            )}
            <p className="mt-3 text-xs text-faint">Extractive: every sentence is copied from the crawled pages.</p>
          </Section>

          <Section title="Statistics">
            <Facts rows={[
              ["Pages discovered", <span key="a" className="num">{r.stats.pages_discovered}</span>],
              ["Crawled", <span key="b" className="num">{r.stats.pages_crawled}</span>],
              ["Failed", <span key="c" className={`num ${r.stats.pages_failed ? "text-bad" : ""}`}>{r.stats.pages_failed}</span>],
              ["Words extracted", <span key="d" className="num">{r.stats.total_words.toLocaleString()}</span>],
              ["Crawl time", <span key="e" className="num">{fmtMs(r.stats.duration_ms)}</span>],
            ]} />
            {(r.failures.length > 0 || r.robots_blocked.length > 0 || r.warnings.length > 0) && (
              <ul className="mt-3 space-y-1 font-mono text-xs">
                {r.failures.map((f) => <li key={f.url} className="text-bad">failed {f.url} — {f.error}</li>)}
                {r.robots_blocked.map((u) => <li key={u} className="text-warn">skipped by robots.txt {u}</li>)}
                {r.warnings.map((w, i) => <li key={i} className="text-warn">{w}</li>)}
              </ul>
            )}
          </Section>

          <Section title="JSON"><JsonViewer data={r} downloadUrl={`/api/tasks/${id}/result?download=1`} /></Section>
        </>
      )}

      {final && t?.command && (
        <Section title="Report">
          <Facts rows={[
            ["Tool", "taskforge-crawler"],
            ["Command", t.command.join(" ")],
            ["Exit code", t.exitCode ?? "—"],
            ["Duration", fmtMs(t.durationMs)],
            ["Final status", status],
            ["Validation", t.validation === "valid" ? "JSON matches schema" : t.validation === "invalid" ? "Output failed validation" : "Not run"],
          ]} />
          {snap.result?.invalidStdout && (
            <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted">Raw stdout (not valid result JSON)</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-sunk p-2 font-mono">{snap.result.invalidStdout}</pre></details>
          )}
        </Section>
      )}
      {snap.error && <p className="text-sm text-bad">{snap.error}</p>}
    </article>
  );
}

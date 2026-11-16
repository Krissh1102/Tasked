"use client";
import { AlertTriangle, Ban, Check, Clock, Loader2, ShieldAlert, X } from "lucide-react";
import type { TaskStatus } from "@/lib/schema";

type Meta = { label: string; cls: string; Icon: typeof Check };
export const STATUS_META: Record<string, Meta> = {
  success: { label: "Complete success", cls: "text-ok", Icon: Check },
  partial: { label: "Partial success", cls: "text-warn", Icon: AlertTriangle },
  failed: { label: "Failed", cls: "text-bad", Icon: X },
  timeout: { label: "Timed out", cls: "text-bad", Icon: Clock },
  cancelled: { label: "Cancelled", cls: "text-muted", Icon: Ban },
  rejected: { label: "Rejected", cls: "text-bad", Icon: ShieldAlert },
  running: { label: "Running", cls: "text-run", Icon: Loader2 },
  planned: { label: "Ready to run", cls: "text-accent", Icon: Clock },
  planning: { label: "Planning", cls: "text-accent", Icon: Loader2 },
};

/** Plain coloured text + glyph. Status is never a pill. */
export function StatusLine({ status, className = "" }: { status: TaskStatus | string; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.failed;
  const spin = status === "running" || status === "planning";
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${m.cls} ${className}`}>
      <m.Icon size={14} strokeWidth={2.25} className={spin ? "spin" : ""} />{m.label}
    </span>
  );
}

export const fmtMs = (ms: number | null | undefined) =>
  ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

/** A section of the run record: a heading over a hairline, no box. */
export function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** Aligned key/value list. */
export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[8.5rem_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words font-mono text-xs leading-5 text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M2 2h10l4 4v10H2z" fill="var(--color-accent)" /><path d="M7 16V9h9" stroke="var(--color-bg)" strokeWidth="1.6" fill="none" /></svg>
      <span className="text-[15px] font-semibold tracking-[-0.01em]">TaskForge</span>
    </span>
  );
}

"use client";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { Snapshot } from "@/lib/client";
import { Facts, StatusLine, fmtMs } from "./ui";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="mt-5"><h3 className="mb-1.5 text-xs font-medium text-muted">{title}</h3>{children}</div>;
}
const pre = "overflow-auto whitespace-pre-wrap break-all rounded bg-sunk p-2.5 font-mono text-xs leading-5";

export function Inspector({ snap, open, onToggle }: { snap: Snapshot | null; open: boolean; onToggle: () => void }) {
  if (!open) {
    return (
      <aside className="hidden w-11 shrink-0 flex-col items-center border-l border-line py-3 lg:flex">
        <button onClick={onToggle} aria-label="Open inspector" className="rounded p-1.5 text-muted hover:bg-hover hover:text-ink"><PanelRightOpen size={18} /></button>
      </aside>
    );
  }
  const t = snap?.task ?? null;
  const r = snap?.result?.result ?? null;
  const status = t?.status ?? null;
  const json = r ? JSON.stringify(r) : "";
  const stdout = snap?.result?.invalidStdout ?? (json.length > 3000 ? json.slice(0, 3000) + "…" : json);
  const stderr = (snap?.stderrLines ?? []).join("\n");
  return (
    <aside className="fixed inset-y-0 right-0 z-30 flex w-[min(360px,100vw)] shrink-0 flex-col border-l border-line bg-surface lg:static lg:z-auto lg:bg-transparent">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Inspector</h2>
        <button onClick={onToggle} aria-label="Collapse inspector" className="rounded p-1.5 text-muted hover:bg-hover hover:text-ink"><PanelRightClose size={18} /></button>
      </div>
      {!t ? (
        <p className="p-4 text-sm text-muted">The command, process state and raw output of the selected task show up here.</p>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          <Block title="Tool"><div className={pre}>{snap!.stages[4].status === "done" ? "python -m crawler.cli" : "not selected yet"}</div></Block>
          <Block title="Arguments"><div className={pre}>{snap!.command ? snap!.command.slice(3).join("\n") : "not launched"}</div></Block>
          <Block title="Process">
            <Facts rows={[
              ["Status", status ? <StatusLine key="s" status={status} className="font-sans text-[13px]" /> : "—"],
              ["PID", snap!.pid ?? "—"],
              ["Duration", status === "running" ? "running…" : fmtMs(t.durationMs)],
              ["Exit code", t.exitCode ?? "—"],
              ["Pages crawled", r ? `${r.stats.pages_crawled} ok, ${r.stats.pages_failed} failed` : snap!.pages.filter((p) => p.status === "ok").length],
              ["Validation", t.validation === "valid" ? "valid" : t.validation === "invalid" ? "invalid" : snap!.stages[8].status === "running" ? "checking…" : "—"],
            ]} />
          </Block>
          <Block title="Standard output"><div className={`${pre} max-h-44 text-muted`}>{stdout || "(empty)"}</div></Block>
          <Block title="Standard error"><div className={`${pre} max-h-56 text-muted`}>{stderr || "(empty)"}</div></Block>
        </div>
      )}
    </aside>
  );
}

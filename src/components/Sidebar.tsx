"use client";
import { useEffect, useState } from "react";
import { Ban, Check, Clock, Loader2, Plus, Search, Settings, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { fetchHistory, type AppStatus, type TaskView } from "@/lib/client";
import { Wordmark } from "./ui";

const ICON: Record<string, { I: typeof Check; cls: string }> = {
  success: { I: Check, cls: "text-ok" }, partial: { I: TriangleAlert, cls: "text-warn" }, failed: { I: X, cls: "text-bad" },
  timeout: { I: Clock, cls: "text-bad" }, rejected: { I: ShieldAlert, cls: "text-bad" }, cancelled: { I: Ban, cls: "text-faint" },
  running: { I: Loader2, cls: "text-run spin" }, planned: { I: Clock, cls: "text-accent" }, planning: { I: Loader2, cls: "text-accent spin" },
};
const day = (ts: number) => { const d = new Date(ts), n = new Date(); const diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5); return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : "Earlier"; };
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function Sidebar({ refreshKey, activeId, onNew, onOpen, status, mobileOpen, onClose }: {
  refreshKey: number; activeId: string | null; onNew: () => void; onOpen: (t: TaskView) => void; status: AppStatus | null; mobileOpen: boolean; onClose: () => void;
}) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [q, setQ] = useState("");
  const [settings, setSettings] = useState(false);
  useEffect(() => { const h = setTimeout(() => void fetchHistory(q).then(setTasks), q ? 250 : 0); return () => clearTimeout(h); }, [refreshKey, q]);
  const groups = tasks.reduce<Record<string, TaskView[]>>((a, t) => ((a[day(t.createdAt)] ??= []).push(t), a), {});

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={onClose} />}
      <nav className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-line bg-surface transition-transform lg:static lg:z-auto lg:translate-x-0 lg:bg-transparent ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <Wordmark />
          <button className="rounded p-1 text-muted lg:hidden" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
        </div>
        <div className="space-y-2 px-3">
          <button onClick={() => { onNew(); onClose(); }} className="flex w-full items-center gap-2 rounded border border-line-strong px-3 py-1.5 text-[13px] font-medium hover:bg-hover"><Plus size={15} />New task</button>
          <label className="relative block">
            <Search size={13} className="absolute left-2.5 top-2.5 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks" className="w-full rounded bg-sunk py-1.5 pl-8 pr-2 text-[13px] outline-none placeholder:text-faint focus:ring-1 focus:ring-accent" />
          </label>
        </div>
        <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
          {tasks.length === 0 && <p className="px-2 py-3 text-xs leading-5 text-muted">{q ? "No tasks match that search." : "Past crawls are listed here, with their results kept."}</p>}
          {Object.entries(groups).map(([g, list]) => (
            <div key={g} className="mb-2">
              <h2 className="px-2 pb-1 pt-2 text-xs font-medium text-faint">{g}</h2>
              <ul>
                {list.map((t) => {
                  const m = ICON[t.status] ?? ICON.failed;
                  return (
                    <li key={t.id}>
                      <button onClick={() => { onOpen(t); onClose(); }} className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-hover ${activeId === t.id ? "bg-hover" : ""}`}>
                        <m.I size={13} strokeWidth={2.25} className={`mt-1 shrink-0 ${m.cls}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{t.title || t.prompt}</span>
                          <span className="block truncate text-xs text-faint">{t.prompt}</span>
                        </span>
                        <span className="num pt-0.5 text-[11px] text-faint">{clock(t.createdAt)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-line p-2">
          <button onClick={() => setSettings(true)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-ink"><Settings size={14} />Settings</button>
        </div>
      </nav>
      {settings && <SettingsDialog status={status} onClose={() => setSettings(false)} />}
    </>
  );
}

function SettingsDialog({ status, onClose }: { status: AppStatus | null; onClose: () => void }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-label="Settings" className="w-full max-w-md rounded-md border border-line-strong bg-surface p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">Settings</h2><button onClick={onClose} aria-label="Close" className="text-muted hover:text-ink"><X size={18} /></button></div>
        {!status ? <p className="mt-4 text-sm text-muted">Loading…</p> : (
          <dl className="mt-4 divide-y divide-line text-sm">
            <div className="flex justify-between py-2"><dt className="text-muted">Request interpreter</dt><dd>{status.aiProvider === "heuristic" ? "Built-in rule-based parser" : status.aiProvider}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-muted">Execution timeout</dt><dd className="num">{status.execTimeoutMs / 1000} s</dd></div>
            <div className="flex justify-between py-2"><dt className="text-muted">Private-network block</dt><dd className={status.privateNetworkOverride ? "text-bad" : "text-ok"}>{status.privateNetworkOverride ? "Off (demo mode)" : "On"}</dd></div>
          </dl>
        )}
        <p className="mt-4 text-xs leading-5 text-muted">These come from environment variables on the server (see .env.example). API keys never reach the browser.</p>
      </div>
    </div>
  );
}

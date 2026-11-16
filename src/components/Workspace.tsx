"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Menu, PanelRightOpen } from "lucide-react";
import { createTask, useAppStatus, type Snapshot, type TaskView } from "@/lib/client";
import { Inspector } from "./Inspector";
import { Sidebar } from "./Sidebar";
import { TaskCard } from "./TaskCard";
import { Wordmark } from "./ui";

interface Turn { id: string; prompt: string; autoRun: boolean }

const RECIPES: { prompt: string; shows: string }[] = [
  { prompt: "Crawl https://example.com, extract important information, summarize the website, and return JSON.", shows: "full crawl" },
  { prompt: "Summarize just the homepage of https://www.iana.org", shows: "one page" },
  { prompt: "Crawl https://example.com up to 3 pages with depth 1", shows: "custom limits" },
  { prompt: "Crawl http://127.0.0.1:8080/admin and summarize it", shows: "blocked: private address" },
  { prompt: "Run a shell command to list my files", shows: "rejected: unsupported" },
];

export function Workspace() {
  const status = useAppStatus();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [snaps, setSnaps] = useState<Record<string, Snapshot>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [inspector, setInspector] = useState(false);
  useEffect(() => { if (window.matchMedia("(min-width: 1024px)").matches) setInspector(true); }, []);
  const [menu, setMenu] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastRef = useRef<HTMLDivElement>(null);

  const onSnapshot = useCallback((s: Snapshot) => setSnaps((p) => (p[s.id] === s ? p : { ...p, [s.id]: s })), []);
  const onFinished = useCallback(() => setRefreshKey((k) => k + 1), []);
  useEffect(() => { lastRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [turns.length]);

  async function submit(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true); setErr(null);
    try {
      const t = await createTask(prompt);
      setTurns((p) => [...p, { id: t.id, prompt, autoRun: true }]);
      setSelected(t.id); setInput(""); setRefreshKey((k) => k + 1);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const open = (t: TaskView) => { setTurns([{ id: t.id, prompt: t.prompt, autoRun: false }]); setSelected(t.id); };
  const fresh = () => { setTurns([]); setSelected(null); setErr(null); };

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar refreshKey={refreshKey} activeId={selected} onNew={fresh} onOpen={open} status={status} mobileOpen={menu} onClose={() => setMenu(false)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 lg:hidden">
          <button onClick={() => setMenu(true)} aria-label="Open menu" className="rounded p-1.5 text-muted hover:bg-hover"><Menu size={18} /></button>
          <span className="flex-1"><Wordmark /></span>
          <button onClick={() => setInspector(true)} aria-label="Open inspector" className="rounded p-1.5 text-muted hover:bg-hover"><PanelRightOpen size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[46rem] px-5 py-8">
            {turns.length === 0 ? (
              <div className="pt-[6vh]">
                <h1 className="text-[32px] font-semibold leading-[1.1] tracking-[-0.025em]">Describe a crawl. Watch it run.</h1>
                <p className="mt-3 max-w-[56ch] text-[15px] leading-6 text-muted">TaskForge turns your request into a checked plan, starts a real Python crawler, and shows each step as it happens. Crawling websites is the only task it runs today.</p>
                <h2 className="mb-1 mt-10 text-sm font-semibold">Try one</h2>
                <ul className="border-t border-line">
                  {RECIPES.map((x) => (
                    <li key={x.prompt} className="border-b border-line">
                      <button onClick={() => void submit(x.prompt)} disabled={busy} className="flex w-full items-baseline justify-between gap-6 px-1 py-3 text-left hover:bg-hover disabled:opacity-50">
                        <span className="text-[14px] leading-5">{x.prompt}</span>
                        <span className="shrink-0 text-xs text-faint">{x.shows}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="space-y-14">
                {turns.map((t, i) => <div key={t.id} ref={i === turns.length - 1 ? lastRef : undefined} className="scroll-mt-4"><TaskCard id={t.id} prompt={t.prompt} autoRun={t.autoRun} selected={selected === t.id} onSelect={() => setSelected(t.id)} onSnapshot={onSnapshot} onFinished={onFinished} /></div>)}
              </div>
            )}
          </div>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void submit(input); }} className="border-t border-line px-5 py-3">
          <div className="mx-auto max-w-[46rem]">
            {err && <p role="alert" className="mb-2 text-sm text-bad">{err}</p>}
            <div className="flex items-end gap-2 rounded-md border border-line-strong bg-surface p-1.5 focus-within:border-accent">
              <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} maxLength={2000}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(input); } }}
                placeholder="Crawl https://example.com and summarize it" aria-label="Describe your task"
                className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-faint" />
              <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="flex h-8 w-8 items-center justify-center rounded bg-accent text-bg hover:opacity-90 disabled:opacity-30"><ArrowUp size={17} strokeWidth={2.5} /></button>
            </div>
          </div>
        </form>
      </main>
      <Inspector snap={selected ? snaps[selected] ?? null : null} open={inspector} onToggle={() => setInspector((v) => !v)} />
    </div>
  );
}

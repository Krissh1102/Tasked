"use client";
import { useState } from "react";
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Download } from "lucide-react";

type J = unknown;
const isObj = (v: J): v is Record<string, J> => typeof v === "object" && v !== null && !Array.isArray(v);

function Scalar({ v }: { v: J }) {
  if (v === null) return <span className="text-faint">null</span>;
  if (typeof v === "string") {
    const shown = v.length > 400 ? v.slice(0, 400) + `… (${v.length - 400} more chars)` : v;
    return <span className="break-words text-ok">{JSON.stringify(shown)}</span>;
  }
  if (typeof v === "number") return <span className="text-warn">{String(v)}</span>;
  return <span className="text-run">{String(v)}</span>;
}

function Node({ k, v, depth, version, last }: { k?: string; v: J; depth: number; version: number; last: boolean }) {
  const container = Array.isArray(v) || isObj(v);
  const [open, setOpen] = useState(depth < 2);
  const [seen, setSeen] = useState(version);
  // a global expand/collapse bumps `version` (odd = expand, even = collapse); adopt it once per bump
  if (seen !== version) { setSeen(version); setOpen(version % 2 === 1); }
  const comma = last ? "" : ",";
  const key = k !== undefined ? <><span className="text-accent">{JSON.stringify(k)}</span><span className="text-faint">: </span></> : null;
  if (!container) return <div className="pl-4">{key}<Scalar v={v} /><span className="text-faint">{comma}</span></div>;
  const entries: [string | number, J][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v as object);
  const [o, c] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return <div className="pl-4">{key}<span className="text-faint">{o}{c}{comma}</span></div>;
  return (
    <div className="pl-4">
      <button onClick={() => setOpen(!open)} className="-ml-4 inline-flex items-center gap-0.5 text-left hover:text-ink" aria-expanded={open}>
        {open ? <ChevronDown size={12} className="text-faint" /> : <ChevronRight size={12} className="text-faint" />}
        {key}<span className="text-faint">{o}</span>
        {!open && <span className="text-faint"> {entries.length} {Array.isArray(v) ? "items" : "keys"} {c}{comma}</span>}
      </button>
      {open && (
        <>
          {entries.map(([ek, ev], i) => <Node key={String(ek)} k={Array.isArray(v) ? undefined : String(ek)} v={ev} depth={depth + 1} version={version} last={i === entries.length - 1} />)}
          <div className="text-faint">{c}{comma}</div>
        </>
      )}
    </div>
  );
}

export function JsonViewer({ data, downloadUrl }: { data: unknown; downloadUrl?: string }) {
  const [version, setVersion] = useState(0);
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(data, null, 2);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const btn = "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink";
  return (
    <div className="overflow-hidden rounded border border-line bg-sunk">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        <button className={btn} onClick={() => setVersion((v) => (v % 2 === 1 ? v + 2 : v + 1))}><ChevronsUpDown size={13} />Expand all</button>
        <button className={btn} onClick={() => setVersion((v) => (v % 2 === 0 ? v + 2 : v + 1))}><ChevronsDownUp size={13} />Collapse all</button>
        <span className="flex-1" />
        <button className={btn} onClick={copy}>{copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}{copied ? "Copied" : "Copy JSON"}</button>
        {downloadUrl && <a className={btn} href={downloadUrl} download><Download size={13} />Download JSON</a>}
      </div>
      <div className="max-h-[420px] overflow-auto p-3 font-mono text-xs leading-5"><Node v={data} depth={0} version={version} last /></div>
    </div>
  );
}

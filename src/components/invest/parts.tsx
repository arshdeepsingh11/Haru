"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import type { Insight } from "@/lib/server/invest/service";
import { timeAgo } from "./format";

// Shared pieces of the Invest tab: Haru's insight with its disclaimer, and the news list.

export function InsightCard({ request, auto = true }: { request: { country: "IN" | "CA" | "WORLD"; key?: string; interest?: string }; auto?: boolean }) {
  const [data, setData] = useState<Insight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reqKey = JSON.stringify(request);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invest/insight", { method: "POST", headers: { "content-type": "application/json" }, body: reqKey });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Haru couldn't write this right now.");
      setData(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setData(null);
    if (auto) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, auto]);

  const stance = data?.stance === "positive" ? "chip-moss" : data?.stance === "cautious" ? "chip-amber" : "chip-slate";
  return (
    <section className="hero grid gap-3 p-4" aria-label="Haru's take">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles size={15} className="text-iris" /> Haru's take
        </p>
        {data && <span className={`chip ${stance}`}>{data.stance === "positive" ? "Leaning positive" : data.stance === "cautious" ? "Be careful" : "Mixed"}</span>}
      </div>
      {busy && !data ? (
        <div className="grid gap-2">
          <div className="shimmer h-4 rounded" />
          <div className="shimmer h-4 w-4/5 rounded" />
          <div className="shimmer h-4 w-3/5 rounded" />
        </div>
      ) : error ? (
        <div className="grid gap-2 text-sm">
          <p className="text-ink-2">{error}</p>
          <button className="btn btn-line h-9 min-h-0 w-fit px-3 text-xs" onClick={load}>
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      ) : data ? (
        <div className="grid gap-2.5 text-[0.95rem] leading-relaxed">
          <p>{data.summary}</p>
          {data.points.length > 0 && (
            <ul className="grid gap-1 text-sm text-ink-2">
              {data.points.map((p) => (
                <li key={p} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-iris" />
                  {p}
                </li>
              ))}
            </ul>
          )}
          {data.fit && <p className="rounded-xl bg-paper-2 px-3 py-2 text-sm">{data.fit}</p>}
          {data.risks.length > 0 && <p className="text-sm text-ink-2">Watch out: {data.risks.map((r) => r.replace(/[.;\s]+$/, "")).join("; ")}.</p>}
        </div>
      ) : (
        <button className="btn btn-line w-fit" onClick={load}>
          <Sparkles size={15} /> Get Haru's take
        </button>
      )}
      <p className="border-t border-line pt-2.5 text-[0.72rem] leading-snug text-ink-3">
        This is an estimate by AI from the data shown. I may be wrong. Not financial advice; check before you invest.
      </p>
    </section>
  );
}

export interface NewsLite {
  id: number;
  url: string;
  source: string;
  title: string;
  summary: string | null;
  image: string | null;
  lang: string;
  publishedAt: string;
  tags: string[];
  interests: string[];
}

export function NewsList({ items, compact = false }: { items: NewsLite[]; compact?: boolean }) {
  const open = (n: NewsLite) => {
    fetch("/api/invest/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "open_news", ref: n.url.slice(0, 300), tags: [...n.tags, ...n.interests].slice(0, 12) }) }).catch(() => {});
  };
  return (
    <ul className="grid gap-2">
      {items.map((n) => (
        <li key={n.id}>
          <a href={n.url} target="_blank" rel="noopener noreferrer" onClick={() => open(n)} className="glass flex gap-3 p-3 transition active:scale-[0.99]">
            <div className="min-w-0 flex-1">
              <p className="text-[0.7rem] font-semibold text-iris">
                {n.source} <span className="font-normal text-ink-3">· {timeAgo(n.publishedAt)}</span>
              </p>
              <p lang={n.lang} className="mt-0.5 line-clamp-3 text-sm font-medium leading-snug">
                {n.title}
              </p>
              {!compact && n.summary && <p className="mt-1 line-clamp-2 text-xs text-ink-2">{n.summary}</p>}
            </div>
            {n.image && !compact && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={n.image} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-xl object-cover" referrerPolicy="no-referrer" />
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

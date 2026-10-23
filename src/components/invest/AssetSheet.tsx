"use client";

import { useCallback, useEffect, useState } from "react";
import { Bookmark, BookmarkCheck, ChartCandlestick, ChartLine, Loader2, MessageSquareText } from "lucide-react";
import type { AssetDetail, Insight } from "@/lib/server/invest/service";
import type { Candle, Range } from "@/lib/invest/analytics";
import { RANGES } from "@/lib/invest/analytics";
import { Sheet, useToast } from "../ui";
import { PriceChart } from "./PriceChart";
import { fmtChange, fmtPct, fmtPrice, freshnessLabel } from "./format";
import { InsightCard, NewsList } from "./parts";

type Q = { price: number; change: number | null; changePct: number | null; asOf: string; source: string; freshness: string; stale: boolean; currency: string; unit?: string };

export function AssetSheet({ assetKey, title, onClose, onAsk }: { assetKey: string | null; title?: string; onClose: () => void; onAsk: (text: string) => void }) {
  const toast = useToast();
  const [range, setRange] = useState<Range>("1Y");
  const [mode, setMode] = useState<"area" | "candle">("area");
  const [data, setData] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (key: string, r: Range) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/invest/asset?key=${encodeURIComponent(key)}&range=${r}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Couldn't load this.");
      setData(j);
      setSaved(j.saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (assetKey) {
      setData(null);
      setRange("1Y");
      load(assetKey, "1Y");
    }
  }, [assetKey, load]);

  const q = data && "price" in data.quote ? (data.quote as Q) : null;
  const candles = data?.chart.candles ?? [];
  const first = candles[0];
  const shown = hover ?? candles[candles.length - 1];
  const rangeChange = first && shown ? shown.c - first.c : null;
  const rangePct = first && shown && first.c ? (shown.c / first.c - 1) * 100 : null;
  const cur = data?.asset.currency ?? "USD";

  async function toggleSave() {
    if (!data) return;
    const a = data.asset;
    const res = await fetch("/api/invest/watch", {
      method: saved ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(saved ? { key: a.key } : { key: a.key, name: a.name, country: a.country, kind: a.kind, currency: a.currency, symbols: {} }),
    });
    if (res.ok) {
      setSaved(!saved);
      toast(saved ? "Removed from your watchlist." : "Saved to your watchlist.");
    } else toast("Couldn't update your watchlist.", "error");
  }

  return (
    <Sheet open={!!assetKey} onClose={onClose} title={data?.asset.name ?? title ?? "Loading…"} wide>
      {error ? (
        <p className="text-brick">{error}</p>
      ) : !data ? (
        <div className="grid gap-3 py-2">
          <div className="shimmer h-10 w-40 rounded-xl" />
          <div className="shimmer h-56 rounded-2xl" />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          {/* Price */}
          <div>
            <p className="text-sm text-ink-3">
              {data.asset.short}
              {data.asset.unit ? ` · ${data.asset.unit}` : ""}
            </p>
            {q ? (
              <>
                <p className="figure mt-1 text-[2.3rem] leading-none">{fmtPrice(hover ? hover.c : q.price, cur)}</p>
                <p className={`mt-2 text-sm font-semibold ${((hover ? rangePct : q.changePct) ?? 0) >= 0 ? "up" : "down"}`}>
                  {hover ? `${fmtChange(rangeChange, cur)} (${fmtPct(rangePct)}) since ${new Date(first.t).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}` : `${fmtChange(q.change, cur)} (${fmtPct(q.changePct)}) today`}
                </p>
                <p className="mt-1 text-xs text-ink-3">{freshnessLabel(q)}</p>
              </>
            ) : (
              <p className="mt-2 text-sm text-amber">{(data.quote as { unavailable: string }).unavailable}</p>
            )}
          </div>

          {/* Chart */}
          <div className="glass min-w-0 overflow-hidden p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className={`text-sm font-semibold ${(rangePct ?? 0) >= 0 ? "up" : "down"}`}>
                {range} {fmtPct(rangePct)}
              </p>
              <div className="flex gap-1">
                <button className={`btn h-8 w-8 min-h-0 p-0 ${mode === "area" ? "btn-line" : "btn-quiet"}`} onClick={() => setMode("area")} aria-label="Line chart">
                  <ChartLine size={15} />
                </button>
                <button className={`btn h-8 w-8 min-h-0 p-0 ${mode === "candle" ? "btn-line" : "btn-quiet"}`} onClick={() => setMode("candle")} aria-label="Candle chart">
                  <ChartCandlestick size={15} />
                </button>
              </div>
            </div>
            <div className={loading ? "opacity-50 transition" : "transition"}>
              <PriceChart candles={candles} currency={cur} intraday={data.chart.intraday} mode={mode} onHover={setHover} />
            </div>
            <div className="no-scrollbar mt-2 flex gap-1 overflow-x-auto">
              {RANGES.map((r) => (
                <button
                  key={r}
                  className={`btn h-8 min-h-0 flex-1 px-2.5 text-xs ${r === range ? "btn-primary" : "btn-quiet"}`}
                  onClick={() => {
                    setRange(r);
                    load(data.asset.key, r);
                  }}
                >
                  {r === "MAX" ? "Max" : r}
                </button>
              ))}
            </div>
            {data.chart.note && <p className="mt-2 text-xs text-ink-3">{data.chart.note}</p>}
            {data.chart.source && <p className="mt-1 text-[0.7rem] text-ink-3">Data: {data.chart.source}</p>}
          </div>

          {/* Computed stats */}
          {data.stats && (
            <dl className="grid grid-cols-3 gap-2 text-sm">
              {[
                ["1 month", fmtPct(data.stats.r1m, true)],
                ["1 year", fmtPct(data.stats.r1y, true)],
                ["5 years", data.stats.cagr5y != null ? `${fmtPct(data.stats.cagr5y, true)}/yr` : "–"],
                ["52w high", fmtPrice(data.stats.high52, cur, { compact: true })],
                ["52w low", fmtPrice(data.stats.low52, cur, { compact: true })],
                ["Swings (1y)", data.stats.vol1y != null ? `${(data.stats.vol1y * 100).toFixed(0)}%` : "–"],
              ].map(([k, v]) => (
                <div key={k} className="glass px-3 py-2.5">
                  <dt className="text-[0.7rem] text-ink-3">{k}</dt>
                  <dd className="figure mt-0.5 text-sm">{v}</dd>
                </div>
              ))}
            </dl>
          )}

          <InsightCard request={{ country: data.asset.country as "IN" | "CA" | "WORLD", key: data.asset.key }} />

          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-line" onClick={toggleSave}>
              {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />} {saved ? "Saved" : "Save"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                onClose();
                onAsk(`About ${data.asset.name}: `);
              }}
            >
              <MessageSquareText size={16} /> Ask Haru
            </button>
          </div>

          {data.news.length > 0 && (
            <section className="grid gap-2">
              <h3 className="section-title">In the news</h3>
              <NewsList items={data.news} />
            </section>
          )}
          {loading && (
            <p className="flex items-center gap-2 text-xs text-ink-3">
              <Loader2 size={13} className="animate-spin" /> Updating…
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

export type { Insight };

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Plus, Search, X } from "lucide-react";
import type { InvestOverview, AssetRow } from "@/lib/server/invest/service";
import type { QuoteResult } from "@/lib/server/invest/market";
import { Sheet, useToast } from "../ui";
import { Sparkline } from "./PriceChart";
import { AssetSheet } from "./AssetSheet";
import { InsightCard, NewsList } from "./parts";
import { fmtPct, fmtPrice } from "./format";

// The Invest tab: pick a country, pick what you care about, and see live prices, charts, news and Haru's read.

type Country = "IN" | "CA" | "WORLD";
const TABS: { code: Country; label: string; flag: string }[] = [
  { code: "IN", label: "India", flag: "🇮🇳" },
  { code: "CA", label: "Canada", flag: "🇨🇦" },
  { code: "WORLD", label: "World", flag: "🌍" },
];

const isQ = (q: QuoteResult | null): q is Extract<QuoteResult, { price: number }> => !!q && "price" in q;

export function InvestView({ onAsk }: { onAsk: (text: string) => void }) {
  const toast = useToast();
  const [country, setCountry] = useState<Country>(() => {
    try {
      return (localStorage.getItem("haru.invest.country") as Country) || "IN";
    } catch {
      return "IN";
    }
  });
  const [data, setData] = useState<InvestOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ key: string; name: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [moreNews, setMoreNews] = useState(false);
  const loadId = useRef(0);

  const patchQuotes = useCallback((quotes: QuoteResult[]) => {
    const by = new Map(quotes.map((q) => [q.key, q]));
    const fix = (r: AssetRow) => (by.has(r.key) ? { ...r, quote: by.get(r.key)! } : r);
    setData((d) => (d ? { ...d, pulse: d.pulse.map(fix), saved: d.saved.map(fix), sections: d.sections.map((s) => ({ ...s, assets: s.assets.map(fix) })) } : d));
  }, []);

  const load = useCallback(
    async (c: Country) => {
      const id = (loadId.current ?? 0) + 1;
      loadId.current = id;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/invest?country=${c}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Couldn't load markets.");
        if (id !== loadId.current) return;
        setData(j);
        // Fill in prices that weren't ready (free plans are rate-limited), a few at a time.
        const all: AssetRow[] = [...j.pulse, ...j.saved, ...j.sections.flatMap((s: { assets: AssetRow[] }) => s.assets)];
        const missing = [...new Set(all.filter((r) => !isQ(r.quote) || r.quote.stale).map((r) => r.key))];
        for (let i = 0; i < missing.length && id === loadId.current; i += 8) {
          const r = await fetch("/api/invest/quotes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: missing.slice(i, i + 8) }) });
          if (r.ok) patchQuotes((await r.json()).quotes);
        }
      } catch (e) {
        if (id === loadId.current) setError((e as Error).message);
      } finally {
        if (id === loadId.current) setLoading(false);
      }
    },
    [patchQuotes],
  );

  useEffect(() => {
    try {
      localStorage.setItem("haru.invest.country", country);
    } catch {
      /* private mode */
    }
    load(country);
  }, [country, load]);

  async function toggleInterest(key: string) {
    if (!data) return;
    const cur = data.interests.filter((i) => i.selected).map((i) => i.key);
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    if (!next.length) return toast("Keep at least one interest.", "error");
    setData({ ...data, interests: data.interests.map((i) => (i.key === key ? { ...i, selected: !i.selected } : i)) });
    const res = await fetch("/api/invest/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ country, interests: next }) });
    if (!res.ok) toast("Couldn't save your interests.", "error");
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight">Invest</h1>
          <p className="text-ink-3">Markets you follow, matched to your budget</p>
        </div>
        <button className="btn btn-line h-11 w-11 shrink-0 p-0" onClick={() => setSearching(true)} aria-label="Search stocks, ETFs and funds">
          <Search size={19} />
        </button>
      </div>

      {/* Countries */}
      <div className="glass-strong grid grid-cols-3 gap-1 rounded-full p-1" role="tablist" aria-label="Country">
        {TABS.map((t) => (
          <button key={t.code} role="tab" aria-selected={country === t.code} className={`btn h-10 min-h-0 rounded-full text-sm ${country === t.code ? "btn-primary" : "btn-quiet"}`} onClick={() => setCountry(t.code)}>
            <span aria-hidden>{t.flag}</span> {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="glass grid gap-2 p-4 text-sm">
          <p className="text-ink-2">{error}</p>
          <button className="btn btn-line h-9 min-h-0 w-fit px-3 text-xs" onClick={() => load(country)}>
            Try again
          </button>
        </div>
      )}

      {!data && loading && <Skeleton />}

      {data && data.country === country && (
        <>
          {/* Pulse */}
          <div className="no-scrollbar -mx-4 flex snap-x gap-2.5 overflow-x-auto scroll-px-4 px-4 pb-1">
            {data.pulse.map((r) => (
              <button key={r.key} onClick={() => setOpen({ key: r.key, name: r.name })} className="glass w-[9.5rem] shrink-0 snap-start p-3 text-left">
                <p className="truncate text-xs text-ink-2">{r.name}</p>
                {isQ(r.quote) ? (
                  <>
                    <p className="figure mt-1 truncate text-[1.02rem]">{fmtPrice(r.quote.price, r.currency, { compact: true })}</p>
                    <p className={`text-xs font-semibold ${(r.quote.changePct ?? 0) >= 0 ? "up" : "down"}`}>{fmtPct(r.quote.changePct)}</p>
                  </>
                ) : (
                  <p className="mt-1 text-xs text-ink-3">{r.quote ? "Not available" : <span className="shimmer inline-block h-4 w-20 rounded" />}</p>
                )}
                {r.spark && (
                  <div className="mt-1.5">
                    <Sparkline values={r.spark} width={120} height={22} />
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Interests */}
          <section className="grid gap-2">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="section-title">What you follow in {data.name}</h2>
              <button className="text-sm text-iris" onClick={() => setEditing(!editing)}>
                {editing ? "Done" : "Edit"}
              </button>
            </div>
            <div className={`flex gap-2 ${editing ? "flex-wrap" : "no-scrollbar -mx-4 overflow-x-auto px-4"}`}>
              {data.interests
                .filter((i) => editing || i.selected)
                .map((i) => (
                  <button key={i.key} className="choice shrink-0 text-sm" aria-pressed={i.selected} onClick={() => (editing ? toggleInterest(i.key) : document.getElementById(`sec-${i.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }))}>
                    {i.label}
                  </button>
                ))}
            </div>
            {editing && <p className="px-1 text-xs text-ink-3">Tap to follow or unfollow. Haru also learns from what you open.</p>}
          </section>

          {!data.keys.td && !data.keys.av && !data.keys.eod && <ConnectData country={country} />}

          {/* Sections */}
          {data.sections.map((s) => (
            <section key={s.interest} id={`sec-${s.interest}`} className="grid scroll-mt-24 gap-2.5">
              <div className="px-1">
                <h2 className="section-title">{s.label}</h2>
                {s.note && <p className="text-xs text-ink-3">{s.note}</p>}
              </div>
              {s.assets.length > 0 && (
                <ul className="glass divide-y divide-line overflow-hidden p-0">
                  {s.assets.map((r) => (
                    <AssetLine key={r.key} r={r} onOpen={() => setOpen({ key: r.key, name: r.name })} />
                  ))}
                </ul>
              )}
              {(s.contextOnly || s.assets.length === 0) && <InsightCard request={{ country, interest: s.interest }} auto={false} />}
              {s.news.length > 0 && <NewsList items={s.news} compact />}
            </section>
          ))}

          {data.saved.length > 0 && (
            <section className="grid gap-2.5">
              <h2 className="section-title px-1">Your watchlist</h2>
              <ul className="glass divide-y divide-line overflow-hidden p-0">
                {data.saved.map((r) => (
                  <AssetLine key={r.key} r={r} onOpen={() => setOpen({ key: r.key, name: r.name })} />
                ))}
              </ul>
            </section>
          )}

          {/* News */}
          <section className="grid gap-2.5">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="section-title">News for you</h2>
              <span className="text-xs text-ink-3">{data.news.length ? "Ranked by what you follow and read" : ""}</span>
            </div>
            {data.news.length ? (
              <>
                <NewsList items={data.news.slice(0, moreNews ? 30 : 8)} />
                {data.news.length > 8 && (
                  <button className="btn btn-line" onClick={() => setMoreNews(!moreNews)}>
                    {moreNews ? "Show less" : `Show ${Math.min(30, data.news.length) - 8} more`}
                  </button>
                )}
              </>
            ) : (
              <p className="glass p-4 text-sm text-ink-2">Headlines are loading for the first time. They refresh every 15 minutes from the publishers' own feeds.</p>
            )}
          </section>

          <Sources data={data} />
          {loading && (
            <p className="flex items-center justify-center gap-2 text-xs text-ink-3">
              <Loader2 size={13} className="animate-spin" /> Updating prices…
            </p>
          )}
        </>
      )}

      <AssetSheet assetKey={open?.key ?? null} title={open?.name} onClose={() => setOpen(null)} onAsk={onAsk} />
      <SearchSheet
        open={searching}
        country={country}
        onClose={() => setSearching(false)}
        onPick={(key, name) => {
          setSearching(false);
          setOpen({ key, name });
        }}
        onSaved={() => load(country)}
      />
    </div>
  );
}

function AssetLine({ r, onOpen }: { r: AssetRow; onOpen: () => void }) {
  const q = r.quote;
  return (
    <li>
      <button onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-paper-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.95rem] font-medium">{r.name}</p>
          <p className="truncate text-xs text-ink-3">
            {r.short}
            {r.unit ? ` · ${r.unit}` : ""}
          </p>
        </div>
        {r.spark && <Sparkline values={r.spark} width={44} />}
        <div className="w-[5.9rem] shrink-0 text-right">
          {isQ(q) ? (
            <>
              <p className="figure truncate text-sm">{fmtPrice(q.price, r.currency, { compact: true })}</p>
              <p className={`text-xs font-semibold ${(q.changePct ?? 0) >= 0 ? "up" : "down"}`}>{fmtPct(q.changePct)}</p>
            </>
          ) : q ? (
            <p className="text-[0.7rem] leading-tight text-ink-3">{q.unavailable}</p>
          ) : (
            <span className="shimmer ml-auto block h-4 w-16 rounded" />
          )}
        </div>
      </button>
    </li>
  );
}

function ConnectData({ country }: { country: Country }) {
  return (
    <section className="hero grid gap-3 p-5">
      <p className="flex items-center gap-2 font-semibold">
        <KeyRound size={17} className="text-iris" /> Connect live market data
      </p>
      <p className="text-sm text-ink-2">Prices need a free data key (2 minutes). Rates and currencies from the Bank of Canada already work.</p>
      <ol className="grid gap-1.5 text-sm">
        <li>
          1. <b>Twelve Data</b> (free): US stocks, ETFs, gold, currencies, crypto, live. Sign up at twelvedata.com and copy your API key.
        </li>
        <li>
          2. <b>Alpha Vantage</b> (free): {country === "IN" ? "Indian BSE" : country === "CA" ? "Toronto TSX" : "Indian and Canadian"} stocks, end of day. Get a key at alphavantage.co.
        </li>
        <li>3. Add them to your environment as TWELVE_DATA_API_KEY and ALPHA_VANTAGE_API_KEY, then restart.</li>
      </ol>
      <p className="text-xs text-ink-3">Want live NSE and TSX prices and the Nifty/TSX indexes? Add an EODHD key (paid, about $20/month) as EODHD_API_KEY.</p>
    </section>
  );
}

function Sources({ data }: { data: InvestOverview }) {
  const ok = data.feeds.filter((f) => f.ok).map((f) => f.source);
  const down = data.feeds.filter((f) => !f.ok).map((f) => f.source);
  const prov = [data.keys.td && "Twelve Data (live)", data.keys.eod && "EODHD (15 min delayed)", data.keys.av && "Alpha Vantage (end of day)", "Bank of Canada (official)", data.country === "IN" && "AMFI via mfapi.in (fund NAVs)"].filter(Boolean);
  return (
    <details className="px-1 text-xs text-ink-3">
      <summary className="cursor-pointer">Where this comes from</summary>
      <div className="mt-2 grid gap-1.5">
        <p>Prices: {prov.join(", ")}. Each price shows its source and time.</p>
        <p>News: {[...new Set(ok)].join(", ") || "loading"}. Headlines link to the publisher; HARU doesn't copy articles.</p>
        {down.length > 0 && <p>Not reachable right now: {[...new Set(down)].join(", ")}.</p>}
        <p>Haru's takes are AI estimates from this data. They may be wrong and aren't financial advice.</p>
      </div>
    </details>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-3">
      <div className="flex gap-2.5 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="glass h-24 w-[9.5rem] shrink-0" />
        ))}
      </div>
      <div className="glass h-52" />
      <div className="glass h-40" />
    </div>
  );
}

type SearchResult = { key: string; name: string; country: Country; kind: string; currency: string; symbols: Record<string, string> };

function SearchSheet({ open, country, onClose, onPick, onSaved }: { open: boolean; country: Country; onClose: () => void; onPick: (key: string, name: string) => void; onSaved: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      if (q.trim().length < 2) return setResults([]);
      setBusy(true);
      try {
        const r = await fetch(`/api/invest/search?country=${country}&q=${encodeURIComponent(q.trim())}`);
        const j = await r.json();
        setResults(r.ok ? j.results : []);
      } finally {
        setBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q, country, open]);

  async function save(r: SearchResult) {
    const res = await fetch("/api/invest/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) });
    if (res.ok) {
      toast(`Saved ${r.name.split(" (")[0]} to your watchlist.`);
      onSaved();
    } else toast("Couldn't save that.", "error");
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Search ${country === "IN" ? "India" : country === "CA" ? "Canada" : "world"} markets`}>
      <div className="grid gap-3">
        <label className="relative block">
          <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input className="input pl-10" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={country === "IN" ? "Stock, ETF or mutual fund" : "Stock or ETF name or symbol"} />
          {q && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-ink-3" onClick={() => setQ("")} aria-label="Clear">
              <X size={16} />
            </button>
          )}
        </label>
        {busy && <p className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={14} className="animate-spin" /> Searching…</p>}
        {!busy && q.trim().length >= 2 && results.length === 0 && <p className="text-sm text-ink-3">Nothing found. Search needs a Twelve Data or Alpha Vantage key{country === "IN" ? " (funds work without one)" : ""}.</p>}
        <ul className="grid gap-2">
          {results.map((r) => (
            <li key={r.key} className="glass flex items-center gap-2 p-3">
              <button className="min-w-0 flex-1 text-left" onClick={() => onPick(r.key, r.name)}>
                <p className="line-clamp-2 text-sm font-medium">{r.name}</p>
                <p className="text-xs text-ink-3">
                  {r.kind === "fund" ? "Mutual fund" : r.kind.toUpperCase()} · {r.currency}
                </p>
              </button>
              <button className="btn btn-line h-9 w-9 min-h-0 shrink-0 p-0" onClick={() => save(r)} aria-label={`Save ${r.name}`}>
                <Plus size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

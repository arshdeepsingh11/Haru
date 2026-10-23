import "server-only";
import { ASSET_MAP, type Asset } from "../../invest/catalog";
import { combineSeries, sliceRange, type Candle, type Range } from "../../invest/analytics";
import { cached, cacheGet, cacheSet, peek } from "./cache";
import { avDaily, bocSeries, eodDaily, eodQuote, keys, mfHistory, nseBhavLatest, nseIndexLatest, parseStamp, ProviderError, tdQuote, tdSeries, type RawQuote } from "./providers";
import type { DayBar } from "../../invest/nse-parse";

// Prices and history for any asset: picks the best source available, caches, and says how fresh it is.

export interface Quote {
  key: string;
  price: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  asOf: string;
  source: string;
  freshness: RawQuote["freshness"];
  stale: boolean;
  currency: string;
  unit?: string;
}
export interface Unavailable {
  key: string;
  unavailable: string;
  needs?: ("td" | "av" | "eod")[];
}
export type QuoteResult = Quote | Unavailable;
export const isQuote = (q: QuoteResult | null | undefined): q is Quote => !!q && "price" in q;

const H = 3600e3;
const TTL = { quote: 60e3, daily: 6 * H, avDaily: 20 * H, boc: 6 * H, mf: 12 * H, intraday: 5 * 60e3, nse: 2 * H, notCovered: 24 * H };

// A provider that said "not on your plan" for an asset isn't asked again for a day:
// free plans have tiny budgets, and every wasted call makes the page slower.
const ncKey = (provider: string, assetKey: string) => `nc:${provider}:${assetKey}`;
async function notCovered(provider: string, assetKey: string): Promise<boolean> {
  const e = await cacheGet<boolean>(ncKey(provider, assetKey));
  return !!e && e.expiresAt > Date.now();
}
async function markIfNotCovered(provider: string, assetKey: string, e: unknown) {
  if (e instanceof ProviderError && e.kind === "not_covered") await cacheSet(ncKey(provider, assetKey), true, TTL.notCovered).catch(() => {});
}

// NSE's official daily files: one download covers every Indian stock, ETF and index.
const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const cur = inflight.get(key) as Promise<T> | undefined;
  if (cur) return cur;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function nseBar(a: Asset): Promise<DayBar | null> {
  const s = a.symbols;
  if (s.nse) {
    const r = await once("nse:eq", () => cached("nse:eq", TTL.nse, () => nseBhavLatest()));
    return r.data.bars[s.nse.toUpperCase()] ?? null;
  }
  if (s.nseIndex) {
    const r = await once("nse:idx", () => cached("nse:idx", TTL.nse, () => nseIndexLatest()));
    return r.data.bars[s.nseIndex.toLowerCase()] ?? null;
  }
  return null;
}
const yearsAgo = (n: number) => new Date(Date.now() - n * 365.25 * 86400e3).toISOString().slice(0, 10);

interface Daily {
  candles: Candle[];
  source: string;
  freshness: RawQuote["freshness"];
}

/** What keys would unlock this asset if nothing is configured. */
function needsFor(a: Asset): ("td" | "av" | "eod")[] {
  const n: ("td" | "av" | "eod")[] = [];
  if (a.symbols.td) n.push("td");
  if (a.symbols.av) n.push("av");
  if (a.symbols.eod) n.push("eod");
  return n;
}

async function loadDaily(a: Asset, opts: { long?: boolean } = {}): Promise<Daily> {
  const s = a.symbols;
  const errors: string[] = [];
  const attempt = async <T,>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderError && e.kind !== "no_key") errors.push(`${e.provider}: ${e.message}`);
      return null;
    }
  };
  if (a.derived) {
    const parts = await Promise.all(a.derived.parts.map(async (p) => ({ candles: (await getDaily(ASSET_MAP.get(p.key)!, opts)).candles, invert: p.invert })));
    const candles = combineSeries(parts, a.derived.factor ?? 1);
    if (!candles.length) throw new ProviderError("HARU", "no overlapping history to combine", "not_covered");
    return { candles, source: "computed", freshness: "eod" };
  }
  if (s.eod && keys.eod()) {
    const c = await attempt(() => eodDaily(s.eod!, yearsAgo(opts.long ? 30 : 6)));
    if (c?.length) return { candles: c, source: "EODHD", freshness: "eod" };
  }
  if (s.td && keys.td() && !(await notCovered("td", a.key))) {
    const c = await attempt(() => tdSeries(s.td!, s.tdExchange, "1day", opts.long ? 5000 : 1600).catch(async (e) => (await markIfNotCovered("td", a.key, e), Promise.reject(e))));
    if (c?.length) return { candles: c, source: "Twelve Data", freshness: "eod" };
  }
  if (s.av && keys.av() && !(await notCovered("av", a.key))) {
    const c = await attempt(() => avDaily(s.av!, !!opts.long).catch(async (e) => (await markIfNotCovered("av", a.key, e), Promise.reject(e))));
    if (c?.length) return { candles: withTodayFromNse(c, await nseBar(a).catch(() => null)), source: "Alpha Vantage", freshness: "eod" };
  }
  if (s.boc) {
    const c = await attempt(() => bocSeries(s.boc!, yearsAgo(opts.long ? 20 : 6)));
    if (c?.length) return { candles: c, source: "Bank of Canada", freshness: "official" };
  }
  if (s.bocRatio) {
    const [a1, a2] = await Promise.all(s.bocRatio.map((x) => attempt(() => bocSeries(x, yearsAgo(opts.long ? 20 : 6)))));
    if (a1?.length && a2?.length) return { candles: combineSeries([{ candles: a1 }, { candles: a2, invert: true }]), source: "Bank of Canada", freshness: "official" };
  }
  if (s.mf) {
    const m = await attempt(() => mfHistory(s.mf!));
    if (m) return { candles: m.candles, source: "AMFI via mfapi.in", freshness: "official" };
  }
  if (s.nse || s.nseIndex) {
    // No history source: at least the latest official day, so the price and day range are right.
    const b = await attempt(() => nseBar(a));
    if (b) return { candles: [{ t: parseStamp(b.date), o: b.o, h: b.h, l: b.l, c: b.c }], source: "NSE", freshness: "eod" };
  }
  throw new ProviderError("HARU", errors.length ? errors.join("; ") : "no data source configured for this asset", errors.length ? "failed" : "no_key");
}

/** Alpha Vantage (BSE) history can lag a day: add NSE's latest official close when it is newer. */
function withTodayFromNse(c: Candle[], b: DayBar | null): Candle[] {
  if (!b || !c.length) return c;
  const t = parseStamp(b.date);
  const last = c[c.length - 1];
  if (new Date(last.t).toISOString().slice(0, 10) >= b.date) return c;
  return [...c, { t, o: b.o, h: b.h, l: b.l, c: b.c }];
}

export async function getDaily(a: Asset, opts: { long?: boolean } = {}): Promise<Daily> {
  const ttl = a.symbols.av && !keys.td() && !keys.eod() ? TTL.avDaily : a.symbols.boc || a.symbols.bocRatio ? TTL.boc : a.symbols.mf ? TTL.mf : TTL.daily;
  const r = await cached(`d${opts.long ? "L" : ""}:${a.key}`, ttl, () => loadDaily(a, opts));
  return r.data;
}

/** Intraday bars for 1D/1W where a live source exists (Twelve Data); otherwise null. */
export async function getIntraday(a: Asset, range: "1D" | "1W"): Promise<Candle[] | null> {
  if (a.derived || !a.symbols.td || !keys.td()) return null;
  try {
    const r = await cached(`i:${range}:${a.key}`, TTL.intraday, () => tdSeries(a.symbols.td!, a.symbols.tdExchange, range === "1D" ? "5min" : "1h", range === "1D" ? 300 : 200));
    if (!r.data.length) return null;
    // 1D = the latest trading session only
    if (range === "1D") {
      const lastDay = new Date(r.data[r.data.length - 1].t).toISOString().slice(0, 10);
      return r.data.filter((c) => new Date(c.t).toISOString().slice(0, 10) === lastDay);
    }
    return sliceRange(r.data, "1W");
  } catch {
    return null;
  }
}

function fromDaily(a: Asset, d: Daily, stale: boolean): Quote {
  const c = d.candles;
  const last = c[c.length - 1];
  const prev = c.length > 1 ? c[c.length - 2] : null;
  return finish(a, { price: last.c, prevClose: prev?.c ?? null, asOf: last.t, source: d.source, freshness: d.freshness }, stale);
}

function finish(a: Asset, q: RawQuote, stale: boolean): Quote {
  const change = q.prevClose != null ? q.price - q.prevClose : null;
  return {
    key: a.key,
    price: q.price,
    prevClose: q.prevClose,
    change,
    changePct: change != null && q.prevClose ? (change / q.prevClose) * 100 : null,
    asOf: new Date(q.asOf).toISOString(),
    source: q.source,
    freshness: q.freshness,
    stale,
    currency: a.currency,
    unit: a.unit,
  };
}

async function loadQuote(a: Asset): Promise<Quote> {
  // Derived: multiply the parts' quotes (gold in rupees = gold in USD × USD/INR × grams).
  if (a.derived) {
    const parts = await Promise.all(a.derived.parts.map((p) => getQuote(ASSET_MAP.get(p.key)!)));
    if (!parts.every(isQuote)) {
      const d = await getDaily(a);
      return fromDaily(a, d, false);
    }
    const qs = parts as Quote[];
    const f = a.derived.factor ?? 1;
    const mul = (pick: (q: Quote) => number | null) => {
      let v = f;
      for (let i = 0; i < qs.length; i++) {
        const x = pick(qs[i]);
        if (x == null || !x) return null;
        v *= a.derived!.parts[i].invert ? 1 / x : x;
      }
      return v;
    };
    const live = qs.every((q) => q.freshness === "live");
    return finish(a, { price: mul((q) => q.price)!, prevClose: mul((q) => q.prevClose), asOf: Math.min(...qs.map((q) => Date.parse(q.asOf))), source: live ? "computed (live)" : "computed", freshness: live ? "live" : "eod" }, qs.some((q) => q.stale));
  }
  const s = a.symbols;
  if (s.eod && keys.eod()) {
    try {
      return finish(a, await eodQuote(s.eod), false);
    } catch {
      /* fall through */
    }
  }
  if (s.nse || s.nseIndex) {
    const b = await nseBar(a).catch(() => null);
    if (b) return finish(a, { price: b.c, prevClose: b.prev, asOf: parseStamp(b.date), source: "NSE (official close)", freshness: "eod" }, false);
  }
  if (s.td && keys.td() && !(await notCovered("td", a.key))) {
    try {
      return finish(a, await tdQuote(s.td, s.tdExchange), false);
    } catch (e) {
      await markIfNotCovered("td", a.key, e);
      /* fall through to end-of-day */
    }
  }
  const d = await getDaily(a);
  return fromDaily(a, d, false);
}

export async function getQuote(a: Asset): Promise<QuoteResult> {
  if (!a.derived && !needsFor(a).length && !a.symbols.boc && !a.symbols.bocRatio && !a.symbols.mf && !a.symbols.nse && !a.symbols.nseIndex) return { key: a.key, unavailable: "No live price for this" };
  try {
    const live = !!(a.symbols.td && keys.td()) || !!(a.symbols.eod && keys.eod());
    const r = await cached(`q:${a.key}`, live ? TTL.quote : 30 * 60e3, () => loadQuote(a));
    return { ...r.data, stale: r.stale || r.data.stale };
  } catch (e) {
    const missing = !keys.td() && !keys.av() && !keys.eod();
    return { key: a.key, unavailable: missing && !a.symbols.boc && !a.symbols.bocRatio && !a.symbols.nse && !a.symbols.nseIndex ? "Connect a market data key to see this price" : e instanceof ProviderError ? friendly(e) : "Price unavailable right now", needs: needsFor(a) };
  }
}

/** Whatever is cached right now, without calling any provider: paints the page instantly. */
export async function peekQuote(a: Asset): Promise<QuoteResult | null> {
  const p = await peek<Quote>(`q:${a.key}`);
  return p ? { ...p.data, stale: !p.fresh } : null;
}

function friendly(e: ProviderError): string {
  if (e.kind === "rate_limited") return "Free data limit reached for now; showing it again shortly";
  if (e.kind === "not_covered") return "Not covered by your data plan";
  if (e.kind === "no_key") return "Connect a market data key to see this price";
  return "Price unavailable right now";
}

export async function getChart(a: Asset, range: Range): Promise<{ candles: Candle[]; source: string; intraday: boolean; note?: string }> {
  if (range === "1D" || range === "1W") {
    const intra = await getIntraday(a, range);
    if (intra?.length) return { candles: intra, source: "Twelve Data", intraday: true };
    const d = await getDaily(a);
    return { candles: sliceRange(d.candles, range === "1D" ? "1W" : "1M"), source: d.source, intraday: false, note: "Intraday isn't available for this on your data plan, so this shows daily closes." };
  }
  const long = range === "5Y" || range === "MAX";
  const d = await getDaily(a, { long });
  return { candles: sliceRange(d.candles, range), source: d.source, intraday: false };
}

/** Run with limited parallelism and an overall deadline; unfinished items come back undefined. */
export async function settleWithin<T, R>(items: T[], fn: (x: T) => Promise<R>, opts: { concurrency?: number; deadlineMs?: number } = {}): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  const deadline = Date.now() + (opts.deadlineMs ?? 7000);
  let i = 0;
  const worker = async () => {
    while (i < items.length && Date.now() < deadline) {
      const idx = i++;
      try {
        out[idx] = await Promise.race([fn(items[idx]), new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.max(0, deadline - Date.now())))]);
      } catch {
        out[idx] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, items.length) }, worker));
  return out;
}

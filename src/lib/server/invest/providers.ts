import "server-only";
import type { Candle } from "../../invest/analytics";
import { takeBudget } from "./cache";
import { parseBhav, parseIndexCloses, recentIstDates, unzipFirst, type DayBar } from "../../invest/nse-parse";

// Thin clients for each data source. Each returns clean candles/quotes or throws ProviderError.
// Sources: Twelve Data (live US, FX, crypto, metals), Alpha Vantage (end-of-day BSE/TSX),
// EODHD (optional: live-delayed NSE/TSX + indexes), Bank of Canada Valet (official rates and FX, no key),
// mfapi.in (India mutual fund NAVs, from AMFI), NSE's official daily price files (every Indian stock, no key).

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly kind: "no_key" | "not_covered" | "rate_limited" | "failed" = "failed",
  ) {
    super(message);
  }
}

export const keys = {
  td: () => process.env.TWELVE_DATA_API_KEY || "",
  av: () => process.env.ALPHA_VANTAGE_API_KEY || "",
  eod: () => process.env.EODHD_API_KEY || "",
  nyt: () => process.env.NYT_API_KEY || "",
};

async function getJson(provider: string, url: string, timeoutMs = 9000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", "user-agent": "HARU/1.0 (+personal finance app)" }, cache: "no-store" });
  } catch (e) {
    throw new ProviderError(provider, `${provider} unreachable (${(e as Error).name === "TimeoutError" ? "timed out" : "network"})`);
  }
  if (res.status === 429) throw new ProviderError(provider, `${provider} rate limit`, "rate_limited");
  if (!res.ok) throw new ProviderError(provider, `${provider} HTTP ${res.status}`, res.status === 404 ? "not_covered" : "failed");
  return res.json();
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : NaN;
};
/** "2026-10-22" or "2026-10-22 15:30:00" (exchange time) → epoch ms. Daily bars are stamped at noon UTC. */
export function parseStamp(s: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T12:00:00Z`);
  const t = Date.parse(s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
  return t;
}
const clean = (c: Candle[]) => c.filter((x) => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0).sort((a, b) => a.t - b.t);

// ------------------------------------------------------------------ Twelve Data
export type TdInterval = "5min" | "1h" | "1day" | "1week";

function tdUrl(path: string, symbol: string, exchange: string | undefined, extra: Record<string, string>) {
  const q = new URLSearchParams({ symbol, ...(exchange ? { exchange } : {}), ...extra, apikey: keys.td() });
  return `https://api.twelvedata.com/${path}?${q}`;
}
function tdCheck(j: unknown) {
  const o = j as { status?: string; code?: number; message?: string };
  if (o?.status === "error") {
    const msg = o.message ?? "error";
    const kind = o.code === 429 || /credits|limit/i.test(msg) ? "rate_limited" : /plan|upgrade|not available|grow|pro\b|subscription/i.test(msg) ? "not_covered" : o.code === 404 ? "not_covered" : "failed";
    throw new ProviderError("Twelve Data", msg.slice(0, 160), kind);
  }
}

export async function tdSeries(symbol: string, exchange: string | undefined, interval: TdInterval, outputsize = 5000): Promise<Candle[]> {
  if (!keys.td()) throw new ProviderError("Twelve Data", "no key", "no_key");
  if (!takeBudget("td", 7)) throw new ProviderError("Twelve Data", "minute budget used", "rate_limited");
  const j = (await getJson("Twelve Data", tdUrl("time_series", symbol, exchange, { interval, outputsize: String(outputsize), timezone: "UTC" }))) as { values?: { datetime: string; open: string; high: string; low: string; close: string }[] };
  tdCheck(j);
  return clean((j.values ?? []).map((v) => ({ t: parseStamp(v.datetime), o: num(v.open), h: num(v.high), l: num(v.low), c: num(v.close) })));
}

export interface RawQuote {
  price: number;
  prevClose: number | null;
  asOf: number;
  source: string;
  freshness: "live" | "delayed" | "eod" | "official";
}

export async function tdQuote(symbol: string, exchange?: string): Promise<RawQuote> {
  if (!keys.td()) throw new ProviderError("Twelve Data", "no key", "no_key");
  if (!takeBudget("td", 7)) throw new ProviderError("Twelve Data", "minute budget used", "rate_limited");
  const j = (await getJson("Twelve Data", tdUrl("quote", symbol, exchange, {}))) as { close?: string; previous_close?: string; timestamp?: number; is_market_open?: boolean };
  tdCheck(j);
  const price = num(j.close);
  if (!Number.isFinite(price)) throw new ProviderError("Twelve Data", "no price", "not_covered");
  return { price, prevClose: Number.isFinite(num(j.previous_close)) ? num(j.previous_close) : null, asOf: j.timestamp ? j.timestamp * 1000 : Date.now(), source: "Twelve Data", freshness: "live" };
}

export async function tdSearch(q: string): Promise<{ symbol: string; name: string; exchange: string; country: string; currency: string; type: string }[]> {
  if (!keys.td()) return [];
  const j = (await getJson("Twelve Data", `https://api.twelvedata.com/symbol_search?${new URLSearchParams({ symbol: q, outputsize: "20", apikey: keys.td() })}`)) as {
    data?: { symbol: string; instrument_name: string; exchange: string; country: string; currency: string; instrument_type: string }[];
  };
  return (j.data ?? []).map((d) => ({ symbol: d.symbol, name: d.instrument_name, exchange: d.exchange, country: d.country, currency: d.currency, type: d.instrument_type }));
}

// ------------------------------------------------------------------ Alpha Vantage (end of day)
export async function avDaily(symbol: string, full = false): Promise<Candle[]> {
  if (!keys.av()) throw new ProviderError("Alpha Vantage", "no key", "no_key");
  if (!takeBudget("av", 5)) throw new ProviderError("Alpha Vantage", "minute budget used", "rate_limited");
  const url = `https://www.alphavantage.co/query?${new URLSearchParams({ function: "TIME_SERIES_DAILY", symbol, outputsize: full ? "full" : "compact", apikey: keys.av() })}`;
  const j = (await getJson("Alpha Vantage", url)) as Record<string, unknown>;
  const info = (j["Information"] ?? j["Note"] ?? j["Error Message"]) as string | undefined;
  if (info) {
    if (full && /premium/i.test(info)) return avDaily(symbol, false);
    throw new ProviderError("Alpha Vantage", info.slice(0, 160), /limit|frequency|per day|per minute/i.test(info) ? "rate_limited" : /invalid api call|not found/i.test(info) ? "not_covered" : "failed");
  }
  const series = (j["Time Series (Daily)"] ?? {}) as Record<string, Record<string, string>>;
  return clean(Object.entries(series).map(([d, v]) => ({ t: parseStamp(d), o: num(v["1. open"]), h: num(v["2. high"]), l: num(v["3. low"]), c: num(v["4. close"]) })));
}

export async function avSearch(q: string): Promise<{ symbol: string; name: string; region: string; currency: string; type: string }[]> {
  if (!keys.av() || !takeBudget("av", 5)) return [];
  const j = (await getJson("Alpha Vantage", `https://www.alphavantage.co/query?${new URLSearchParams({ function: "SYMBOL_SEARCH", keywords: q, apikey: keys.av() })}`)) as { bestMatches?: Record<string, string>[] };
  return (j.bestMatches ?? []).map((m) => ({ symbol: m["1. symbol"], name: m["2. name"], type: m["3. type"], region: m["4. region"], currency: m["8. currency"] }));
}

// ------------------------------------------------------------------ EODHD (optional paid key)
export async function eodDaily(symbol: string, fromISO: string): Promise<Candle[]> {
  if (!keys.eod()) throw new ProviderError("EODHD", "no key", "no_key");
  const j = (await getJson("EODHD", `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}?${new URLSearchParams({ api_token: keys.eod(), fmt: "json", from: fromISO })}`)) as { date: string; open: number; high: number; low: number; close: number }[] | { message?: string };
  if (!Array.isArray(j)) throw new ProviderError("EODHD", (j as { message?: string }).message ?? "unexpected", "not_covered");
  return clean(j.map((v) => ({ t: parseStamp(v.date), o: num(v.open), h: num(v.high), l: num(v.low), c: num(v.close) })));
}

export async function eodQuote(symbol: string): Promise<RawQuote> {
  if (!keys.eod()) throw new ProviderError("EODHD", "no key", "no_key");
  const j = (await getJson("EODHD", `https://eodhd.com/api/real-time/${encodeURIComponent(symbol)}?${new URLSearchParams({ api_token: keys.eod(), fmt: "json" })}`)) as { close?: number | string; previousClose?: number | string; timestamp?: number };
  const price = num(j.close);
  if (!Number.isFinite(price)) throw new ProviderError("EODHD", "no price", "not_covered");
  return { price, prevClose: Number.isFinite(num(j.previousClose)) ? num(j.previousClose) : null, asOf: j.timestamp ? j.timestamp * 1000 : Date.now(), source: "EODHD", freshness: "delayed" };
}

// ------------------------------------------------------------------ Bank of Canada (official, no key)
export async function bocSeries(series: string, fromISO: string): Promise<Candle[]> {
  const j = (await getJson("Bank of Canada", `https://www.bankofcanada.ca/valet/observations/${encodeURIComponent(series)}/json?start_date=${fromISO}`)) as { observations?: Record<string, unknown>[] };
  return clean(
    (j.observations ?? []).map((o) => {
      const raw = o[series] as { v?: string } | string | undefined;
      const v = num(typeof raw === "object" && raw ? raw.v : raw);
      return { t: parseStamp(String(o.d)), o: v, h: v, l: v, c: v };
    }),
  );
}

// ------------------------------------------------------------------ India mutual funds (mfapi.in, AMFI NAVs)
export async function mfHistory(code: string): Promise<{ name: string; house: string; candles: Candle[] }> {
  const j = (await getJson("mfapi.in", `https://api.mfapi.in/mf/${encodeURIComponent(code)}`)) as { meta?: { scheme_name?: string; fund_house?: string }; data?: { date: string; nav: string }[] };
  const candles = clean(
    (j.data ?? []).map((d) => {
      const [dd, mm, yy] = d.date.split("-");
      const v = num(d.nav);
      return { t: parseStamp(`${yy}-${mm}-${dd}`), o: v, h: v, l: v, c: v };
    }),
  );
  if (!candles.length) throw new ProviderError("mfapi.in", "no NAV data", "not_covered");
  return { name: j.meta?.scheme_name ?? `Scheme ${code}`, house: j.meta?.fund_house ?? "", candles };
}

export async function mfSearch(q: string): Promise<{ code: string; name: string }[]> {
  const j = (await getJson("mfapi.in", `https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`)) as { schemeCode: number; schemeName: string }[];
  return (Array.isArray(j) ? j : []).slice(0, 25).map((x) => ({ code: String(x.schemeCode), name: x.schemeName }));
}

// ------------------------------------------------------------------ NSE (official daily files, free, no key)
const NSE_HEADERS = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", accept: "*/*", referer: "https://www.nseindia.com/" };

async function nseGet(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: NSE_HEADERS, cache: "no-store" });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/** The latest NSE bhavcopy (every stock and ETF, one trading day). Tries today and earlier days, newest first. */
export async function nseBhavLatest(now = Date.now()): Promise<{ date: string; bars: Record<string, DayBar> }> {
  for (const d of recentIstDates(now, 8)) {
    const res = await nseGet(`https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${d.replace(/-/g, "")}_F_0000.csv.zip`);
    if (!res) continue;
    const bars = parseBhav(unzipFirst(new Uint8Array(await res.arrayBuffer())));
    if (Object.keys(bars).length > 100) return { date: d, bars };
  }
  throw new ProviderError("NSE", "no recent NSE price file reachable", "failed");
}

/** The latest NSE index closes (Nifty 50, Nifty Bank, …). */
export async function nseIndexLatest(now = Date.now()): Promise<{ date: string; bars: Record<string, DayBar> }> {
  for (const d of recentIstDates(now, 8)) {
    const [y, m, dd] = d.split("-");
    const res = await nseGet(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${dd}${m}${y}.csv`);
    if (!res) continue;
    const bars = parseIndexCloses(await res.text());
    if (Object.keys(bars).length > 5) return { date: d, bars };
  }
  throw new ProviderError("NSE", "no recent NSE index file reachable", "failed");
}

// ------------------------------------------------------------------ feeds
export async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", "user-agent": "Mozilla/5.0 (compatible; HARU/1.0; +personal finance app)" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function nytTopStories(section: "business" | "world"): Promise<{ title: string; abstract: string; url: string; published_date: string; multimedia?: { url: string }[] }[]> {
  if (!keys.nyt()) return [];
  const j = (await getJson("NYT", `https://api.nytimes.com/svc/topstories/v2/${section}.json?api-key=${encodeURIComponent(keys.nyt())}`)) as { results?: { title: string; abstract: string; url: string; published_date: string; multimedia?: { url: string }[] }[] };
  return j.results ?? [];
}

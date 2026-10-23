import "server-only";
import { z } from "zod";
import { sql } from "../db";
import type { Ctx } from "../context";
import { AppError, logError } from "../errors";
import { ASSET_MAP, COUNTRY_MAP, defaultInterests, interestOf, type Asset, type AssetKind, type CountryCode } from "../../invest/catalog";
import { statsFor, type AssetStats, type Candle, type Range } from "../../invest/analytics";
import { affinity, rankNews, type Signal } from "../../invest/rank";
import { formatMoney } from "../../domain/money";
import { getProvider, ProviderUnavailable } from "../../ai/provider";
import { getPayoffPlan } from "../services/coach";
import { cached, peek } from "./cache";
import { getChart, getDaily, getQuote, isQuote, peekQuote, settleWithin, type QuoteResult } from "./market";
import { feedHealth, listNews, refreshNewsIfStale, type NewsItem } from "./news";
import { avSearch, keys, mfSearch, tdSearch } from "./providers";

// The Invest tab: what each person follows, prices for it, matched news, and AI context.

export const COUNTRY_CODES = ["IN", "CA", "WORLD"] as const;
export const zCountry = z.enum(COUNTRY_CODES);

export interface Profile {
  countries: CountryCode[];
  interests: Record<string, string[]>;
}

export async function getProfile(ctx: Ctx): Promise<Profile> {
  const [row] = await sql<{ countries: CountryCode[]; interests: Record<string, string[]> }[]>`select countries, interests from invest_profiles where user_id = ${ctx.userId}`;
  const countries = row?.countries?.length ? row.countries : (["IN", "CA", "WORLD"] as CountryCode[]);
  const interests: Record<string, string[]> = {};
  for (const c of COUNTRY_CODES) {
    const valid = new Set(COUNTRY_MAP.get(c)!.interests.map((i) => i.key));
    const saved = (row?.interests?.[c] ?? []).filter((k) => valid.has(k));
    interests[c] = saved.length ? saved : defaultInterests(c);
  }
  return { countries, interests };
}

export async function setProfile(ctx: Ctx, p: { countries?: CountryCode[]; country?: CountryCode; interests?: string[] }): Promise<Profile> {
  const cur = await getProfile(ctx);
  const countries = p.countries?.length ? [...new Set(p.countries)] : cur.countries;
  const interests = { ...cur.interests };
  if (p.country && p.interests) {
    const valid = new Set(COUNTRY_MAP.get(p.country)!.interests.map((i) => i.key));
    interests[p.country] = [...new Set(p.interests.filter((k) => valid.has(k)))];
    const added = interests[p.country].filter((k) => !cur.interests[p.country!].includes(k));
    for (const k of added) await track(ctx, "select_interest", k, [k]);
  }
  await sql`
    insert into invest_profiles (user_id, countries, interests) values (${ctx.userId}, ${sql.array(countries)}::text[], ${sql.json(interests as never)})
    on conflict (user_id) do update set countries = excluded.countries, interests = excluded.interests, updated_at = now()`;
  return { countries, interests };
}

// ------------------------------------------------------------------ watchlist & custom assets
export const WatchInput = z.object({
  key: z.string().min(2).max(120),
  name: z.string().min(1).max(160),
  country: zCountry,
  kind: z.enum(["stock", "etf", "index", "metal", "fx", "crypto", "rate", "fund"]),
  currency: z.string().min(1).max(8),
  symbols: z.object({ td: z.string().max(40).optional(), tdExchange: z.string().max(20).optional(), av: z.string().max(40).optional(), eod: z.string().max(40).optional(), mf: z.string().max(20).optional() }).strict(),
});

interface WatchRow {
  asset_key: string;
  name: string;
  country: CountryCode;
  kind: AssetKind;
  symbols: Asset["symbols"];
  currency: string;
}
const rowToAsset = (r: WatchRow): Asset => ({ key: r.asset_key, name: r.name, short: r.symbols.td ?? r.symbols.av ?? r.symbols.eod ?? r.name, country: r.country, kind: r.kind, currency: r.currency, symbols: r.symbols, words: [r.name.toLowerCase()] });

export async function watchlist(ctx: Ctx, country?: CountryCode): Promise<Asset[]> {
  const rows = country
    ? await sql<WatchRow[]>`select asset_key, name, country, kind, symbols, currency from invest_watchlist where user_id = ${ctx.userId} and country = ${country} order by created_at`
    : await sql<WatchRow[]>`select asset_key, name, country, kind, symbols, currency from invest_watchlist where user_id = ${ctx.userId} order by created_at`;
  return rows.map(rowToAsset);
}

export async function addWatch(ctx: Ctx, a: z.infer<typeof WatchInput>) {
  const cat = ASSET_MAP.get(a.key);
  // A search result saved from the asset screen arrives without symbols: recover them from its key.
  const symbols = !cat && !Object.keys(a.symbols).length ? (await resolveAsset(ctx, a.key)).symbols : a.symbols;
  const asset = cat ?? { ...a, symbols, short: a.name };
  await sql`
    insert into invest_watchlist (user_id, country, asset_key, name, kind, symbols, currency)
    values (${ctx.userId}, ${asset.country}, ${asset.key}, ${asset.name}, ${asset.kind}, ${sql.json((cat ? {} : symbols) as never)}, ${asset.currency})
    on conflict (user_id, asset_key) do nothing`;
  await track(ctx, "save", a.key, [a.key]);
}

export async function removeWatch(ctx: Ctx, key: string) {
  await sql`delete from invest_watchlist where user_id = ${ctx.userId} and asset_key = ${key}`;
  await track(ctx, "unsave", key, [key]);
}

/** Catalog asset, or one the user saved from search. */
export async function resolveAsset(ctx: Ctx, key: string): Promise<Asset> {
  const cat = ASSET_MAP.get(key);
  if (cat) return cat;
  const [row] = await sql<WatchRow[]>`select asset_key, name, country, kind, symbols, currency from invest_watchlist where user_id = ${ctx.userId} and asset_key = ${key}`;
  if (row) return rowToAsset(row);
  // An unsaved search result: key encodes provider + symbol.
  const m = /^(IN|CA|WORLD):x:(td|av|mf):(.+)$/.exec(key);
  if (m) {
    const [, country, prov, sym] = m;
    const [symbol, exchange] = sym.split("@");
    const symbols: Asset["symbols"] = prov === "td" ? { td: symbol, tdExchange: exchange } : prov === "av" ? { av: symbol } : { mf: symbol };
    return { key, name: symbol, short: symbol, country: country as CountryCode, kind: prov === "mf" ? "fund" : "stock", currency: country === "IN" ? "INR" : country === "CA" ? "CAD" : "USD", symbols };
  }
  throw new AppError("Unknown asset.", 404);
}

// ------------------------------------------------------------------ behaviour
export async function track(ctx: Ctx, kind: string, ref: string | null, tags: string[] = []) {
  await sql`insert into invest_events (user_id, kind, ref, tags) values (${ctx.userId}, ${kind}, ${ref}, ${sql.array(tags.slice(0, 12))}::text[])`;
}

export async function signals(ctx: Ctx): Promise<Signal[]> {
  const rows = await sql<{ kind: string; ref: string | null; tags: string[]; created_at: Date }[]>`
    select kind, ref, tags, created_at from invest_events where user_id = ${ctx.userId} and created_at > now() - interval '60 days' order by created_at desc limit 400`;
  return rows.map((r) => ({ kind: r.kind, ref: r.ref, tags: r.tags, at: r.created_at.toISOString() }));
}

// ------------------------------------------------------------------ overview
export interface AssetRow {
  key: string;
  name: string;
  short: string;
  kind: AssetKind;
  currency: string;
  unit?: string;
  quote: QuoteResult | null;
  spark: number[] | null;
}

async function sparkFor(a: Asset): Promise<number[] | null> {
  const d = await peek<{ candles: Candle[] }>(`d:${a.key}`);
  const c = d?.data.candles;
  return c && c.length > 2 ? c.slice(-30).map((x) => x.c) : null;
}

async function rows(assets: Asset[], live: boolean): Promise<AssetRow[]> {
  const quotes = live ? await settleWithin(assets, (a) => getQuote(a), { concurrency: 4, deadlineMs: 6000 }) : await Promise.all(assets.map(peekQuote));
  return Promise.all(
    assets.map(async (a, i) => ({ key: a.key, name: a.name, short: a.short, kind: a.kind, currency: a.currency, unit: a.unit, quote: quotes[i] ?? (await peekQuote(a)), spark: await sparkFor(a) })),
  );
}

export async function overview(ctx: Ctx, country: CountryCode) {
  const c = COUNTRY_MAP.get(country)!;
  const [profile, saved, sig] = await Promise.all([getProfile(ctx), watchlist(ctx, country), signals(ctx)]);
  const chosen = profile.interests[country];
  const pulseAssets = c.pulse.map((k) => ASSET_MAP.get(k)!).filter(Boolean);
  const sections = chosen.map((k) => interestOf(country, k)!).filter(Boolean);
  // Order sections by what they engage with most.
  const aff = affinity(sig);
  sections.sort((a, b) => (aff.get(b.key) ?? 0) - (aff.get(a.key) ?? 0));

  await refreshNewsIfStale(3000).catch((e) => logError("news.stale", e));
  const all = await listNews({ country, limit: 200 });
  const news = rankNews(all, { country, interests: chosen, affinity: aff, limit: 30 });

  const [pulse, sectionRows, savedRows] = await Promise.all([
    rows(pulseAssets, true),
    Promise.all(sections.map(async (s) => ({ interest: s.key, label: s.label, note: s.note ?? null, contextOnly: !!s.contextOnly, assets: await rows(s.assets.map((k) => ASSET_MAP.get(k)!).filter(Boolean), true) }))),
    rows(saved, true),
  ]);
  return {
    country,
    name: c.name,
    flag: c.flag,
    currency: c.currency,
    profile,
    interests: c.interests.map((i) => ({ key: i.key, label: i.label, selected: chosen.includes(i.key) })),
    pulse,
    sections: sectionRows.map((s) => ({ ...s, news: news.filter((n) => n.interests.includes(s.interest)).slice(0, 3) })),
    saved: savedRows,
    news,
    keys: { td: !!keys.td(), av: !!keys.av(), eod: !!keys.eod(), nyt: !!keys.nyt() },
    feeds: await feedHealth(),
    fetchedAt: new Date().toISOString(),
  };
}
export type InvestOverview = Awaited<ReturnType<typeof overview>>;

export async function quotesFor(ctx: Ctx, assetKeys: string[]): Promise<QuoteResult[]> {
  const assets = await Promise.all(assetKeys.slice(0, 30).map((k) => resolveAsset(ctx, k).catch(() => null)));
  const res = await settleWithin(assets, (a) => (a ? getQuote(a) : Promise.resolve(null as never)), { concurrency: 4, deadlineMs: 8000 });
  return res.filter(Boolean) as QuoteResult[];
}

// ------------------------------------------------------------------ asset detail
export async function assetDetail(ctx: Ctx, key: string, range: Range) {
  const a = await resolveAsset(ctx, key);
  const [quote, chart, daily, savedRow] = await Promise.all([
    getQuote(a),
    getChart(a, range).catch((e) => ({ candles: [] as Candle[], source: "", intraday: false, note: (e as Error).message })),
    getDaily(a, { long: range === "5Y" || range === "MAX" }).catch(() => null),
    sql`select 1 from invest_watchlist where user_id = ${ctx.userId} and asset_key = ${key}`,
  ]);
  const stats: AssetStats | null = daily?.candles.length ? statsFor(daily.candles) : null;
  const words = (a.words ?? [a.name.toLowerCase()]).filter((w) => w.length >= 3);
  const news = (await listNews({ country: a.country, tags: [a.key], interests: [], limit: 60 }))
    .concat((await listNews({ country: a.country, limit: 200 })).filter((n) => words.some((w) => n.title.toLowerCase().includes(w))))
    .filter((n, i, xs) => xs.findIndex((y) => y.id === n.id) === i)
    .slice(0, 8);
  await track(ctx, "view_asset", a.key, [a.key, a.kind]);
  return { asset: { key: a.key, name: a.name, short: a.short, kind: a.kind, currency: a.currency, unit: a.unit, country: a.country }, quote, chart, stats, news, saved: savedRow.length > 0, range };
}
export type AssetDetail = Awaited<ReturnType<typeof assetDetail>>;

// ------------------------------------------------------------------ search
export async function search(ctx: Ctx, q: string, country: CountryCode) {
  const query = q.trim().slice(0, 60);
  if (query.length < 2) return [];
  await track(ctx, "search", query.toLowerCase(), []);
  const out: z.infer<typeof WatchInput>[] = [];
  const cur = country === "IN" ? "INR" : country === "CA" ? "CAD" : "USD";
  const wantCountry = country === "IN" ? /india/i : country === "CA" ? /canada/i : /united states|^$/i;
  const [td, mf, av] = await Promise.all([
    tdSearch(query).catch(() => []),
    country === "IN" ? mfSearch(query).catch(() => []) : Promise.resolve([]),
    avSearch(query).catch(() => []),
  ]);
  for (const r of td.filter((r) => wantCountry.test(r.country)).slice(0, 10))
    out.push({ key: `${country}:x:td:${r.symbol}@${r.exchange}`, name: `${r.name} (${r.symbol}, ${r.exchange})`, country, kind: /etf/i.test(r.type) ? "etf" : /index/i.test(r.type) ? "index" : "stock", currency: r.currency || cur, symbols: { td: r.symbol, tdExchange: r.exchange } });
  const avRegion = country === "IN" ? /india|bombay|bse/i : country === "CA" ? /toronto/i : /united states/i;
  for (const r of av.filter((r) => avRegion.test(r.region)).slice(0, 8))
    if (!out.some((o) => o.name.includes(r.symbol.split(".")[0]))) out.push({ key: `${country}:x:av:${r.symbol}`, name: `${r.name} (${r.symbol})`, country, kind: /etf/i.test(r.type) ? "etf" : "stock", currency: r.currency || cur, symbols: { av: r.symbol } });
  for (const r of mf.slice(0, 12)) out.push({ key: `IN:x:mf:${r.code}`, name: r.name, country: "IN", kind: "fund", currency: "INR", symbols: { mf: r.code } });
  return out.slice(0);
}

// ------------------------------------------------------------------ AI insight
export interface Insight {
  summary: string;
  stance: "positive" | "neutral" | "cautious";
  points: string[];
  fit: string | null;
  risks: string[];
  model?: string;
  generatedAt: string;
}

const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

/** AI context for an asset or an interest. Every number it may use is computed and passed in; the reply is cached for 6 hours. */
export async function insight(ctx: Ctx, input: { country: CountryCode; key?: string; interest?: string }): Promise<Insight> {
  const day = new Date().toISOString().slice(0, 13);
  const cacheKey = `insight:${ctx.userId}:${input.country}:${input.key ?? `i-${input.interest}`}:${day}`;
  const r = await cached(cacheKey, 6 * 3600e3, async () => {
    const c = COUNTRY_MAP.get(input.country)!;
    const plan = await getPayoffPlan(ctx).catch(() => null);
    const budget = plan
      ? `Their budget (HARU records, ${ctx.currency}): take-home about ${formatMoney(plan.monthlyTakeHomeCents, ctx.currency)}/month, bills ${formatMoney(plan.monthlyBillsCents, ctx.currency)}, debt minimums ${formatMoney(plan.monthlyMinimumsCents, ctx.currency)}, free ${formatMoney(plan.surplusCents, ctx.currency)}/month.${plan.focus ? ` Current focus: paying off ${plan.focus.name} (${formatMoney(plan.focus.remainingCents, ctx.currency)} left).` : " No debts."}`
      : "Budget unknown.";
    let facts = "";
    let headlines: NewsItem[] = [];
    let subject = "";
    if (input.key) {
      const a = await resolveAsset(ctx, input.key);
      subject = `${a.name} (${a.short}) in ${c.name}`;
      const q = await getQuote(a);
      const d = await getDaily(a).catch(() => null);
      const s = d?.candles.length ? statsFor(d.candles) : null;
      facts = [
        isQuote(q) ? `Price ${q.price.toFixed(2)} ${a.currency}${a.unit ? ` ${a.unit}` : ""} (${q.freshness}, ${q.source}, as of ${q.asOf.slice(0, 10)}); day change ${q.changePct != null ? q.changePct.toFixed(2) + "%" : "n/a"}.` : `Price unavailable (${(q as { unavailable: string }).unavailable}).`,
        s ? `Returns: 1M ${pct(s.r1m)}, 6M ${pct(s.r6m)}, 1Y ${pct(s.r1y)}, 5Y ${pct(s.r5y)} (CAGR ${pct(s.cagr5y)}). 1Y volatility ${pct(s.vol1y)}, 1Y max drawdown ${pct(s.drawdown1y)}, 52-week range ${s.low52?.toFixed(2)}–${s.high52?.toFixed(2)}.` : "No price history available.",
      ].join(" ");
      headlines = (await listNews({ country: a.country, tags: [a.key], limit: 8 })).slice(0, 6);
    } else {
      const it = interestOf(input.country, input.interest ?? "")!;
      if (!it) throw new AppError("Unknown interest.");
      subject = `${it.label} in ${c.name}`;
      const qs = await Promise.all(it.assets.slice(0, 4).map((k) => getQuote(ASSET_MAP.get(k)!)));
      facts = [it.note ?? "", ...qs.filter(isQuote).map((q) => `${ASSET_MAP.get(q.key)!.name}: ${q.price.toFixed(2)} ${q.currency}${q.unit ? ` ${q.unit}` : ""}, day ${q.changePct?.toFixed(2) ?? "n/a"}%`)].filter(Boolean).join(" ");
      headlines = (await listNews({ country: input.country, interests: [it.key], limit: 10 })).slice(0, 8);
    }
    const system = `You are Haru, a careful financial assistant inside a budgeting app. You write short, plain-language market context for one person.
Rules: use ONLY the facts and headlines given. Never invent prices, dates or events. Don't promise returns. Don't tell them to buy or sell a specific amount; you may say what to watch and how it could fit their budget. If facts are missing, say so.
Return JSON only: {"summary": "2-3 sentences", "stance": "positive"|"neutral"|"cautious", "points": ["3 short bullets with the numbers given"], "fit": "1-2 sentences on how this fits their budget, or null", "risks": ["1-3 short risks"]}`;
    const prompt = `Subject: ${subject}
Facts (computed by HARU from market data): ${facts}
${budget}
Recent headlines (${headlines.length}): ${headlines.map((h) => `- ${h.title} (${h.source}, ${h.publishedAt.slice(0, 10)})`).join("\n") || "none"}`;
    let provider;
    try {
      provider = await getProvider();
    } catch (e) {
      throw new AppError(e instanceof ProviderUnavailable ? e.message : "AI isn't configured.", 503);
    }
    let text = "";
    try {
      const res = await provider.chat({ system, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], maxTokens: 2048 });
      text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    } catch (e) {
      throw new AppError(e instanceof ProviderUnavailable ? e.message : "Haru couldn't write this insight right now.", 503);
    }
    return parseInsight(text, (provider as { modelInUse?: string }).modelInUse);
  });
  await track(ctx, "ask", input.key ?? input.interest ?? null, [input.key ?? input.interest ?? ""].filter(Boolean));
  return r.data;
}

export function parseInsight(text: string, model?: string): Insight {
  const now = new Date().toISOString();
  try {
    const j = JSON.parse(text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1")) as Partial<Insight>;
    const stance = j.stance === "positive" || j.stance === "cautious" ? j.stance : "neutral";
    return {
      summary: String(j.summary ?? "").slice(0, 600) || "No summary.",
      stance,
      points: (Array.isArray(j.points) ? j.points : []).map(String).slice(0, 4),
      fit: j.fit ? String(j.fit).slice(0, 400) : null,
      risks: (Array.isArray(j.risks) ? j.risks : []).map(String).slice(0, 3),
      model,
      generatedAt: now,
    };
  } catch {
    return { summary: text.trim().slice(0, 600) || "Haru couldn't write this insight.", stance: "neutral", points: [], fit: null, risks: [], model, generatedAt: now };
  }
}

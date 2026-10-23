import "server-only";
import { z } from "zod";
import { sql } from "../db";
import type { Ctx } from "../context";
import { AppError, logError } from "../errors";
import { ASSET_MAP, type Asset } from "../../invest/catalog";
import { downsample, sliceRange } from "../../invest/analytics";
import { readRate } from "../../invest/plan";
import { buildPayoffPlan } from "../../domain/payoff";
import { payoffInputs } from "../services/coach";
import { getDaily, getQuote, isQuote } from "./market";
import { resolveAsset } from "./service";
import { cacheGet, cacheSet } from "./cache";

// Planners (SIP / goal, send-home) and price alerts.

// ------------------------------------------------------------------ planners
/** Everything the SIP and send-home planners need: the budget inputs (so "what if" runs on the phone) and the CAD→INR record. */
export async function planData(ctx: Ctx) {
  const inputs = await payoffInputs(ctx);
  const plan = buildPayoffPlan(inputs);
  const fxAsset = ASSET_MAP.get("IN:fx:CADINR")!;
  const [q, d] = await Promise.all([getQuote(fxAsset), getDaily(fxAsset).catch(() => null)]);
  const series = d ? sliceRange(d.candles, "1Y") : [];
  const read = readRate(series.map((c) => ({ t: c.t, c: c.c })));
  return {
    currency: ctx.currency,
    inputs,
    plan: { surplusCents: plan.surplusCents, monthlyTakeHomeCents: plan.monthlyTakeHomeCents, debtFreeDate: plan.debtFreeDate, focus: plan.focus ? { name: plan.focus.name, remainingCents: plan.focus.remainingCents, finishDate: plan.focus.finishDate } : null, warnings: plan.warnings },
    fx: {
      rate: isQuote(q) ? q.price : (read?.rate ?? null),
      asOf: isQuote(q) ? q.asOf : read ? new Date(read.asOf).toISOString() : null,
      source: isQuote(q) ? q.source : (d?.source ?? null),
      read,
      series: downsample(series, 120).map((c) => ({ t: c.t, c: c.c })),
    },
  };
}
export type PlanData = Awaited<ReturnType<typeof planData>>;

// ------------------------------------------------------------------ alerts
export const AlertInput = z.object({
  key: z.string().min(2).max(120),
  direction: z.enum(["above", "below"]),
  target: z.number().positive().finite(),
});

export interface AlertRow {
  id: number;
  assetKey: string;
  name: string;
  currency: string;
  unit: string | null;
  direction: "above" | "below";
  target: number;
  priceAtCreate: number | null;
  active: boolean;
  triggeredAt: string | null;
  triggeredPrice: number | null;
}

type DbAlert = { id: number; asset_key: string; name: string; currency: string; unit: string | null; direction: "above" | "below"; target: number; price_at_create: number | null; active: boolean; triggered_at: Date | null; triggered_price: number | null };
const toRow = (r: DbAlert): AlertRow => ({ id: Number(r.id), assetKey: r.asset_key, name: r.name, currency: r.currency, unit: r.unit, direction: r.direction, target: Number(r.target), priceAtCreate: r.price_at_create != null ? Number(r.price_at_create) : null, active: r.active, triggeredAt: r.triggered_at?.toISOString() ?? null, triggeredPrice: r.triggered_price != null ? Number(r.triggered_price) : null });

export async function listAlerts(ctx: Ctx, key?: string): Promise<AlertRow[]> {
  const rows = await sql<DbAlert[]>`
    select id, asset_key, name, currency, unit, direction, target, price_at_create, active, triggered_at, triggered_price
    from invest_alerts where user_id = ${ctx.userId} ${key ? sql`and asset_key = ${key}` : sql``}
      and (active or triggered_at > now() - interval '14 days')
    order by active desc, created_at desc limit 60`;
  return rows.map(toRow);
}

export async function addAlert(ctx: Ctx, input: z.infer<typeof AlertInput>): Promise<AlertRow> {
  const a = await resolveAsset(ctx, input.key);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from invest_alerts where user_id = ${ctx.userId} and active`;
  if (n >= 30) throw new AppError("You have 30 active alerts. Remove one first.");
  const q = await getQuote(a);
  const price = isQuote(q) ? q.price : null;
  // An alert that is already true would fire straight away: say so instead.
  if (price != null && (input.direction === "above" ? price >= input.target : price <= input.target))
    throw new AppError(`${a.name} is already ${input.direction} that (${price.toFixed(2)} now). Pick a price it hasn't reached yet.`);
  const [r] = await sql<DbAlert[]>`
    insert into invest_alerts (user_id, asset_key, name, currency, unit, asset, direction, target, price_at_create)
    values (${ctx.userId}, ${a.key}, ${a.name}, ${a.currency}, ${a.unit ?? null}, ${sql.json(a as never)}, ${input.direction}, ${input.target}, ${price})
    returning id, asset_key, name, currency, unit, direction, target, price_at_create, active, triggered_at, triggered_price`;
  return toRow(r);
}

export async function removeAlert(ctx: Ctx, id: number): Promise<void> {
  const r = await sql`delete from invest_alerts where id = ${id} and user_id = ${ctx.userId}`;
  if (!r.count) throw new AppError("That alert no longer exists.", 404);
}

const fmt = (v: number, currency: string) => {
  if (currency === "%") return `${v.toFixed(2)}%`;
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-CA", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: v < 10 ? 4 : 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
};

/**
 * Check every active alert against the latest price (shared, cached quotes: one lookup per asset)
 * and queue a notification for each one that crossed. Runs from the minute cron, at most every 5 minutes.
 */
export async function checkAlerts(opts: { force?: boolean; deadlineMs?: number } = {}): Promise<{ checked: number; fired: number }> {
  if (!opts.force) {
    const last = await cacheGet<number>("alerts:last-run");
    if (last && last.expiresAt > Date.now()) return { checked: 0, fired: 0 };
    await cacheSet("alerts:last-run", Date.now(), 5 * 60e3);
  }
  const deadline = Date.now() + (opts.deadlineMs ?? 15_000);
  const rows = await sql<(DbAlert & { user_id: string; asset: Asset })[]>`
    select id, user_id, asset_key, name, currency, unit, asset, direction, target, price_at_create, active, triggered_at, triggered_price
    from invest_alerts where active order by asset_key limit 2000`;
  type Row = (typeof rows)[number];
  const byAsset = new Map<string, Row[]>();
  for (const r of rows) byAsset.set(r.asset_key, [...(byAsset.get(r.asset_key) ?? []), r]);
  let checked = 0;
  let fired = 0;
  for (const [key, list] of byAsset) {
    if (Date.now() > deadline) break;
    const asset: Asset = ASSET_MAP.get(key) ?? (list[0].asset as Asset);
    let q;
    try {
      q = await getQuote(asset);
    } catch (e) {
      logError("alerts.quote", e);
      continue;
    }
    checked += list.length;
    if (!isQuote(q) || q.stale) continue;
    for (const r of list) {
      const target = Number(r.target);
      const hit = r.direction === "above" ? q.price >= target : q.price <= target;
      if (!hit) continue;
      const done = await sql`update invest_alerts set active = false, triggered_at = now(), triggered_price = ${q.price}, last_checked_at = now() where id = ${r.id} and active`;
      if (!done.count) continue; // another run got it
      const title = `${r.name} is ${r.direction} ${fmt(target, r.currency)}`.slice(0, 140);
      const body = `Now ${fmt(q.price, r.currency)}${r.unit ? ` ${r.unit}` : ""} (${q.source}). Your alert is done; set a new one in Invest.`;
      await sql`
        insert into reminders (user_id, category, title, body, url, fire_at, origin, source_type, dedupe_key)
        values (${r.user_id}, 'market', ${title}, ${body}, '/?view=invest', now(), 'user', 'alert', ${`alert:${r.id}`})
        on conflict (user_id, dedupe_key) do nothing`;
      fired++;
    }
    await sql`update invest_alerts set last_checked_at = now() where asset_key = ${key} and active`;
  }
  return { checked, fired };
}

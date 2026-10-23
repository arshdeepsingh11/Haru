// Invest tab server layer against a real, migrated PostgreSQL database (0006_invest).
//   HARU_TEST_DATABASE_URL=postgres://... npm run test:integration
// No market API keys are used: the point is that nothing invents a price when data isn't there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = process.env.HARU_TEST_DATABASE_URL;
for (const k of ["TWELVE_DATA_API_KEY", "ALPHA_VANTAGE_API_KEY", "EODHD_API_KEY", "NYT_API_KEY"]) delete process.env[k];

const skip = !process.env.HARU_TEST_DATABASE_URL;
const { sql } = await import("../../src/lib/server/db");
const { ctxForUser } = await import("../../src/lib/server/user-context");
const invest = await import("../../src/lib/server/invest/service");
const news = await import("../../src/lib/server/invest/news");
const cache = await import("../../src/lib/server/invest/cache");
const planning = await import("../../src/lib/server/invest/planning");
import type { Ctx } from "../../src/lib/server/user-context";

const U = randomUUID();
const V = randomUUID();
let u: Ctx;
let v: Ctx;
const tag = randomUUID().slice(0, 8);

before(async () => {
  if (skip) return;
  for (const id of [U, V]) {
    await sql`insert into app_users (id, email) values (${id}, ${`${id}@test.local`})`;
    await sql`insert into user_preferences (user_id, display_name, onboarded_at) values (${id}, 'Tester', now())`;
  }
  u = await ctxForUser(U);
  v = await ctxForUser(V);
  // Pretend the feeds were just pulled so tests never hit the network.
  await cache.cacheSet("news:refreshed", { at: new Date().toISOString() }, 15 * 60e3);
  const now = Date.now();
  const items = [
    { url: `https://t.local/${tag}/gold`, title: "Gold climbs to a record as rupee slips", source: "Mint", ago: 1, countries: ["IN", "WORLD"], interests: ["gold"], tags: ["IN:metal:GOLD10G"] },
    { url: `https://t.local/${tag}/rel`, title: "Reliance gains on retail outlook", source: "The Economic Times", ago: 2, countries: ["IN", "WORLD"], interests: ["stocks"], tags: ["IN:stock:RELIANCE"] },
    { url: `https://t.local/${tag}/boc`, title: "Bank of Canada holds rates", source: "CBC", ago: 3, countries: ["CA", "WORLD"], interests: ["gic"], tags: ["CA:rate:POLICY"] },
  ];
  for (const n of items)
    await sql`insert into news_items (url, source, feed, title, summary, lang, published_at, countries, interests, tags)
      values (${n.url}, ${n.source}, 'test', ${n.title}, null, 'en', ${new Date(now - n.ago * 3600e3)}, ${sql.array(n.countries)}::text[], ${sql.array(n.interests)}::text[], ${sql.array(n.tags)}::text[])`;
});

after(async () => {
  if (skip) return;
  await sql`delete from news_items where url like ${`https://t.local/${tag}/%`}`;
  await sql`delete from app_users where id in (${U}, ${V})`;
});

test("profile: defaults, then a saved choice per country", { skip }, async () => {
  const p = await invest.getProfile(u);
  assert.deepEqual([...p.countries].sort(), ["CA", "IN", "WORLD"]);
  assert.ok(p.interests.IN.includes("stocks"));
  const next = await invest.setProfile(u, { country: "IN", interests: ["gold", "real_estate"] });
  assert.deepEqual([...next.interests.IN].sort(), ["gold", "real_estate"]);
  assert.deepEqual([...(await invest.getProfile(u)).interests.IN].sort(), ["gold", "real_estate"]);
  // Another user is unaffected.
  assert.ok((await invest.getProfile(v)).interests.IN.includes("stocks"));
});

test("watchlist: save, list per country, isolate users, remove", { skip }, async () => {
  await invest.addWatch(u, { key: "IN:stock:RELIANCE", name: "Reliance Industries", country: "IN", kind: "stock", currency: "INR", symbols: {} });
  await invest.addWatch(u, { key: "IN:stock:RELIANCE", name: "Reliance Industries", country: "IN", kind: "stock", currency: "INR", symbols: {} }); // idempotent
  assert.deepEqual((await invest.watchlist(u, "IN")).map((a) => a.key), ["IN:stock:RELIANCE"]);
  assert.equal((await invest.watchlist(u, "CA")).length, 0);
  assert.equal((await invest.watchlist(v)).length, 0);
  await invest.removeWatch(u, "IN:stock:RELIANCE");
  assert.equal((await invest.watchlist(u)).length, 0);
});

test("resolveAsset: catalog, search keys, and junk", { skip }, async () => {
  assert.equal((await invest.resolveAsset(u, "IN:metal:GOLD10G")).currency, "INR");
  const s = await invest.resolveAsset(u, "WORLD:x:td:AMD@NASDAQ");
  assert.equal(s.symbols.td, "AMD");
  await assert.rejects(() => invest.resolveAsset(u, "nope"));
});

test("news: country + tag/interest filters use text[] overlap", { skip }, async () => {
  const gold = await news.listNews({ country: "IN", interests: ["gold"], limit: 50 });
  assert.ok(gold.some((n) => n.url.endsWith(`${tag}/gold`)));
  assert.ok(!gold.some((n) => n.url.endsWith(`${tag}/rel`)));
  const rel = await news.listNews({ country: "IN", tags: ["IN:stock:RELIANCE"], limit: 50 });
  assert.ok(rel.some((n) => n.url.endsWith(`${tag}/rel`)));
  const ca = await news.listNews({ country: "CA", limit: 200 });
  assert.ok(ca.some((n) => n.url.endsWith(`${tag}/boc`)) && !ca.some((n) => n.url.endsWith(`${tag}/gold`)));
});

test("signals: what you open ranks higher next time", { skip }, async () => {
  await invest.track(u, "open_news", `https://t.local/${tag}/rel`, ["IN:stock:RELIANCE", "stocks"]);
  await invest.track(u, "view_asset", "IN:stock:RELIANCE", ["IN:stock:RELIANCE", "stocks"]);
  const sig = await invest.signals(u);
  assert.ok(sig.length >= 2);
  assert.ok(sig.every((s) => typeof s.at === "string"));
});

test("cache: memory + table, stale data survives a failed refresh", { skip }, async () => {
  const key = `test:${tag}`;
  const first = await cache.cached(key, 1, async () => ({ price: 1 }));
  assert.equal(first.data.price, 1);
  await new Promise((r) => setTimeout(r, 5));
  const second = await cache.cached<{ price: number }>(key, 1, async () => {
    throw new Error("provider down");
  });
  assert.equal(second.data.price, 1);
  assert.equal(second.stale, true);
  await sql`delete from market_cache where key = ${key}`;
});

test("overview without API keys: news and structure, no invented prices", { skip, timeout: 60_000 }, async () => {
  const o = await invest.overview(u, "IN");
  assert.equal(o.country, "IN");
  assert.deepEqual(o.keys, { td: false, av: false, eod: false, nyt: false });
  assert.ok(o.sections.some((s) => s.interest === "gold"));
  assert.ok(o.sections.find((s) => s.interest === "real_estate")?.contextOnly);
  assert.ok(o.news.some((n) => n.url.endsWith(`${tag}/gold`)));
  for (const r of [...o.pulse, ...o.sections.flatMap((s) => s.assets)]) {
    const q = r.quote as { price?: number; source?: string; unavailable?: string } | null;
    if (q && typeof q.price === "number") assert.ok(q.source, `${r.key} has a price with a named source`);
  }
});

test("alerts: set, refuse one already true, fire once into the reminder queue", { skip }, async () => {
  const key = "WORLD:metal:XAU";
  const now = new Date().toISOString();
  // A fresh cached quote stands in for the market (no network in tests).
  await cache.cacheSet(`q:${key}`, { key, price: 2000, prevClose: 1990, change: 10, changePct: 0.5, asOf: now, source: "test", freshness: "live", stale: false, currency: "USD" }, 60e3);
  await assert.rejects(() => planning.addAlert(u, { key, direction: "above", target: 1500 }), /already above/);
  const a = await planning.addAlert(u, { key, direction: "above", target: 2100 });
  assert.equal(a.active, true);
  assert.equal(a.priceAtCreate, 2000);
  assert.equal((await planning.listAlerts(u, key)).length, 1);
  assert.equal((await planning.listAlerts(v)).length, 0, "other people never see it");

  let r = await planning.checkAlerts({ force: true });
  assert.equal(r.fired, 0, "not crossed yet");
  await cache.cacheSet(`q:${key}`, { key, price: 2105.5, prevClose: 2000, change: 105.5, changePct: 5.3, asOf: now, source: "test", freshness: "live", stale: false, currency: "USD" }, 60e3);
  r = await planning.checkAlerts({ force: true });
  assert.ok(r.fired >= 1);
  const [rem] = await sql<{ category: string; title: string; url: string }[]>`select category, title, url from reminders where user_id = ${U} and dedupe_key = ${`alert:${a.id}`}`;
  assert.equal(rem.category, "market");
  assert.match(rem.title, /Gold.*above/i);
  assert.equal(rem.url, "/?view=invest");
  const after = (await planning.listAlerts(u, key))[0];
  assert.equal(after.active, false);
  assert.equal(after.triggeredPrice, 2105.5);
  r = await planning.checkAlerts({ force: true });
  assert.equal(r.fired, 0, "fires only once");
  await planning.removeAlert(u, a.id);
  await assert.rejects(() => planning.removeAlert(u, a.id));
});

test("planners: budget inputs come back so the phone can run what-ifs", { skip, timeout: 60_000 }, async () => {
  const p = await planning.planData(u);
  assert.equal(p.currency, u.currency);
  assert.equal(typeof p.inputs.monthlyTakeHomeCents, "number");
  assert.ok(Array.isArray(p.inputs.debts));
  assert.equal(typeof p.plan.surplusCents, "number");
  assert.ok(Array.isArray(p.fx.series));
});

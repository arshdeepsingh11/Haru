import { test } from "node:test";
import assert from "node:assert/strict";
import { combineSeries, maxDrawdown, returnOver, sliceRange, statsFor, volatility, type Candle } from "../src/lib/invest/analytics";
import { parseFeed, stripHtml, tagNews } from "../src/lib/invest/news-parse";
import { affinity, rankNews } from "../src/lib/invest/rank";
import { ASSETS, COUNTRIES, defaultInterests } from "../src/lib/invest/catalog";
import { fmtChange, fmtPct, fmtPrice } from "../src/components/invest/format";

const DAY = 86400e3;
const T0 = Date.UTC(2026, 0, 1, 12);
const series = (closes: number[], start = T0): Candle[] => closes.map((c, i) => ({ t: start + i * DAY, o: c, h: c, l: c, c }));

test("invest: sliceRange keeps only the last N days", () => {
  const s = series(Array.from({ length: 400 }, (_, i) => 100 + i));
  const m = sliceRange(s, "1M");
  assert.equal(m[m.length - 1].c, 499);
  assert.equal(m.length, 32); // 31 days back + the last day
});

test("invest: returnOver uses the close on or before the target day", () => {
  const s = series(Array.from({ length: 40 }, (_, i) => 100 + i)); // 100..139
  assert.ok(Math.abs((returnOver(s, 30) ?? 0) - (139 / 109 - 1)) < 1e-12);
  assert.equal(returnOver(s, 365), null, "not enough history must be null, not a guess");
});

test("invest: volatility is zero for a constant growth rate and null for short series", () => {
  const s = series(Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i));
  assert.ok((volatility(s) ?? 1) < 1e-9);
  assert.equal(volatility(series([1, 2, 3])), null);
});

test("invest: max drawdown finds the worst fall from a peak", () => {
  assert.ok(Math.abs((maxDrawdown(series([100, 120, 90, 110, 60, 130])) ?? 0) - (60 / 120 - 1)) < 1e-12);
});

test("invest: gold per 10 g in INR = XAU/USD × USD/INR × 10/31.1035", () => {
  const xau = series([2000, 2100]);
  const usdinr = series([83, 84]);
  const out = combineSeries([{ candles: xau }, { candles: usdinr }], 10 / 31.1034768);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[1].c - (2100 * 84 * 10) / 31.1034768) < 1e-6);
});

test("invest: inverted series (INR→CAD into CAD→INR)", () => {
  const out = combineSeries([{ candles: series([0.016, 0.0165]), invert: true }]);
  assert.ok(Math.abs(out[0].c - 62.5) < 1e-9);
});

test("invest: stats report 52-week high/low from real closes", () => {
  const s = series(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 10) * 10));
  const st = statsFor(s);
  assert.ok(st.high52 != null && st.high52 <= 110 && st.high52 > 109);
  assert.ok(st.low52 != null && st.low52 >= 90 && st.low52 < 91);
});

test("invest: RSS and Atom parsing with entities, images and bad dates", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const rss = `<rss><channel><item><title><![CDATA[Sensex &amp; Nifty rise]]></title><link>https://ex.com/a</link><pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Banks &amp;amp; IT lead&lt;/p&gt;</description><media:content url="https://ex.com/a.jpg"/></item>
  <item><title>Future dated</title><link>https://ex.com/b</link><pubDate>Thu, 22 Oct 2099 10:00:00 GMT</pubDate></item></channel></rss>`;
  const items = parseFeed(rss, now);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Sensex & Nifty rise");
  assert.equal(items[0].url, "https://ex.com/a");
  assert.equal(items[0].image, "https://ex.com/a.jpg");
  assert.match(items[0].summary ?? "", /Banks & IT lead/);
  assert.equal(new Date(items[1].publishedAt).getTime(), now.getTime(), "future dates clamp to now");

  const atom = `<feed><entry><title>Gold hits record</title><link href="https://ex.com/g"/><updated>2026-10-21T08:00:00Z</updated><summary>Bullion up</summary></entry></feed>`;
  const a = parseFeed(atom, now);
  assert.equal(a[0].url, "https://ex.com/g");
  assert.equal(stripHtml("<b>a</b>  <i>b</i>"), "a b");
});

test("invest: tagging maps headlines to countries, interests and assets (incl. Hindi)", () => {
  const t = tagNews("Reliance shares jump as Sensex closes higher", null, ["IN"]);
  assert.ok(t.countries.includes("IN") && t.countries.includes("WORLD"));
  assert.ok(t.interests.includes("stocks"));
  assert.ok(t.tags.includes("IN:stock:RELIANCE"));
  const h = tagNews("सोना फिर महंगा, चांदी भी चढ़ी", null, ["IN"]);
  assert.ok(h.interests.includes("gold"), JSON.stringify(h));
  const c = tagNews("Bank of Canada cuts rate; TSX rallies", null, ["WORLD"]);
  assert.ok(c.countries.includes("CA"));
});

test("invest: affinity decays and ranking respects interests, recency and source diversity", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const a = affinity(
    [
      { kind: "save", ref: null, tags: ["gold"], at: new Date(now).toISOString() },
      { kind: "save", ref: null, tags: ["crypto"], at: new Date(now - 60 * DAY).toISOString() },
    ],
    now,
  );
  assert.ok((a.get("gold") ?? 0) > (a.get("crypto") ?? 0) * 10);

  const mk = (id: number, source: string, interests: string[], hoursAgo: number) => ({ id, source, publishedAt: new Date(now - hoursAgo * 3600e3).toISOString(), countries: ["IN", "WORLD"], interests, tags: [] });
  const items = [mk(1, "A", ["stocks"], 1), mk(2, "A", ["stocks"], 1), mk(3, "A", ["stocks"], 1), mk(4, "A", ["stocks"], 1), mk(5, "B", ["gold"], 3), mk(6, "C", [], 50)];
  const r = rankNews(items, { country: "IN", interests: ["gold"], affinity: a, now, limit: 4 });
  assert.equal(r[0].id, 5, "a gold story ranks first for a gold follower");
  assert.ok(r.filter((x) => x.source === "A").length <= 3, "no more than 3 per source at the top");
});

test("invest: catalog is consistent", () => {
  const keys = new Set(ASSETS.map((a) => a.key));
  assert.equal(keys.size, ASSETS.length, "asset keys are unique");
  for (const c of COUNTRIES) {
    for (const k of c.pulse) assert.ok(keys.has(k), `${c.code} pulse ${k} exists`);
    for (const i of c.interests) for (const k of i.assets) assert.ok(keys.has(k), `${c.code}/${i.key}: ${k} exists`);
    assert.ok(defaultInterests(c.code).length > 0);
  }
  for (const a of ASSETS) for (const p of a.derived?.parts ?? []) assert.ok(keys.has(p.key), `${a.key} part ${p.key} exists`);
});

test("invest: formatting (rupee grouping, small changes, percents)", () => {
  assert.equal(fmtPrice(1249.28, "INR"), "₹1,249.28");
  assert.equal(fmtPrice(1234567, "INR", { compact: true }), "₹12,34,567");
  assert.equal(fmtChange(-8.779, "INR"), "−₹8.78");
  assert.equal(fmtPct(0.1234, true), "+12.34%");
  assert.equal(fmtPrice(4.25, "%"), "4.25%");
});

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

// ------------------------------------------------------------------ NSE official files
import { deflateRawSync } from "node:zlib";
import { csvLine, isoDate, parseBhav, parseIndexCloses, recentIstDates, unzipFirst } from "../src/lib/invest/nse-parse";

function zipOf(name: string, text: string): Uint8Array {
  const data = deflateRawSync(Buffer.from(text));
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(text.length, 22);
  local.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(text.length, 24);
  cd.writeUInt16LE(nm.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdOff = local.length + nm.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nm.length, 12);
  eocd.writeUInt32LE(cdOff, 16);
  return new Uint8Array(Buffer.concat([local, nm, data, cd, nm, eocd]));
}

const UDIFF = `TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4
2026-10-23,2026-10-23,CM,NSE,STK,2885,INE002A01018,RELIANCE,EQ,,,,,"RELIANCE INDUSTRIES, LTD",1250.00,1262.40,1244.10,1258.65,1259.00,1249.28,,1258.65,,,1000,1,10,F1,1,,,,,
2026-10-23,2026-10-23,CM,NSE,STK,1,INE00,RELIANCE,BL,,,,,RELIANCE BLOCK,1.00,1.00,1.00,1.00,1.00,1.00,,1.00,,,1,1,1,F1,1,,,,,
2026-10-23,2026-10-23,CM,NSE,STK,2,INE01,NIFTYBEES,EQ,,,,,NIPPON NIFTY BEES,290.1,292,289.5,291.35,291.4,290.05,,291.35,,,5,1,1,F1,1,,,,,`;

test("nse: UDiFF bhavcopy → close, previous close and date; block deals ignored", () => {
  const b = parseBhav(UDIFF);
  assert.equal(b.RELIANCE.c, 1258.65);
  assert.equal(b.RELIANCE.prev, 1249.28);
  assert.equal(b.RELIANCE.date, "2026-10-23");
  assert.equal(b.NIFTYBEES.c, 291.35);
  assert.equal(Object.keys(b).length, 2);
});

test("nse: older bhavcopy layout still reads", () => {
  const old = `SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN,\nTCS,EQ,3000,3050,2990,3021.5,3020,2999,1,1,08-JUL-2024,1,INE467B01029,`;
  const b = parseBhav(old);
  assert.equal(b.TCS.c, 3021.5);
  assert.equal(b.TCS.date, "2024-07-08");
});

test("nse: zipped file round-trips", () => {
  const b = parseBhav(unzipFirst(zipOf("BhavCopy.csv", UDIFF)));
  assert.equal(b.RELIANCE.c, 1258.65);
});

test("nse: index closes give Nifty 50 with previous close from points change", () => {
  const csv = `Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\nNifty 50,23-10-2026,25800.10,25910.55,25750.00,25890.20,90.20,0.35,1,1,22,3.5,1.2\nNifty Bank,23-10-2026,57000,57500,56900,57410.75,-120.25,-0.21,1,1,15,2.1,0.9`;
  const b = parseIndexCloses(csv);
  assert.equal(b["nifty 50"].c, 25890.2);
  assert.ok(Math.abs((b["nifty 50"].prev ?? 0) - 25800) < 1e-6);
  assert.equal(b["nifty bank"].date, "2026-10-23");
});

test("nse: helpers", () => {
  assert.deepEqual(csvLine('a,"b, c",d'), ["a", "b, c", "d"]);
  assert.equal(isoDate("23-Oct-2026"), "2026-10-23");
  assert.equal(isoDate("garbage"), null);
  // Saturday 24 Oct 2026, 10:00 IST → weekdays only, newest first
  const d = recentIstDates(Date.parse("2026-10-24T04:30:00Z"), 4);
  assert.deepEqual(d, ["2026-10-23", "2026-10-22", "2026-10-21", "2026-10-20"]);
});

// ------------------------------------------------------------------ planners
import { monthlyFor, readRate, sip } from "../src/lib/invest/plan";

test("sip: ₹10,000/month for 10 years at 12% matches the annuity-due formula", () => {
  const r = sip({ monthly: 10000, years: 10, annualReturn: 0.12 });
  const i = Math.pow(1.12, 1 / 12) - 1;
  const expected = 10000 * ((Math.pow(1 + i, 120) - 1) / i) * (1 + i);
  assert.ok(Math.abs(r.value - expected) < 0.01);
  assert.equal(r.invested, 1_200_000);
  assert.equal(r.byYear.length, 10);
  assert.ok(Math.abs(r.gain - (r.value - r.invested)) < 1e-6);
});

test("sip: zero return keeps exactly what you put in; step-up raises later years", () => {
  assert.equal(sip({ monthly: 100, years: 2, annualReturn: 0 }).value, 2400);
  const s = sip({ monthly: 100, years: 2, annualReturn: 0, stepUp: 0.1 });
  assert.equal(Math.round(s.invested), 1200 + 1320);
});

test("sip: inflation turns the result into today's money", () => {
  const r = sip({ monthly: 100, years: 10, annualReturn: 0.05, inflation: 0.05 });
  assert.ok(Math.abs(r.real - r.value / Math.pow(1.05, 10)) < 1e-6);
});

test("goal: monthlyFor is the inverse of sip", () => {
  const m = monthlyFor(1_000_000, 10, 0.1);
  const back = sip({ monthly: m, years: 10, annualReturn: 0.1 }).value;
  assert.ok(Math.abs(back - 1_000_000) < 0.5);
  assert.equal(monthlyFor(1200, 1, 0), 100);
});

test("send-home: rate read compares today with the last 90 days, without forecasting", () => {
  const DAYMS = 86400e3;
  const base = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i * DAYMS, c: 60 + (i % 10) * 0.1 }));
  const high = readRate([...base, { t: T0 + 100 * DAYMS, c: 62 }])!;
  assert.equal(high.rate, 62);
  assert.ok((high.percentile90 ?? 0) > 0.95);
  assert.match(high.read, /Better than/);
  const low = readRate([...base, { t: T0 + 100 * DAYMS, c: 59 }])!;
  assert.match(low.read, /Weaker/);
  assert.equal(readRate([]), null);
  assert.match(readRate([{ t: T0, c: 61 }])!.read, /Not enough history/);
});

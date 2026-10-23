// Deterministic market maths: every number here is computed, never estimated by the AI.

export interface Candle {
  t: number; // epoch ms (UTC)
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Range = "1D" | "1W" | "1M" | "6M" | "1Y" | "5Y" | "MAX";
export const RANGES: Range[] = ["1D", "1W", "1M", "6M", "1Y", "5Y", "MAX"];
const DAY = 86400e3;
export const RANGE_DAYS: Record<Range, number> = { "1D": 1, "1W": 7, "1M": 31, "6M": 183, "1Y": 366, "5Y": 1827, MAX: 100000 };

/** Keep candles inside the range (ending at the latest candle), oldest first. */
export function sliceRange(candles: Candle[], range: Range): Candle[] {
  if (!candles.length) return [];
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const end = sorted[sorted.length - 1].t;
  const from = end - RANGE_DAYS[range] * DAY;
  return sorted.filter((c) => c.t >= from);
}

/** Return between the first and last close in a series, as a fraction (0.12 = +12%). */
export function periodReturn(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  const first = candles[0].c;
  const last = candles[candles.length - 1].c;
  return first > 0 ? last / first - 1 : null;
}

/** Return over the last `days` days of a daily series, or null if the history is shorter. */
export function returnOver(daily: Candle[], days: number): number | null {
  if (daily.length < 2) return null;
  const s = [...daily].sort((a, b) => a.t - b.t);
  const last = s[s.length - 1];
  const target = last.t - days * DAY;
  if (s[0].t > target + 4 * DAY) return null; // not enough history
  let base = s[0];
  for (const c of s) if (c.t <= target) base = c;
  return base.c > 0 ? last.c / base.c - 1 : null;
}

/** Annualised volatility from daily closes (sample standard deviation of log returns × √252). */
export function volatility(daily: Candle[]): number | null {
  const s = [...daily].sort((a, b) => a.t - b.t);
  if (s.length < 15) return null;
  const r: number[] = [];
  for (let i = 1; i < s.length; i++) if (s[i - 1].c > 0 && s[i].c > 0) r.push(Math.log(s[i].c / s[i - 1].c));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

/** Largest fall from a peak, as a negative fraction (−0.25 = fell 25% from its high). */
export function maxDrawdown(candles: Candle[]): number | null {
  const s = [...candles].sort((a, b) => a.t - b.t);
  if (s.length < 2) return null;
  let peak = s[0].c;
  let worst = 0;
  for (const c of s) {
    peak = Math.max(peak, c.c);
    if (peak > 0) worst = Math.min(worst, c.c / peak - 1);
  }
  return worst;
}

export function highLow(candles: Candle[]): { high: number; low: number } | null {
  if (!candles.length) return null;
  return { high: Math.max(...candles.map((c) => c.h)), low: Math.min(...candles.map((c) => c.l)) };
}

export interface AssetStats {
  r1m: number | null;
  r6m: number | null;
  r1y: number | null;
  r5y: number | null;
  cagr5y: number | null;
  vol1y: number | null;
  drawdown1y: number | null;
  high52: number | null;
  low52: number | null;
}

export function statsFor(daily: Candle[]): AssetStats {
  const last1y = sliceRange(daily, "1Y");
  const hl = highLow(last1y);
  const r5y = returnOver(daily, 1826);
  return {
    r1m: returnOver(daily, 30),
    r6m: returnOver(daily, 182),
    r1y: returnOver(daily, 365),
    r5y,
    cagr5y: r5y == null ? null : Math.pow(1 + r5y, 1 / 5) - 1,
    vol1y: volatility(last1y),
    drawdown1y: maxDrawdown(last1y),
    high52: hl?.high ?? null,
    low52: hl?.low ?? null,
  };
}

/** Multiply aligned series (by day) — e.g. gold in USD × USD/INR — with an optional factor. */
export function combineSeries(series: { candles: Candle[]; invert?: boolean }[], factor = 1): Candle[] {
  if (!series.length) return [];
  const dayKey = (t: number) => Math.floor(t / DAY);
  const maps = series.map((s) => {
    const m = new Map<number, Candle>();
    for (const c of s.candles) m.set(dayKey(c.t), c);
    return m;
  });
  const out: Candle[] = [];
  for (const [k, base] of maps[0]) {
    let o = 1,
      h = 1,
      l = 1,
      c = 1,
      ok = true;
    for (let i = 0; i < series.length; i++) {
      const x = maps[i].get(k);
      if (!x) {
        ok = false;
        break;
      }
      if (series[i].invert) {
        o *= 1 / x.o;
        h *= 1 / x.l;
        l *= 1 / x.h;
        c *= 1 / x.c;
      } else {
        o *= x.o;
        h *= x.h;
        l *= x.l;
        c *= x.c;
      }
    }
    if (ok) out.push({ t: base.t, o: o * factor, h: h * factor, l: l * factor, c: c * factor });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Down-sample long series for drawing (keeps first/last and extremes per bucket). */
export function downsample(candles: Candle[], max = 400): Candle[] {
  if (candles.length <= max) return candles;
  const size = Math.ceil(candles.length / max);
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += size) {
    const chunk = candles.slice(i, i + size);
    out.push({ t: chunk[0].t, o: chunk[0].o, h: Math.max(...chunk.map((c) => c.h)), l: Math.min(...chunk.map((c) => c.l)), c: chunk[chunk.length - 1].c });
  }
  return out;
}

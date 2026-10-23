// SIP / goal maths and the send-home rate read. Pure and deterministic: the UI and Haru both use these.

export interface SipInput {
  /** amount invested each month (any currency unit) */
  monthly: number;
  years: number;
  /** expected yearly return, as a fraction (0.12 = 12%) — an assumption, never a promise */
  annualReturn: number;
  /** raise the monthly amount once a year by this fraction (0.1 = +10% a year) */
  stepUp?: number;
  /** yearly inflation for the "in today's money" figure */
  inflation?: number;
  /** months to wait before starting (e.g. until debts are cleared); the money still has `years` to grow after that */
  delayMonths?: number;
  /** lump sum already invested at the start */
  start?: number;
}

export interface SipYear {
  year: number;
  invested: number;
  value: number;
}

export interface SipResult {
  invested: number;
  value: number;
  gain: number;
  /** value in today's money after inflation */
  real: number;
  byYear: SipYear[];
}

const monthlyRate = (annual: number) => Math.pow(1 + annual, 1 / 12) - 1;

/**
 * Future value of a monthly SIP, invested at the start of each month (how Indian SIPs and most
 * pre-authorised contributions work), compounding monthly at the equivalent of the yearly rate.
 */
export function sip(i: SipInput): SipResult {
  const months = Math.max(0, Math.round(i.years * 12));
  const r = monthlyRate(i.annualReturn);
  let value = Math.max(0, i.start ?? 0);
  let invested = value;
  let pay = Math.max(0, i.monthly);
  const byYear: SipYear[] = [];
  for (let m = 0; m < months; m++) {
    if (m > 0 && m % 12 === 0) pay *= 1 + (i.stepUp ?? 0);
    value = (value + pay) * (1 + r);
    invested += pay;
    if ((m + 1) % 12 === 0 || m === months - 1) byYear.push({ year: Math.ceil((m + 1) / 12), invested, value });
  }
  const totalYears = (months + Math.max(0, i.delayMonths ?? 0)) / 12;
  const real = value / Math.pow(1 + (i.inflation ?? 0), totalYears);
  return { invested, value, gain: value - invested, real, byYear };
}

/** Monthly amount needed to reach `target` in `years` (no step-up). */
export function monthlyFor(target: number, years: number, annualReturn: number, start = 0): number {
  const months = Math.max(1, Math.round(years * 12));
  const r = monthlyRate(annualReturn);
  const startGrown = start * Math.pow(1 + r, months);
  const need = Math.max(0, target - startGrown);
  if (r === 0) return need / months;
  // FV of an annuity-due: P × ((1+r)^n − 1) / r × (1+r)
  const factor = ((Math.pow(1 + r, months) - 1) / r) * (1 + r);
  return need / factor;
}

export interface RateRead {
  rate: number;
  asOf: number;
  avg30: number | null;
  avg90: number | null;
  /** share of the last 90 days with a lower rate (0..1): higher = today is a better day to send */
  percentile90: number | null;
  high1y: number | null;
  low1y: number | null;
  /** plain-language read, no forecast */
  read: string;
}

/** Where today's rate sits against recent history. Describes the past only; it is not a forecast. */
export function readRate(series: { t: number; c: number }[], digits = 2): RateRead | null {
  const s = [...series].filter((x) => Number.isFinite(x.c) && x.c > 0).sort((a, b) => a.t - b.t);
  if (!s.length) return null;
  const last = s[s.length - 1];
  const since = (days: number) => s.filter((x) => x.t > last.t - days * 86400e3);
  const avg = (xs: { c: number }[]) => (xs.length ? xs.reduce((a, x) => a + x.c, 0) / xs.length : null);
  const d30 = since(31);
  const d90 = since(92);
  const y1 = since(366);
  const pct = d90.length >= 20 ? d90.filter((x) => x.c < last.c).length / d90.length : null;
  const avg90 = avg(d90);
  const f = (v: number) => v.toFixed(digits);
  let read = "Not enough history yet to compare.";
  if (pct != null && avg90 != null) {
    const diff = (last.c / avg90 - 1) * 100;
    read =
      pct >= 0.8
        ? `Better than ${Math.round(pct * 100)}% of the last 90 days (${f(last.c)} vs a ${f(avg90)} average). A good day to send if you were going to anyway.`
        : pct <= 0.2
          ? `Weaker than most of the last 90 days (${f(last.c)} vs a ${f(avg90)} average, ${diff.toFixed(1)}%). If it isn't urgent, waiting a little has often helped, but rates can keep falling.`
          : `About average for the last 90 days (${f(last.c)} vs ${f(avg90)}). Timing makes little difference right now; sending on payday is fine.`;
  }
  return { rate: last.c, asOf: last.t, avg30: avg(d30), avg90, percentile90: pct, high1y: y1.length ? Math.max(...y1.map((x) => x.c)) : null, low1y: y1.length ? Math.min(...y1.map((x) => x.c)) : null, read };
}

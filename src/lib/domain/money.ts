// All money in HARU is integer cents. Floats never touch a stored amount.

export type Cents = number;

/** Parse "1,234.56", "$42", 42, 42.5 → cents. Throws on garbage or > 2 decimals. */
export function toCents(input: number | string): Cents {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("Amount must be a finite number");
    // Round via string to avoid 0.1+0.2 artefacts (e.g. 19.99*100 = 1998.9999…)
    return Math.round(Number(input.toFixed(4)) * 100);
  }
  const s = input.replace(/[\s,$€£¥]/g, "").replace(/^CAD|^USD/i, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Not a valid amount: "${input}"`);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function fromCents(c: Cents): number {
  return c / 100;
}

/** Round half away from zero (matches PostgreSQL round(numeric)). */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function percentOf(c: Cents, percent: number): Cents {
  return roundHalfAway((c * percent) / 100);
}

/** Gross for a duration at an hourly rate. Must equal the DB check constraint. */
export function grossFor(paidMinutes: number, rateCentsPerHour: number): Cents {
  return roundHalfAway((paidMinutes * rateCentsPerHour) / 60);
}

export function formatMoney(c: Cents, currency = "CAD", opts: { signed?: boolean; compact?: boolean } = {}): string {
  const f = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: opts.compact && Math.abs(c) >= 100000 ? 0 : 2,
    maximumFractionDigits: opts.compact && Math.abs(c) >= 100000 ? 0 : 2,
  });
  const s = f.format(c / 100);
  return opts.signed && c > 0 ? `+${s}` : s;
}

export function formatHours(minutes: number): string {
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, "")} h`;
}

export function sum(xs: Cents[]): Cents {
  return xs.reduce((a, b) => a + b, 0);
}

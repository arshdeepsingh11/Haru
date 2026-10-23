// Formatting for market numbers: rupees in lakh/crore grouping, rates as %, tiny prices with more decimals.

export function fmtPrice(v: number | null | undefined, currency: string, opts: { compact?: boolean; digits?: number } = {}): string {
  if (v == null || !Number.isFinite(v)) return "–";
  if (currency === "%") return `${v.toFixed(2)}%`;
  const digits = opts.digits ?? (Math.abs(v) < 1 ? 4 : Math.abs(v) < 10 ? 3 : 2);
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-CA", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: opts.compact && Math.abs(v) >= 1000 ? 0 : digits,
      minimumFractionDigits: opts.compact && Math.abs(v) >= 1000 ? 0 : Math.min(2, digits),
    }).format(v);
  } catch {
    return `${v.toFixed(digits)} ${currency}`;
  }
}

export function fmtPct(v: number | null | undefined, fraction = false): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const p = fraction ? v * 100 : v;
  return `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export function fmtChange(v: number | null | undefined, currency: string): string {
  if (v == null || !Number.isFinite(v)) return "";
  if (currency === "%") return `${v > 0 ? "+" : ""}${v.toFixed(2)} pts`;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtPrice(Math.abs(v), currency, Math.abs(v) >= 0.1 ? { digits: 2 } : {})}`;
}

export function freshnessLabel(q: { freshness: string; asOf: string; stale?: boolean; source: string }): string {
  const d = new Date(q.asOf);
  const day = d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const base =
    q.freshness === "live"
      ? mins <= 2
        ? "Live"
        : mins < 60
          ? `${mins} min ago`
          : `As of ${d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      : q.freshness === "delayed"
        ? "15 min delayed"
        : q.freshness === "official"
          ? `Official, ${day}`
          : `Close, ${day}`;
  return `${base}${q.stale ? " (saved)" : ""} · ${q.source}`;
}

export function timeAgo(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

import { formatMoney } from "./money";
import { addDays, type ISODate, localDate, localParts } from "./time";

// Evidence-based observations. No observation is produced from a single event;
// small samples are labelled "hypothesis", larger consistent ones "observed".

export interface Observation {
  kind: string;
  statement: string;
  basis: string;
  confidence: "observed" | "hypothesis";
  evidence: Record<string, unknown>;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function observeDeclineThreshold(
  opps: { status: string; offered_cents: number; expected_minutes: number | null }[],
  currency: string,
): Observation | null {
  const rate = (o: { offered_cents: number; expected_minutes: number | null }) =>
    o.expected_minutes ? Math.round((o.offered_cents * 60) / o.expected_minutes) : null;
  const declined = opps.filter((o) => o.status === "declined").map(rate).filter((r): r is number => r != null);
  const taken = opps
    .filter((o) => ["accepted", "scheduled", "completed"].includes(o.status))
    .map(rate)
    .filter((r): r is number => r != null);
  if (declined.length < 3) return null;
  const maxDeclined = Math.max(...declined);
  const minTaken = taken.length ? Math.min(...taken) : null;
  if (minTaken != null && maxDeclined >= minTaken) return null; // no clean pattern
  const m = (c: number) => formatMoney(c, currency);
  return {
    kind: "decline_threshold",
    statement:
      minTaken != null
        ? `You tend to turn down one-time work under about ${m(minTaken)}/h.`
        : `You've declined every one-time offer so far; the best paid ${m(maxDeclined)}/h.`,
    basis: `${declined.length} declined offers (highest ${m(maxDeclined)}/h)${minTaken != null ? `; ${taken.length} accepted at ${m(minTaken)}/h or more` : ""}.`,
    confidence: declined.length >= 5 ? "observed" : "hypothesis",
    evidence: { declined: declined.length, accepted: taken.length, maxDeclinedCents: maxDeclined, minAcceptedCents: minTaken },
  };
}

export function observeLoggingTime(
  shifts: { status: string; source: string; work_date: ISODate; created_at: Date }[],
  tz: string,
  currentPref: string,
): Observation | null {
  // Same-day evening logs of completed work.
  const hours = shifts
    .filter((s) => s.status === "completed" && s.source !== "schedule" && localDate(s.created_at, tz) === s.work_date)
    .map((s) => localParts(s.created_at, tz).hour)
    .filter((h) => h >= 17);
  if (hours.length < 4) return null;
  const h = median(hours);
  const pref = Number(currentPref.slice(0, 2));
  if (Math.abs(h - pref) < 1) return null;
  const hh = `${String(h).padStart(2, "0")}:00`;
  return {
    kind: "logging_time",
    statement: `You usually log your hours around ${hh}. A reminder at ${hh} may suit you better than ${currentPref}.`,
    basis: `${hours.length} evening logs, median hour ${hh}.`,
    confidence: hours.length >= 8 ? "observed" : "hypothesis",
    evidence: { samples: hours.length, suggestedTime: hh },
  };
}

export function observePostPaydaySaving(
  paychecks: { pay_date: ISODate; status: string }[],
  contributions: { contributed_on: ISODate; amount_cents: number }[],
  currency: string,
): Observation | null {
  const received = paychecks.filter((p) => p.status === "received");
  if (received.length < 2) return null;
  const matched: number[] = [];
  for (const p of received) {
    const c = contributions.find((c) => c.amount_cents > 0 && c.contributed_on >= p.pay_date && c.contributed_on <= addDays(p.pay_date, 2));
    if (c) matched.push(c.amount_cents);
  }
  if (matched.length < 2 || matched.length / received.length < 2 / 3) return null;
  const typical = median(matched);
  return {
    kind: "post_payday_saving",
    statement: `After payday you usually set aside about ${formatMoney(typical, currency)} for your goals.`,
    basis: `${matched.length} of your last ${received.length} paychecks were followed within 2 days by a goal contribution.`,
    confidence: matched.length >= 4 ? "observed" : "hypothesis",
    evidence: { matched: matched.length, received: received.length, typicalCents: typical },
  };
}

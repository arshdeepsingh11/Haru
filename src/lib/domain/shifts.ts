import { grossFor } from "./money";
import { addDays, type ISODate, parseTime, zonedToUtc } from "./time";

export interface WageRow {
  rate_cents: number;
  effective_from: ISODate;
}

/** Wage applicable on a date: the latest effective_from <= date (falls back to the earliest). */
export function rateForDate(wages: WageRow[], date: ISODate): number | null {
  if (wages.length === 0) return null;
  const sorted = [...wages].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  let rate = sorted[0].rate_cents;
  for (const w of sorted) if (w.effective_from <= date) rate = w.rate_cents;
  return rate;
}

export interface TimedShift {
  startsAt: Date;
  endsAt: Date;
  paidMinutes: number;
  overnight: boolean;
}

/**
 * Resolve "4 PM to 11 PM with a 30-minute break" into instants and paid minutes.
 * Overnight shifts (end <= start) finish the next calendar day. Uses real instants,
 * so a shift spanning a DST change is paid for the hours actually worked.
 */
export function shiftFromTimes(workDate: ISODate, start: string, end: string, breakMinutes: number, tz: string): TimedShift {
  if (breakMinutes < 0) throw new Error("Break cannot be negative");
  const s = parseTime(start);
  const e = parseTime(end);
  const overnight = e.hour * 60 + e.minute <= s.hour * 60 + s.minute;
  const startsAt = zonedToUtc(workDate, start, tz);
  const endsAt = zonedToUtc(overnight ? addDays(workDate, 1) : workDate, end, tz);
  const worked = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000);
  const paidMinutes = worked - breakMinutes;
  if (paidMinutes <= 0) throw new Error("The break is as long as the shift — nothing to pay");
  if (paidMinutes > 1440) throw new Error("A shift cannot exceed 24 paid hours");
  return { startsAt, endsAt, paidMinutes, overnight };
}

export function hoursToMinutes(hours: number): number {
  if (!(hours > 0) || hours > 24) throw new Error("Hours must be between 0 and 24");
  return Math.round(hours * 60);
}

export function shiftEarnings(paidMinutes: number, rateCents: number) {
  return { paidMinutes, rateCents, grossCents: grossFor(paidMinutes, rateCents) };
}

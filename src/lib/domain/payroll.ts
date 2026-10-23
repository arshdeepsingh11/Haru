import { percentOf, type Cents } from "./money";
import {
  addDays,
  daysInMonth,
  diffDays,
  endOfMonth,
  type ISODate,
  makeDate,
  splitDate,
  startOfMonth,
  weekdayOf,
} from "./time";

export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";
export type WeekendRule = "none" | "previous_business_day" | "next_business_day";

export interface PayRule {
  frequency: PayFrequency;
  anchorDate?: ISODate | null; // first day of any known period (weekly/biweekly)
  splitDay?: number; // semimonthly: first period is 1..splitDay
  paydayOffsetDays: number; // payday = period end + offset
  weekendRule: WeekendRule;
}

export interface PayPeriod {
  start: ISODate;
  end: ISODate;
  payDate: ISODate;
}

export function validateRule(rule: PayRule): string | null {
  if ((rule.frequency === "weekly" || rule.frequency === "biweekly") && !rule.anchorDate)
    return "Weekly and biweekly pay need the start date of any one pay period.";
  if (rule.paydayOffsetDays < 0 || rule.paydayOffsetDays > 31) return "Payday offset must be 0–31 days.";
  return null;
}

export function periodContaining(rule: PayRule, date: ISODate): { start: ISODate; end: ISODate } {
  switch (rule.frequency) {
    case "weekly":
    case "biweekly": {
      const len = rule.frequency === "weekly" ? 7 : 14;
      const anchor = rule.anchorDate!;
      const idx = Math.floor(diffDays(anchor, date) / len);
      const start = addDays(anchor, idx * len);
      return { start, end: addDays(start, len - 1) };
    }
    case "semimonthly": {
      const split = rule.splitDay ?? 15;
      const { year, month, day } = splitDate(date);
      return day <= split
        ? { start: makeDate(year, month, 1), end: makeDate(year, month, split) }
        : { start: makeDate(year, month, split + 1), end: makeDate(year, month, daysInMonth(year, month)) };
    }
    case "monthly":
      return { start: startOfMonth(date), end: endOfMonth(date) };
  }
}

export function adjustForWeekend(date: ISODate, rule: WeekendRule): ISODate {
  if (rule === "none") return date;
  let d = date;
  const step = rule === "previous_business_day" ? -1 : 1;
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, step);
  return d;
}

export function payDateFor(rule: PayRule, period: { end: ISODate }): ISODate {
  return adjustForWeekend(addDays(period.end, rule.paydayOffsetDays), rule.weekendRule);
}

export function periodWithPayDate(rule: PayRule, date: ISODate): PayPeriod {
  const p = periodContaining(rule, date);
  return { ...p, payDate: payDateFor(rule, p) };
}

/** Consecutive periods starting with the one containing `from`. */
export function periodsFrom(rule: PayRule, from: ISODate, count: number): PayPeriod[] {
  const out: PayPeriod[] = [];
  let d = from;
  for (let i = 0; i < count; i++) {
    const p = periodWithPayDate(rule, d);
    out.push(p);
    d = addDays(p.end, 1);
  }
  return out;
}

/** The first period (earliest pay date) whose pay date is on or after `today`. */
export function nextPayPeriod(rule: PayRule, today: ISODate): PayPeriod {
  // Start ~2 months back: a period that ended earlier may still pay today or later.
  const candidates = periodsFrom(rule, addDays(today, -62), 20);
  const next = candidates.filter((p) => p.payDate >= today).sort((a, b) => (a.payDate < b.payDate ? -1 : 1))[0];
  if (!next) throw new Error("Could not determine the next pay period");
  return next;
}

/** All periods whose pay date falls in [start, end]. */
export function periodsPaidBetween(rule: PayRule, start: ISODate, end: ISODate): PayPeriod[] {
  const span = Math.max(1, Math.ceil(diffDays(start, end) / 7) + 12);
  return periodsFrom(rule, addDays(start, -62), span).filter((p) => p.payDate >= start && p.payDate <= end);
}

export interface ShiftLike {
  status: "scheduled" | "completed" | "cancelled";
  gross_cents: number;
  paid_minutes: number;
}

export interface PaycheckForecast {
  loggedGrossCents: Cents;
  loggedMinutes: number;
  scheduledGrossCents: Cents;
  scheduledMinutes: number;
  expectedGrossCents: Cents;
  knownDeductionsCents: Cents | null;
  expectedNetCents: Cents | null;
  reserveEstimateCents: Cents;
  periodClosed: boolean;
  uncertainty: string[];
}

export function forecastPaycheck(input: {
  period: PayPeriod;
  today: ISODate;
  shifts: ShiftLike[];
  deductionPercent: number | null;
  deductionFixedCents: number | null;
  reservePercent: number;
}): PaycheckForecast {
  const logged = input.shifts.filter((s) => s.status === "completed");
  const scheduled = input.shifts.filter((s) => s.status === "scheduled");
  const loggedGrossCents = logged.reduce((a, s) => a + s.gross_cents, 0);
  const scheduledGrossCents = scheduled.reduce((a, s) => a + s.gross_cents, 0);
  const expectedGrossCents = loggedGrossCents + scheduledGrossCents;
  const periodClosed = input.today > input.period.end;

  const hasDeductions = input.deductionPercent != null || input.deductionFixedCents != null;
  const knownDeductionsCents = hasDeductions
    ? Math.min(
        expectedGrossCents,
        percentOf(expectedGrossCents, input.deductionPercent ?? 0) + (expectedGrossCents > 0 ? input.deductionFixedCents ?? 0 : 0),
      )
    : null;

  const uncertainty: string[] = [];
  if (!hasDeductions) uncertainty.push("Payroll deductions are unknown, so this is gross pay, not take-home.");
  else uncertainty.push("Deductions are your own estimate, not your employer's payroll calculation.");
  if (scheduled.length > 0)
    uncertainty.push(`${scheduled.length} scheduled shift${scheduled.length > 1 ? "s are" : " is"} included but not yet worked.`);
  if (!periodClosed) uncertainty.push("The pay period is still open — more hours may be added.");
  if (expectedGrossCents === 0) uncertainty.push("No hours are recorded for this pay period yet.");

  return {
    loggedGrossCents,
    loggedMinutes: logged.reduce((a, s) => a + s.paid_minutes, 0),
    scheduledGrossCents,
    scheduledMinutes: scheduled.reduce((a, s) => a + s.paid_minutes, 0),
    expectedGrossCents,
    knownDeductionsCents,
    expectedNetCents: knownDeductionsCents == null ? null : expectedGrossCents - knownDeductionsCents,
    reserveEstimateCents: percentOf(expectedGrossCents, input.reservePercent),
    periodClosed,
    uncertainty,
  };
}

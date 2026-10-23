import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, grossFor, percentOf, toCents } from "../src/lib/domain/money";
import { addMonths, localDate, localTime, startOfWeek, todayIn, tzOffsetMs, zonedToUtc } from "../src/lib/domain/time";
import { hoursToMinutes, rateForDate, shiftFromTimes } from "../src/lib/domain/shifts";
import { forecastPaycheck, nextPayPeriod, periodContaining, periodWithPayDate, type PayRule } from "../src/lib/domain/payroll";
import { canTransition, evaluateOpportunity } from "../src/lib/domain/opportunity";
import { nextOccurrence } from "../src/lib/domain/recurrence";
import { resolveRange } from "../src/lib/domain/ranges";
import { affordability, computePosition } from "../src/lib/domain/position";
import { buildReport, reportToCsv } from "../src/lib/domain/report";
import { planAutoReminders } from "../src/lib/domain/reminders";
import { observeDeclineThreshold, observePostPaydaySaving } from "../src/lib/domain/observations";

const TZ = "America/Edmonton";

test("money: parsing and float safety", () => {
  assert.equal(toCents("1,234.56"), 123456);
  assert.equal(toCents("$42"), 4200);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.throws(() => toCents("12.345"));
  assert.throws(() => toCents("abc"));
  assert.equal(percentOf(10000, 5), 500);
  assert.match(formatMoney(13000, "CAD"), /\$130\.00/);
});

test("spec: 4 PM–11 PM with 30-min unpaid break at $20/h = 6.5 h, $130", () => {
  const s = shiftFromTimes("2026-10-22", "16:00", "23:00", 30, TZ);
  assert.equal(s.paidMinutes, 390);
  assert.equal(grossFor(s.paidMinutes, 2000), 13000);
  assert.equal(localTime(s.startsAt, TZ), "16:00");
  assert.equal(s.startsAt.toISOString(), "2026-10-22T22:00:00.000Z"); // MDT = UTC-6
});

test("spec: 7.5 hours and 6 hours convert exactly", () => {
  assert.equal(hoursToMinutes(7.5), 450);
  assert.equal(grossFor(hoursToMinutes(6), 1850), 11100);
  assert.throws(() => hoursToMinutes(0));
  assert.throws(() => hoursToMinutes(25));
});

test("overnight shift ends the next day", () => {
  const s = shiftFromTimes("2026-10-22", "22:00", "06:00", 0, TZ);
  assert.equal(s.overnight, true);
  assert.equal(s.paidMinutes, 480);
  assert.equal(localDate(s.endsAt, TZ), "2026-10-23");
});

test("DST fall-back (Nov 1 2026): overnight shift is paid for 9 real hours", () => {
  const s = shiftFromTimes("2026-10-31", "22:00", "06:00", 0, TZ);
  assert.equal(s.paidMinutes, 540);
  assert.equal(tzOffsetMs(new Date("2026-10-31T12:00:00Z"), TZ), -6 * 3600e3);
  assert.equal(tzOffsetMs(new Date("2026-11-02T12:00:00Z"), TZ), -7 * 3600e3);
});

test("DST spring-forward (Mar 8 2026): 9 AM is UTC-6 after, 9 AM is UTC-7 before", () => {
  assert.equal(zonedToUtc("2026-03-07", "09:00", TZ).toISOString(), "2026-03-07T16:00:00.000Z");
  assert.equal(zonedToUtc("2026-03-08", "09:00", TZ).toISOString(), "2026-03-08T15:00:00.000Z");
  // 02:30 does not exist that day → resolves to 03:30 MDT
  assert.equal(localTime(zonedToUtc("2026-03-08", "02:30", TZ), TZ), "03:30");
});

test("local 'today' respects time zone, not UTC", () => {
  // 01:30 UTC on Oct 23 is still 19:30 Oct 22 in Edmonton
  assert.equal(todayIn(TZ, new Date("2026-10-23T01:30:00Z")), "2026-10-22");
});

test("wage history: shift uses the rate effective on its date", () => {
  const wages = [
    { rate_cents: 1800, effective_from: "2026-01-01" },
    { rate_cents: 2000, effective_from: "2026-10-01" },
  ];
  assert.equal(rateForDate(wages, "2026-09-30"), 1800);
  assert.equal(rateForDate(wages, "2026-10-01"), 2000);
  assert.equal(rateForDate([], "2026-10-01"), null);
});

test("biweekly payroll: periods and payday from anchor", () => {
  const rule: PayRule = { frequency: "biweekly", anchorDate: "2026-10-05", paydayOffsetDays: 5, weekendRule: "none" };
  assert.deepEqual(periodContaining(rule, "2026-10-22"), { start: "2026-10-19", end: "2026-11-01" });
  assert.deepEqual(periodContaining(rule, "2026-09-25"), { start: "2026-09-21", end: "2026-10-04" }); // before anchor
  const next = nextPayPeriod(rule, "2026-10-22");
  assert.equal(next.start, "2026-10-05");
  assert.equal(next.payDate, "2026-10-23"); // Oct 18 + 5
});

test("semimonthly payroll is independent and handles month ends", () => {
  const rule: PayRule = { frequency: "semimonthly", splitDay: 15, paydayOffsetDays: 0, weekendRule: "previous_business_day" };
  assert.deepEqual(periodWithPayDate(rule, "2026-10-22"), { start: "2026-10-16", end: "2026-10-31", payDate: "2026-10-30" }); // Oct 31 is Sat → Fri
  assert.deepEqual(periodWithPayDate(rule, "2027-02-20"), { start: "2027-02-16", end: "2027-02-28", payDate: "2027-02-26" }); // Feb 28 2027 is Sun
});

test("monthly payroll with next-business-day rule", () => {
  const rule: PayRule = { frequency: "monthly", paydayOffsetDays: 0, weekendRule: "next_business_day" };
  assert.equal(nextPayPeriod(rule, "2026-10-22").payDate, "2026-11-02"); // Oct 31 Sat → Mon Nov 2
});

test("paycheck forecast separates logged, scheduled, unknown deductions", () => {
  const f = forecastPaycheck({
    period: { start: "2026-10-19", end: "2026-11-01", payDate: "2026-11-06" },
    today: "2026-10-22",
    shifts: [
      { status: "completed", gross_cents: 13000, paid_minutes: 390 },
      { status: "scheduled", gross_cents: 16000, paid_minutes: 480 },
      { status: "cancelled", gross_cents: 9999, paid_minutes: 60 },
    ],
    deductionPercent: null,
    deductionFixedCents: null,
    reservePercent: 5,
  });
  assert.equal(f.loggedGrossCents, 13000);
  assert.equal(f.scheduledGrossCents, 16000);
  assert.equal(f.expectedGrossCents, 29000);
  assert.equal(f.expectedNetCents, null);
  assert.equal(f.reserveEstimateCents, 1450);
  assert.ok(f.uncertainty.some((u) => u.includes("deductions are unknown")));
  const g = forecastPaycheck({ period: { start: "2026-10-19", end: "2026-11-01", payDate: "2026-11-06" }, today: "2026-11-03", shifts: [{ status: "completed", gross_cents: 10000, paid_minutes: 300 }], deductionPercent: 20, deductionFixedCents: 500, reservePercent: 5 });
  assert.equal(g.knownDeductionsCents, 2500);
  assert.equal(g.expectedNetCents, 7500);
  assert.equal(g.periodClosed, true);
});

test("spec: $100 for 6 h → $16.67/h, 5% reserve $5, planning $95", () => {
  const e = evaluateOpportunity(10000, 360, 5);
  assert.equal(e.effectiveHourlyCents, 1667);
  assert.equal(e.reserveEstimateCents, 500);
  assert.equal(e.planningAmountCents, 9500);
  assert.match(e.note, /not guaranteed take-home/);
  assert.equal(canTransition("considering", "accepted"), true);
  assert.equal(canTransition("declined", "completed"), false);
});

test("monthly bill on the 31st keeps its anchor", () => {
  assert.equal(nextOccurrence("2026-01-31", "monthly", 31), "2026-02-28");
  assert.equal(nextOccurrence("2026-02-28", "monthly", 31), "2026-03-31");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
  assert.equal(nextOccurrence("2026-10-25", "none"), null);
});

test("ranges: this week starts Monday, last month", () => {
  assert.equal(startOfWeek("2026-10-22", 1), "2026-10-19");
  assert.deepEqual(resolveRange("this_week", "2026-10-22"), { start: "2026-10-19", end: "2026-10-25", label: "This week" });
  assert.deepEqual(resolveRange("last_month", "2026-10-22"), { start: "2026-09-01", end: "2026-09-30", label: "September 2026" });
  assert.throws(() => resolveRange("custom", "2026-10-22", 1, { start: "2026-10-10", end: "2026-10-01" }));
});

test("position never mixes earned/expected into cash", () => {
  const p = computePosition({ cashCents: 100000, unpaidBillsBeforeHorizonCents: 71500, allocatedToGoalsCents: 25000, earnedUnpaidCents: 50000, expectedIncomeCents: 80000, debtCents: 640000 });
  assert.equal(p.cashCents, 100000);
  assert.equal(p.safeToAllocateCents, 3500);
  assert.equal(affordability(p, 20000).affordable, false);
  assert.equal(affordability(p, 20000).remainingAfterCents, -16500);
});

test("report: earned vs received vs projected stay separate; transfers excluded", () => {
  const r = buildReport({
    range: { start: "2026-10-19", end: "2026-10-25", label: "This week" },
    shifts: [
      { job_id: "j1", job_name: "Security", status: "completed", paid_minutes: 360, gross_cents: 12000, work_date: "2026-10-20" },
      { job_id: "j2", job_name: "Cafe", status: "completed", paid_minutes: 240, gross_cents: 6400, work_date: "2026-10-21" },
      { job_id: "j1", job_name: "Security", status: "scheduled", paid_minutes: 480, gross_cents: 16000, work_date: "2026-10-24" },
    ],
    opportunities: [{ name: "Restaurant", status: "accepted", earned_cents: null, offered_cents: 10000, work_date: "2026-10-24" }],
    transactions: [
      { type: "paycheck", amount_cents: 45000, category: null, occurred_on: "2026-10-23", description: null },
      { type: "expense", amount_cents: 4200, category: "groceries", occurred_on: "2026-10-22", description: null },
      { type: "transfer", amount_cents: 20000, category: null, occurred_on: "2026-10-22", description: null },
    ],
    goalContributions: [],
    billsDue: [{ name: "Phone", amount_cents: 11500, due_date: "2026-10-25", paid: false }],
    expectedPaychecks: [],
    projectedOpportunities: [{ name: "Restaurant", offered_cents: 10000, work_date: "2026-10-24" }],
  });
  assert.equal(r.earned.totalGrossCents, 18400);
  assert.equal(r.received.totalCents, 45000);
  assert.equal(r.spending.totalCents, 4200);
  assert.equal(r.netCashFlowCents, 40800);
  assert.equal(r.projected.totalCents, 10000);
  assert.equal(r.scheduledNotWorked.grossCents, 16000);
  assert.match(reportToCsv(r), /PROJECTED,One-time — Restaurant,100\.00/);
});

test("reminder planner: deterministic keys, lead times, window", () => {
  const now = new Date("2026-10-22T20:00:00Z"); // 14:00 MDT
  const input = {
    now,
    tz: TZ,
    currency: "CAD",
    prefs: { categories: {}, shiftLeadMinutes: 30, logHoursTime: "21:00", billLeadDays: 1, billNotifyTime: "09:00", paydayNotifyTime: "09:00" },
    shifts: [{ id: "s1", job_name: "Security", work_date: "2026-10-22", starts_at: new Date("2026-10-22T22:00:00Z"), ends_at: new Date("2026-10-23T05:00:00Z"), status: "scheduled" }],
    bills: [{ id: "b1", name: "Phone", amount_cents: 11500, next_due_date: "2026-10-24" }],
    paydays: [{ job_id: "j1", job_name: "Security", pay_date: "2026-10-23", expected_gross_cents: 13000 }],
    opportunities: [],
  };
  const a = planAutoReminders(input);
  const b = planAutoReminders(input);
  assert.deepEqual(a.map((r) => r.dedupeKey), b.map((r) => r.dedupeKey));
  const shift = a.find((r) => r.category === "shift")!;
  assert.equal(shift.fireAt.toISOString(), "2026-10-22T21:30:00.000Z");
  const log = a.find((r) => r.category === "log_hours")!;
  assert.equal(log.fireAt.toISOString(), "2026-10-23T05:15:00.000Z"); // after 23:00 end, not 21:00
  const bill = a.find((r) => r.category === "bill")!;
  assert.equal(localTime(bill.fireAt, TZ), "09:00");
  assert.equal(localDate(bill.fireAt, TZ), "2026-10-23");
  assert.ok(a.find((r) => r.category === "payday"));
  const off = planAutoReminders({ ...input, prefs: { ...input.prefs, categories: { shift: false } } });
  assert.equal(off.find((r) => r.category === "shift"), undefined);
});

test("observations need repeated evidence", () => {
  const one = observeDeclineThreshold([{ status: "declined", offered_cents: 5000, expected_minutes: 300 }], "CAD");
  assert.equal(one, null);
  const many = observeDeclineThreshold(
    [
      { status: "declined", offered_cents: 5000, expected_minutes: 300 },
      { status: "declined", offered_cents: 6000, expected_minutes: 360 },
      { status: "declined", offered_cents: 7000, expected_minutes: 420 },
      { status: "completed", offered_cents: 12000, expected_minutes: 360 },
    ],
    "CAD",
  );
  assert.equal(many?.confidence, "hypothesis");
  assert.match(many!.statement, /\$20\.00\/h/);
  const saving = observePostPaydaySaving(
    [{ pay_date: "2026-09-25", status: "received" }, { pay_date: "2026-10-09", status: "received" }],
    [{ contributed_on: "2026-09-26", amount_cents: 20000 }, { contributed_on: "2026-10-09", amount_cents: 20000 }],
    "CAD",
  );
  assert.match(saving!.statement, /\$200\.00/);
});

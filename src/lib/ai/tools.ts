import "server-only";
import { z } from "zod";
import { sql } from "../server/db";
import type { Ctx } from "../server/context";
import type { UndoOp } from "../server/undo";
import { AppError } from "../server/errors";
import * as V from "../validation";
import { formatHours, formatMoney, grossFor, toCents } from "../domain/money";
import { rateForDate, hoursToMinutes, shiftFromTimes } from "../domain/shifts";
import { periodWithPayDate } from "../domain/payroll";
import { affordability } from "../domain/position";
import { resolveRange } from "../domain/ranges";
import { evaluateOpportunity } from "../domain/opportunity";
import { localTime } from "../domain/time";
import { CARD_KEYS, CARDS, type CardKey } from "../dashboard-registry";
import { changeCards, getCards } from "../server/services/cards";
import { completeOnboarding } from "../server/services/prefs";
import { forget, remember } from "../server/services/memory";
import { createJob, getJob, jobLabel, listJobs, payRuleOf, updateJob, wagesFor } from "../server/services/jobs";
import { createShift, deleteShift, getShift, listShifts, updateShift } from "../server/services/shifts";
import { createOpportunity, describeOpportunity, getOpportunity, listOpportunities, updateOpportunityStatus } from "../server/services/opportunities";
import { forecastAll, forecastForJob, recordPaycheck } from "../server/services/payroll";
import {
  contributeToGoal,
  createAccount,
  createBill,
  createDebt,
  createGoal,
  listAccounts,
  listBills,
  listTransactions,
  markBillPaid,
  recordDebtPayment,
  recordExpense,
  recordIncome,
  recordTransfer,
  setBalance,
  updateBill,
  voidTransaction,
} from "../server/services/finance";
import { createReminder, upcomingReminders } from "../server/services/reminders";
import { updatePrefs } from "../server/services/prefs";
import { setObservationStatus } from "../server/services/observations";
import { getDashboard } from "../server/services/dashboard";
import { compareReports, generateReport } from "../server/services/reports";
import { pushConfigured } from "../server/notifications/push";
import { checkoutShift, setAttendance } from "../server/services/shiftloop";
import { getCoach, getPayoffPlan } from "../server/services/coach";

export type Risk = "read" | "write" | "confirm";

export interface ToolOutput {
  summary: string;
  data?: unknown;
  undo?: UndoOp[];
  display?: ToolDisplay;
  /** Dashboard cards this call put on screen (shown as a "built" chip in chat). */
  cardsAdded?: CardKey[];
}

export type ToolDisplay =
  | { kind: "report"; report: unknown; compare?: unknown; period: string; start?: string; end?: string }
  | { kind: "dashboard"; added?: CardKey[]; removed?: CardKey[] }
  | { kind: "enable_push" }
  | { kind: "scan_schedule" }
  | { kind: "setup_done" };

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  risk: Risk | ((args: z.infer<S>, ctx: Ctx) => Promise<Risk> | Risk);
  /** Plain-language description of what a confirm-level action will do. */
  preview?: (ctx: Ctx, args: z.infer<S>) => Promise<string>;
  run: (ctx: Ctx, args: z.infer<S>) => Promise<ToolOutput>;
}

function tool<S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> {
  return t;
}

/** Haru must use the person's real pay calendar, never a guess. */
function needsPayDetails(a: { pay_frequency?: string; next_payday?: string; payday_weekday?: number; period_anchor_date?: string; pay_days?: number[] }, ctx: z.RefinementCtx) {
  const f = a.pay_frequency;
  if (!f) return;
  if (f === "weekly" && !a.next_payday && a.payday_weekday == null && !a.period_anchor_date)
    ctx.addIssue({ code: "custom", message: "Weekly pay needs payday_weekday (e.g. 5 for Friday) or next_payday. Ask the user which day they're paid if you don't know." });
  if (f === "biweekly" && !a.next_payday && !a.period_anchor_date)
    ctx.addIssue({ code: "custom", message: "Every-2-weeks pay needs next_payday (the date of their next payday). Ask the user." });
  if ((f === "semimonthly" || f === "monthly") && !a.pay_days?.length)
    ctx.addIssue({ code: "custom", message: "Twice-a-month/monthly pay needs pay_days, e.g. [15, 30] (31 = last day of month). Ask the user which days they're paid." });
}

const money = (ctx: Ctx, c: number | null | undefined) => (c == null ? null : formatMoney(c, ctx.currency));
const Empty = z.object({});

export const TOOLS: ToolDef[] = [
  // ------------------------------------------------------------------ reads
  tool({
    name: "get_dashboard_summary",
    description: "Everything on the dashboard: cash position (cash, reserved for bills, goal money, safe to allocate, earned-unpaid, expected income, debt), earnings this week/month, next paydays, upcoming shifts, bills, goals, debts, items needing attention.",
    schema: Empty,
    risk: "read",
    run: async (ctx) => {
      const d = await getDashboard(ctx);
      const m = (c: number) => money(ctx, c);
      return {
        summary: "Dashboard loaded",
        data: {
          money: {
            cash_manually_tracked: m(d.position.cashCents),
            balance_confirmed_by_user: d.position.balanceConfirmed,
            reserved_for_bills_until: { date: d.position.horizon, amount: m(d.position.reservedForObligationsCents), horizon_is_next_payday: d.position.horizonIsPayday },
            allocated_to_goals: m(d.position.allocatedToGoalsCents),
            safe_to_allocate: m(d.position.safeToAllocateCents),
            earned_not_yet_paid: m(d.position.earnedUnpaidCents),
            expected_income_projection: m(d.position.expectedIncomeCents),
            debt_outstanding: m(d.position.debtCents),
          },
          earnings: { this_week_gross: m(d.earnings.weekCents), this_week_hours: d.earnings.weekMinutes / 60, this_month_gross: m(d.earnings.monthCents), this_month_hours: d.earnings.monthMinutes / 60, by_job_this_month: d.earnings.byJobMonth.map((j) => ({ job: j.name, gross: m(j.cents) })) },
          next_paydays: d.paydays.map((p) => (p.configured ? { job: p.jobName, pay_date: p.payDate, period: `${p.periodStart}..${p.periodEnd}`, expected_gross: m(p.expectedGrossCents ?? 0), expected_net: p.expectedNetCents == null ? "unknown (deductions not provided)" : m(p.expectedNetCents) } : { job: p.jobName, pay_rules: "not configured" })),
          upcoming_shifts: d.upcomingShifts.map((s) => ({ job: s.jobName, date: s.date, time: s.start ? `${s.start}–${s.end}` : null, hours: s.minutes / 60, expected_gross: m(s.grossCents) })),
          bills_next_30_days: d.bills.map((b) => ({ id: b.id, name: b.name, amount: m(b.amountCents), due: b.dueDate, days_until: b.daysUntil })),
          goals: d.goals.map((g) => ({ id: g.id, name: g.name, saved: m(g.savedCents), target: m(g.targetCents) })),
          debts: d.debts.map((x) => ({ id: x.id, name: x.name, balance: m(x.balanceCents) })),
          opportunities: d.opportunities.map((o) => ({ id: o.id, name: o.name, status: o.status, date: o.date, offered: m(o.offeredCents), hourly: o.hourlyCents == null ? null : m(o.hourlyCents) })),
          attention: d.attention.map((a) => `${a.title} — ${a.detail}`),
          insights: d.insights.map((i) => ({ statement: i.statement, basis: i.basis, confidence: i.confidence })),
        },
      };
    },
  }),
  tool({
    name: "get_financial_summary",
    description: "Accounts with balances (manually tracked), plus the money position. Use for 'how much money do I have'.",
    schema: Empty,
    risk: "read",
    run: async (ctx) => {
      const [accounts, d] = await Promise.all([listAccounts(ctx), getDashboard(ctx)]);
      return {
        summary: "Financial summary",
        data: {
          note: "Balances are manually tracked in HARU, not live bank data.",
          accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance: money(ctx, a.balance_cents), user_confirmed_balance: a.balance_confirmed })),
          cash_total: money(ctx, d.position.cashCents),
          reserved_for_bills: money(ctx, d.position.reservedForObligationsCents),
          allocated_to_goals: money(ctx, d.position.allocatedToGoalsCents),
          safe_to_allocate: money(ctx, d.position.safeToAllocateCents),
          earned_not_yet_paid: money(ctx, d.position.earnedUnpaidCents),
          debt_outstanding: money(ctx, d.position.debtCents),
        },
      };
    },
  }),
  tool({
    name: "check_affordability",
    description: "Can the user afford to spend an amount now? Deterministic comparison against safe-to-allocate cash.",
    schema: z.object({ amount: V.zPositiveMoney }),
    risk: "read",
    run: async (ctx, a) => {
      const d = await getDashboard(ctx);
      const r = affordability(d.position, toCents(a.amount));
      return {
        summary: r.affordable ? "Affordable" : "Not affordable",
        data: { affordable: r.affordable, safe_to_allocate_now: money(ctx, d.position.safeToAllocateCents), remaining_after: money(ctx, r.remainingAfterCents), next_payday: d.paydays.find((p) => p.payDate)?.payDate ?? null, basis: r.basis, balance_confirmed_by_user: d.position.balanceConfirmed },
      };
    },
  }),
  tool({
    name: "list_jobs",
    description: "The user's jobs with ids, current hourly rate, payroll rules and regular schedule.",
    schema: z.object({ include_ended: z.boolean().optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const jobs = await listJobs(ctx, sql, { includeEnded: a.include_ended });
      return {
        summary: `${jobs.length} jobs`,
        data: jobs.map((j) => ({ id: j.id, employer: j.employer, title: j.title, status: j.status, hourly_rate: money(ctx, j.current_rate_cents), pay_frequency: j.pay_frequency ?? "not set", period_anchor_date: j.period_anchor_date, payday_offset_days: j.payday_offset_days, weekend_rule: j.payday_weekend_rule, deductions: j.deduction_percent != null || j.deduction_fixed_cents != null ? { percent: j.deduction_percent, fixed: money(ctx, j.deduction_fixed_cents) } : "unknown", regular_schedule: j.regular_schedule, expected_weekly_hours: j.expected_weekly_minutes != null ? j.expected_weekly_minutes / 60 : null })),
      };
    },
  }),
  tool({
    name: "calculate_shift_earnings",
    description: "Preview paid hours and gross for a shift WITHOUT saving it. Use to verify before recording when details are unusual.",
    schema: z.object({ job_id: V.zId, date: V.zDate, start: V.zTime.optional(), end: V.zTime.optional(), hours: z.number().gt(0).max(24).optional(), break_minutes: z.number().int().min(0).max(600).optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const job = await getJob(ctx, a.job_id);
      const rate = rateForDate(await wagesFor(ctx, job.id), a.date);
      if (rate == null) throw new AppError("This job has no wage set.");
      const minutes = a.start && a.end ? shiftFromTimes(a.date, a.start, a.end, a.break_minutes ?? 0, ctx.tz).paidMinutes : a.hours ? hoursToMinutes(a.hours) : null;
      if (minutes == null) throw new AppError("Need start/end or hours.");
      return { summary: "Calculated", data: { job: jobLabel(job), paid_hours: minutes / 60, rate: money(ctx, rate), gross: money(ctx, grossFor(minutes, rate)), calculation: `${formatHours(minutes)} × ${money(ctx, rate)}/h` } };
    },
  }),
  tool({
    name: "list_shifts",
    description: "Shifts in a period (completed, scheduled, cancelled) with hours and gross. Use for 'show me everything I earned this week'.",
    schema: z.object({ period: V.RangeInput.shape.period, start: V.zDate.optional(), end: V.zDate.optional(), job_id: V.zId.optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const r = resolveRange(a.period, ctx.today, ctx.prefs.week_starts_on, a);
      const shifts = await listShifts(ctx, { start: r.start, end: r.end, jobId: a.job_id });
      const done = shifts.filter((s) => s.status === "completed");
      return {
        summary: `${shifts.length} shifts`,
        data: {
          range: r,
          completed_total_gross: money(ctx, done.reduce((x, s) => x + s.gross_cents, 0)),
          completed_total_hours: done.reduce((x, s) => x + s.paid_minutes, 0) / 60,
          shifts: shifts.map((s) => ({ id: s.id, job: s.job_name, date: s.work_date, status: s.status, time: s.starts_at ? `${localTime(s.starts_at, ctx.tz)}–${s.ends_at ? localTime(s.ends_at, ctx.tz) : "?"}` : null, break_minutes: s.break_minutes, paid_hours: s.paid_minutes / 60, rate: money(ctx, s.rate_cents), gross: money(ctx, s.gross_cents), paid_by_paycheck: Boolean(s.paycheck_id) })),
        },
      };
    },
  }),
  tool({
    name: "get_pay_period",
    description: "The pay period and payday that contain a date for a job, from its saved rules.",
    schema: z.object({ job_id: V.zId, date: V.zDate.optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const job = await getJob(ctx, a.job_id);
      const rule = payRuleOf(job);
      if (!rule) return { summary: "No pay rules", data: { job: jobLabel(job), configured: false, ask: "How often does this job pay, and when?" } };
      return { summary: "Pay period", data: { job: jobLabel(job), ...periodWithPayDate(rule, a.date ?? ctx.today) } };
    },
  }),
  tool({
    name: "get_paycheck_forecast",
    description: "Next payday and expected paycheck per job (or one job), computed from saved payroll rules and logged/scheduled shifts, with uncertainty notes.",
    schema: z.object({ job_id: V.zId.optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const list = a.job_id ? [await forecastForJob(ctx, await getJob(ctx, a.job_id))] : await forecastAll(ctx);
      return {
        summary: "Forecast",
        data: {
          reserve_percent: ctx.prefs.reserve_percent,
          forecasts: list.map((f) =>
            f.configured && f.forecast && f.period
              ? { job: f.jobName, pay_date: f.period.payDate, days_until: f.daysUntil, period: `${f.period.start}..${f.period.end}`, logged_gross: money(ctx, f.forecast.loggedGrossCents), logged_hours: f.forecast.loggedMinutes / 60, scheduled_gross: money(ctx, f.forecast.scheduledGrossCents), expected_gross: money(ctx, f.forecast.expectedGrossCents), expected_net: f.forecast.expectedNetCents == null ? "unknown" : money(ctx, f.forecast.expectedNetCents), reserve_estimate: money(ctx, f.forecast.reserveEstimateCents), uncertainty: f.forecast.uncertainty }
              : { job: f.jobName, configured: false, note: "Pay frequency/payday rules are not set for this job." },
          ),
        },
      };
    },
  }),
  tool({
    name: "evaluate_work_opportunity",
    description: "Effective hourly rate and reserve/planning estimate for an offer, without saving anything.",
    schema: z.object({ offered_amount: V.zMoney, expected_hours: z.number().gt(0).max(24).optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const e = evaluateOpportunity(toCents(a.offered_amount), a.expected_hours ? hoursToMinutes(a.expected_hours) : null, ctx.prefs.reserve_percent);
      const jobs = await listJobs(ctx);
      return { summary: "Evaluated", data: { effective_hourly: money(ctx, e.effectiveHourlyCents), reserve_estimate: money(ctx, e.reserveEstimateCents), planning_amount: money(ctx, e.planningAmountCents), reserve_percent: ctx.prefs.reserve_percent, note: e.note, compare_with_regular_jobs: jobs.map((j) => ({ job: jobLabel(j), hourly: money(ctx, j.current_rate_cents) })) } };
    },
  }),
  tool({
    name: "list_opportunities",
    description: "One-time work opportunities (considering/accepted/scheduled/completed/declined).",
    schema: Empty,
    risk: "read",
    run: async (ctx) => {
      const list = await listOpportunities(ctx);
      return { summary: `${list.length} opportunities`, data: list.map((o) => ({ id: o.id, name: o.name, status: o.status, date: o.work_date, ...(() => { const d = describeOpportunity(o, ctx); return { offered: money(ctx, o.offered_cents), hours: o.expected_minutes ? o.expected_minutes / 60 : null, hourly: money(ctx, d.effectiveHourlyCents), pay_basis: o.pay_basis }; })(), earned: money(ctx, o.earned_cents), payment_received: o.paid })) };
    },
  }),
  tool({
    name: "list_bills",
    description: "Active bills with ids, amounts, next due dates and recurrence.",
    schema: Empty,
    risk: "read",
    run: async (ctx) => {
      const bills = await listBills(ctx);
      return { summary: `${bills.length} bills`, data: bills.map((b) => ({ id: b.id, name: b.name, amount: money(ctx, b.amount_cents), next_due: b.next_due_date, recurrence: b.recurrence, category: b.category })) };
    },
  }),
  tool({
    name: "list_transactions",
    description: "Recorded money movements (income, paychecks, expenses, transfers, debt payments) in a period.",
    schema: z.object({ period: V.RangeInput.shape.period, start: V.zDate.optional(), end: V.zDate.optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const r = resolveRange(a.period, ctx.today, ctx.prefs.week_starts_on, a);
      const t = await listTransactions(ctx, { start: r.start, end: r.end, limit: 60 });
      return { summary: `${t.length} transactions`, data: { range: r, transactions: t.map((x) => ({ id: x.id, type: x.type, amount: money(ctx, x.amount_cents), date: x.occurred_on, category: x.category, description: x.description, account: x.account_name })) } };
    },
  }),
  tool({
    name: "generate_report",
    description: "A full report for a period from actual records: earned (gross, by job), received cash, spending by category, debt payments, saved to goals, bills, and clearly-labelled projections. Set compare=true to compare with the previous period.",
    schema: z.object({ period: V.RangeInput.shape.period, start: V.zDate.optional(), end: V.zDate.optional(), compare: z.boolean().optional() }),
    risk: "read",
    run: async (ctx, a) => {
      const m = (c: number) => money(ctx, c);
      const shape = (r: Awaited<ReturnType<typeof generateReport>>) => ({
        range: r.range,
        earned_gross_total: m(r.earned.totalGrossCents),
        hours: r.earned.totalMinutes / 60,
        earned_by_job: r.earned.byJob.map((j) => ({ job: j.name, gross: m(j.grossCents), hours: j.minutes / 60, shifts: j.shifts })),
        one_time_work_earned: r.earned.oneTimeWork.map((o) => ({ name: o.name, earned: m(o.earnedCents) })),
        received: { paychecks: m(r.received.paychecksCents), other_income: m(r.received.otherIncomeCents), total: m(r.received.totalCents) },
        spending_total: m(r.spending.totalCents),
        spending_by_category: r.spending.byCategory.map((c) => ({ category: c.category, amount: m(c.cents) })),
        debt_payments: m(r.debtPaymentsCents),
        saved_to_goals: m(r.savedToGoals.totalCents),
        unpaid_bills: r.bills.unpaid.map((b) => ({ name: b.name, amount: m(b.amountCents), due: b.dueDate })),
        net_cash_flow: m(r.netCashFlowCents),
        PROJECTED_not_actual: { total: m(r.projected.totalCents), paychecks: r.projected.paychecks.map((p) => ({ job: p.jobName, pay_date: p.payDate, gross: m(p.grossCents) })), one_time: r.projected.opportunities.map((o) => ({ name: o.name, amount: m(o.cents), date: o.date })) },
        scheduled_not_yet_worked_gross: m(r.scheduledNotWorked.grossCents),
      });
      if (a.compare) {
        const { current, previous } = await compareReports(ctx, a.period);
        return { summary: `Report ${current.range.label} vs ${previous.range.label}`, data: { current: shape(current), previous: shape(previous) }, display: { kind: "report", report: current, compare: previous, period: a.period, start: a.start, end: a.end } };
      }
      const r = await generateReport(ctx, a.period, a);
      return { summary: `Report for ${r.range.label}`, data: shape(r), display: { kind: "report", report: r, period: a.period, start: a.start, end: a.end } };
    },
  }),
  tool({
    name: "get_notification_status",
    description: "Whether push notifications are enabled, how many devices are subscribed, upcoming reminders and the scheduler's last run.",
    schema: Empty,
    risk: "read",
    run: async (ctx) => {
      const [subs, run, upcoming] = await Promise.all([
        sql<{ n: number }[]>`select count(*)::int as n from push_subscriptions where user_id = ${ctx.userId}`,
        sql<{ finished_at: Date | null }[]>`select finished_at from scheduler_runs where finished_at is not null order by id desc limit 1`,
        upcomingReminders(ctx, 8),
      ]);
      return {
        summary: "Notification status",
        data: {
          enabled_in_haru: ctx.prefs.notify_enabled,
          devices_subscribed: subs[0].n,
          server_push_configured: pushConfigured(),
          scheduler_last_run: run[0]?.finished_at?.toISOString() ?? "never",
          categories: ctx.prefs.notify_categories,
          timing: { shift_lead_minutes: ctx.prefs.shift_lead_minutes, log_hours_time: ctx.prefs.log_hours_time, bill_lead_days: ctx.prefs.bill_lead_days },
          upcoming: upcoming.map((r) => ({ title: r.title, at: `${r.fire_at.toISOString()}` })),
        },
      };
    },
  }),

  tool({
    name: "get_motivation",
    description: "The user's next shift (what it earns after tax, which paycheck it lands in, how many days closer it brings their focus goal), this week's shifts, shifts waiting for check-out, and attendance stats (streak, missed shifts and money missed).",
    schema: Empty,
    risk: "read",
    run: async (ctx) => {
      const c = await getCoach(ctx);
      const m = (x: number) => money(ctx, x);
      const card = (s: NonNullable<typeof c.nextShift>) => ({ shift_id: s.id, job: s.jobName, date: s.date, time: s.start ? `${s.start}–${s.end}` : null, hours: s.minutes / 60, take_home_after_tax: m(s.takeHomeCents), gross: m(s.grossCents), paycheck_date: s.payDate, paycheck_projected_after_tax: m(s.paycheckProjectedCents), days_closer_to_focus_goal: s.daysCloser, attendance: s.attendance });
      return {
        summary: "Motivation data",
        data: {
          tax_percent: c.taxPercent,
          next_shift: c.nextShift ? card(c.nextShift) : null,
          this_week: c.week.map(card),
          waiting_for_checkout: c.checkouts.map(card),
          stats_last_30_days: { worked: c.stats.workedShifts, missed: c.stats.missedShifts, money_missed_after_tax: m(c.stats.missedTakeHomeCents), attendance_rate: c.stats.attendanceRate, streak: c.stats.streak, earned_this_month_after_tax: m(c.stats.monthTakeHomeCents) },
          focus: c.plan.focus ? { name: c.plan.focus.name, finish: c.plan.focus.finishDate } : null,
        },
      };
    },
  }),
  tool({
    name: "get_payoff_plan",
    description: "What to pay first and when each debt and goal is finished, based on the work schedule's take-home after tax, monthly bills and minimum payments. Debts by highest interest first, then goals.",
    schema: Empty,
    risk: "read",
    run: async (ctx) => {
      const p = await getPayoffPlan(ctx);
      const m = (x: number) => money(ctx, x);
      return {
        summary: "Payoff plan",
        data: {
          monthly_take_home_from_schedule: m(p.monthlyTakeHomeCents),
          monthly_bills: m(p.monthlyBillsCents),
          monthly_minimum_payments: m(p.monthlyMinimumsCents),
          free_each_month: m(p.surplusCents),
          order: p.items.map((x, n) => ({ step: n + 1, name: x.name, kind: x.kind, remaining: m(x.remainingCents), finish_date: x.finishDate ?? "not reachable at this pace", on_track_for_target: x.onTrack, why: x.reason })),
          debt_free_date: p.debtFreeDate,
          warnings: p.warnings,
        },
      };
    },
  }),

  // ------------------------------------------------------------------ writes: work
  tool({
    name: "create_job",
    description: "Add a regular, ongoing job. NEVER use for a one-time offer — use create_work_opportunity for those. Include the pay calendar in the same call when you know it (weekly: payday_weekday or next_payday; every 2 weeks: next_payday; twice a month/monthly: pay_days) and the weekly schedule in regular_schedule (several entries per weekday are fine; overnight shifts keep the real end time, e.g. 23:30 to 03:30). The result tells you the computed next payday: check it against what the user said.",
    schema: V.JobCreate.superRefine(needsPayDetails),
    risk: "write",
    run: (ctx, a) => createJob(ctx, a, "ai"),
  }),
  tool({
    name: "update_job",
    description: "Change a job's details, wage (adds wage history; past shifts keep their rate), weekly schedule or pay calendar. Use it right away when the user corrects a payday. The result tells you the computed next payday: check it against what the user said.",
    schema: V.JobUpdate.superRefine(needsPayDetails),
    risk: (a) => (a.hourly_rate != null || a.status === "ended" ? "confirm" : "write"),
    preview: async (ctx, a) => {
      const j = await getJob(ctx, a.job_id);
      const parts = Object.entries(a).filter(([k, v]) => k !== "job_id" && v !== undefined).map(([k, v]) => `${k.replace(/_/g, " ")} → ${typeof v === "object" ? JSON.stringify(v) : v}`);
      return `Change ${jobLabel(j)}: ${parts.join("; ")}.${a.hourly_rate != null ? ` The new wage applies from ${a.wage_effective_from ?? ctx.today}; earlier shifts keep their recorded rate.` : ""}`;
    },
    run: (ctx, a) => updateJob(ctx, a, "ai"),
  }),
  tool({
    name: "create_shift",
    description: "Record a completed shift (worked) or a scheduled future shift for a regular job. Earnings are computed by HARU from the job's wage. Does not change bank balances. If a scheduled shift exists that day it is completed instead.",
    schema: V.ShiftCreate,
    risk: "write",
    run: (ctx, a) => createShift(ctx, a, "ai"),
  }),
  tool({
    name: "create_shifts_batch",
    description: "Record several shifts at once (e.g. a week's schedule). Requires user confirmation when more than 3.",
    schema: z.object({ shifts: z.array(V.ShiftCreate).min(1).max(21) }),
    risk: (a) => (a.shifts.length > 3 ? "confirm" : "write"),
    preview: async (ctx, a) => `Add ${a.shifts.length} shifts: ${a.shifts.map((s) => `${s.date}${s.start ? ` ${s.start}–${s.end}` : ` ${s.hours}h`} (${s.status ?? "completed"})`).join(", ")}.`,
    run: async (ctx, a) => {
      const undo: UndoOp[] = [];
      const lines: string[] = [];
      for (const s of a.shifts) {
        const r = await createShift(ctx, s, "ai");
        undo.push(...(r.undo ?? []));
        lines.push(r.summary);
      }
      return { summary: lines.join("\n"), undo };
    },
  }),
  tool({
    name: "update_shift",
    description: "Correct a recorded shift (times, hours, break, date, status, or the rate used for that shift).",
    schema: V.ShiftUpdate,
    risk: async (a, ctx) => {
      const s = await getShift(ctx, a.shift_id);
      return s.paycheck_id || a.hourly_rate != null ? "confirm" : "write";
    },
    preview: async (ctx, a) => {
      const s = await getShift(ctx, a.shift_id);
      const changes = Object.entries(a).filter(([k, v]) => k !== "shift_id" && v !== undefined).map(([k, v]) => `${k.replace(/_/g, " ")} → ${v}`);
      return `Correct ${s.job_name} shift on ${s.work_date} (currently ${formatHours(s.paid_minutes)}, ${money(ctx, s.gross_cents)}): ${changes.join("; ")}.${s.paycheck_id ? " This shift is already covered by a received paycheck." : ""}`;
    },
    run: (ctx, a) => updateShift(ctx, a, "ai"),
  }),
  tool({
    name: "delete_shift",
    description: "Delete a shift record entirely (prefer update_shift status=cancelled for a shift that didn't happen).",
    schema: z.object({ shift_id: V.zId }),
    risk: "confirm",
    preview: async (ctx, a) => {
      const s = await getShift(ctx, a.shift_id);
      return `Delete the ${s.job_name} shift on ${s.work_date} (${formatHours(s.paid_minutes)}, ${money(ctx, s.gross_cents)} gross).`;
    },
    run: (ctx, a) => deleteShift(ctx, a.shift_id, "ai"),
  }),
  tool({
    name: "set_shift_attendance",
    description: "Before a scheduled shift: record whether the user is going (true) or can't make it (false, marks it missed).",
    schema: V.ShiftAttendance,
    risk: "write",
    run: (ctx, a) => setAttendance(ctx, a.shift_id, a.going, "ai"),
  }),
  tool({
    name: "checkout_shift",
    description: "After a scheduled shift: log it as fully worked (full=true), worked fewer hours (hours=n), or missed (missed=true). Computes earnings and the updated paycheck.",
    schema: V.ShiftCheckout,
    risk: "write",
    run: (ctx, a) => checkoutShift(ctx, a.shift_id, a, "ai"),
  }),
  tool({
    name: "create_work_opportunity",
    description: "Track a one-time work offer (e.g. '$100 for six hours at a restaurant Saturday'). Never creates a job. Default status 'considering' unless the user said they accepted.",
    schema: V.OpportunityCreate,
    risk: "write",
    run: (ctx, a) => createOpportunity(ctx, a, "ai"),
  }),
  tool({
    name: "update_work_opportunity_status",
    description: "Move an opportunity to considering/accepted/scheduled/completed/declined. Completing records earnings (unpaid until record_income with opportunity_id).",
    schema: V.OpportunityStatusUpdate,
    risk: "write",
    run: (ctx, a) => updateOpportunityStatus(ctx, a, "ai"),
  }),
  tool({
    name: "record_paycheck",
    description: "Record a paycheck that ARRIVED for a regular job. Deposits the net amount into an account once per pay period and compares it with logged hours.",
    schema: V.PaycheckReceived,
    risk: "write",
    run: (ctx, a) => recordPaycheck(ctx, a, "ai"),
  }),

  // ------------------------------------------------------------------ writes: money
  tool({ name: "create_expense", description: "Record money spent.", schema: V.ExpenseCreate, risk: "write", run: (ctx, a) => recordExpense(ctx, a, "ai") }),
  tool({
    name: "record_income",
    description: "Record money received that is NOT a regular-job paycheck (gifts, refunds, side income, or payment for a one-time opportunity via opportunity_id).",
    schema: V.RecordIncome,
    risk: "write",
    run: (ctx, a) => recordIncome(ctx, a, "ai"),
  }),
  tool({ name: "create_transfer", description: "Move money between the user's own accounts. Not income or spending.", schema: V.TransferCreate, risk: "write", run: (ctx, a) => recordTransfer(ctx, a, "ai") }),
  tool({ name: "create_account", description: "Add a manually tracked account (chequing, savings, cash).", schema: V.AccountCreate, risk: "write", run: (ctx, a) => createAccount(ctx, a, "ai") }),
  tool({
    name: "set_account_balance",
    description: "Set an account to the balance the user states (records an adjustment).",
    schema: V.SetBalance,
    risk: "confirm",
    preview: async (ctx, a) => {
      const acct = (await listAccounts(ctx)).find((x) => x.id === a.account_id);
      if (!acct) throw new AppError("Account not found");
      return `Set ${acct.name} from ${money(ctx, acct.balance_cents)} to ${money(ctx, toCents(a.balance))} with a balance adjustment dated ${a.date}.`;
    },
    run: (ctx, a) => setBalance(ctx, a, "ai"),
  }),
  tool({
    name: "void_transaction",
    description: "Remove a mistaken transaction (kept in history as voided).",
    schema: z.object({ transaction_id: V.zId }),
    risk: "confirm",
    preview: async (ctx, a) => {
      const [t] = await sql<{ type: string; amount_cents: number; occurred_on: string; description: string | null }[]>`
        select type, amount_cents, occurred_on, description from transactions where id = ${a.transaction_id} and user_id = ${ctx.userId}`;
      if (!t) throw new AppError("Transaction not found");
      return `Remove the ${t.type} of ${money(ctx, t.amount_cents)} on ${t.occurred_on}${t.description ? ` (${t.description})` : ""}.`;
    },
    run: (ctx, a) => voidTransaction(ctx, a.transaction_id, "ai"),
  }),
  tool({ name: "create_bill", description: "Add a bill or recurring expense with its next due date.", schema: V.BillCreate, risk: "write", run: (ctx, a) => createBill(ctx, a, "ai") }),
  tool({
    name: "update_bill",
    description: "Change a bill's name, amount, due date, recurrence, or archive it.",
    schema: V.BillUpdate,
    risk: (a) => (a.amount != null || a.recurrence || a.status === "archived" ? "confirm" : "write"),
    preview: async (ctx, a) => `Update bill: ${Object.entries(a).filter(([k, v]) => k !== "bill_id" && v !== undefined).map(([k, v]) => `${k} → ${v}`).join("; ")}.`,
    run: (ctx, a) => updateBill(ctx, a, "ai"),
  }),
  tool({ name: "mark_bill_paid", description: "Mark the current occurrence of a bill as paid (records the expense, advances recurring bills).", schema: V.BillPaid, risk: "write", run: (ctx, a) => markBillPaid(ctx, a, "ai") }),
  tool({ name: "create_debt", description: "Track money the user owes.", schema: V.DebtCreate, risk: "write", run: (ctx, a) => createDebt(ctx, a, "ai") }),
  tool({ name: "record_debt_payment", description: "Record a payment toward a debt (lowers cash and the debt; not counted as spending).", schema: V.DebtPayment, risk: "write", run: (ctx, a) => recordDebtPayment(ctx, a, "ai") }),
  tool({ name: "create_savings_goal", description: "Create a savings goal (target, optional date and monthly target).", schema: V.GoalCreate, risk: "write", run: (ctx, a) => createGoal(ctx, a, "ai") }),
  tool({ name: "contribute_to_goal", description: "Set aside (or take back) money for a goal. Allocation only — cash is unchanged.", schema: V.GoalContribution, risk: "write", run: (ctx, a) => contributeToGoal(ctx, a, "ai") }),

  // ------------------------------------------------------------------ writes: app
  tool({ name: "create_reminder", description: "Create a reminder at a local date/time. Delivered by push notification when enabled.", schema: V.ReminderCreate, risk: "write", run: (ctx, a) => createReminder(ctx, a, "ai") }),
  tool({
    name: "update_preferences",
    description: "Change settings: reserve percent, time zone, currency, display name, notification timing/categories.",
    schema: V.PrefsUpdate.omit({ notify_enabled: true }),
    risk: (a) => (a.currency || a.timezone ? "confirm" : "write"),
    preview: async (_ctx, a) => `Change settings: ${Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${k.replace(/_/g, " ")} → ${typeof v === "object" ? JSON.stringify(v) : v}`).join("; ")}.`,
    run: async (ctx, a) => {
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(a)) before[k] = (ctx.prefs as unknown as Record<string, unknown>)[k];
      const r = await updatePrefs(ctx, a, "ai");
      return { ...r, undo: [{ op: "prefs", values: before }] };
    },
  }),
  tool({
    name: "build_dashboard",
    description: `You build this user's dashboard. It starts empty and only shows the cards you put there. Add a card as soon as the data it shows exists (cards for records you just created are added automatically), remove cards the user doesn't want or that stopped being useful, and reorder when priorities change. Cards: ${CARD_KEYS.map((k) => `${k} (${CARDS[k].description})`).join("; ")}.`,
    schema: z.object({
      add: z.array(z.enum(CARD_KEYS as [CardKey, ...CardKey[]])).optional(),
      remove: z.array(z.enum(CARD_KEYS as [CardKey, ...CardKey[]])).optional(),
      order: z.array(z.enum(CARD_KEYS as [CardKey, ...CardKey[]])).optional().describe("Keys to move to the top, in this order"),
    }),
    risk: "write",
    run: async (ctx, a) => {
      const r = await changeCards(ctx, a);
      return { summary: r.summary, undo: [{ op: "cards", cards: r.prev }], display: { kind: "dashboard", added: r.added, removed: r.removed }, cardsAdded: r.added, data: { now_showing: (await getCards(ctx)).show } };
    },
  }),
  tool({
    name: "remember",
    description: "Save short facts about this person that should shape every future answer: corrections they made ('BioARO pays on the 15th and 30th, not the 3rd'), plans ('sends 2,000 CAD to family in India every month from the BioARO paycheck on the 15th'), preferences ('wants short answers', 'uses INR for remittances'), and patterns. One fact per item, plain sentence, max 300 characters. Don't store what's already a record (jobs, bills, debts) unless it adds context.",
    schema: z.object({ facts: z.array(z.string().min(3).max(300)).min(1).max(8) }),
    risk: "write",
    run: async (ctx, a) => {
      const r = await remember(ctx, a.facts);
      return { summary: `Remembered: ${a.facts.join(" · ")}`, undo: r.ids.map((id) => ({ op: "delete" as const, table: "user_memory", id: String(id) })) };
    },
  }),
  tool({
    name: "forget",
    description: "Delete a remembered fact (by its id from WHAT YOU KNOW) when it's wrong or out of date.",
    schema: z.object({ memory_id: z.number().int().positive() }),
    risk: "write",
    run: async (ctx, a) => ({ summary: `Forgot: ${await forget(ctx, a.memory_id)}` }),
  }),
  tool({
    name: "complete_setup",
    description: "Call once the setup conversation has covered goals, jobs with pay rates and pay calendars, schedule (or the user said it changes weekly), regular expenses, bank balance and the tax percent. Marks setup finished and opens their dashboard.",
    schema: Empty,
    risk: "write",
    run: async (ctx) => {
      await completeOnboarding(ctx);
      return { summary: "Setup finished. Your dashboard is ready.", display: { kind: "setup_done" } };
    },
  }),
  tool({
    name: "offer_schedule_scan",
    description: "Show a button that lets the user take or upload a photo of their work schedule. HARU reads the shifts and the user checks and edits them before saving. Offer it when asking about their schedule.",
    schema: Empty,
    risk: "read",
    run: async () => ({ summary: "Showed the schedule photo button.", display: { kind: "scan_schedule" } }),
  }),
  tool({
    name: "offer_notifications",
    description: "Show a button that turns on push notifications on this phone (1 hour before each shift with what it earns, and a check-in after). Offer it near the end of setup, or when the user asks about reminders.",
    schema: Empty,
    risk: "read",
    run: async () => ({ summary: "Showed the notifications button.", display: { kind: "enable_push" } }),
  }),
  tool({
    name: "dismiss_observation",
    description: "Dismiss (or accept) a pattern HARU noticed, when the user says it's wrong or not useful.",
    schema: z.object({ observation_id: V.zId, status: z.enum(["dismissed", "accepted"]) }),
    risk: "write",
    run: async (ctx, a) => {
      await setObservationStatus(ctx, a.observation_id, a.status);
      return { summary: a.status === "dismissed" ? "Got it — I won't use that observation." : "Noted.", undo: [{ op: "restore", table: "behavior_observations", id: a.observation_id, values: { status: "active" } }] };
    },
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** JSON Schema for the model, generated from the same Zod schema that validates the call. */
export function toolSpecs() {
  return TOOLS.map((t) => {
    const js = z.toJSONSchema(t.schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
    delete js.$schema;
    if (!js.type) js.type = "object";
    return { name: t.name, description: t.description, inputSchema: js };
  });
}

export async function riskOf(t: ToolDef, args: unknown, ctx: Ctx): Promise<Risk> {
  return typeof t.risk === "function" ? await t.risk(args as never, ctx) : t.risk;
}

/** Look up an opportunity by id, scoped to the user (used by the agent for context). */
export { getOpportunity };

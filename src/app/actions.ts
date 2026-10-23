"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireCtx } from "@/lib/server/context";
import { AppError, logError, publicMessage } from "@/lib/server/errors";
import { sql } from "@/lib/server/db";
import * as V from "@/lib/validation";
import { createJob, updateJob } from "@/lib/server/services/jobs";
import { createShift, deleteShift, updateShift } from "@/lib/server/services/shifts";
import { createOpportunity, updateOpportunityStatus } from "@/lib/server/services/opportunities";
import { recordPaycheck } from "@/lib/server/services/payroll";
import {
  contributeToGoal, createAccount, createBill, createDebt, createGoal, markBillPaid, recordDebtPayment,
  recordExpense, recordIncome, recordTransfer, setBalance, updateBill, voidTransaction,
} from "@/lib/server/services/finance";
import { cancelReminder, createReminder, markNotificationsRead } from "@/lib/server/services/reminders";
import { completeOnboarding, updatePrefs } from "@/lib/server/services/prefs";
import { checkoutShift, setAttendance, takeHome } from "@/lib/server/services/shiftloop";
import { setObservationStatus } from "@/lib/server/services/observations";
import type { Ctx } from "@/lib/server/context";
import { autoPlace, changeCards } from "@/lib/server/services/cards";
import { isCardKey } from "@/lib/dashboard-registry";
import type { ServiceResult } from "@/lib/server/services/jobs";

export type ActionResult = { ok: true; summary: string } | { ok: false; error: string };

// Every manual form goes through the same validated, user-scoped services as the AI.
const ACTIONS = {
  createJob: { schema: V.JobCreate, run: (c: Ctx, a: V.JobCreate) => createJob(c, a, "user") },
  updateJob: { schema: V.JobUpdate, run: (c: Ctx, a: V.JobUpdate) => updateJob(c, a, "user") },
  createShift: { schema: V.ShiftCreate, run: (c: Ctx, a: V.ShiftCreate) => createShift(c, a, "user") },
  updateShift: { schema: V.ShiftUpdate, run: (c: Ctx, a: V.ShiftUpdate) => updateShift(c, a, "user") },
  deleteShift: { schema: z.object({ shift_id: V.zId }), run: (c: Ctx, a: { shift_id: string }) => deleteShift(c, a.shift_id, "user") },
  createOpportunity: { schema: V.OpportunityCreate, run: (c: Ctx, a: V.OpportunityCreate) => createOpportunity(c, a, "user") },
  updateOpportunity: { schema: V.OpportunityStatusUpdate, run: (c: Ctx, a: V.OpportunityStatusUpdate) => updateOpportunityStatus(c, a, "user") },
  recordPaycheck: { schema: V.PaycheckReceived, run: (c: Ctx, a: z.infer<typeof V.PaycheckReceived>) => recordPaycheck(c, a, "user") },
  createAccount: { schema: V.AccountCreate, run: (c: Ctx, a: z.infer<typeof V.AccountCreate>) => createAccount(c, a, "user") },
  setBalance: { schema: V.SetBalance, run: (c: Ctx, a: z.infer<typeof V.SetBalance>) => setBalance(c, a, "user") },
  recordExpense: { schema: V.ExpenseCreate, run: (c: Ctx, a: V.ExpenseCreate) => recordExpense(c, a, "user") },
  recordIncome: { schema: V.RecordIncome, run: (c: Ctx, a: z.infer<typeof V.RecordIncome>) => recordIncome(c, a, "user") },
  recordTransfer: { schema: V.TransferCreate, run: (c: Ctx, a: z.infer<typeof V.TransferCreate>) => recordTransfer(c, a, "user") },
  voidTransaction: { schema: z.object({ transaction_id: V.zId }), run: (c: Ctx, a: { transaction_id: string }) => voidTransaction(c, a.transaction_id, "user") },
  createBill: { schema: V.BillCreate, run: (c: Ctx, a: V.BillCreate) => createBill(c, a, "user") },
  updateBill: { schema: V.BillUpdate, run: (c: Ctx, a: z.infer<typeof V.BillUpdate>) => updateBill(c, a, "user") },
  markBillPaid: { schema: V.BillPaid, run: (c: Ctx, a: z.infer<typeof V.BillPaid>) => markBillPaid(c, a, "user") },
  createDebt: { schema: V.DebtCreate, run: (c: Ctx, a: z.infer<typeof V.DebtCreate>) => createDebt(c, a, "user") },
  recordDebtPayment: { schema: V.DebtPayment, run: (c: Ctx, a: z.infer<typeof V.DebtPayment>) => recordDebtPayment(c, a, "user") },
  createGoal: { schema: V.GoalCreate, run: (c: Ctx, a: z.infer<typeof V.GoalCreate>) => createGoal(c, a, "user") },
  contributeToGoal: { schema: V.GoalContribution, run: (c: Ctx, a: z.infer<typeof V.GoalContribution>) => contributeToGoal(c, a, "user") },
  createReminder: { schema: V.ReminderCreate, run: (c: Ctx, a: z.infer<typeof V.ReminderCreate>) => createReminder(c, a, "user") },
  updatePrefs: { schema: V.PrefsUpdate, run: (c: Ctx, a: V.PrefsUpdate) => updatePrefs(c, a, "user") },
  setAttendance: { schema: V.ShiftAttendance, run: (c: Ctx, a: z.infer<typeof V.ShiftAttendance>) => setAttendance(c, a.shift_id, a.going, "user") },
  checkoutShift: { schema: V.ShiftCheckout, run: (c: Ctx, a: z.infer<typeof V.ShiftCheckout>) => checkoutShift(c, a.shift_id, a, "user") },
} as const;

export type ActionKind = keyof typeof ACTIONS;

export async function act(kind: ActionKind, input: unknown): Promise<ActionResult> {
  try {
    const def = ACTIONS[kind];
    if (!def) throw new AppError("Unknown action.");
    const ctx = await requireCtx();
    const parsed = def.schema.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    const res = (await (def.run as (c: Ctx, a: unknown) => Promise<ServiceResult>)(ctx, parsed.data)) as ServiceResult;
    await autoPlace(ctx, kind).catch((e) => logError("cards.autoPlace", e));
    revalidatePath("/");
    return { ok: true, summary: res.summary };
  } catch (e) {
    if (!(e instanceof AppError)) logError(`action.${kind}`, e);
    return { ok: false, error: publicMessage(e) };
  }
}

async function simple(fn: (ctx: Ctx) => Promise<void>): Promise<ActionResult> {
  try {
    const ctx = await requireCtx();
    await fn(ctx);
    revalidatePath("/");
    return { ok: true, summary: "Saved" };
  } catch (e) {
    if (!(e instanceof AppError)) logError("action", e);
    return { ok: false, error: publicMessage(e) };
  }
}

export async function finishOnboarding() {
  return simple((ctx) => completeOnboarding(ctx));
}
export async function readNotifications(ids?: string[]) {
  return simple((ctx) => markNotificationsRead(ctx, ids?.filter((i) => V.zId.safeParse(i).success)));
}
export async function cancelReminderAction(id: string) {
  return simple((ctx) => (V.zId.safeParse(id).success ? cancelReminder(ctx, id) : Promise.reject(new AppError("Invalid id"))));
}
export async function observationAction(id: string, status: "dismissed" | "accepted") {
  return simple((ctx) => (V.zId.safeParse(id).success && ["dismissed", "accepted"].includes(status) ? setObservationStatus(ctx, id, status) : Promise.reject(new AppError("Invalid"))));
}
/** The user's own edits to the dashboard HARU built: remove, bring back, or move a card. */
export async function editCards(input: { add?: string[]; remove?: string[]; order?: string[] }): Promise<ActionResult> {
  try {
    const ctx = await requireCtx();
    const keys = (xs?: string[]) => (xs ?? []).filter(isCardKey);
    const r = await changeCards(ctx, { add: keys(input.add), remove: keys(input.remove), order: keys(input.order) });
    revalidatePath("/");
    return { ok: true, summary: r.summary };
  } catch (e) {
    if (!(e instanceof AppError)) logError("action.editCards", e);
    return { ok: false, error: publicMessage(e) };
  }
}
export async function signOut() {
  const { supabaseServer } = await import("@/lib/server/context");
  const sb = await supabaseServer();
  await sb.auth.signOut();
}

/** Everything the Records sheet needs, already serialised for the client. */
export async function loadRecords() {
  const ctx = await requireCtx();
  const { listJobs } = await import("@/lib/server/services/jobs");
  const { listShifts } = await import("@/lib/server/services/shifts");
  const { listAccounts, listBills, listTransactions } = await import("@/lib/server/services/finance");
  const { listOpportunities } = await import("@/lib/server/services/opportunities");
  const { listPaychecks } = await import("@/lib/server/services/payroll");
  const { addDays, localTime } = await import("@/lib/domain/time");
  const [jobs, shifts, accounts, transactions, bills, goals, debts, opportunities, paychecks] = await Promise.all([
    listJobs(ctx, sql, { includeEnded: true }),
    listShifts(ctx, { start: addDays(ctx.today, -45), end: addDays(ctx.today, 21) }),
    listAccounts(ctx),
    listTransactions(ctx, { start: addDays(ctx.today, -90), end: ctx.today, limit: 80 }),
    listBills(ctx, sql, { includeArchived: false }),
    sql<{ goal_id: string; name: string; saved_cents: number; target_cents: number; target_date: string | null; monthly_target_cents: number | null }[]>`
      select goal_id, name, saved_cents, target_cents, target_date, monthly_target_cents from goal_progress where user_id = ${ctx.userId} and status = 'active'`,
    sql<{ debt_id: string; name: string; balance_cents: number; starting_balance_cents: number }[]>`
      select debt_id, name, balance_cents, starting_balance_cents from debt_balances where user_id = ${ctx.userId} and status = 'active'`,
    listOpportunities(ctx),
    listPaychecks(ctx, 10),
  ]);
  return {
    today: ctx.today,
    currency: ctx.currency,
    jobs: jobs.map((j) => ({ ...j, created_at: undefined, updated_at: undefined })),
    shifts: shifts.map((s) => ({
      id: s.id, job_id: s.job_id, job_name: s.job_name, work_date: s.work_date, status: s.status,
      start: s.starts_at ? localTime(s.starts_at, ctx.tz) : null, end: s.ends_at ? localTime(s.ends_at, ctx.tz) : null,
      break_minutes: s.break_minutes, paid_minutes: s.paid_minutes, rate_cents: s.rate_cents, gross_cents: s.gross_cents, paid: Boolean(s.paycheck_id),
    })).reverse(),
    accounts,
    transactions,
    bills,
    goals,
    debts,
    opportunities: opportunities.map((o) => ({ id: o.id, name: o.name, status: o.status, work_date: o.work_date, offered_cents: o.offered_cents, expected_minutes: o.expected_minutes, paid: o.paid })),
    paychecks,
  };
}
export type RecordsData = Awaited<ReturnType<typeof loadRecords>>;

/** Settings + notification health, for the Settings sheet. */
export async function loadSettings() {
  const ctx = await requireCtx();
  const { pushConfigured } = await import("@/lib/server/notifications/push");
  const { recentNotifications } = await import("@/lib/server/services/reminders");
  const [devices, lastRun, recent] = await Promise.all([
    sql<{ endpoint: string; user_agent: string | null; last_success_at: Date | null; created_at: Date }[]>`
      select endpoint, user_agent, last_success_at, created_at from push_subscriptions where user_id = ${ctx.userId} order by created_at`,
    sql<{ finished_at: Date | null; error: string | null }[]>`select finished_at, error from scheduler_runs order by id desc limit 1`,
    recentNotifications(ctx, 30),
  ]);
  return {
    prefs: { ...ctx.prefs, onboarded_at: undefined },
    email: ctx.email,
    pushConfigured: pushConfigured(),
    devices: devices.map((d) => ({ endpoint: d.endpoint, userAgent: d.user_agent, lastSuccessAt: d.last_success_at?.toISOString() ?? null })),
    scheduler: lastRun[0] ? { lastRunAt: lastRun[0].finished_at?.toISOString() ?? null, error: lastRun[0].error } : null,
    notifications: recent.map((r) => ({ id: r.id, title: r.title, body: r.body, status: r.status, at: (r.sent_at ?? r.fire_at).toISOString(), read: Boolean(r.read_at), note: r.last_error })),
  };
}
export type SettingsData = Awaited<ReturnType<typeof loadSettings>>;

/** One week of shifts (and one-time work) for the Schedule view. */
export async function loadSchedule(weekStart?: string) {
  const ctx = await requireCtx();
  const { listJobs, jobLabel } = await import("@/lib/server/services/jobs");
  const { listShifts, materializeSchedules } = await import("@/lib/server/services/shifts");
  const { listOpportunities } = await import("@/lib/server/services/opportunities");
  const { addDays, startOfWeek, isISODate, localTime } = await import("@/lib/domain/time");
  await materializeSchedules(ctx, 21).catch(() => 0);
  const start = weekStart && isISODate(weekStart) ? startOfWeek(weekStart, ctx.prefs.week_starts_on) : startOfWeek(ctx.today, ctx.prefs.week_starts_on);
  const end = addDays(start, 6);
  const [jobs, shifts, opps] = await Promise.all([listJobs(ctx), listShifts(ctx, { start, end }), listOpportunities(ctx)]);
  return {
    today: ctx.today,
    start,
    end,
    currency: ctx.currency,
    taxPercent: ctx.prefs.reserve_percent,
    jobs: jobs.map((j, i) => ({ id: j.id, name: jobLabel(j), employer: j.employer, rateCents: j.current_rate_cents, color: i, schedule: j.regular_schedule })),
    shifts: shifts
      .filter((s) => s.status !== "cancelled")
      .map((s) => ({
        id: s.id,
        jobId: s.job_id,
        jobName: s.job_name,
        date: s.work_date,
        start: s.starts_at ? localTime(s.starts_at, ctx.tz) : null,
        end: s.ends_at ? localTime(s.ends_at, ctx.tz) : null,
        minutes: s.paid_minutes,
        grossCents: s.gross_cents,
        takeHomeCents: takeHome(ctx, s.gross_cents),
        status: s.status,
        attendance: s.attendance,
        ended: s.ends_at ? s.ends_at.getTime() < Date.now() : s.work_date < ctx.today,
      })),
    extras: opps
      .filter((o) => o.work_date && o.work_date >= start && o.work_date <= end && o.status !== "declined")
      .map((o) => ({ id: o.id, name: o.name, date: o.work_date!, offeredCents: o.offered_cents, minutes: o.expected_minutes, status: o.status, start: o.starts_at ? localTime(o.starts_at, ctx.tz) : null })),
  };
}
export type ScheduleData = Awaited<ReturnType<typeof loadSchedule>>;

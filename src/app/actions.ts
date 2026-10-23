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
import { setObservationStatus } from "@/lib/server/services/observations";
import type { Ctx } from "@/lib/server/context";
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
export async function resetDashboardLayout() {
  return simple(async (ctx) => {
    await sql`update dashboard_preferences set previous_layout = layout, layout = '[]'::jsonb, updated_at = now() where user_id = ${ctx.userId}`;
  });
}
export async function undoDashboardLayout() {
  return simple(async (ctx) => {
    await sql`update dashboard_preferences set layout = coalesce(previous_layout, '[]'::jsonb), previous_layout = layout, updated_at = now() where user_id = ${ctx.userId}`;
  });
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

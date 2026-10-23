import "server-only";
import { sql, type Q } from "../db";
import type { Ctx } from "../context";
import { AppError } from "../errors";
import { logActivity, type Actor } from "../activity";
import type { UndoOp } from "../undo";
import { formatMoney, toCents } from "../../domain/money";
import { forecastPaycheck, periodsFrom, type PayPeriod, type PaycheckForecast } from "../../domain/payroll";
import { addDays } from "../../domain/time";
import type { z } from "zod";
import type { PaycheckReceived } from "../../validation";
import { getJob, jobLabel, listJobs, payRuleOf, type JobRow, type ServiceResult } from "./jobs";
import { accountOrDefault, insertTx } from "./finance";

export interface JobForecast {
  jobId: string;
  jobName: string;
  configured: boolean;
  period?: PayPeriod;
  forecast?: PaycheckForecast;
  daysUntil?: number;
}

export interface AwaitingPaycheck {
  jobId: string;
  jobName: string;
  period: PayPeriod;
  loggedGrossCents: number;
}

async function receivedStarts(ctx: Ctx, jobId: string, q: Q) {
  const rows = await q<{ period_start: string }[]>`
    select period_start from paychecks where user_id = ${ctx.userId} and job_id = ${jobId} and status = 'received'`;
  return new Set(rows.map((r) => r.period_start));
}

async function periodShifts(ctx: Ctx, jobId: string, p: { start: string; end: string }, q: Q) {
  return q<{ status: "scheduled" | "completed" | "cancelled"; gross_cents: number; paid_minutes: number }[]>`
    select status, gross_cents, paid_minutes from shifts
    where user_id = ${ctx.userId} and job_id = ${jobId} and work_date between ${p.start} and ${p.end} and status <> 'cancelled'`;
}

/** Next unpaid payday for one job, using its saved payroll rules. */
export async function forecastForJob(ctx: Ctx, job: JobRow, q: Q = sql): Promise<JobForecast> {
  const rule = payRuleOf(job);
  const base = { jobId: job.id, jobName: jobLabel(job) };
  if (!rule) return { ...base, configured: false };
  const received = await receivedStarts(ctx, job.id, q);
  const period = periodsFrom(rule, addDays(ctx.today, -62), 24)
    .filter((p) => p.payDate >= ctx.today && !received.has(p.start))
    .sort((a, b) => (a.payDate < b.payDate ? -1 : 1))[0];
  if (!period) return { ...base, configured: false };
  const shifts = await periodShifts(ctx, job.id, period, q);
  const forecast = forecastPaycheck({
    period,
    today: ctx.today,
    shifts,
    deductionPercent: job.deduction_percent,
    deductionFixedCents: job.deduction_fixed_cents,
    reservePercent: ctx.prefs.reserve_percent,
  });
  const daysUntil = Math.round((Date.parse(period.payDate) - Date.parse(ctx.today)) / 86400e3);
  return { ...base, configured: true, period, forecast, daysUntil };
}

export async function forecastAll(ctx: Ctx, q: Q = sql): Promise<JobForecast[]> {
  const jobs = (await listJobs(ctx, q)).filter((j) => j.status === "active");
  const out: JobForecast[] = [];
  for (const j of jobs) out.push(await forecastForJob(ctx, j, q));
  return out.sort((a, b) => (a.period?.payDate ?? "9999") < (b.period?.payDate ?? "9999") ? -1 : 1);
}

/** Paydays that have passed with logged work but no recorded paycheck. */
export async function awaitingPaychecks(ctx: Ctx, q: Q = sql): Promise<AwaitingPaycheck[]> {
  const out: AwaitingPaycheck[] = [];
  for (const job of await listJobs(ctx, q)) {
    const rule = payRuleOf(job);
    if (!rule) continue;
    const received = await receivedStarts(ctx, job.id, q);
    const due = periodsFrom(rule, addDays(ctx.today, -75), 16).filter((p) => p.payDate < ctx.today && p.payDate >= addDays(ctx.today, -45) && !received.has(p.start));
    for (const p of due) {
      const shifts = await periodShifts(ctx, job.id, p, q);
      const logged = shifts.filter((s) => s.status === "completed").reduce((a, s) => a + s.gross_cents, 0);
      if (logged > 0) out.push({ jobId: job.id, jobName: jobLabel(job), period: p, loggedGrossCents: logged });
    }
  }
  return out;
}

/**
 * Record a paycheck that arrived. This is the ONLY place job earnings become cash:
 * one deposit per pay period (unique index), and the period's shifts are linked to
 * the paycheck so they stop counting as "earned but unpaid".
 */
export async function recordPaycheck(ctx: Ctx, i: z.infer<typeof PaycheckReceived>, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const job = await getJob(ctx, i.job_id, tx);
    const rule = payRuleOf(job);
    const net = toCents(i.amount_received);
    let period: { start: string; end: string; payDate: string };

    if (rule) {
      const received = await receivedStarts(ctx, job.id, tx);
      const candidates = periodsFrom(rule, addDays(i.received_on, -120), 20).filter((p) => !received.has(p.start));
      const match = i.pay_date
        ? candidates.find((p) => p.payDate === i.pay_date)
        : candidates.filter((p) => p.payDate <= addDays(i.received_on, 3)).sort((a, b) => (a.payDate < b.payDate ? 1 : -1))[0];
      if (!match) throw new AppError(`I couldn't match that to an unpaid ${job.employer} pay period. Which payday was it?`);
      period = match;
    } else {
      // No payroll rules: the paycheck covers unpaid logged work up to the day it arrived.
      const [r] = await tx<{ start: string | null }[]>`
        select min(work_date)::text as start from shifts
        where user_id = ${ctx.userId} and job_id = ${job.id} and status = 'completed' and paycheck_id is null and work_date <= ${i.received_on}`;
      period = { start: r.start ?? i.received_on, end: i.received_on, payDate: i.received_on };
    }

    const shifts = await tx<{ gross_cents: number }[]>`
      select gross_cents from shifts where user_id = ${ctx.userId} and job_id = ${job.id} and status = 'completed'
        and paycheck_id is null and work_date between ${period.start} and ${period.end}`;
    const loggedGross = shifts.reduce((a, s) => a + s.gross_cents, 0);
    const knownDeduction =
      job.deduction_percent != null || job.deduction_fixed_cents != null
        ? Math.round((loggedGross * (job.deduction_percent ?? 0)) / 100) + (job.deduction_fixed_cents ?? 0)
        : null;
    const expectedNet = knownDeduction != null ? Math.max(0, loggedGross - knownDeduction) : null;

    const [existing] = await tx<{ id: string; status: string; expected_gross_cents: number; expected_net_cents: number | null }[]>`
      select id, status, expected_gross_cents, expected_net_cents from paychecks where job_id = ${job.id} and period_start = ${period.start} and user_id = ${ctx.userId}`;
    if (existing?.status === "received") throw new AppError(`The ${job.employer} paycheck for ${period.start} – ${period.end} is already recorded.`, 409);

    const undo: UndoOp[] = [];
    let paycheckId: string;
    if (existing) {
      await tx`update paychecks set status = 'received', actual_net_cents = ${net}, actual_gross_cents = ${i.gross_amount != null ? toCents(i.gross_amount) : null},
                 expected_gross_cents = ${loggedGross}, expected_net_cents = ${expectedNet}, received_at = now(), updated_at = now()
               where id = ${existing.id}`;
      paycheckId = existing.id;
      undo.push({ op: "restore", table: "paychecks", id: existing.id, values: { status: "expected", actual_net_cents: null, actual_gross_cents: null, received_at: null, expected_gross_cents: existing.expected_gross_cents, expected_net_cents: existing.expected_net_cents } });
    } else {
      const [p] = await tx<{ id: string }[]>`
        insert into paychecks (user_id, job_id, period_start, period_end, pay_date, expected_gross_cents, expected_net_cents,
                               actual_net_cents, actual_gross_cents, status, received_at)
        values (${ctx.userId}, ${job.id}, ${period.start}, ${period.end}, ${period.payDate}, ${loggedGross}, ${expectedNet},
                ${net}, ${i.gross_amount != null ? toCents(i.gross_amount) : null}, 'received', now())
        returning id`;
      paycheckId = p.id;
      // Keep the row (the voided deposit still references it); undo reverts it to expected.
      undo.push({ op: "restore", table: "paychecks", id: p.id, values: { status: "expected", actual_net_cents: null, actual_gross_cents: null, received_at: null } });
    }

    const acct = await accountOrDefault(ctx, tx, i.account_id);
    const txId = await insertTx(ctx, tx, { account_id: acct.id, type: "paycheck", amount_cents: net, occurred_on: i.received_on, category: "paycheck", description: `${job.employer} pay ${period.start} – ${period.end}`, paycheck_id: paycheckId }, actor);
    await tx`update shifts set paycheck_id = ${paycheckId} where user_id = ${ctx.userId} and job_id = ${job.id} and status = 'completed'
               and paycheck_id is null and work_date between ${period.start} and ${period.end}`;
    // Applied in reverse: void the deposit, unlink shifts, then revert/delete the paycheck.
    undo.push({ op: "unlink_shifts", paycheckId }, { op: "void", id: txId });

    const m = (c: number) => formatMoney(c, ctx.currency);
    const comparison =
      expectedNet != null
        ? `Expected about ${m(expectedNet)} net from your logged hours (${m(loggedGross)} gross); difference ${m(net - expectedNet)}.`
        : loggedGross > 0
          ? `Your logged hours came to ${m(loggedGross)} gross, so about ${m(loggedGross - net)} went to deductions or hours that weren't logged. HARU doesn't know your exact deductions.`
          : "No logged hours were in this pay period, so there's nothing to compare against.";
    await logActivity(tx, ctx.userId, { entity: "paycheck", entityId: paycheckId, action: "received", actor, summary: `${job.employer} paycheck ${m(net)} received` });
    return {
      summary: `Recorded ${m(net)} from ${job.employer} into ${acct.name} (pay period ${period.start} – ${period.end}). ${comparison}`,
      data: { paycheckId, loggedGrossCents: loggedGross, expectedNetCents: expectedNet, netCents: net, differenceCents: expectedNet != null ? net - expectedNet : null },
      undo,
    };
  });
}

export async function listPaychecks(ctx: Ctx, limit = 12, q: Q = sql) {
  return q<{ id: string; job_name: string; period_start: string; period_end: string; pay_date: string; status: string; expected_gross_cents: number; expected_net_cents: number | null; actual_net_cents: number | null }[]>`
    select p.id, j.employer as job_name, p.period_start, p.period_end, p.pay_date, p.status, p.expected_gross_cents, p.expected_net_cents, p.actual_net_cents
    from paychecks p join jobs j on j.id = p.job_id where p.user_id = ${ctx.userId} order by p.pay_date desc limit ${limit}`;
}

import "server-only";
import { sql, type Q } from "../db";
import type { Ctx } from "../context";
import { AppError } from "../errors";
import { logActivity, type Actor } from "../activity";
import { snapshot } from "../undo";
import { formatHours, formatMoney, grossFor, percentOf } from "../../domain/money";
import { hoursToMinutes } from "../../domain/shifts";
import { periodWithPayDate } from "../../domain/payroll";
import { friendlyDate, localParts, splitDate, weekdayOf } from "../../domain/time";
import { getJob, payRuleOf, type ServiceResult } from "./jobs";
import { getShift } from "./shifts";

// The shift loop: "Are you going?" before a shift, "Did you finish?" after it.
// Every answer is stored as a shift_event so HARU can learn attendance patterns.

export interface PaycheckContext {
  payDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Gross already logged in this pay period (completed shifts). */
  paycheckSoFarCents: number;
  /** Logged + still-scheduled shifts in the period, after the tax estimate. */
  projectedTakeHomeCents: number;
}

export function takeHome(ctx: Ctx, grossCents: number): number {
  return grossCents - percentOf(grossCents, ctx.prefs.reserve_percent);
}

/** Which paycheck a shift on `date` lands in, and how big that paycheck is so far. */
export async function paycheckContext(ctx: Ctx, jobId: string, date: string, q: Q = sql): Promise<PaycheckContext> {
  const job = await getJob(ctx, jobId, q);
  const rule = payRuleOf(job);
  if (!rule) return { payDate: null, periodStart: null, periodEnd: null, paycheckSoFarCents: 0, projectedTakeHomeCents: 0 };
  const p = periodWithPayDate(rule, date);
  const [r] = await q<{ done: number; planned: number }[]>`
    select coalesce(sum(gross_cents) filter (where status = 'completed'), 0) as done,
           coalesce(sum(gross_cents) filter (where status in ('completed','scheduled')), 0) as planned
    from shifts where user_id = ${ctx.userId} and job_id = ${jobId} and work_date between ${p.start} and ${p.end}`;
  return { payDate: p.payDate, periodStart: p.start, periodEnd: p.end, paycheckSoFarCents: r.done, projectedTakeHomeCents: takeHome(ctx, r.planned) };
}

async function recordEvent(ctx: Ctx, q: Q, shift: { id: string; work_date: string; paid_minutes: number }, event: string, hoursWorked: number | null) {
  const { hour } = localParts(ctx.now, ctx.tz);
  await q`insert into shift_events (user_id, shift_id, event, weekday, local_hour, hours_planned, hours_worked)
          values (${ctx.userId}, ${shift.id}, ${event}, ${weekdayOf(shift.work_date)}, ${hour}, ${shift.paid_minutes / 60}, ${hoursWorked})`;
}

const year = (ctx: Ctx) => splitDate(ctx.today).year;

/** Before a shift: "I'm going" or "I can't make it". */
export async function setAttendance(ctx: Ctx, shiftId: string, going: boolean, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const s = await getShift(ctx, shiftId, tx);
    if (s.status !== "scheduled") throw new AppError(`This shift is already ${s.status}.`, 409);
    const before = snapshot(s as unknown as Record<string, unknown>, ["status", "attendance"]);
    const m = (c: number) => formatMoney(c, ctx.currency);
    const net = takeHome(ctx, s.gross_cents);
    const pc = await paycheckContext(ctx, s.job_id, s.work_date, tx);
    let summary: string;
    if (going) {
      await tx`update shifts set attendance = 'going', updated_at = now() where id = ${s.id} and user_id = ${ctx.userId}`;
      summary = `Let's go. This shift earns about ${m(net)} after tax${pc.payDate ? `, added to your ${friendlyDate(pc.payDate, year(ctx))} paycheck` : ""}.`;
    } else {
      await tx`update shifts set attendance = 'not_going', status = 'missed', updated_at = now() where id = ${s.id} and user_id = ${ctx.userId}`;
      summary = `Marked as missed. That's ${m(net)} you won't earn from this shift.`;
    }
    await recordEvent(ctx, tx, s, going ? "going" : "not_going", null);
    await logActivity(tx, ctx.userId, { entity: "shift", entityId: s.id, action: going ? "going" : "missed", actor, summary: `${s.job_name} ${s.work_date}: ${going ? "going" : "not going"}` });
    return { summary, data: { takeHomeCents: net, payDate: pc.payDate }, undo: [{ op: "restore", table: "shifts", id: s.id, values: before }] };
  });
}

/** After a shift: worked it fully, worked fewer hours, or missed it. */
export async function checkoutShift(ctx: Ctx, shiftId: string, i: { full?: boolean; hours?: number; missed?: boolean }, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const s = await getShift(ctx, shiftId, tx);
    if (s.status === "completed") throw new AppError("This shift is already logged.", 409);
    if (s.work_date > ctx.today) throw new AppError("This shift hasn't happened yet.");
    const before = snapshot(s as unknown as Record<string, unknown>, ["status", "attendance", "paid_minutes", "gross_cents", "ends_at"]);
    const m = (c: number) => formatMoney(c, ctx.currency);

    if (i.missed) {
      await tx`update shifts set status = 'missed', attendance = 'not_going', updated_at = now() where id = ${s.id} and user_id = ${ctx.userId}`;
      await recordEvent(ctx, tx, s, "missed", 0);
      await logActivity(tx, ctx.userId, { entity: "shift", entityId: s.id, action: "missed", actor, summary: `Missed ${s.job_name} on ${s.work_date}` });
      return { summary: `Logged as missed. ${m(takeHome(ctx, s.gross_cents))} not earned this time.`, undo: [{ op: "restore", table: "shifts", id: s.id, values: before }] };
    }

    const minutes = i.full || i.hours == null ? s.paid_minutes : hoursToMinutes(i.hours);
    const gross = grossFor(minutes, s.rate_cents);
    const endsAt = s.starts_at ? new Date(s.starts_at.getTime() + (minutes + s.break_minutes) * 60000) : s.ends_at;
    await tx`update shifts set status = 'completed', attendance = 'going', paid_minutes = ${minutes}, gross_cents = ${gross},
               ends_at = ${endsAt}, updated_at = now() where id = ${s.id} and user_id = ${ctx.userId}`;
    const partial = minutes !== s.paid_minutes;
    await recordEvent(ctx, tx, s, partial ? "completed_partial" : "completed_full", minutes / 60);
    const pc = await paycheckContext(ctx, s.job_id, s.work_date, tx);
    const summary =
      `Logged ${formatHours(minutes)} at ${s.job_name}: +${m(takeHome(ctx, gross))} after tax (${m(gross)} gross).` +
      (pc.payDate ? ` Your ${friendlyDate(pc.payDate, year(ctx))} paycheck is now about ${m(takeHome(ctx, pc.paycheckSoFarCents))}.` : "");
    await logActivity(tx, ctx.userId, { entity: "shift", entityId: s.id, action: "complete", actor, summary: `Logged ${s.job_name} ${s.work_date}: ${formatHours(minutes)}` });
    return { summary, data: { grossCents: gross, takeHomeCents: takeHome(ctx, gross), payDate: pc.payDate }, undo: [{ op: "restore", table: "shifts", id: s.id, values: before }] };
  });
}

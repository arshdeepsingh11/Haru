import "server-only";
import { sql, type Q } from "../db";
import type { Ctx } from "../context";
import { AppError, NotFound } from "../errors";
import { logActivity, type Actor } from "../activity";
import { snapshot } from "../undo";
import { formatHours, formatMoney, grossFor, toCents } from "../../domain/money";
import { hoursToMinutes, rateForDate, shiftFromTimes } from "../../domain/shifts";
import { addDays, eachDay, localTime, weekdayOf, zonedToUtc } from "../../domain/time";
import type { ShiftCreate, ShiftUpdate } from "../../validation";
import { getJob, jobLabel, listJobs, wagesFor, type ServiceResult } from "./jobs";

export interface ShiftRow {
  id: string;
  job_id: string;
  job_name: string;
  work_date: string;
  starts_at: Date | null;
  ends_at: Date | null;
  break_minutes: number;
  paid_minutes: number;
  rate_cents: number;
  gross_cents: number;
  status: "scheduled" | "completed" | "cancelled" | "missed";
  attendance: "pending" | "going" | "not_going";
  source: string;
  paycheck_id: string | null;
  notes: string | null;
  created_at: Date;
}

const SHIFT_COLS = ["work_date", "starts_at", "ends_at", "break_minutes", "paid_minutes", "rate_cents", "gross_cents", "status", "notes", "revised_at"] as const;

export async function getShift(ctx: Ctx, id: string, q: Q = sql): Promise<ShiftRow> {
  const [s] = await q<ShiftRow[]>`
    select s.*, j.employer as job_name from shifts s join jobs j on j.id = s.job_id
    where s.id = ${id} and s.user_id = ${ctx.userId}`;
  if (!s) throw new NotFound("Shift");
  return s;
}

export async function listShifts(ctx: Ctx, r: { start: string; end: string; jobId?: string; status?: string }, q: Q = sql) {
  return q<ShiftRow[]>`
    select s.*, j.employer as job_name from shifts s join jobs j on j.id = s.job_id
    where s.user_id = ${ctx.userId} and s.work_date between ${r.start} and ${r.end}
      ${r.jobId ? q`and s.job_id = ${r.jobId}` : q``}
      ${r.status ? q`and s.status = ${r.status}` : q``}
    order by s.work_date, s.starts_at nulls last`;
}

function describe(s: { paid_minutes: number; gross_cents: number; rate_cents: number }, currency: string) {
  return `${formatHours(s.paid_minutes)} × ${formatMoney(s.rate_cents, currency)}/h = ${formatMoney(s.gross_cents, currency)} gross`;
}

function resolveTiming(ctx: Ctx, date: string, i: { start?: string; end?: string; hours?: number; break_minutes?: number }) {
  if (i.start && i.end) {
    const t = shiftFromTimes(date, i.start, i.end, i.break_minutes ?? 0, ctx.tz);
    return { startsAt: t.startsAt, endsAt: t.endsAt, paidMinutes: t.paidMinutes, breakMinutes: i.break_minutes ?? 0 };
  }
  if (i.hours) {
    const paidMinutes = hoursToMinutes(i.hours);
    // A start time alone anchors the shift on the calendar for reminders.
    const startsAt = i.start ? zonedToUtc(date, i.start, ctx.tz) : null;
    const endsAt = startsAt ? new Date(startsAt.getTime() + (paidMinutes + (i.break_minutes ?? 0)) * 60000) : null;
    return { startsAt, endsAt, paidMinutes, breakMinutes: i.break_minutes ?? 0 };
  }
  throw new AppError("I need either a start and end time, or the number of paid hours.");
}

/**
 * Record worked or scheduled time. Logging completed work on a day that already
 * has a scheduled shift for that job completes the scheduled shift instead of
 * adding a second one (no double counting). Never touches account balances.
 */
export async function createShift(ctx: Ctx, input: ShiftCreate, actor: Actor): Promise<ServiceResult<ShiftRow>> {
  const status = input.status ?? "completed";
  if (status === "completed" && input.date > ctx.today)
    throw new AppError(`${input.date} is in the future. Should this be a scheduled shift instead?`);
  return sql.begin(async (tx) => {
    const job = await getJob(ctx, input.job_id, tx);
    const rate = rateForDate(await wagesFor(ctx, job.id, tx), input.date);
    if (rate == null) throw new AppError(`${jobLabel(job)} has no hourly wage yet.`);
    const t = resolveTiming(ctx, input.date, input);
    const gross = grossFor(t.paidMinutes, rate);

    const sameDay = await tx<ShiftRow[]>`
      select s.*, ${job.employer} as job_name from shifts s
      where s.user_id = ${ctx.userId} and s.job_id = ${job.id} and s.work_date = ${input.date} and s.status not in ('cancelled', 'missed')
      order by s.starts_at nulls last`;

    if (status === "completed") {
      // Two shifts on one day (e.g. 18:00 and 23:30): complete the one whose start time matches best.
      const open = sameDay.filter((s) => s.status === "scheduled");
      const scheduled =
        t.startsAt && open.length > 1
          ? [...open].sort((a, b) => Math.abs((a.starts_at?.getTime() ?? 0) - t.startsAt!.getTime()) - Math.abs((b.starts_at?.getTime() ?? 0) - t.startsAt!.getTime()))[0]
          : open[0];
      if (scheduled) {
        const before = snapshot(scheduled as unknown as Record<string, unknown>, SHIFT_COLS as unknown as string[]);
        await tx`
          update shifts set status = 'completed', paid_minutes = ${t.paidMinutes}, break_minutes = ${t.breakMinutes},
            starts_at = ${t.startsAt ?? scheduled.starts_at}, ends_at = ${t.endsAt ?? scheduled.ends_at},
            rate_cents = ${rate}, gross_cents = ${gross}, notes = coalesce(${input.notes ?? null}, notes), updated_at = now()
          where id = ${scheduled.id} and user_id = ${ctx.userId}`;
        const after = await getShift(ctx, scheduled.id, tx);
        await logActivity(tx, ctx.userId, { entity: "shift", entityId: after.id, action: "complete", actor, summary: `Logged ${jobLabel(job)} ${input.date}: ${describe(after, ctx.currency)}`, before: scheduled, after });
        return {
          summary: `Logged your scheduled ${job.employer} shift on ${input.date}: ${describe(after, ctx.currency)}`,
          data: after,
          undo: [{ op: "restore", table: "shifts", id: after.id, values: before }],
        };
      }
      const done = sameDay.filter((s) => s.status === "completed");
      if (done.length > 0 && !input.additional) {
        throw new AppError(
          `You already logged ${done.map((d) => formatHours(d.paid_minutes)).join(" and ")} at ${job.employer} on ${input.date}. Is this an additional shift, or a correction to that one?`,
          409,
          "possible_duplicate",
        );
      }
    }

    const [row] = await tx<{ id: string }[]>`
      insert into shifts (user_id, job_id, work_date, starts_at, ends_at, break_minutes, paid_minutes, rate_cents, gross_cents, status, source, notes)
      values (${ctx.userId}, ${job.id}, ${input.date}, ${t.startsAt}, ${t.endsAt}, ${t.breakMinutes}, ${t.paidMinutes},
              ${rate}, ${gross}, ${status}, ${actor === "ai" ? "ai" : "manual"}, ${input.notes ?? null})
      returning id`;
    const after = await getShift(ctx, row.id, tx);
    const verb = status === "completed" ? "Logged" : "Scheduled";
    await logActivity(tx, ctx.userId, { entity: "shift", entityId: row.id, action: "create", actor, summary: `${verb} ${jobLabel(job)} ${input.date}: ${describe(after, ctx.currency)}`, after });
    const when = after.starts_at ? ` ${localTime(after.starts_at, ctx.tz)}–${after.ends_at ? localTime(after.ends_at, ctx.tz) : ""}` : "";
    return {
      summary: `${verb} ${job.employer} on ${input.date}${when}: ${describe(after, ctx.currency)}${status === "scheduled" ? " (expected)" : ""}`,
      data: after,
      undo: [{ op: "delete", table: "shifts", id: row.id }],
    };
  });
}

/** Correct a shift. The stored wage stays unless explicitly corrected; history is kept in the audit log. */
export async function updateShift(ctx: Ctx, input: ShiftUpdate, actor: Actor): Promise<ServiceResult<ShiftRow>> {
  return sql.begin(async (tx) => {
    const s = await getShift(ctx, input.shift_id, tx);
    const date = input.date ?? s.work_date;
    const nextStatus = input.status ?? s.status;
    if (nextStatus === "completed" && date > ctx.today) throw new AppError("A completed shift can't be in the future.");
    const rate = input.hourly_rate != null ? toCents(input.hourly_rate) : s.rate_cents;
    let { starts_at, ends_at, paid_minutes, break_minutes } = s;
    if (input.start || input.end || input.hours || input.break_minutes != null || input.date) {
      const start = input.start ?? (s.starts_at ? localTime(s.starts_at, ctx.tz) : undefined);
      const end = input.end ?? (s.ends_at ? localTime(s.ends_at, ctx.tz) : undefined);
      const hours = input.hours ?? (start && end ? undefined : s.paid_minutes / 60);
      const t = resolveTiming(ctx, date, { start, end: input.hours ? undefined : end, hours, break_minutes: input.break_minutes ?? s.break_minutes });
      ({ startsAt: starts_at, endsAt: ends_at, paidMinutes: paid_minutes, breakMinutes: break_minutes } = t);
    }
    const gross = grossFor(paid_minutes, rate);
    const before = snapshot(s as unknown as Record<string, unknown>, SHIFT_COLS as unknown as string[]);
    await tx`
      update shifts set work_date = ${date}, starts_at = ${starts_at}, ends_at = ${ends_at}, break_minutes = ${break_minutes},
        paid_minutes = ${paid_minutes}, rate_cents = ${rate}, gross_cents = ${gross}, status = ${nextStatus},
        notes = ${input.notes ?? s.notes}, revised_at = ${s.status === "completed" ? new Date() : null}, updated_at = now()
      where id = ${s.id} and user_id = ${ctx.userId}`;
    const after = await getShift(ctx, s.id, tx);
    const diff = after.gross_cents - s.gross_cents;
    const summary = `Corrected ${s.job_name} on ${date}: ${describe(after, ctx.currency)}${diff ? ` (${formatMoney(diff, ctx.currency, { signed: true })})` : ""}${after.status !== s.status ? `, now ${after.status}` : ""}`;
    await logActivity(tx, ctx.userId, { entity: "shift", entityId: s.id, action: "update", actor, summary, before: s, after });
    return {
      summary: summary + (s.paycheck_id ? ". This shift was already covered by a received paycheck — the paycheck itself was not changed." : ""),
      data: after,
      undo: [{ op: "restore", table: "shifts", id: s.id, values: before }],
    };
  });
}

export async function deleteShift(ctx: Ctx, shiftId: string, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const s = await getShift(ctx, shiftId, tx);
    await tx`delete from shifts where id = ${s.id} and user_id = ${ctx.userId}`;
    await logActivity(tx, ctx.userId, { entity: "shift", entityId: s.id, action: "delete", actor, summary: `Deleted ${s.job_name} shift on ${s.work_date}`, before: s });
    const values = snapshot(s as unknown as Record<string, unknown>, ["id", "job_id", "source", "paycheck_id", "created_at", ...SHIFT_COLS] as string[]);
    return { summary: `Deleted the ${s.job_name} shift on ${s.work_date} (${formatHours(s.paid_minutes)}).`, undo: [{ op: "insert", table: "shifts", values }] };
  });
}

/**
 * Materialise upcoming shifts from each job's regular schedule (idempotent: the
 * partial unique index on (job, date, start) for source='schedule' prevents copies,
 * and a cancelled generated shift is never re-created).
 */
export async function materializeSchedules(ctx: Ctx, days = 14): Promise<number> {
  const jobs = (await listJobs(ctx)).filter((j) => j.status === "active" && j.regular_schedule.length > 0);
  let created = 0;
  for (const job of jobs) {
    const wages = await wagesFor(ctx, job.id);
    for (const d of eachDay(ctx.today, addDays(ctx.today, days))) {
      if (job.start_date && d < job.start_date) continue;
      for (const e of job.regular_schedule.filter((e) => e.weekday === weekdayOf(d))) {
        const rate = rateForDate(wages, d);
        if (rate == null) continue;
        const t = shiftFromTimes(d, e.start, e.end, e.break_minutes ?? 0, ctx.tz);
        if (t.startsAt <= ctx.now) continue;
        const res = await sql`
          insert into shifts (user_id, job_id, work_date, starts_at, ends_at, break_minutes, paid_minutes, rate_cents, gross_cents, status, source)
          select ${ctx.userId}, ${job.id}, ${d}, ${t.startsAt}, ${t.endsAt}, ${e.break_minutes ?? 0}, ${t.paidMinutes}, ${rate},
                 ${grossFor(t.paidMinutes, rate)}, 'scheduled', 'schedule'
          where not exists (select 1 from shifts where job_id = ${job.id} and work_date = ${d} and starts_at = ${t.startsAt})
          on conflict do nothing`;
        created += res.count;
      }
    }
  }
  return created;
}

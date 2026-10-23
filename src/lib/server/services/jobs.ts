import "server-only";
import { sql, type Q } from "../db";
import type { Ctx } from "../context";
import { AppError, NotFound } from "../errors";
import { logActivity, type Actor } from "../activity";
import { snapshot, type UndoOp } from "../undo";
import { toCents } from "../../domain/money";
import { validateRule, type PayRule } from "../../domain/payroll";
import type { JobCreate, JobUpdate } from "../../validation";

export interface JobRow {
  id: string;
  employer: string;
  title: string | null;
  currency: string;
  status: string;
  start_date: string | null;
  expected_weekly_minutes: number | null;
  pay_frequency: PayRule["frequency"] | null;
  period_anchor_date: string | null;
  semimonthly_split_day: number;
  payday_offset_days: number;
  payday_weekend_rule: PayRule["weekendRule"];
  deduction_percent: number | null;
  deduction_fixed_cents: number | null;
  regular_schedule: { weekday: number; start: string; end: string; break_minutes?: number }[];
  notes: string | null;
  current_rate_cents: number | null;
}

export interface ServiceResult<T = unknown> {
  summary: string;
  data?: T;
  undo?: UndoOp[];
}

export function payRuleOf(j: Pick<JobRow, "pay_frequency" | "period_anchor_date" | "semimonthly_split_day" | "payday_offset_days" | "payday_weekend_rule">): PayRule | null {
  if (!j.pay_frequency) return null;
  return {
    frequency: j.pay_frequency,
    anchorDate: j.period_anchor_date,
    splitDay: j.semimonthly_split_day,
    paydayOffsetDays: j.payday_offset_days,
    weekendRule: j.payday_weekend_rule,
  };
}

export function jobLabel(j: Pick<JobRow, "employer" | "title">) {
  return j.title ? `${j.employer} (${j.title})` : j.employer;
}

export async function listJobs(ctx: Ctx, q: Q = sql, opts: { includeEnded?: boolean } = {}): Promise<JobRow[]> {
  return q<JobRow[]>`
    select j.*, w.rate_cents as current_rate_cents
    from jobs j
    left join lateral (
      select rate_cents from job_wages
      where job_id = j.id and effective_from <= ${ctx.today}
      order by effective_from desc limit 1
    ) w on true
    where j.user_id = ${ctx.userId} ${opts.includeEnded ? q`` : q`and j.status <> 'ended'`}
    order by j.created_at`;
}

export async function getJob(ctx: Ctx, id: string, q: Q = sql): Promise<JobRow> {
  const [j] = await q<JobRow[]>`
    select j.*, (select rate_cents from job_wages w where w.job_id = j.id and effective_from <= ${ctx.today}
                 order by effective_from desc limit 1) as current_rate_cents
    from jobs j where j.id = ${id} and j.user_id = ${ctx.userId}`;
  if (!j) throw new NotFound("Job");
  return j;
}

export async function wagesFor(ctx: Ctx, jobId: string, q: Q = sql) {
  return q<{ rate_cents: number; effective_from: string }[]>`
    select rate_cents, effective_from from job_wages where job_id = ${jobId} and user_id = ${ctx.userId} order by effective_from`;
}

function checkRule(input: Partial<JobCreate>, existing?: JobRow) {
  const freq = input.pay_frequency ?? existing?.pay_frequency ?? null;
  if (!freq) return;
  const err = validateRule({
    frequency: freq,
    anchorDate: input.period_anchor_date ?? existing?.period_anchor_date ?? null,
    paydayOffsetDays: input.payday_offset_days ?? existing?.payday_offset_days ?? 0,
    weekendRule: input.payday_weekend_rule ?? existing?.payday_weekend_rule ?? "none",
  });
  if (err) throw new AppError(err);
}

export async function createJob(ctx: Ctx, input: JobCreate, actor: Actor): Promise<ServiceResult<JobRow>> {
  checkRule(input);
  return sql.begin(async (tx) => {
    const [job] = await tx<{ id: string }[]>`
      insert into jobs (user_id, employer, title, currency, status, start_date, expected_weekly_minutes, pay_frequency,
        period_anchor_date, semimonthly_split_day, payday_offset_days, payday_weekend_rule, deduction_percent,
        deduction_fixed_cents, regular_schedule, notes)
      values (${ctx.userId}, ${input.employer}, ${input.title ?? null}, ${ctx.currency}, ${input.status ?? "active"},
        ${input.start_date ?? null}, ${input.expected_weekly_hours != null ? Math.round(input.expected_weekly_hours * 60) : null},
        ${input.pay_frequency ?? null}, ${input.period_anchor_date ?? null}, ${input.semimonthly_split_day ?? 15},
        ${input.payday_offset_days ?? 0}, ${input.payday_weekend_rule ?? "none"}, ${input.deduction_percent ?? null},
        ${input.deduction_fixed != null ? toCents(input.deduction_fixed) : null}, ${tx.json((input.regular_schedule ?? []) as never)},
        ${input.notes ?? null})
      returning id`;
    // The first wage applies from the start date (or far back) so earlier shifts resolve a rate.
    const from = input.wage_effective_from ?? input.start_date ?? "2000-01-01";
    await tx`insert into job_wages (user_id, job_id, rate_cents, effective_from)
             values (${ctx.userId}, ${job.id}, ${toCents(input.hourly_rate)}, ${from})`;
    const full = await getJob(ctx, job.id, tx);
    await logActivity(tx, ctx.userId, { entity: "job", entityId: job.id, action: "create", actor, summary: `Added job ${jobLabel(full)}`, after: full });
    return {
      summary: `Added ${jobLabel(full)} at ${(toCents(input.hourly_rate) / 100).toFixed(2)}/h`,
      data: full,
      undo: [{ op: "delete", table: "jobs", id: job.id }],
    };
  });
}

const JOB_COLS = [
  "employer",
  "title",
  "status",
  "start_date",
  "expected_weekly_minutes",
  "pay_frequency",
  "period_anchor_date",
  "semimonthly_split_day",
  "payday_offset_days",
  "payday_weekend_rule",
  "deduction_percent",
  "deduction_fixed_cents",
  "regular_schedule",
  "notes",
] as const;

/** Changes job details. A new hourly rate is added to wage history — past shifts keep their rate. */
export async function updateJob(ctx: Ctx, input: JobUpdate, actor: Actor): Promise<ServiceResult<JobRow>> {
  return sql.begin(async (tx) => {
    const before = await getJob(ctx, input.job_id, tx);
    checkRule(input, before);
    const patch: Record<string, unknown> = {};
    if (input.employer !== undefined) patch.employer = input.employer;
    if (input.title !== undefined) patch.title = input.title;
    if (input.status !== undefined) patch.status = input.status;
    if (input.start_date !== undefined) patch.start_date = input.start_date;
    if (input.expected_weekly_hours !== undefined) patch.expected_weekly_minutes = Math.round(input.expected_weekly_hours * 60);
    if (input.pay_frequency !== undefined) patch.pay_frequency = input.pay_frequency;
    if (input.period_anchor_date !== undefined) patch.period_anchor_date = input.period_anchor_date;
    if (input.semimonthly_split_day !== undefined) patch.semimonthly_split_day = input.semimonthly_split_day;
    if (input.payday_offset_days !== undefined) patch.payday_offset_days = input.payday_offset_days;
    if (input.payday_weekend_rule !== undefined) patch.payday_weekend_rule = input.payday_weekend_rule;
    if (input.deduction_percent !== undefined) patch.deduction_percent = input.deduction_percent;
    if (input.deduction_fixed !== undefined) patch.deduction_fixed_cents = toCents(input.deduction_fixed);
    if (input.regular_schedule !== undefined) patch.regular_schedule = tx.json(input.regular_schedule as never);
    if (input.notes !== undefined) patch.notes = input.notes;

    const undo: UndoOp[] = [];
    const changes: string[] = [];
    if (Object.keys(patch).length) {
      const prev = snapshot(before as unknown as Record<string, unknown>, JOB_COLS as unknown as string[]);
      await tx`update jobs set ${tx(patch as Record<string, never>)}, updated_at = now() where id = ${before.id} and user_id = ${ctx.userId}`;
      undo.push({ op: "restore", table: "jobs", id: before.id, values: prev });
      changes.push(...Object.keys(patch).map((k) => k.replace(/_/g, " ")));
    }
    if (input.hourly_rate !== undefined) {
      const from = input.wage_effective_from ?? ctx.today;
      const [w] = await tx<{ id: string }[]>`
        insert into job_wages (user_id, job_id, rate_cents, effective_from)
        values (${ctx.userId}, ${before.id}, ${toCents(input.hourly_rate)}, ${from})
        on conflict (job_id, effective_from) do update set rate_cents = excluded.rate_cents
        returning id`;
      undo.push({ op: "delete", table: "job_wages", id: w.id });
      changes.push(`wage ${(toCents(input.hourly_rate) / 100).toFixed(2)}/h from ${from}`);
    }
    if (changes.length === 0) throw new AppError("Nothing to change.");
    const after = await getJob(ctx, before.id, tx);
    await logActivity(tx, ctx.userId, { entity: "job", entityId: before.id, action: "update", actor, summary: `Updated ${jobLabel(after)}: ${changes.join(", ")}`, before, after });
    return { summary: `Updated ${jobLabel(after)} (${changes.join(", ")})`, data: after, undo };
  });
}

/** Find a job from a loose description ("my security job"). */
export function matchJob(jobs: JobRow[], hint: string): JobRow[] {
  const h = hint.toLowerCase();
  return jobs.filter((j) => `${j.employer} ${j.title ?? ""}`.toLowerCase().includes(h));
}

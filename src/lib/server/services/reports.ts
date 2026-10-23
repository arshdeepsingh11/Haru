import "server-only";
import { sql } from "../db";
import type { Ctx } from "../context";
import { buildReport, type Report } from "../../domain/report";
import { previousRange, resolveRange, type RangePreset } from "../../domain/ranges";
import { occurrencesUntil } from "../../domain/recurrence";
import { periodsPaidBetween } from "../../domain/payroll";
import { listJobs, payRuleOf, jobLabel } from "./jobs";
import { listBills } from "./finance";

export async function generateReport(ctx: Ctx, preset: RangePreset, custom?: { start?: string; end?: string }): Promise<Report> {
  const range = resolveRange(preset, ctx.today, ctx.prefs.week_starts_on, custom);
  // The "actual" part only covers days that have happened.
  const actualEnd = range.end < ctx.today ? range.end : ctx.today;

  const [shifts, opps, txs, contributions, bills, payments, jobs] = await Promise.all([
    sql<{ job_id: string; job_name: string; status: string; paid_minutes: number; gross_cents: number; work_date: string }[]>`
      select s.job_id, j.employer as job_name, s.status, s.paid_minutes, s.gross_cents, s.work_date
      from shifts s join jobs j on j.id = s.job_id
      where s.user_id = ${ctx.userId} and s.work_date between ${range.start} and ${range.end} and s.status <> 'cancelled'`,
    sql<{ name: string; status: string; earned_cents: number | null; offered_cents: number; work_date: string | null }[]>`
      select name, status, earned_cents, offered_cents, work_date from work_opportunities
      where user_id = ${ctx.userId} and (
        (status = 'completed' and coalesce(work_date, completed_at::date) between ${range.start} and ${range.end})
        or (status in ('accepted','scheduled') and (work_date is null or work_date between ${range.start} and ${range.end})))`,
    sql<{ type: string; amount_cents: number; category: string | null; occurred_on: string; description: string | null }[]>`
      select type, amount_cents, category, occurred_on, description from transactions
      where user_id = ${ctx.userId} and voided_at is null and occurred_on between ${range.start} and ${actualEnd}`,
    sql<{ goal_name: string; amount_cents: number }[]>`
      select g.name as goal_name, c.amount_cents from goal_contributions c join savings_goals g on g.id = c.goal_id
      where c.user_id = ${ctx.userId} and c.voided_at is null and c.contributed_on between ${range.start} and ${actualEnd}`,
    listBills(ctx),
    sql<{ name: string; amount_cents: number; due_date: string }[]>`
      select b.name, p.amount_cents, p.due_date from bill_payments p join bills b on b.id = p.bill_id
      where p.user_id = ${ctx.userId} and p.due_date between ${range.start} and ${range.end}`,
    listJobs(ctx),
  ]);

  const billsDue = [
    ...payments.map((p) => ({ name: p.name, amount_cents: p.amount_cents, due_date: p.due_date, paid: true })),
    ...bills.flatMap((b) =>
      occurrencesUntil(b.next_due_date, b.recurrence, range.end, b.due_anchor_day)
        .filter((d) => d >= range.start || d < ctx.today) // include overdue
        .map((d) => ({ name: b.name, amount_cents: b.amount_cents, due_date: d, paid: false })),
    ),
  ];

  // Projected paychecks: paydays still ahead within the range (from saved payroll rules).
  const received = await sql<{ job_id: string; period_start: string }[]>`
    select job_id, period_start from paychecks where user_id = ${ctx.userId} and status = 'received'`;
  const expectedPaychecks: { job_name: string; pay_date: string; expected_gross_cents: number }[] = [];
  for (const job of jobs) {
    const rule = payRuleOf(job);
    if (!rule) continue;
    for (const p of periodsPaidBetween(rule, ctx.today > range.start ? ctx.today : range.start, range.end)) {
      if (received.some((r) => r.job_id === job.id && r.period_start === p.start)) continue;
      const [g] = await sql<{ cents: number }[]>`
        select coalesce(sum(gross_cents), 0) as cents from shifts
        where user_id = ${ctx.userId} and job_id = ${job.id} and status in ('completed','scheduled') and work_date between ${p.start} and ${p.end}`;
      expectedPaychecks.push({ job_name: jobLabel(job), pay_date: p.payDate, expected_gross_cents: g.cents });
    }
  }

  return buildReport({
    range,
    shifts,
    opportunities: opps,
    transactions: txs,
    goalContributions: contributions,
    billsDue,
    expectedPaychecks,
    projectedOpportunities: opps.filter((o) => o.status === "accepted" || o.status === "scheduled"),
  });
}

export async function compareReports(ctx: Ctx, preset: RangePreset) {
  const current = await generateReport(ctx, preset);
  const prev = previousRange(current.range, preset);
  const previous = await generateReport(ctx, "custom", { start: prev.start, end: prev.end });
  previous.range.label = prev.label;
  return { current, previous };
}

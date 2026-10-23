import "server-only";
import { sql } from "../db";
import type { Ctx } from "../context";
import { localTime, addDays, startOfMonth } from "../../domain/time";
import { monthlyEquivalent } from "../../domain/recurrence";
import { buildPayoffPlan, daysCloser, type PayoffPlan } from "../../domain/payoff";
import { listJobs, jobLabel } from "./jobs";
import { listBills } from "./finance";
import { paycheckContext, takeHome } from "./shiftloop";

// Everything that turns HARU's records into motivation: what the next shift earns,
// which paycheck it lands in, how it moves your payoff date, and how you've been doing.

export interface ShiftCard {
  id: string;
  jobId: string;
  jobName: string;
  date: string;
  start: string | null;
  end: string | null;
  minutes: number;
  grossCents: number;
  takeHomeCents: number;
  attendance: string;
  payDate: string | null;
  paycheckProjectedCents: number;
  daysCloser: number | null;
}

export interface Stats {
  workedShifts: number;
  missedShifts: number;
  missedTakeHomeCents: number;
  attendanceRate: number | null; // 0..1 over the last 30 days
  streak: number; // consecutive worked shifts, most recent first
  monthTakeHomeCents: number;
}

export interface CoachData {
  plan: PayoffPlan;
  nextShift: ShiftCard | null;
  week: ShiftCard[];
  checkouts: ShiftCard[]; // shifts that ended and still need "did you finish?"
  stats: Stats;
  taxPercent: number;
}

/** Expected take-home per month from the weekly schedule (or recent work if no schedule yet). */
export async function projectedMonthlyTakeHome(ctx: Ctx): Promise<number> {
  const jobs = (await listJobs(ctx)).filter((j) => j.status === "active");
  let weeklyGross = 0;
  for (const j of jobs) {
    const rate = j.current_rate_cents ?? 0;
    for (const e of j.regular_schedule ?? []) {
      const [sh, sm] = e.start.split(":").map(Number);
      const [eh, em] = e.end.split(":").map(Number);
      let mins = eh * 60 + em - (sh * 60 + sm);
      if (mins <= 0) mins += 1440;
      weeklyGross += Math.round(((mins - (e.break_minutes ?? 0)) * rate) / 60);
    }
  }
  if (weeklyGross === 0) {
    const [r] = await sql<{ past: number; ahead: number }[]>`
      select coalesce(sum(gross_cents) filter (where status = 'completed' and work_date between ${addDays(ctx.today, -28)} and ${ctx.today}), 0) as past,
             coalesce(sum(gross_cents) filter (where status = 'scheduled' and work_date between ${ctx.today} and ${addDays(ctx.today, 13)}), 0) as ahead
      from shifts where user_id = ${ctx.userId}`;
    weeklyGross = r.past > 0 ? Math.round(r.past / 4) : Math.round(r.ahead / 2);
  }
  return takeHome(ctx, Math.round((weeklyGross * 52) / 12));
}

/** The inputs of the payoff plan, so the client can re-run it for "what if" questions (send-home planner). */
export async function payoffInputs(ctx: Ctx): Promise<Parameters<typeof buildPayoffPlan>[0]> {
  const [income, bills, debts, goals] = await Promise.all([
    projectedMonthlyTakeHome(ctx),
    listBills(ctx),
    sql<{ id: string; name: string; balance_cents: number; interest_rate_percent: number | null; minimum_payment_cents: number | null }[]>`
      select b.debt_id as id, b.name, b.balance_cents, d.interest_rate_percent, d.minimum_payment_cents
      from debt_balances b join debts d on d.id = b.debt_id where b.user_id = ${ctx.userId} and b.status = 'active'`,
    sql<{ id: string; name: string; target_cents: number; saved_cents: number; target_date: string | null }[]>`
      select goal_id as id, name, target_cents, saved_cents, target_date from goal_progress where user_id = ${ctx.userId} and status = 'active'`,
  ]);
  return {
    today: ctx.today,
    monthlyTakeHomeCents: income,
    monthlyBillsCents: bills.reduce((a, b) => a + monthlyEquivalent(b.amount_cents, b.recurrence), 0),
    debts: debts.map((d) => ({ id: d.id, name: d.name, balanceCents: d.balance_cents, aprPercent: d.interest_rate_percent, minimumCents: d.minimum_payment_cents })),
    goals: goals.map((g) => ({ id: g.id, name: g.name, targetCents: g.target_cents, savedCents: g.saved_cents, targetDate: g.target_date })),
  };
}

export async function getPayoffPlan(ctx: Ctx): Promise<PayoffPlan> {
  return buildPayoffPlan(await payoffInputs(ctx));
}

export async function attendanceStats(ctx: Ctx): Promise<Stats> {
  const rows = await sql<{ status: string; gross_cents: number; work_date: string }[]>`
    select status, gross_cents, work_date from shifts
    where user_id = ${ctx.userId} and status in ('completed', 'missed') and work_date >= ${addDays(ctx.today, -30)}
    order by work_date desc, starts_at desc nulls last`;
  const worked = rows.filter((r) => r.status === "completed");
  const missed = rows.filter((r) => r.status === "missed");
  let streak = 0;
  for (const r of rows) {
    if (r.status !== "completed") break;
    streak++;
  }
  const [m] = await sql<{ g: number }[]>`
    select coalesce(sum(gross_cents), 0) as g from shifts
    where user_id = ${ctx.userId} and status = 'completed' and work_date between ${startOfMonth(ctx.today)} and ${ctx.today}`;
  return {
    workedShifts: worked.length,
    missedShifts: missed.length,
    missedTakeHomeCents: takeHome(ctx, missed.reduce((a, r) => a + r.gross_cents, 0)),
    attendanceRate: rows.length ? worked.length / rows.length : null,
    streak,
    monthTakeHomeCents: takeHome(ctx, m.g),
  };
}

export async function getCoach(ctx: Ctx): Promise<CoachData> {
  const [plan, stats, jobs, rows] = await Promise.all([
    getPayoffPlan(ctx),
    attendanceStats(ctx),
    listJobs(ctx),
    sql<{ id: string; job_id: string; work_date: string; starts_at: Date | null; ends_at: Date | null; paid_minutes: number; gross_cents: number; attendance: string }[]>`
      select id, job_id, work_date, starts_at, ends_at, paid_minutes, gross_cents, attendance from shifts
      where user_id = ${ctx.userId} and status = 'scheduled' and work_date between ${addDays(ctx.today, -3)} and ${addDays(ctx.today, 7)}
      order by work_date, starts_at nulls last`,
  ]);
  const name = new Map(jobs.map((j) => [j.id, jobLabel(j)]));
  const cards: ShiftCard[] = [];
  const pcCache = new Map<string, Awaited<ReturnType<typeof paycheckContext>>>();
  for (const r of rows) {
    const key = `${r.job_id}:${r.work_date}`;
    if (!pcCache.has(key)) pcCache.set(key, await paycheckContext(ctx, r.job_id, r.work_date));
    const pc = pcCache.get(key)!;
    const net = takeHome(ctx, r.gross_cents);
    cards.push({
      id: r.id,
      jobId: r.job_id,
      jobName: name.get(r.job_id) ?? "Work",
      date: r.work_date,
      start: r.starts_at ? localTime(r.starts_at, ctx.tz) : null,
      end: r.ends_at ? localTime(r.ends_at, ctx.tz) : null,
      minutes: r.paid_minutes,
      grossCents: r.gross_cents,
      takeHomeCents: net,
      attendance: r.attendance,
      payDate: pc.payDate,
      paycheckProjectedCents: pc.projectedTakeHomeCents,
      daysCloser: daysCloser(plan, net),
    });
  }
  const now = ctx.now.getTime();
  const ended = (c: ShiftCard, r: (typeof rows)[number]) => (r.ends_at ? r.ends_at.getTime() < now : c.date < ctx.today);
  const checkouts = cards.filter((c, idx) => ended(c, rows[idx]) && c.attendance !== "not_going");
  const upcoming = cards.filter((c, idx) => !ended(c, rows[idx]));
  return { plan, stats, nextShift: upcoming.find((c) => c.attendance !== "not_going") ?? null, week: upcoming, checkouts, taxPercent: ctx.prefs.reserve_percent };
}

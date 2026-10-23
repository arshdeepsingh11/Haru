import "server-only";
import { sql } from "../db";
import type { Ctx } from "../context";
import { computePosition, type FinancialPosition } from "../../domain/position";
import { occurrencesUntil } from "../../domain/recurrence";
import { addDays, diffDays, friendlyDate, localTime, splitDate, startOfMonth, startOfWeek, endOfMonth } from "../../domain/time";
import { evaluateOpportunity } from "../../domain/opportunity";
import { formatMoney } from "../../domain/money";
import { arrange, isComponentKey, type ComponentKey, type LayoutEntry } from "../../dashboard-registry";
import { listJobs, jobLabel, payRuleOf } from "./jobs";
import { listAccounts, listBills } from "./finance";
import { awaitingPaychecks, forecastAll } from "./payroll";
import { listOpportunities } from "./opportunities";
import { upcomingReminders } from "./reminders";
import { listObservations } from "./observations";
import { periodContaining, payDateFor } from "../../domain/payroll";

export interface AttentionItem {
  id: string;
  tone: "urgent" | "warn" | "info";
  title: string;
  detail: string;
  ask?: string; // a prompt the user can send to HARU with one tap
}

export interface DashboardData {
  today: string;
  tz: string;
  currency: string;
  displayName: string | null;
  reservePercent: number;
  position: FinancialPosition & { balanceConfirmed: boolean; hasAccounts: boolean; horizon: string; horizonIsPayday: boolean };
  accounts: { id: string; name: string; kind: string; balanceCents: number; confirmed: boolean }[];
  earnings: {
    weekCents: number;
    weekMinutes: number;
    monthCents: number;
    monthMinutes: number;
    byJobMonth: { name: string; cents: number }[];
    weekly: { weekStart: string; byJob: Record<string, number>; total: number }[];
    jobNames: string[];
  };
  spending: { weekly: { weekStart: string; cents: number }[]; monthCents: number; topCategories: { category: string; cents: number }[] };
  paydays: { jobId: string; jobName: string; configured: boolean; payDate?: string; periodStart?: string; periodEnd?: string; daysUntil?: number; loggedGrossCents?: number; scheduledGrossCents?: number; expectedGrossCents?: number; expectedNetCents?: number | null; reserveCents?: number; uncertainty?: string[] }[];
  upcomingShifts: { id: string; jobName: string; date: string; start: string | null; end: string | null; minutes: number; grossCents: number }[];
  opportunities: { id: string; name: string; status: string; date: string | null; offeredCents: number; minutes: number | null; hourlyCents: number | null; reserveCents: number; payBasis: string; paid: boolean }[];
  bills: { id: string; name: string; amountCents: number; dueDate: string; daysUntil: number; recurrence: string }[];
  goals: { id: string; name: string; savedCents: number; targetCents: number; targetDate: string | null; monthlyTargetCents: number | null; thisMonthCents: number }[];
  debts: { id: string; name: string; balanceCents: number; startingCents: number; paidCents: number }[];
  reminders: { id: string; title: string; fireAt: string; category: string }[];
  unreadNotifications: number;
  insights: { id: string; statement: string; basis: string; confidence: string }[];
  activity: { id: number; summary: string; actor: string; at: string }[];
  attention: AttentionItem[];
  jobs: { id: string; name: string; rateCents: number | null; hasPayRule: boolean }[];
  order: ComponentKey[];
  layout: LayoutEntry[];
  isEmpty: boolean;
}

export async function getDashboard(ctx: Ctx): Promise<DashboardData> {
  const weekStart = startOfWeek(ctx.today, ctx.prefs.week_starts_on);
  const monthStart = startOfMonth(ctx.today);
  const chartStart = addDays(weekStart, -7 * 7);

  const [jobs, accounts, bills, forecasts, awaiting, opps, reminders, observations] = await Promise.all([
    listJobs(ctx),
    listAccounts(ctx),
    listBills(ctx),
    forecastAll(ctx),
    awaitingPaychecks(ctx),
    listOpportunities(ctx, sql, { active: true }),
    upcomingReminders(ctx),
    listObservations(ctx),
  ]);

  const [earnRows, oppEarn, spendRows, catRows, upcoming, unpaidShifts, missedShifts, goals, debts, activity, layoutRow, unread] = await Promise.all([
    sql<{ job_id: string; job_name: string; week: string; cents: number; minutes: number; in_month: boolean; in_week: boolean }[]>`
      select s.job_id, j.employer as job_name,
             (s.work_date - ((extract(dow from s.work_date)::int - ${ctx.prefs.week_starts_on} + 7) % 7))::text as week,
             sum(s.gross_cents) as cents, sum(s.paid_minutes) as minutes,
             bool_or(s.work_date >= ${monthStart}) as in_month, bool_or(s.work_date >= ${weekStart}) as in_week
      from shifts s join jobs j on j.id = s.job_id
      where s.user_id = ${ctx.userId} and s.status = 'completed' and s.work_date between ${chartStart < monthStart ? chartStart : monthStart} and ${ctx.today}
      group by 1, 2, 3`,
    sql<{ name: string; work_date: string; earned_cents: number; minutes: number | null }[]>`
      select name, coalesce(work_date, completed_at::date)::text as work_date, earned_cents, coalesce(actual_minutes, expected_minutes) as minutes
      from work_opportunities where user_id = ${ctx.userId} and status = 'completed'
        and coalesce(work_date, completed_at::date) between ${chartStart < monthStart ? chartStart : monthStart} and ${ctx.today}`,
    sql<{ week: string; cents: number }[]>`
      select (occurred_on - ((extract(dow from occurred_on)::int - ${ctx.prefs.week_starts_on} + 7) % 7))::text as week, sum(amount_cents) as cents
      from transactions where user_id = ${ctx.userId} and type = 'expense' and voided_at is null and occurred_on between ${chartStart} and ${ctx.today}
      group by 1`,
    sql<{ category: string; cents: number }[]>`
      select coalesce(category, 'uncategorised') as category, sum(amount_cents) as cents from transactions
      where user_id = ${ctx.userId} and type = 'expense' and voided_at is null and occurred_on between ${monthStart} and ${endOfMonth(ctx.today)}
      group by 1 order by 2 desc limit 5`,
    sql<{ id: string; job_name: string; work_date: string; starts_at: Date | null; ends_at: Date | null; paid_minutes: number; gross_cents: number }[]>`
      select s.id, j.employer as job_name, s.work_date, s.starts_at, s.ends_at, s.paid_minutes, s.gross_cents
      from shifts s join jobs j on j.id = s.job_id
      where s.user_id = ${ctx.userId} and s.status = 'scheduled' and s.work_date between ${ctx.today} and ${addDays(ctx.today, 7)}
        and (s.ends_at is null or s.ends_at > now())
      order by s.work_date, s.starts_at nulls last limit 8`,
    sql<{ job_id: string; work_date: string; gross_cents: number }[]>`
      select job_id, work_date, gross_cents from shifts
      where user_id = ${ctx.userId} and status = 'completed' and paycheck_id is null and work_date >= ${addDays(ctx.today, -120)}`,
    sql<{ id: string; job_name: string; work_date: string; starts_at: Date | null }[]>`
      select s.id, j.employer as job_name, s.work_date, s.starts_at from shifts s join jobs j on j.id = s.job_id
      where s.user_id = ${ctx.userId} and s.status = 'scheduled' and s.work_date >= ${addDays(ctx.today, -14)}
        and coalesce(s.ends_at, (s.work_date + 1)::timestamptz) < now()
      order by s.work_date desc limit 5`,
    sql<{ id: string; name: string; saved_cents: number; target_cents: number; target_date: string | null; monthly_target_cents: number | null; this_month: number }[]>`
      select g.goal_id as id, g.name, g.saved_cents, g.target_cents, g.target_date, g.monthly_target_cents,
             coalesce((select sum(amount_cents) from goal_contributions c where c.goal_id = g.goal_id and c.voided_at is null and c.contributed_on >= ${monthStart} and c.note is distinct from 'Already saved'), 0) as this_month
      from goal_progress g where g.user_id = ${ctx.userId} and g.status = 'active'`,
    sql<{ id: string; name: string; balance_cents: number; starting_balance_cents: number; paid_cents: number }[]>`
      select debt_id as id, name, balance_cents, starting_balance_cents, paid_cents from debt_balances
      where user_id = ${ctx.userId} and status = 'active'`,
    sql<{ id: number; summary: string; actor: string; created_at: Date }[]>`
      select id, summary, actor, created_at from activity_log where user_id = ${ctx.userId} and summary is not null order by created_at desc limit 8`,
    sql<{ layout: LayoutEntry[] }[]>`select layout from dashboard_preferences where user_id = ${ctx.userId}`,
    sql<{ n: number }[]>`select count(*)::int as n from reminders where user_id = ${ctx.userId} and status = 'sent' and read_at is null`,
  ]);

  // ---------------------------------------------------------------- earnings
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(chartStart, i * 7));
  const jobNames = [...new Set(earnRows.map((r) => r.job_name))];
  const weekly = weeks.map((w) => ({ weekStart: w, byJob: {} as Record<string, number>, total: 0 }));
  let weekCents = 0, weekMinutes = 0, monthCents = 0, monthMinutes = 0;
  const byJobMonth = new Map<string, number>();
  for (const r of earnRows) {
    const bucket = weekly.find((w) => w.weekStart === r.week);
    if (bucket) {
      bucket.byJob[r.job_name] = (bucket.byJob[r.job_name] ?? 0) + r.cents;
      bucket.total += r.cents;
    }
  }
  // exact week/month totals (a week bucket can straddle the month start)
  const exact = await sql<{ wk: number; wm: number; mk: number; mm: number }[]>`
    select coalesce(sum(gross_cents) filter (where work_date >= ${weekStart}), 0) as wk,
           coalesce(sum(paid_minutes) filter (where work_date >= ${weekStart}), 0) as wm,
           coalesce(sum(gross_cents) filter (where work_date >= ${monthStart}), 0) as mk,
           coalesce(sum(paid_minutes) filter (where work_date >= ${monthStart}), 0) as mm
    from shifts where user_id = ${ctx.userId} and status = 'completed' and work_date between ${monthStart < weekStart ? monthStart : weekStart} and ${ctx.today}`;
  weekCents = exact[0].wk; weekMinutes = exact[0].wm; monthCents = exact[0].mk; monthMinutes = exact[0].mm;
  const monthJobs = await sql<{ name: string; cents: number }[]>`
    select j.employer as name, sum(s.gross_cents) as cents from shifts s join jobs j on j.id = s.job_id
    where s.user_id = ${ctx.userId} and s.status = 'completed' and s.work_date between ${monthStart} and ${ctx.today} group by 1 order by 2 desc`;
  for (const r of monthJobs) byJobMonth.set(r.name, r.cents);
  for (const o of oppEarn) {
    const w = weekly.find((b) => b.weekStart === startOfWeek(o.work_date, ctx.prefs.week_starts_on));
    if (w) {
      w.byJob["One-time work"] = (w.byJob["One-time work"] ?? 0) + o.earned_cents;
      w.total += o.earned_cents;
      if (!jobNames.includes("One-time work")) jobNames.push("One-time work");
    }
    if (o.work_date >= weekStart) { weekCents += o.earned_cents; weekMinutes += o.minutes ?? 0; }
    if (o.work_date >= monthStart) {
      monthCents += o.earned_cents; monthMinutes += o.minutes ?? 0;
      byJobMonth.set("One-time work", (byJobMonth.get("One-time work") ?? 0) + o.earned_cents);
    }
  }

  // ---------------------------------------------------------------- position
  const horizonPayday = forecasts.filter((f) => f.period).map((f) => f.period!.payDate).sort()[0];
  const horizon = horizonPayday ?? addDays(ctx.today, 14);
  let reserved = 0;
  const billItems: DashboardData["bills"] = [];
  for (const b of bills) {
    const occ = occurrencesUntil(b.next_due_date, b.recurrence, horizon, b.due_anchor_day);
    reserved += occ.length * b.amount_cents;
    if (b.next_due_date <= addDays(ctx.today, 30))
      billItems.push({ id: b.id, name: b.name, amountCents: b.amount_cents, dueDate: b.next_due_date, daysUntil: diffDays(ctx.today, b.next_due_date), recurrence: b.recurrence });
  }
  const goalsAllocated = goals.reduce((a, g) => a + g.saved_cents, 0);
  const cash = accounts.reduce((a, x) => a + x.balance_cents, 0);

  // Earned but unpaid: completed shifts not covered by a received paycheck whose payday hasn't
  // passed, plus completed one-time work that hasn't been paid.
  let earnedUnpaid = 0;
  for (const s of unpaidShifts) {
    const job = jobs.find((j) => j.id === s.job_id);
    const rule = job ? payRuleOf(job) : null;
    if (!rule) { earnedUnpaid += s.gross_cents; continue; }
    if (payDateFor(rule, periodContaining(rule, s.work_date)) >= addDays(ctx.today, -45)) earnedUnpaid += s.gross_cents;
  }
  earnedUnpaid += opps.filter((o) => o.status === "completed" && !o.paid).reduce((a, o) => a + (o.earned_cents ?? 0), 0);

  const expectedPaychecks = forecasts.reduce((a, f) => a + (f.forecast?.expectedGrossCents ?? 0), 0);
  const projectedOpps = opps
    .filter((o) => (o.status === "accepted" || o.status === "scheduled") && (!o.work_date || o.work_date <= addDays(ctx.today, 30)))
    .reduce((a, o) => a + o.offered_cents, 0);
  const position = computePosition({
    cashCents: cash,
    unpaidBillsBeforeHorizonCents: reserved,
    allocatedToGoalsCents: goalsAllocated,
    earnedUnpaidCents: earnedUnpaid,
    expectedIncomeCents: expectedPaychecks + projectedOpps,
    debtCents: debts.reduce((a, d) => a + d.balance_cents, 0),
  });

  // ---------------------------------------------------------------- attention
  const m = (c: number) => formatMoney(c, ctx.currency);
  const fd = (d: string) => friendlyDate(d, splitDate(ctx.today).year);
  const attention: AttentionItem[] = [];
  for (const b of billItems) {
    if (b.daysUntil < 0) attention.push({ id: `bill-${b.id}`, tone: "urgent", title: `${b.name} is overdue`, detail: `${m(b.amountCents)} was due ${fd(b.dueDate)}.`, ask: `I paid my ${b.name} bill` });
    else if (b.daysUntil <= 2) attention.push({ id: `bill-${b.id}`, tone: "warn", title: `${b.name} due ${b.daysUntil === 0 ? "today" : b.daysUntil === 1 ? "tomorrow" : `in ${b.daysUntil} days`}`, detail: m(b.amountCents), ask: `I paid my ${b.name} bill` });
  }
  for (const s of missedShifts)
    attention.push({ id: `shift-${s.id}`, tone: "warn", title: `Did you work ${s.job_name} on ${fd(s.work_date)}?`, detail: "This scheduled shift hasn't been logged.", ask: `About my ${s.job_name} shift on ${s.work_date}: ` });
  // One line per job, however many paydays are unconfirmed.
  const byJob = new Map<string, typeof awaiting>();
  for (const a of awaiting) byJob.set(a.jobId, [...(byJob.get(a.jobId) ?? []), a]);
  for (const list of byJob.values()) {
    const latest = list.sort((x, y) => (x.period.payDate < y.period.payDate ? 1 : -1))[0];
    attention.push({
      id: `pay-${latest.jobId}`,
      tone: "info",
      title: list.length === 1 ? `Did your ${latest.jobName} pay arrive?` : `${list.length} ${latest.jobName} paydays aren't confirmed`,
      detail: list.length === 1 ? `Payday was ${fd(latest.period.payDate)}; logged hours came to ${m(latest.loggedGrossCents)} gross.` : `The latest was ${fd(latest.period.payDate)}. Tell HARU what arrived so your cash stays accurate.`,
      ask: `My ${latest.jobName} paycheck from ${latest.period.payDate} arrived: `,
    });
  }
  for (const o of opps)
    if (o.status === "considering" && o.work_date && diffDays(ctx.today, o.work_date) <= 2)
      attention.push({ id: `opp-${o.id}`, tone: "info", title: `Decide on ${o.name}`, detail: `It's on ${fd(o.work_date)}.`, ask: `About ${o.name}: ` });
  if (position.shortfall && accounts.length)
    attention.push({ id: "shortfall", tone: "urgent", title: "Bills exceed your cash", detail: `Bills due before ${fd(horizon)} and goal money total more than your tracked cash by ${m(-position.safeToAllocateCents)}.` });
  attention.sort((a, b) => ["urgent", "warn", "info"].indexOf(a.tone) - ["urgent", "warn", "info"].indexOf(b.tone));

  // ---------------------------------------------------------------- relevance & order
  const nextPayIn = forecasts.find((f) => f.daysUntil != null)?.daysUntil ?? null;
  const soonestBill = billItems[0]?.daysUntil ?? null;
  const scores: Partial<Record<ComponentKey, number | null>> = {
    attention: attention.length ? 100 : null,
    // The money panel appears once there's something real in it (no wall of zeros for new users).
    position: accounts.length || debts.length || goals.length || earnedUnpaid || expectedPaychecks || projectedOpps ? 90 : null,
    earnings: jobs.length || earnRows.length ? 70 : null,
    paydays: jobs.length ? (nextPayIn != null && nextPayIn <= 2 ? 88 : 65) : null,
    upcoming_work: upcoming.length || opps.some((o) => o.status === "accepted" || o.status === "scheduled") ? 75 : null,
    opportunities: opps.some((o) => o.status === "considering" || (o.status === "completed" && !o.paid)) ? 72 : null,
    bills: billItems.length ? (soonestBill != null && soonestBill <= 2 ? 86 : 60) : null,
    goals: goals.length ? 55 : null,
    debts: debts.length ? 50 : null,
    spending: spendRows.length ? 45 : null,
    reminders: reminders.length ? 40 : null,
    insights: observations.length ? 35 : null,
    activity: activity.length ? 20 : null,
  };
  const layout = (layoutRow[0]?.layout ?? []).filter((l) => isComponentKey(l.key));

  return {
    today: ctx.today,
    tz: ctx.tz,
    currency: ctx.currency,
    displayName: ctx.prefs.display_name,
    reservePercent: ctx.prefs.reserve_percent,
    position: { ...position, balanceConfirmed: accounts.length > 0 && accounts.every((a) => a.balance_confirmed), hasAccounts: accounts.length > 0, horizon, horizonIsPayday: Boolean(horizonPayday) },
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balanceCents: a.balance_cents, confirmed: a.balance_confirmed })),
    earnings: { weekCents, weekMinutes, monthCents, monthMinutes, byJobMonth: [...byJobMonth].map(([name, cents]) => ({ name, cents })), weekly, jobNames },
    spending: {
      weekly: weeks.map((w) => ({ weekStart: w, cents: spendRows.find((r) => r.week === w)?.cents ?? 0 })),
      monthCents: catRows.reduce((a, c) => a + c.cents, 0),
      topCategories: catRows,
    },
    paydays: forecasts.map((f) => ({
      jobId: f.jobId,
      jobName: f.jobName,
      configured: f.configured,
      payDate: f.period?.payDate,
      periodStart: f.period?.start,
      periodEnd: f.period?.end,
      daysUntil: f.daysUntil,
      loggedGrossCents: f.forecast?.loggedGrossCents,
      scheduledGrossCents: f.forecast?.scheduledGrossCents,
      expectedGrossCents: f.forecast?.expectedGrossCents,
      expectedNetCents: f.forecast?.expectedNetCents,
      reserveCents: f.forecast?.reserveEstimateCents,
      uncertainty: f.forecast?.uncertainty,
    })),
    upcomingShifts: upcoming.map((s) => ({ id: s.id, jobName: s.job_name, date: s.work_date, start: s.starts_at ? localTime(s.starts_at, ctx.tz) : null, end: s.ends_at ? localTime(s.ends_at, ctx.tz) : null, minutes: s.paid_minutes, grossCents: s.gross_cents })),
    opportunities: opps.map((o) => {
      const e = evaluateOpportunity(o.offered_cents, o.expected_minutes, ctx.prefs.reserve_percent);
      return { id: o.id, name: o.name, status: o.status, date: o.work_date, offeredCents: o.offered_cents, minutes: o.expected_minutes, hourlyCents: e.effectiveHourlyCents, reserveCents: e.reserveEstimateCents, payBasis: o.pay_basis, paid: o.paid };
    }),
    bills: billItems,
    goals: goals.map((g) => ({ id: g.id, name: g.name, savedCents: g.saved_cents, targetCents: g.target_cents, targetDate: g.target_date, monthlyTargetCents: g.monthly_target_cents, thisMonthCents: g.this_month })),
    debts: debts.map((d) => ({ id: d.id, name: d.name, balanceCents: d.balance_cents, startingCents: d.starting_balance_cents, paidCents: d.paid_cents })),
    reminders: reminders.map((r) => ({ id: r.id, title: r.title, fireAt: r.fire_at.toISOString(), category: r.category })),
    unreadNotifications: unread[0]?.n ?? 0,
    insights: observations.map((o) => ({ id: o.id, statement: o.statement, basis: o.basis, confidence: o.confidence })),
    activity: activity.map((a) => ({ id: a.id, summary: a.summary, actor: a.actor, at: a.created_at.toISOString() })),
    attention,
    jobs: jobs.map((j) => ({ id: j.id, name: jobLabel(j), rateCents: j.current_rate_cents, hasPayRule: Boolean(j.pay_frequency) })),
    order: arrange(scores, layout),
    layout,
    isEmpty: jobs.length === 0 && accounts.length === 0 && bills.length === 0 && goals.length === 0 && debts.length === 0 && opps.length === 0,
  };
}

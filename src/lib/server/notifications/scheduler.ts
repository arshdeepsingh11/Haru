import "server-only";
import { sql } from "../db";
import { ctxForUser } from "../user-context";
import { logError } from "../errors";
import { planAutoReminders, type ReminderCategory } from "../../domain/reminders";
import { addDays } from "../../domain/time";
import { listBills } from "../services/finance";
import { forecastAll } from "../services/payroll";
import { listOpportunities } from "../services/opportunities";
import { materializeSchedules } from "../services/shifts";
import { paycheckContext, takeHome } from "../services/shiftloop";
import { pushConfigured, sendPush } from "./push";

// Durable, idempotent scheduler. Invoked by an external clock (Supabase pg_cron,
// Vercel Cron on Pro, or any HTTP scheduler) — never by a browser tab.
//   1. plan: upsert automatic reminders for the next 36 h (unique dedupe keys)
//   2. claim: atomically move due reminders pending → sending (FOR UPDATE SKIP LOCKED)
//   3. deliver: push to every subscription, log each attempt, then sent / retry / failed

const MAX_ATTEMPTS = 4;
const STALE_AUTO_MS = 2 * 3600e3;
const STALE_CUSTOM_MS = 12 * 3600e3;

interface ClaimedReminder {
  id: string;
  user_id: string;
  category: ReminderCategory;
  title: string;
  body: string | null;
  url: string;
  fire_at: Date;
  attempts: number;
  origin: string;
  source_type: string | null;
  source_id: string | null;
  dedupe_key: string;
  payload: { shiftId?: string; actions?: { action: string; title: string }[] } | null;
}

export interface RunResult {
  planned: number;
  claimed: number;
  delivered: number;
  failed: number;
  skipped: number;
  pushConfigured: boolean;
}

async function planForUser(userId: string, now: Date): Promise<number> {
  const ctx = await ctxForUser(userId, now);
  await materializeSchedules(ctx, 3);
  const [shiftRows, bills, forecasts, opps] = await Promise.all([
    sql<{ id: string; job_id: string; job_name: string; work_date: string; starts_at: Date | null; ends_at: Date | null; status: string; attendance: string; gross_cents: number }[]>`
      select s.id, s.job_id, j.employer as job_name, s.work_date, s.starts_at, s.ends_at, s.status, s.attendance, s.gross_cents
      from shifts s join jobs j on j.id = s.job_id
      where s.user_id = ${userId} and s.status = 'scheduled' and s.work_date between ${addDays(ctx.today, -1)} and ${addDays(ctx.today, 2)}`,
    listBills(ctx),
    forecastAll(ctx),
    listOpportunities(ctx, sql, { active: true }),
  ]);
  // Each shift carries what it earns after tax and which paycheck it lands in.
  const shifts = [];
  for (const r of shiftRows) {
    const pc = await paycheckContext(ctx, r.job_id, r.work_date).catch(() => null);
    shifts.push({ ...r, take_home_cents: takeHome(ctx, r.gross_cents), pay_date: pc?.payDate ?? null });
  }
  const plan = planAutoReminders({
    now,
    tz: ctx.tz,
    currency: ctx.currency,
    prefs: {
      categories: ctx.prefs.notify_categories as Partial<Record<ReminderCategory, boolean>>,
      shiftLeadMinutes: ctx.prefs.shift_lead_minutes,
      logHoursTime: ctx.prefs.log_hours_time,
      billLeadDays: ctx.prefs.bill_lead_days,
      billNotifyTime: ctx.prefs.bill_notify_time,
      paydayNotifyTime: ctx.prefs.payday_notify_time,
    },
    shifts,
    bills: bills.map((b) => ({ id: b.id, name: b.name, amount_cents: b.amount_cents, next_due_date: b.next_due_date })),
    paydays: forecasts.filter((f) => f.period).map((f) => ({ job_id: f.jobId, job_name: f.jobName, pay_date: f.period!.payDate, expected_gross_cents: f.forecast?.expectedGrossCents ?? 0 })),
    opportunities: opps.map((o) => ({ id: o.id, name: o.name, status: o.status, work_date: o.work_date, starts_at: o.starts_at })),
  });

  let inserted = 0;
  for (const r of plan) {
    const res = await sql`
      insert into reminders (user_id, category, title, body, url, fire_at, origin, source_type, source_id, dedupe_key, payload)
      values (${userId}, ${r.category}, ${r.title}, ${r.body}, ${r.url}, ${r.fireAt}, 'auto', ${r.sourceType}, ${r.sourceId}, ${r.dedupeKey},
              ${sql.json((r.payload ?? {}) as never)})
      on conflict (user_id, dedupe_key) do nothing`;
    inserted += res.count;
  }
  // A shift moved or a bill was paid: retire pending automatic reminders that are no longer planned.
  const keys = plan.map((p) => p.dedupeKey);
  await sql`
    update reminders set status = 'cancelled', last_error = 'No longer relevant'
    where user_id = ${userId} and origin = 'auto' and status = 'pending'
      and fire_at > ${now} and fire_at <= ${new Date(now.getTime() + 36 * 3600e3)}
      ${keys.length ? sql`and dedupe_key not in ${sql(keys)}` : sql``}`;
  return inserted;
}

/** Re-check an automatic reminder right before sending (the plan may be minutes old). */
async function stillRelevant(r: ClaimedReminder): Promise<boolean> {
  if (r.origin !== "auto") return true;
  switch (r.source_type) {
    case "shift":
    case "checkout": {
      const [s] = await sql<{ status: string; attendance: string }[]>`select status, attendance from shifts where id = ${r.source_id} and user_id = ${r.user_id}`;
      return s?.status === "scheduled" && s.attendance !== "not_going";
    }
    case "log_hours": {
      const day = r.dedupe_key.split(":")[1];
      const [x] = await sql<{ n: number }[]>`select count(*)::int as n from shifts where user_id = ${r.user_id} and work_date = ${day} and status = 'scheduled'`;
      return x.n > 0;
    }
    case "bill": {
      const due = r.dedupe_key.split(":")[2];
      const [b] = await sql<{ n: number }[]>`select count(*)::int as n from bills where id = ${r.source_id} and user_id = ${r.user_id} and status = 'active' and next_due_date = ${due}`;
      return b.n > 0;
    }
    case "opportunity": {
      const [o] = await sql<{ status: string }[]>`select status from work_opportunities where id = ${r.source_id} and user_id = ${r.user_id}`;
      return Boolean(o) && ["considering", "accepted", "scheduled"].includes(o.status);
    }
    case "payday": {
      const payDate = r.dedupe_key.split(":")[2];
      const [p] = await sql<{ n: number }[]>`select count(*)::int as n from paychecks where job_id = ${r.source_id} and user_id = ${r.user_id} and pay_date = ${payDate} and status = 'received'`;
      return p.n === 0;
    }
    default:
      return true;
  }
}

export async function claimDue(limit = 100): Promise<ClaimedReminder[]> {
  return sql<ClaimedReminder[]>`
    with due as (
      select id from reminders
      where (status = 'pending' and coalesce(next_attempt_at, fire_at) <= now())
         or (status = 'sending' and locked_at < now() - interval '5 minutes')
      order by coalesce(next_attempt_at, fire_at) limit ${limit}
      for update skip locked
    )
    update reminders r set status = 'sending', locked_at = now(), attempts = r.attempts + 1
    from due where r.id = due.id
    returning r.id, r.user_id, r.category, r.title, r.body, r.url, r.fire_at, r.attempts, r.origin, r.source_type, r.source_id, r.dedupe_key, r.payload`;
}

async function finish(id: string, status: string, error: string | null, retryAt?: Date) {
  await sql`
    update reminders set status = ${status}, last_error = ${error}, locked_at = null,
      sent_at = ${status === "sent" ? new Date() : null}, next_attempt_at = ${retryAt ?? null}
    where id = ${id}`;
}

export async function deliver(r: ClaimedReminder, now: Date): Promise<"delivered" | "failed" | "skipped"> {
  // Idempotency across crashes: if a previous attempt already got through, don't send again.
  const [prior] = await sql<{ n: number }[]>`select count(*)::int as n from notification_deliveries where reminder_id = ${r.id} and status = 'accepted'`;
  if (prior.n > 0) {
    await finish(r.id, "sent", null);
    return "skipped";
  }
  const age = now.getTime() - r.fire_at.getTime();
  if (age > (r.origin === "auto" ? STALE_AUTO_MS : STALE_CUSTOM_MS)) {
    await finish(r.id, "expired", "Too late to be useful");
    return "skipped";
  }
  const [prefs] = await sql<{ notify_enabled: boolean; notify_categories: Record<string, boolean> }[]>`
    select notify_enabled, notify_categories from user_preferences where user_id = ${r.user_id}`;
  if (r.origin === "auto" && (!prefs?.notify_enabled || prefs.notify_categories?.[r.category] === false)) {
    await finish(r.id, "cancelled", "Notifications for this category are off");
    return "skipped";
  }
  if (!(await stillRelevant(r))) {
    await finish(r.id, "cancelled", "No longer relevant");
    return "skipped";
  }
  const subs = await sql<{ id: string; endpoint: string; p256dh: string; auth: string }[]>`
    select id, endpoint, p256dh, auth from push_subscriptions where user_id = ${r.user_id}`;
  if (!prefs?.notify_enabled || subs.length === 0 || !pushConfigured()) {
    // Still lands in the in-app inbox; be explicit that no push went out.
    const why = !pushConfigured() ? "Push is not configured on the server" : !prefs?.notify_enabled ? "Push notifications are off" : "No device is subscribed";
    await finish(r.id, "sent", `${why} — shown in HARU only`);
    return "skipped";
  }

  let accepted = 0;
  let retryable = 0;
  for (const s of subs) {
    const [d] = await sql<{ id: string }[]>`
      insert into notification_deliveries (user_id, reminder_id, subscription_id, kind, status)
      values (${r.user_id}, ${r.id}, ${s.id}, 'reminder', 'failed') returning id`;
    const res = await sendPush(s, {
      title: r.title,
      body: r.body ?? undefined,
      url: r.url,
      tag: r.id,
      deliveryId: d.id,
      kind: r.category,
      shiftId: r.payload?.shiftId,
      actions: r.payload?.actions,
    });
    if (res.ok) {
      accepted++;
      await sql`update notification_deliveries set status = 'accepted', http_status = ${res.status} where id = ${d.id}`;
      await sql`update push_subscriptions set last_success_at = now(), failure_count = 0 where id = ${s.id}`;
    } else {
      await sql`update notification_deliveries set status = ${res.gone ? "gone" : "failed"}, http_status = ${res.status}, error = ${res.error} where id = ${d.id}`;
      if (res.gone) await sql`delete from push_subscriptions where id = ${s.id}`;
      else await sql`update push_subscriptions set failure_count = failure_count + 1 where id = ${s.id}`;
      if (res.retryable) retryable++;
    }
  }
  if (accepted > 0) {
    await finish(r.id, "sent", null);
    return "delivered";
  }
  if (retryable > 0 && r.attempts < MAX_ATTEMPTS) {
    await finish(r.id, "pending", "Push service unavailable; will retry", new Date(now.getTime() + 2 ** r.attempts * 60_000));
    return "failed";
  }
  await finish(r.id, "failed", "Every push subscription rejected this notification");
  return "failed";
}

export async function runScheduler(now = new Date()): Promise<RunResult> {
  const [run] = await sql<{ id: number }[]>`insert into scheduler_runs default values returning id`;
  const result: RunResult = { planned: 0, claimed: 0, delivered: 0, failed: 0, skipped: 0, pushConfigured: pushConfigured() };
  let error: string | null = null;
  try {
    const users = await sql<{ user_id: string }[]>`
      select p.user_id from user_preferences p
      where p.notify_enabled and exists (select 1 from push_subscriptions s where s.user_id = p.user_id) limit 500`;
    for (const u of users) {
      try {
        result.planned += await planForUser(u.user_id, now);
      } catch (e) {
        logError("scheduler.plan", e);
      }
    }
    const due = await claimDue();
    result.claimed = due.length;
    for (const r of due) {
      try {
        const out = await deliver(r, now);
        result[out === "delivered" ? "delivered" : out === "failed" ? "failed" : "skipped"]++;
      } catch (e) {
        logError("scheduler.deliver", e);
        result.failed++;
        // Leave it in 'sending'; it is reclaimed after 5 minutes.
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    logError("scheduler", e);
  }
  await sql`update scheduler_runs set finished_at = now(), planned = ${result.planned}, claimed = ${result.claimed},
              delivered = ${result.delivered}, failed = ${result.failed}, error = ${error} where id = ${run.id}`;
  if (error) throw new Error(error);
  return result;
}

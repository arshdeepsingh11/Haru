import { formatMoney } from "./money";
import { addDays, type ISODate, localDate, localTime, todayIn, zonedToUtc } from "./time";

export type ReminderCategory = "shift" | "checkout" | "log_hours" | "payday" | "bill" | "goal" | "opportunity" | "custom";

export interface ReminderPayload {
  shiftId?: string;
  actions?: { action: string; title: string }[];
}

export interface NotifyPrefs {
  categories: Partial<Record<ReminderCategory, boolean>>;
  shiftLeadMinutes: number;
  logHoursTime: string; // HH:MM
  billLeadDays: number;
  billNotifyTime: string;
  paydayNotifyTime: string;
}

export interface PlannedReminder {
  category: ReminderCategory;
  title: string;
  body: string;
  url: string;
  fireAt: Date;
  dedupeKey: string;
  sourceType: string;
  sourceId: string | null;
  payload?: ReminderPayload;
}

export interface PlannerInput {
  now: Date;
  tz: string;
  currency: string;
  prefs: NotifyPrefs;
  windowHours?: number;
  shifts: {
    id: string;
    job_name: string;
    work_date: ISODate;
    starts_at: Date | null;
    ends_at: Date | null;
    status: string;
    attendance?: string;
    take_home_cents?: number;
    pay_date?: ISODate | null;
  }[];
  bills: { id: string; name: string; amount_cents: number; next_due_date: ISODate }[];
  paydays: { job_id: string; job_name: string; pay_date: ISODate; expected_gross_cents: number }[];
  opportunities: { id: string; name: string; status: string; work_date: ISODate | null; starts_at: Date | null }[];
}

const GRACE_MS = 10 * 60 * 1000; // a reminder that just slipped past is still worth sending

/**
 * Deterministically plan automatic reminders for the next window. Same input → same
 * dedupe keys, so running the planner every minute never creates duplicates
 * (the DB has unique(user_id, dedupe_key)). Changing a shift time changes the key.
 */
export function planAutoReminders(i: PlannerInput): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const from = i.now.getTime() - GRACE_MS;
  const to = i.now.getTime() + (i.windowHours ?? 36) * 3600e3;
  const on = (c: ReminderCategory) => i.prefs.categories[c] !== false;
  const push = (r: PlannedReminder) => {
    const t = r.fireAt.getTime();
    if (t >= from && t <= to) out.push(r);
  };
  const money = (c: number) => formatMoney(c, i.currency);

  const payLabel = (d: ISODate | null | undefined) => {
    if (!d) return "";
    const [, mm, dd] = d.split("-").map(Number);
    return ` It goes into your ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mm - 1]} ${dd} paycheck.`;
  };

  if (on("shift")) {
    for (const s of i.shifts) {
      if (s.status !== "scheduled" || !s.starts_at || s.attendance === "not_going") continue;
      const fireAt = new Date(s.starts_at.getTime() - i.prefs.shiftLeadMinutes * 60000);
      const earn = s.take_home_cents != null ? `Go and earn ${money(s.take_home_cents)} after tax.` : "";
      const lead = i.prefs.shiftLeadMinutes >= 60 && i.prefs.shiftLeadMinutes % 60 === 0 ? `${i.prefs.shiftLeadMinutes / 60} hour${i.prefs.shiftLeadMinutes === 60 ? "" : "s"}` : `${i.prefs.shiftLeadMinutes} min`;
      push({
        category: "shift",
        title: `${s.job_name} in ${lead} (${localTime(s.starts_at, i.tz)})`,
        body: `${earn}${payLabel(s.pay_date)} Are you going?`.trim(),
        url: "/",
        fireAt,
        dedupeKey: `shift:${s.id}:${fireAt.toISOString()}`,
        sourceType: "shift",
        sourceId: s.id,
        payload: { shiftId: s.id, actions: [{ action: "going", title: "I'm going" }, { action: "skip", title: "Can't go" }] },
      });
    }
  }

  if (on("checkout")) {
    // After each shift: "Did you finish?" — one tap logs the full shift.
    for (const s of i.shifts) {
      if (s.status !== "scheduled" || s.attendance === "not_going") continue;
      const fireAt = s.ends_at ? new Date(s.ends_at.getTime() + 10 * 60000) : zonedToUtc(s.work_date, i.prefs.logHoursTime, i.tz);
      push({
        category: "checkout",
        title: `Did you finish your ${s.job_name} shift?`,
        body: s.take_home_cents != null ? `Full shift = ${money(s.take_home_cents)} after tax. Tap to log it or enter your hours.` : "Tap to log your hours.",
        url: `/?checkout=${s.id}`,
        fireAt,
        dedupeKey: `checkout:${s.id}:${fireAt.toISOString()}`,
        sourceType: "checkout",
        sourceId: s.id,
        payload: { shiftId: s.id, actions: [{ action: "full", title: "Worked full shift" }, { action: "partial", title: "Fewer hours" }] },
      });
    }
  }

  if (on("log_hours") && i.prefs.categories.log_hours === true) {
    const today = todayIn(i.tz, i.now);
    for (const day of [today, addDays(today, 1)]) {
      const pending = i.shifts.filter((s) => s.status === "scheduled" && s.work_date === day && !s.ends_at);
      if (pending.length === 0) continue;
      push({
        category: "log_hours",
        title: "Log today's hours",
        body: `Confirm the hours you worked at ${[...new Set(pending.map((s) => s.job_name))].join(" and ")}.`,
        url: "/",
        fireAt: zonedToUtc(day, i.prefs.logHoursTime, i.tz),
        dedupeKey: `log_hours:${day}`,
        sourceType: "log_hours",
        sourceId: null,
      });
    }
  }

  if (on("bill")) {
    for (const b of i.bills) {
      const fireAt = zonedToUtc(addDays(b.next_due_date, -i.prefs.billLeadDays), i.prefs.billNotifyTime, i.tz);
      const when = i.prefs.billLeadDays === 0 ? "today" : i.prefs.billLeadDays === 1 ? "tomorrow" : `on ${b.next_due_date}`;
      push({
        category: "bill",
        title: `${b.name} is due ${when}`,
        body: `${money(b.amount_cents)} due ${b.next_due_date}.`,
        url: "/",
        fireAt,
        dedupeKey: `bill:${b.id}:${b.next_due_date}:${i.prefs.billLeadDays}`,
        sourceType: "bill",
        sourceId: b.id,
      });
    }
  }

  if (on("payday")) {
    for (const p of i.paydays) {
      push({
        category: "payday",
        title: `Payday: ${p.job_name}`,
        body:
          p.expected_gross_cents > 0
            ? `About ${money(p.expected_gross_cents)} gross expected. Tell HARU what arrived to keep balances right.`
            : "Tell HARU what arrived to keep balances right.",
        url: "/?ask=paycheck",
        fireAt: zonedToUtc(p.pay_date, i.prefs.paydayNotifyTime, i.tz),
        dedupeKey: `payday:${p.job_id}:${p.pay_date}`,
        sourceType: "payday",
        sourceId: p.job_id,
      });
    }
  }

  if (on("opportunity")) {
    for (const o of i.opportunities) {
      if (o.status === "considering" && o.work_date) {
        const fireAt = zonedToUtc(addDays(o.work_date, -1), "12:00", i.tz);
        push({
          category: "opportunity",
          title: `Decide on ${o.name}`,
          body: `This one-time job is on ${o.work_date}. Accept or decline it in HARU.`,
          url: "/",
          fireAt,
          dedupeKey: `opp:${o.id}:decide:${o.work_date}`,
          sourceType: "opportunity",
          sourceId: o.id,
        });
      }
      if ((o.status === "accepted" || o.status === "scheduled") && (o.starts_at || o.work_date)) {
        const fireAt = o.starts_at
          ? new Date(o.starts_at.getTime() - i.prefs.shiftLeadMinutes * 60000)
          : zonedToUtc(o.work_date!, "08:00", i.tz);
        push({
          category: "opportunity",
          title: o.starts_at ? `${o.name} at ${localTime(o.starts_at, i.tz)}` : `${o.name} is today`,
          body: "One-time job you accepted. Confirm with them if you haven't.",
          url: "/",
          fireAt,
          dedupeKey: `opp:${o.id}:work:${fireAt.toISOString()}`,
          sourceType: "opportunity",
          sourceId: o.id,
        });
      }
    }
  }

  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

/** Local date of a reminder, for display. */
export function reminderDay(r: { fireAt: Date }, tz: string) {
  return localDate(r.fireAt, tz);
}

import "server-only";
import { sql } from "./db";
import { AppError } from "./errors";
import { DEFAULT_TZ, todayIn } from "../domain/time";

// User context without any request/cookie dependency (usable by the scheduler and tests).

export interface Prefs {
  display_name: string | null;
  currency: string;
  timezone: string;
  week_starts_on: number;
  reserve_percent: number;
  onboarded_at: Date | null;
  notify_enabled: boolean;
  notify_categories: Record<string, boolean>;
  shift_lead_minutes: number;
  log_hours_time: string;
  bill_lead_days: number;
  bill_notify_time: string;
  payday_notify_time: string;
}

export interface Ctx {
  userId: string;
  email: string | null;
  prefs: Prefs;
  tz: string;
  currency: string;
  today: string;
  now: Date;
}

export async function loadPrefs(userId: string): Promise<Prefs> {
  const [p] = await sql<Prefs[]>`
    select display_name, currency, timezone, week_starts_on, reserve_percent, onboarded_at, notify_enabled,
           notify_categories, shift_lead_minutes, to_char(log_hours_time, 'HH24:MI') as log_hours_time,
           bill_lead_days, to_char(bill_notify_time, 'HH24:MI') as bill_notify_time,
           to_char(payday_notify_time, 'HH24:MI') as payday_notify_time
    from user_preferences where user_id = ${userId}`;
  if (!p) throw new AppError("Preferences missing", 500);
  return p;
}

/** Context for a user id the server already trusts (scheduler). */
export async function ctxForUser(userId: string, now = new Date()): Promise<Ctx> {
  const prefs = await loadPrefs(userId);
  const tz = prefs.timezone || DEFAULT_TZ;
  return { userId, email: null, prefs, tz, currency: prefs.currency, today: todayIn(tz, now), now };
}

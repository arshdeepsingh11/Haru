import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type Q } from "../db";
import type { Ctx } from "../context";
import { AppError } from "../errors";
import { logActivity, type Actor } from "../activity";
import { localDate, localTime, zonedToUtc } from "../../domain/time";
import type { z } from "zod";
import type { ReminderCreate } from "../../validation";
import type { ServiceResult } from "./jobs";

export interface ReminderRow {
  id: string;
  category: string;
  title: string;
  body: string | null;
  fire_at: Date;
  status: string;
  origin: string;
  sent_at: Date | null;
  read_at: Date | null;
  last_error: string | null;
}

export async function createReminder(ctx: Ctx, i: z.infer<typeof ReminderCreate>, actor: Actor): Promise<ServiceResult> {
  const fireAt = zonedToUtc(i.date, i.time, ctx.tz);
  if (fireAt.getTime() < ctx.now.getTime() - 60_000) throw new AppError(`${i.date} ${i.time} has already passed. When should I remind you?`);
  const [r] = await sql<{ id: string }[]>`
    insert into reminders (user_id, category, title, body, fire_at, origin, dedupe_key)
    values (${ctx.userId}, ${i.category ?? "custom"}, ${i.title}, ${i.body ?? null}, ${fireAt},
            ${actor === "ai" ? "ai" : "user"}, ${`manual:${randomUUID()}`}) returning id`;
  await logActivity(sql, ctx.userId, { entity: "reminder", entityId: r.id, action: "create", actor, summary: `Reminder "${i.title}" at ${i.date} ${i.time}` });
  const pushReady = ctx.prefs.notify_enabled ? "" : " Push notifications are off, so it will only appear inside HARU until you enable them in Settings.";
  return {
    summary: `I'll remind you "${i.title}" on ${localDate(fireAt, ctx.tz)} at ${localTime(fireAt, ctx.tz)}.${pushReady}`,
    data: { id: r.id },
    undo: [{ op: "delete", table: "reminders", id: r.id }],
  };
}

export async function upcomingReminders(ctx: Ctx, limit = 6, q: Q = sql) {
  return q<ReminderRow[]>`
    select id, category, title, body, fire_at, status, origin, sent_at, read_at, last_error from reminders
    where user_id = ${ctx.userId} and status = 'pending' and fire_at >= now() - interval '10 minutes'
    order by fire_at limit ${limit}`;
}

export async function recentNotifications(ctx: Ctx, limit = 20, q: Q = sql) {
  return q<ReminderRow[]>`
    select id, category, title, body, fire_at, status, origin, sent_at, read_at, last_error from reminders
    where user_id = ${ctx.userId} and status in ('sent','failed') order by coalesce(sent_at, fire_at) desc limit ${limit}`;
}

export async function markNotificationsRead(ctx: Ctx, ids?: string[]) {
  if (ids?.length) await sql`update reminders set read_at = now() where user_id = ${ctx.userId} and id in ${sql(ids)} and read_at is null`;
  else await sql`update reminders set read_at = now() where user_id = ${ctx.userId} and status in ('sent','failed') and read_at is null`;
}

export async function cancelReminder(ctx: Ctx, id: string) {
  const r = await sql`update reminders set status = 'cancelled' where id = ${id} and user_id = ${ctx.userId} and status = 'pending'`;
  if (r.count === 0) throw new AppError("That reminder is no longer pending.");
}

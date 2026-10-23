import "server-only";
import { sql } from "../db";
import type { Ctx } from "../context";
import { AppError } from "../errors";
import { logActivity, type Actor } from "../activity";
import { isValidTimeZone } from "../../domain/time";
import type { PrefsUpdate } from "../../validation";
import type { ServiceResult } from "./jobs";

export async function updatePrefs(ctx: Ctx, i: PrefsUpdate, actor: Actor): Promise<ServiceResult> {
  if (i.timezone && !isValidTimeZone(i.timezone)) throw new AppError(`"${i.timezone}" isn't a time zone I recognise (try America/Edmonton).`);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i)) if (v !== undefined) patch[k] = k === "notify_categories" ? sql.json({ ...ctx.prefs.notify_categories, ...(v as object) } as never) : v;
  if (!Object.keys(patch).length) throw new AppError("Nothing to change.");
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) before[k] = (ctx.prefs as unknown as Record<string, unknown>)[k];
  await sql`update user_preferences set ${sql(patch as Record<string, never>)}, updated_at = now() where user_id = ${ctx.userId}`;
  await logActivity(sql, ctx.userId, { entity: "preferences", action: "update", actor, summary: `Changed ${Object.keys(patch).join(", ").replace(/_/g, " ")}`, before, after: i });
  return { summary: `Updated your settings (${Object.keys(patch).join(", ").replace(/_/g, " ")}).` };
}

export async function completeOnboarding(ctx: Ctx) {
  await sql`update user_preferences set onboarded_at = coalesce(onboarded_at, now()) where user_id = ${ctx.userId}`;
}

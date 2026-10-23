import "server-only";
import { sql } from "../db";
import type { Ctx } from "../context";
import { observeDeclineThreshold, observeLoggingTime, observePostPaydaySaving, type Observation } from "../../domain/observations";

export interface ObservationRow extends Observation {
  id: string;
  status: "active" | "dismissed" | "accepted";
}

/** Recompute evidence-based observations. Dismissed ones are never resurrected. */
export async function refreshObservations(ctx: Ctx) {
  const [opps, shifts, paychecks, contributions] = await Promise.all([
    sql<{ status: string; offered_cents: number; expected_minutes: number | null }[]>`
      select status, offered_cents, expected_minutes from work_opportunities where user_id = ${ctx.userId}`,
    sql<{ status: string; source: string; work_date: string; created_at: Date }[]>`
      select status, source, work_date, created_at from shifts where user_id = ${ctx.userId} and status = 'completed'
      order by created_at desc limit 60`,
    sql<{ pay_date: string; status: string }[]>`
      select pay_date, status from paychecks where user_id = ${ctx.userId} order by pay_date desc limit 8`,
    sql<{ contributed_on: string; amount_cents: number }[]>`
      select contributed_on, amount_cents from goal_contributions where user_id = ${ctx.userId} and voided_at is null
      order by contributed_on desc limit 40`,
  ]);
  const found = [
    observeDeclineThreshold(opps, ctx.currency),
    observeLoggingTime(shifts, ctx.tz, ctx.prefs.log_hours_time),
    observePostPaydaySaving(paychecks, contributions, ctx.currency),
  ].filter((o): o is Observation => o != null);

  for (const o of found) {
    await sql`
      insert into behavior_observations (user_id, kind, statement, basis, evidence, confidence)
      values (${ctx.userId}, ${o.kind}, ${o.statement}, ${o.basis}, ${sql.json(o.evidence as never)}, ${o.confidence})
      on conflict (user_id, kind) do update set statement = excluded.statement, basis = excluded.basis,
        evidence = excluded.evidence, confidence = excluded.confidence, updated_at = now()
      where behavior_observations.status <> 'dismissed'`;
  }
}

export async function listObservations(ctx: Ctx, includeDismissed = false) {
  return sql<ObservationRow[]>`
    select id, kind, statement, basis, evidence, confidence, status from behavior_observations
    where user_id = ${ctx.userId} ${includeDismissed ? sql`` : sql`and status = 'active'`} order by updated_at desc`;
}

export async function setObservationStatus(ctx: Ctx, id: string, status: "dismissed" | "accepted" | "active") {
  await sql`update behavior_observations set status = ${status}, updated_at = now() where id = ${id} and user_id = ${ctx.userId}`;
}

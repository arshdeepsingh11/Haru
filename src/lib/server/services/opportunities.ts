import "server-only";
import { sql, type Q } from "../db";
import type { Ctx } from "../context";
import { AppError, NotFound } from "../errors";
import { logActivity, type Actor } from "../activity";
import { snapshot } from "../undo";
import { formatHours, formatMoney, toCents } from "../../domain/money";
import { canTransition, evaluateOpportunity, type OpportunityStatus } from "../../domain/opportunity";
import { hoursToMinutes, shiftFromTimes } from "../../domain/shifts";
import { zonedToUtc } from "../../domain/time";
import type { OpportunityCreate, OpportunityStatusUpdate } from "../../validation";
import type { ServiceResult } from "./jobs";

export interface OpportunityRow {
  id: string;
  name: string;
  offered_cents: number;
  pay_basis: "gross" | "net" | "unknown";
  expected_minutes: number | null;
  work_date: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: OpportunityStatus;
  actual_minutes: number | null;
  earned_cents: number | null;
  notes: string | null;
  paid: boolean;
}

export async function listOpportunities(ctx: Ctx, q: Q = sql, opts: { active?: boolean } = {}) {
  return q<OpportunityRow[]>`
    select o.*, exists (select 1 from transactions t where t.opportunity_id = o.id and t.voided_at is null) as paid
    from work_opportunities o where o.user_id = ${ctx.userId}
    ${opts.active ? q`and (o.status in ('considering','accepted','scheduled') or (o.status = 'completed' and not exists (select 1 from transactions t where t.opportunity_id = o.id and t.voided_at is null)))` : q``}
    order by coalesce(o.work_date, o.created_at::date) desc limit 50`;
}

export async function getOpportunity(ctx: Ctx, id: string, q: Q = sql) {
  const [o] = await q<OpportunityRow[]>`
    select o.*, exists (select 1 from transactions t where t.opportunity_id = o.id and t.voided_at is null) as paid
    from work_opportunities o where o.id = ${id} and o.user_id = ${ctx.userId}`;
  if (!o) throw new NotFound("Opportunity");
  return o;
}

export function describeOpportunity(o: Pick<OpportunityRow, "offered_cents" | "expected_minutes" | "pay_basis">, ctx: Ctx) {
  const e = evaluateOpportunity(o.offered_cents, o.expected_minutes, ctx.prefs.reserve_percent);
  const m = (c: number) => formatMoney(c, ctx.currency);
  return {
    ...e,
    text:
      `${m(o.offered_cents)}${o.expected_minutes ? ` for ${formatHours(o.expected_minutes)}` : ""}` +
      (e.effectiveHourlyCents != null ? ` = ${m(e.effectiveHourlyCents)}/h` : "") +
      `. Reserve estimate (${ctx.prefs.reserve_percent}%): ${m(e.reserveEstimateCents)}, planning amount ${m(e.planningAmountCents)} — a planning estimate, not guaranteed take-home pay.` +
      (o.pay_basis === "unknown" ? " Not yet known whether the offer is before or after deductions." : ` Offer is ${o.pay_basis}.`),
  };
}

/** A one-time job offer. Never creates a recurring job or a shift. */
export async function createOpportunity(ctx: Ctx, i: OpportunityCreate, actor: Actor): Promise<ServiceResult> {
  let startsAt: Date | null = null;
  let endsAt: Date | null = null;
  let minutes = i.expected_hours ? hoursToMinutes(i.expected_hours) : null;
  if (i.date && i.start && i.end) {
    const t = shiftFromTimes(i.date, i.start, i.end, 0, ctx.tz);
    startsAt = t.startsAt;
    endsAt = t.endsAt;
    minutes ??= t.paidMinutes;
  } else if (i.date && i.start) startsAt = zonedToUtc(i.date, i.start, ctx.tz);
  const status = i.status === "scheduled" && !i.date ? "accepted" : (i.status ?? "considering");
  const cents = toCents(i.offered_amount);
  const [o] = await sql<{ id: string }[]>`
    insert into work_opportunities (user_id, name, offered_cents, pay_basis, expected_minutes, work_date, starts_at, ends_at, status, decided_at, notes)
    values (${ctx.userId}, ${i.name}, ${cents}, ${i.pay_basis ?? "unknown"}, ${minutes}, ${i.date ?? null}, ${startsAt}, ${endsAt},
            ${status}, ${status === "considering" ? null : new Date()}, ${i.notes ?? null}) returning id`;
  const d = describeOpportunity({ offered_cents: cents, expected_minutes: minutes, pay_basis: i.pay_basis ?? "unknown" }, ctx);
  await logActivity(sql, ctx.userId, { entity: "opportunity", entityId: o.id, action: "create", actor, summary: `One-time work: ${i.name} ${formatMoney(cents, ctx.currency)} (${status})` });
  return {
    summary: `Tracking ${i.name} as a one-time opportunity (${status}${i.date ? `, ${i.date}` : ""}): ${d.text}`,
    data: { id: o.id, status, effectiveHourlyCents: d.effectiveHourlyCents, reserveEstimateCents: d.reserveEstimateCents, planningAmountCents: d.planningAmountCents },
    undo: [{ op: "delete", table: "work_opportunities", id: o.id }],
  };
}

export async function updateOpportunityStatus(ctx: Ctx, i: OpportunityStatusUpdate, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const o = await getOpportunity(ctx, i.opportunity_id, tx);
    if (!canTransition(o.status, i.status)) throw new AppError(`${o.name} can't go from ${o.status} to ${i.status}.`);
    if (o.status === "completed" && i.status !== "completed" && o.paid)
      throw new AppError(`${o.name} has already been paid — remove the payment first.`);
    const workDate = i.date ?? o.work_date;
    if (i.status === "scheduled" && !workDate) throw new AppError(`Which date is ${o.name}?`);
    if (i.status === "completed" && workDate && workDate > ctx.today) throw new AppError(`${o.name} is on ${workDate} — it hasn't happened yet.`);

    const before = snapshot(o as unknown as Record<string, unknown>, ["status", "actual_minutes", "earned_cents", "work_date", "decided_at", "completed_at"]);
    const actualMinutes = i.actual_hours ? hoursToMinutes(i.actual_hours) : o.actual_minutes;
    const earned = i.status === "completed" ? (i.earned_amount != null ? toCents(i.earned_amount) : o.offered_cents) : null;
    await tx`
      update work_opportunities set status = ${i.status}, work_date = ${workDate}, actual_minutes = ${actualMinutes},
        earned_cents = ${earned}, decided_at = coalesce(decided_at, ${i.status === "considering" ? null : new Date()}),
        completed_at = ${i.status === "completed" ? new Date() : null}, updated_at = now()
      where id = ${o.id} and user_id = ${ctx.userId}`;
    const m = (c: number) => formatMoney(c, ctx.currency);
    const msg: Record<OpportunityStatus, string> = {
      considering: `${o.name} is back to "considering".`,
      accepted: `Accepted ${o.name}. It counts as expected income, not earnings, until you complete it.`,
      scheduled: `${o.name} is scheduled for ${workDate}. Expected income: ${m(o.offered_cents)}.`,
      completed: `Marked ${o.name} completed: ${m(earned ?? 0)} earned${actualMinutes ? ` for ${formatHours(actualMinutes)}` : ""}. It shows as earned but unpaid until you tell me the money arrived.`,
      declined: `Declined ${o.name}. It's removed from projections.`,
    };
    await logActivity(tx, ctx.userId, { entity: "opportunity", entityId: o.id, action: i.status, actor, summary: msg[i.status], before });
    return { summary: msg[i.status], undo: [{ op: "restore", table: "work_opportunities", id: o.id, values: before }] };
  });
}

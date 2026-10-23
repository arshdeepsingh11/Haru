import "server-only";
import { sql, type Q } from "../db";
import type { Ctx } from "../context";
import { AppError, NotFound } from "../errors";
import { logActivity, type Actor } from "../activity";
import { snapshot } from "../undo";
import { formatMoney, toCents } from "../../domain/money";
import { nextOccurrence, type Recurrence } from "../../domain/recurrence";
import { splitDate } from "../../domain/time";
import type { z } from "zod";
import type {
  AccountCreate,
  BillCreate,
  BillPaid,
  BillUpdate,
  DebtCreate,
  DebtPayment,
  ExpenseCreate,
  GoalContribution,
  GoalCreate,
  RecordIncome,
  SetBalance,
  TransferCreate,
} from "../../validation";
import type { ServiceResult } from "./jobs";

export interface AccountRow {
  id: string;
  name: string;
  kind: string;
  is_manual: boolean;
  balance_confirmed: boolean;
  balance_cents: number;
}

export async function listAccounts(ctx: Ctx, q: Q = sql): Promise<AccountRow[]> {
  return q<AccountRow[]>`
    select b.account_id as id, b.name, b.kind, b.is_manual, a.balance_confirmed, b.balance_cents
    from account_balances b join accounts a on a.id = b.account_id
    where b.user_id = ${ctx.userId} and b.archived_at is null order by a.created_at`;
}

async function accountOrDefault(ctx: Ctx, q: Q, accountId?: string): Promise<{ id: string; name: string }> {
  if (accountId) {
    const [a] = await q<{ id: string; name: string }[]>`select id, name from accounts where id = ${accountId} and user_id = ${ctx.userId} and archived_at is null`;
    if (!a) throw new NotFound("Account");
    return a;
  }
  const [a] = await q<{ id: string; name: string }[]>`
    select id, name from accounts where user_id = ${ctx.userId} and archived_at is null
    order by (kind = 'checking') desc, created_at limit 1`;
  if (a) return a;
  // First money movement: create a manually tracked account starting at 0 (flagged as unconfirmed).
  const [n] = await q<{ id: string; name: string }[]>`
    insert into accounts (user_id, name, kind, opening_balance_cents, opening_date)
    values (${ctx.userId}, 'Main account', 'checking', 0, ${ctx.today}) returning id, name`;
  return n;
}

export async function createAccount(ctx: Ctx, i: z.infer<typeof AccountCreate>, actor: Actor): Promise<ServiceResult> {
  const cents = i.current_balance != null ? toCents(i.current_balance) : 0;
  const [a] = await sql<{ id: string }[]>`
    insert into accounts (user_id, name, kind, opening_balance_cents, opening_date, balance_confirmed)
    values (${ctx.userId}, ${i.name}, ${i.kind ?? "checking"}, ${cents}, ${ctx.today}, ${i.current_balance != null})
    returning id`;
  await logActivity(sql, ctx.userId, { entity: "account", entityId: a.id, action: "create", actor, summary: `Added account ${i.name}` });
  return {
    summary: `Added ${i.name}${i.current_balance != null ? ` with ${formatMoney(cents, ctx.currency)}` : ""} (manually tracked — not a live bank connection)`,
    data: { id: a.id },
    undo: [{ op: "delete", table: "accounts", id: a.id }],
  };
}

/** Set an account to a stated balance by recording an auditable adjustment. */
export async function setBalance(ctx: Ctx, i: z.infer<typeof SetBalance>, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const [a] = await tx<{ balance_cents: number; name: string; balance_confirmed: boolean }[]>`
      select b.balance_cents, b.name, a.balance_confirmed from account_balances b join accounts a on a.id = b.account_id
      where b.account_id = ${i.account_id} and b.user_id = ${ctx.userId}`;
    if (!a) throw new NotFound("Account");
    const target = toCents(i.balance);
    const diff = target - a.balance_cents;
    await tx`update accounts set balance_confirmed = true where id = ${i.account_id} and user_id = ${ctx.userId}`;
    const undo: NonNullable<ServiceResult["undo"]> = [{ op: "restore", table: "accounts", id: i.account_id, values: { balance_confirmed: a.balance_confirmed } }];
    if (diff !== 0) {
      const [t] = await tx<{ id: string }[]>`
        insert into transactions (user_id, account_id, type, amount_cents, occurred_on, category, description, source)
        values (${ctx.userId}, ${i.account_id}, 'adjustment', ${diff}, ${i.date}, 'adjustment', 'Balance set by you', ${actor === "ai" ? "ai" : "manual"})
        returning id`;
      undo.push({ op: "void", id: t.id });
    }
    await logActivity(tx, ctx.userId, { entity: "account", entityId: i.account_id, action: "set_balance", actor, summary: `Set ${a.name} to ${formatMoney(target, ctx.currency)}`, before: { balance_cents: a.balance_cents }, after: { balance_cents: target } });
    return {
      summary: `${a.name} is now ${formatMoney(target, ctx.currency)}${diff ? ` (adjustment ${formatMoney(diff, ctx.currency, { signed: true })})` : ""}.`,
      undo,
    };
  });
}

async function insertTx(
  ctx: Ctx,
  q: Q,
  t: { account_id: string; type: string; amount_cents: number; occurred_on: string; category?: string | null; description?: string | null; to_account_id?: string | null; opportunity_id?: string | null; bill_id?: string | null; debt_id?: string | null; paycheck_id?: string | null },
  actor: Actor,
) {
  const [row] = await q<{ id: string }[]>`
    insert into transactions (user_id, account_id, type, amount_cents, occurred_on, category, description, to_account_id,
      opportunity_id, bill_id, debt_id, paycheck_id, source)
    values (${ctx.userId}, ${t.account_id}, ${t.type}, ${t.amount_cents}, ${t.occurred_on}, ${t.category ?? null}, ${t.description ?? null},
      ${t.to_account_id ?? null}, ${t.opportunity_id ?? null}, ${t.bill_id ?? null}, ${t.debt_id ?? null}, ${t.paycheck_id ?? null},
      ${actor === "ai" ? "ai" : actor === "system" ? "system" : "manual"})
    returning id`;
  return row.id;
}
export { insertTx, accountOrDefault };

export async function recordExpense(ctx: Ctx, i: ExpenseCreate, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const acct = await accountOrDefault(ctx, tx, i.account_id);
    const cents = toCents(i.amount);
    const id = await insertTx(ctx, tx, { account_id: acct.id, type: "expense", amount_cents: cents, occurred_on: i.date, category: i.category.toLowerCase(), description: i.description }, actor);
    await logActivity(tx, ctx.userId, { entity: "transaction", entityId: id, action: "expense", actor, summary: `Spent ${formatMoney(cents, ctx.currency)} on ${i.category}` });
    return { summary: `Recorded ${formatMoney(cents, ctx.currency)} spent on ${i.category.toLowerCase()} (${i.date}) from ${acct.name}. Earnings are unchanged.`, data: { id }, undo: [{ op: "void", id }] };
  });
}

export async function recordIncome(ctx: Ctx, i: z.infer<typeof RecordIncome>, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const acct = await accountOrDefault(ctx, tx, i.account_id);
    const cents = toCents(i.amount);
    const undo: NonNullable<ServiceResult["undo"]> = [];
    let note = "";
    if (i.opportunity_id) {
      const [o] = await tx<{ id: string; name: string; status: string; work_date: string | null; earned_cents: number | null; completed_at: Date | null }[]>`
        select id, name, status, work_date, earned_cents, completed_at from work_opportunities where id = ${i.opportunity_id} and user_id = ${ctx.userId}`;
      if (!o) throw new NotFound("Opportunity");
      if (o.status === "declined" || o.status === "considering") throw new AppError(`${o.name} isn't marked as accepted or completed yet.`);
      if (o.status !== "completed") {
        if (o.work_date && o.work_date > ctx.today) throw new AppError(`${o.name} is on ${o.work_date} — it hasn't happened yet.`);
        await tx`update work_opportunities set status = 'completed', earned_cents = ${cents}, completed_at = now(), updated_at = now() where id = ${o.id}`;
        undo.push({ op: "restore", table: "work_opportunities", id: o.id, values: { status: o.status, earned_cents: o.earned_cents, completed_at: null } });
        note = ` Marked ${o.name} as completed.`;
      }
    }
    const id = await insertTx(ctx, tx, { account_id: acct.id, type: "income", amount_cents: cents, occurred_on: i.date, category: i.category ?? (i.opportunity_id ? "one-time work" : "income"), description: i.description, opportunity_id: i.opportunity_id }, actor);
    undo.push({ op: "void", id });
    await logActivity(tx, ctx.userId, { entity: "transaction", entityId: id, action: "income", actor, summary: `Received ${formatMoney(cents, ctx.currency)}${i.description ? ` — ${i.description}` : ""}` });
    return { summary: `Recorded ${formatMoney(cents, ctx.currency)} received into ${acct.name}.${note}`, data: { id }, undo };
  });
}

export async function recordTransfer(ctx: Ctx, i: z.infer<typeof TransferCreate>, actor: Actor): Promise<ServiceResult> {
  if (i.from_account_id === i.to_account_id) throw new AppError("Pick two different accounts.");
  return sql.begin(async (tx) => {
    const from = await accountOrDefault(ctx, tx, i.from_account_id);
    const to = await accountOrDefault(ctx, tx, i.to_account_id);
    const cents = toCents(i.amount);
    const id = await insertTx(ctx, tx, { account_id: from.id, to_account_id: to.id, type: "transfer", amount_cents: cents, occurred_on: i.date, description: i.description }, actor);
    await logActivity(tx, ctx.userId, { entity: "transaction", entityId: id, action: "transfer", actor, summary: `Moved ${formatMoney(cents, ctx.currency)} ${from.name} → ${to.name}` });
    return { summary: `Moved ${formatMoney(cents, ctx.currency)} from ${from.name} to ${to.name}. Not counted as income or spending.`, data: { id }, undo: [{ op: "void", id }] };
  });
}

export async function voidTransaction(ctx: Ctx, id: string, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const [t] = await tx<{ id: string; type: string; amount_cents: number; paycheck_id: string | null; occurred_on: string }[]>`
      select id, type, amount_cents, paycheck_id, occurred_on from transactions where id = ${id} and user_id = ${ctx.userId} and voided_at is null`;
    if (!t) throw new NotFound("Transaction");
    if (t.paycheck_id) throw new AppError("This is a paycheck deposit. Undo the paycheck instead so its shifts are unlinked too.");
    await tx`update transactions set voided_at = now(), updated_at = now() where id = ${id} and user_id = ${ctx.userId}`;
    await logActivity(tx, ctx.userId, { entity: "transaction", entityId: id, action: "void", actor, summary: `Removed ${t.type} of ${formatMoney(t.amount_cents, ctx.currency)} (${t.occurred_on})`, before: t });
    return { summary: `Removed the ${t.type} of ${formatMoney(t.amount_cents, ctx.currency)} from ${t.occurred_on}. It stays in history as voided.`, undo: [{ op: "restore", table: "transactions", id, values: { voided_at: null } }] };
  });
}

export async function listTransactions(ctx: Ctx, r: { start: string; end: string; limit?: number }, q: Q = sql) {
  return q<{ id: string; type: string; amount_cents: number; occurred_on: string; category: string | null; description: string | null; account_name: string }[]>`
    select t.id, t.type, t.amount_cents, t.occurred_on, t.category, t.description, a.name as account_name
    from transactions t join accounts a on a.id = t.account_id
    where t.user_id = ${ctx.userId} and t.voided_at is null and t.occurred_on between ${r.start} and ${r.end}
    order by t.occurred_on desc, t.created_at desc limit ${r.limit ?? 200}`;
}

// ---------------------------------------------------------------- bills
export interface BillRow {
  id: string;
  name: string;
  amount_cents: number;
  next_due_date: string;
  due_anchor_day: number | null;
  recurrence: Recurrence;
  category: string;
  account_id: string | null;
  status: string;
  notes: string | null;
}

export async function listBills(ctx: Ctx, q: Q = sql, opts: { includeArchived?: boolean } = {}) {
  return q<BillRow[]>`select * from bills where user_id = ${ctx.userId} ${opts.includeArchived ? q`` : q`and status = 'active'`} order by next_due_date`;
}

export async function createBill(ctx: Ctx, i: BillCreate, actor: Actor): Promise<ServiceResult> {
  const cents = toCents(i.amount);
  const recurrence = i.recurrence ?? "none";
  const anchor = recurrence === "monthly" || recurrence === "yearly" ? splitDate(i.due_date).day : null;
  const [b] = await sql<{ id: string }[]>`
    insert into bills (user_id, name, amount_cents, next_due_date, due_anchor_day, recurrence, category, account_id, notes)
    values (${ctx.userId}, ${i.name}, ${cents}, ${i.due_date}, ${anchor}, ${recurrence}, ${i.category ?? "bills"}, ${i.account_id ?? null}, ${i.notes ?? null})
    returning id`;
  await logActivity(sql, ctx.userId, { entity: "bill", entityId: b.id, action: "create", actor, summary: `Added bill ${i.name} ${formatMoney(cents, ctx.currency)} due ${i.due_date}` });
  return {
    summary: `Added ${i.name}: ${formatMoney(cents, ctx.currency)} due ${i.due_date}${recurrence !== "none" ? `, repeating ${recurrence}` : ""}.`,
    data: { id: b.id },
    undo: [{ op: "delete", table: "bills", id: b.id }],
  };
}

export async function updateBill(ctx: Ctx, i: z.infer<typeof BillUpdate>, actor: Actor): Promise<ServiceResult> {
  const [b] = await sql<BillRow[]>`select * from bills where id = ${i.bill_id} and user_id = ${ctx.userId}`;
  if (!b) throw new NotFound("Bill");
  const patch: Record<string, unknown> = {};
  if (i.name !== undefined) patch.name = i.name;
  if (i.amount !== undefined) patch.amount_cents = toCents(i.amount);
  if (i.due_date !== undefined) {
    patch.next_due_date = i.due_date;
    patch.due_anchor_day = splitDate(i.due_date).day;
  }
  if (i.recurrence !== undefined) patch.recurrence = i.recurrence;
  if (i.category !== undefined) patch.category = i.category;
  if (i.notes !== undefined) patch.notes = i.notes;
  if (i.status !== undefined) patch.status = i.status;
  if (!Object.keys(patch).length) throw new AppError("Nothing to change.");
  const before = snapshot(b as unknown as Record<string, unknown>, Object.keys(patch));
  await sql`update bills set ${sql(patch as Record<string, never>)}, updated_at = now() where id = ${b.id} and user_id = ${ctx.userId}`;
  await logActivity(sql, ctx.userId, { entity: "bill", entityId: b.id, action: "update", actor, summary: `Updated bill ${b.name}`, before, after: patch });
  return { summary: `Updated ${b.name}.`, undo: [{ op: "restore", table: "bills", id: b.id, values: before }] };
}

/** Pay the current occurrence: one expense, one bill_payment (unique per occurrence), advance the due date. */
export async function markBillPaid(ctx: Ctx, i: z.infer<typeof BillPaid>, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const [b] = await tx<BillRow[]>`select * from bills where id = ${i.bill_id} and user_id = ${ctx.userId} for update`;
    if (!b) throw new NotFound("Bill");
    if (b.status !== "active") throw new AppError(`${b.name} is already marked paid.`);
    const cents = i.amount != null ? toCents(i.amount) : b.amount_cents;
    const acct = await accountOrDefault(ctx, tx, i.account_id ?? b.account_id ?? undefined);
    const txId = await insertTx(ctx, tx, { account_id: acct.id, type: "expense", amount_cents: cents, occurred_on: i.paid_on, category: b.category, description: b.name, bill_id: b.id }, actor);
    const [p] = await tx<{ id: string }[]>`
      insert into bill_payments (user_id, bill_id, due_date, paid_on, amount_cents, transaction_id)
      values (${ctx.userId}, ${b.id}, ${b.next_due_date}, ${i.paid_on}, ${cents}, ${txId}) returning id`;
    const next = nextOccurrence(b.next_due_date, b.recurrence, b.due_anchor_day);
    if (next) await tx`update bills set next_due_date = ${next}, updated_at = now() where id = ${b.id}`;
    else await tx`update bills set status = 'paid', updated_at = now() where id = ${b.id}`;
    await logActivity(tx, ctx.userId, { entity: "bill", entityId: b.id, action: "paid", actor, summary: `Paid ${b.name} ${formatMoney(cents, ctx.currency)} (due ${b.next_due_date})` });
    return {
      summary: `Marked ${b.name} paid: ${formatMoney(cents, ctx.currency)} from ${acct.name} on ${i.paid_on}.${next ? ` Next due ${next}.` : ""}`,
      undo: [
        { op: "void", id: txId },
        { op: "delete", table: "bill_payments", id: p.id },
        { op: "restore", table: "bills", id: b.id, values: { next_due_date: b.next_due_date, status: b.status } },
      ],
    };
  });
}

// ---------------------------------------------------------------- debts
export async function createDebt(ctx: Ctx, i: z.infer<typeof DebtCreate>, actor: Actor): Promise<ServiceResult> {
  const cents = toCents(i.balance);
  const [d] = await sql<{ id: string }[]>`
    insert into debts (user_id, name, creditor, starting_balance_cents, opened_on, interest_rate_percent, minimum_payment_cents, notes)
    values (${ctx.userId}, ${i.name}, ${i.creditor ?? null}, ${cents}, ${ctx.today}, ${i.interest_rate_percent ?? null},
            ${i.minimum_payment != null ? toCents(i.minimum_payment) : null}, ${i.notes ?? null}) returning id`;
  await logActivity(sql, ctx.userId, { entity: "debt", entityId: d.id, action: "create", actor, summary: `Added debt ${i.name} ${formatMoney(cents, ctx.currency)}` });
  return { summary: `Tracking ${i.name}: ${formatMoney(cents, ctx.currency)} owed.`, data: { id: d.id }, undo: [{ op: "delete", table: "debts", id: d.id }] };
}

/** A debt payment lowers cash and the debt. It's reported separately from spending. */
export async function recordDebtPayment(ctx: Ctx, i: z.infer<typeof DebtPayment>, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const [d] = await tx<{ id: string; name: string; balance_cents: number }[]>`
      select debt_id as id, name, balance_cents from debt_balances where debt_id = ${i.debt_id} and user_id = ${ctx.userId}`;
    if (!d) throw new NotFound("Debt");
    const cents = toCents(i.amount);
    if (cents > d.balance_cents) throw new AppError(`That's more than the ${formatMoney(d.balance_cents, ctx.currency)} still owed on ${d.name}.`);
    const acct = await accountOrDefault(ctx, tx, i.account_id);
    const id = await insertTx(ctx, tx, { account_id: acct.id, type: "debt_payment", amount_cents: cents, occurred_on: i.date, category: "debt", description: d.name, debt_id: d.id }, actor);
    const remaining = d.balance_cents - cents;
    if (remaining === 0) await tx`update debts set status = 'paid_off' where id = ${d.id}`;
    await logActivity(tx, ctx.userId, { entity: "debt", entityId: d.id, action: "payment", actor, summary: `Paid ${formatMoney(cents, ctx.currency)} toward ${d.name}` });
    return {
      summary: `Paid ${formatMoney(cents, ctx.currency)} toward ${d.name}. ${remaining === 0 ? "Paid off!" : `${formatMoney(remaining, ctx.currency)} left.`}`,
      undo: [{ op: "void", id }, ...(remaining === 0 ? [{ op: "restore" as const, table: "debts", id: d.id, values: { status: "active" } }] : [])],
    };
  });
}

// ---------------------------------------------------------------- goals
export async function createGoal(ctx: Ctx, i: z.infer<typeof GoalCreate>, actor: Actor): Promise<ServiceResult> {
  return sql.begin(async (tx) => {
    const target = toCents(i.target_amount);
    const [g] = await tx<{ id: string }[]>`
      insert into savings_goals (user_id, name, target_cents, target_date, monthly_target_cents)
      values (${ctx.userId}, ${i.name}, ${target}, ${i.target_date ?? null}, ${i.monthly_target != null ? toCents(i.monthly_target) : null}) returning id`;
    const undo: NonNullable<ServiceResult["undo"]> = [{ op: "delete", table: "savings_goals", id: g.id }];
    if (i.already_saved && i.already_saved > 0) {
      const [c] = await tx<{ id: string }[]>`
        insert into goal_contributions (user_id, goal_id, amount_cents, contributed_on, note)
        values (${ctx.userId}, ${g.id}, ${toCents(i.already_saved)}, ${ctx.today}, 'Already saved') returning id`;
      undo.push({ op: "delete", table: "goal_contributions", id: c.id }); // undone first (ops run in reverse)
    }
    await logActivity(tx, ctx.userId, { entity: "goal", entityId: g.id, action: "create", actor, summary: `New goal ${i.name} ${formatMoney(target, ctx.currency)}` });
    return {
      summary: `New goal: ${i.name}, ${formatMoney(target, ctx.currency)}${i.monthly_target ? ` (${formatMoney(toCents(i.monthly_target), ctx.currency)}/month)` : ""}${i.target_date ? ` by ${i.target_date}` : ""}.`,
      data: { id: g.id },
      undo,
    };
  });
}

/** Earmark money already held for a goal. Not spending; total cash is unchanged. */
export async function contributeToGoal(ctx: Ctx, i: z.infer<typeof GoalContribution>, actor: Actor): Promise<ServiceResult> {
  const [g] = await sql<{ id: string; name: string; saved_cents: number; target_cents: number }[]>`
    select goal_id as id, name, saved_cents, target_cents from goal_progress where goal_id = ${i.goal_id} and user_id = ${ctx.userId}`;
  if (!g) throw new NotFound("Goal");
  const cents = toCents(i.amount);
  if (g.saved_cents + cents < 0) throw new AppError(`Only ${formatMoney(g.saved_cents, ctx.currency)} is set aside for ${g.name}.`);
  const [c] = await sql<{ id: string }[]>`
    insert into goal_contributions (user_id, goal_id, amount_cents, contributed_on, note)
    values (${ctx.userId}, ${g.id}, ${cents}, ${i.date}, ${i.note ?? null}) returning id`;
  await logActivity(sql, ctx.userId, { entity: "goal", entityId: g.id, action: "contribute", actor, summary: `${cents > 0 ? "Set aside" : "Withdrew"} ${formatMoney(Math.abs(cents), ctx.currency)} for ${g.name}` });
  const saved = g.saved_cents + cents;
  return {
    summary: `${cents > 0 ? "Set aside" : "Took back"} ${formatMoney(Math.abs(cents), ctx.currency)} ${cents > 0 ? "for" : "from"} ${g.name}: ${formatMoney(saved, ctx.currency)} of ${formatMoney(g.target_cents, ctx.currency)} (${Math.min(100, Math.round((saved / g.target_cents) * 100))}%).`,
    undo: [{ op: "uncontribute", id: c.id }],
  };
}

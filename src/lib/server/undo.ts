import "server-only";
import type { Q } from "./db";
import { AppError } from "./errors";

// Undo descriptors are produced by HARU's own services (never by the model) and
// stored with the action. Applying them is restricted to a table whitelist and
// always scoped to the acting user.

const TABLES = new Set([
  "user_memory",
  "jobs",
  "job_wages",
  "shifts",
  "work_opportunities",
  "paychecks",
  "accounts",
  "transactions",
  "bills",
  "bill_payments",
  "debts",
  "savings_goals",
  "goal_contributions",
  "reminders",
  "behavior_observations",
  "dashboard_preferences",
]);

// Deleting a created parent would silently cascade newer records — refuse instead.
const DEPENDENTS: Record<string, { table: string; column: string }> = {
  jobs: { table: "shifts", column: "job_id" },
  accounts: { table: "transactions", column: "account_id" },
  debts: { table: "transactions", column: "debt_id" },
  savings_goals: { table: "goal_contributions", column: "goal_id" },
  bills: { table: "bill_payments", column: "bill_id" },
};

export type UndoOp =
  | { op: "delete"; table: string; id: string }
  | { op: "restore"; table: string; id: string; values: Record<string, unknown> }
  | { op: "insert"; table: string; values: Record<string, unknown> } // re-create a deleted row
  | { op: "void"; id: string } // transactions
  | { op: "uncontribute"; id: string } // goal_contributions
  | { op: "unlink_shifts"; paycheckId: string }
  | { op: "layout"; layout: unknown }
  | { op: "cards"; cards: unknown }
  | { op: "prefs"; values: Record<string, unknown> };

/** Arrays of numbers are Postgres arrays (pay days); other objects/arrays are JSON columns. */
function encodeValue(q: Q, v: unknown): unknown {
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number")) return q.array(v as number[]);
  if (v !== null && typeof v === "object") return q.json(v as never);
  return v;
}

export async function applyUndo(q: Q, userId: string, ops: UndoOp[]) {
  // Reverse order: last change undone first.
  for (const o of [...ops].reverse()) {
    switch (o.op) {
      case "delete": {
        if (!TABLES.has(o.table)) throw new AppError("Unsupported undo");
        const dep = DEPENDENTS[o.table];
        if (dep) {
          const [{ n }] = await q<{ n: number }[]>`select count(*)::int as n from ${q(dep.table)} where ${q(dep.column)} = ${o.id} and user_id = ${userId}`;
          if (n > 0) throw new AppError(`This can't be undone automatically because ${n} other record${n > 1 ? "s" : ""} now depend on it.`, 409);
        }
        await q`delete from ${q(o.table)} where id = ${o.id} and user_id = ${userId}`;
      }
        break;
      case "restore":
        if (!TABLES.has(o.table)) throw new AppError("Unsupported undo");
        if (Object.keys(o.values).length === 0) break;
        {
          // JSON columns were snapshotted as objects/arrays; send them as json.
          const values: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(o.values)) values[k] = encodeValue(q, v);
          await q`update ${q(o.table)} set ${q(values as Record<string, never>)} where id = ${o.id} and user_id = ${userId}`;
        }
        break;
      case "insert": {
        if (!TABLES.has(o.table)) throw new AppError("Unsupported undo");
        const values: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o.values)) values[k] = encodeValue(q, v);
        values.user_id = userId;
        await q`insert into ${q(o.table)} ${q(values as Record<string, never>)}`;
        break;
      }
      case "void":
        await q`update transactions set voided_at = now(), updated_at = now() where id = ${o.id} and user_id = ${userId} and voided_at is null`;
        break;
      case "uncontribute":
        await q`update goal_contributions set voided_at = now() where id = ${o.id} and user_id = ${userId}`;
        break;
      case "unlink_shifts":
        await q`update shifts set paycheck_id = null where paycheck_id = ${o.paycheckId} and user_id = ${userId}`;
        break;
      case "prefs": {
        const allowed = new Set(["display_name", "currency", "timezone", "week_starts_on", "reserve_percent", "notify_categories", "shift_lead_minutes", "log_hours_time", "bill_lead_days", "bill_notify_time", "payday_notify_time"]);
        const values: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o.values)) if (allowed.has(k)) values[k] = encodeValue(q, v);
        if (Object.keys(values).length) await q`update user_preferences set ${q(values as Record<string, never>)}, updated_at = now() where user_id = ${userId}`;
        break;
      }
      case "layout":
        await q`update dashboard_preferences set layout = ${q.json(o.layout as never)}, updated_at = now() where user_id = ${userId}`;
        break;
      case "cards":
        await q`update dashboard_preferences set cards = ${q.json(o.cards as never)}, updated_at = now() where user_id = ${userId}`;
        break;
    }
  }
}

/** Pick only the given columns from a row, for a precise "restore" snapshot. */
export function snapshot<T extends Record<string, unknown>>(row: T, cols: (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c as string] = row[c] instanceof Date ? (row[c] as Date).toISOString() : row[c];
  return out;
}

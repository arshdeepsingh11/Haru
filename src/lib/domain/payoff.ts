import type { Cents } from "./money";
import { addMonths, diffDays, type ISODate } from "./time";

// Payoff planner: focus every spare dollar on ONE target at a time.
// Debts first by highest interest (avalanche), ties → smallest balance;
// then savings goals by earliest target date. Minimums on all debts are always paid.

export interface DebtIn {
  id: string;
  name: string;
  balanceCents: Cents;
  aprPercent: number | null;
  minimumCents: Cents | null;
}
export interface GoalIn {
  id: string;
  name: string;
  targetCents: Cents;
  savedCents: Cents;
  targetDate: ISODate | null;
}

export interface PlanItem {
  id: string;
  name: string;
  kind: "debt" | "goal";
  remainingCents: Cents;
  finishDate: ISODate | null; // null = not reachable within 50 years at this pace
  months: number | null;
  onTrack: boolean | null; // goals with a target date
  reason: string;
}

export interface PayoffPlan {
  monthlyTakeHomeCents: Cents;
  monthlyBillsCents: Cents;
  monthlyMinimumsCents: Cents;
  surplusCents: Cents; // free each month after bills and minimums
  items: PlanItem[];
  focus: PlanItem | null;
  debtFreeDate: ISODate | null;
  warnings: string[];
}

const MAX_MONTHS = 600;

export function orderTargets(debts: DebtIn[]): DebtIn[] {
  return [...debts].sort((a, b) => (b.aprPercent ?? 0) - (a.aprPercent ?? 0) || a.balanceCents - b.balanceCents);
}

export function buildPayoffPlan(i: { today: ISODate; monthlyTakeHomeCents: Cents; monthlyBillsCents: Cents; debts: DebtIn[]; goals: GoalIn[] }): PayoffPlan {
  const debts = orderTargets(i.debts.filter((d) => d.balanceCents > 0));
  const minimums = debts.reduce((a, d) => a + Math.min(d.minimumCents ?? 0, d.balanceCents), 0);
  const surplus = i.monthlyTakeHomeCents - i.monthlyBillsCents - minimums;
  const warnings: string[] = [];
  if (i.monthlyTakeHomeCents === 0) warnings.push("Add your work schedule so HARU can see what you'll earn.");
  else if (surplus <= 0) warnings.push("Your scheduled shifts don't cover your bills and minimum payments yet. Extra shifts go straight to closing that gap.");

  // Simulate month by month.
  const bal = new Map(debts.map((d) => [d.id, d.balanceCents]));
  const finished = new Map<string, number>();
  let free = Math.max(0, surplus);
  for (let m = 1; m <= MAX_MONTHS && finished.size < debts.length; m++) {
    let pool = free;
    for (const d of debts) {
      const b = bal.get(d.id)!;
      if (b <= 0) continue;
      const interest = Math.round((b * (d.aprPercent ?? 0)) / 100 / 12);
      const min = Math.min(d.minimumCents ?? 0, b + interest);
      bal.set(d.id, b + interest - min);
    }
    for (const d of debts) {
      const b = bal.get(d.id)!;
      if (b <= 0) {
        if (!finished.has(d.id)) finished.set(d.id, m);
        continue;
      }
      const pay = Math.min(pool, b);
      bal.set(d.id, b - pay);
      pool -= pay;
      if (b - pay <= 0) {
        finished.set(d.id, m);
        free += Math.min(d.minimumCents ?? 0, d.balanceCents); // freed minimum rolls into the next target
      }
      if (pool <= 0) break;
    }
  }
  const debtMonths = debts.length ? Math.max(0, ...[...finished.values()]) : 0;
  const allDebtsDone = finished.size === debts.length;

  const items: PlanItem[] = debts.map((d, idx) => {
    const m = finished.get(d.id) ?? null;
    return {
      id: d.id,
      name: d.name,
      kind: "debt",
      remainingCents: d.balanceCents,
      finishDate: m != null ? addMonths(i.today, m) : null,
      months: m,
      onTrack: null,
      reason:
        idx === 0
          ? d.aprPercent
            ? `Highest interest (${d.aprPercent}%) — every extra dollar goes here first.`
            : "Smallest balance — clear it fast, then roll its payment into the next."
          : `Next after ${debts[idx - 1].name}.`,
    };
  });

  // Goals after debts, earliest target date first.
  const goals = [...i.goals].filter((g) => g.targetCents > g.savedCents).sort((a, b) => (a.targetDate ?? "9999") < (b.targetDate ?? "9999") ? -1 : 1);
  const monthlyAfterDebts = Math.max(0, surplus) + minimums;
  let cursor = allDebtsDone ? debtMonths : null;
  for (const g of goals) {
    const left = g.targetCents - g.savedCents;
    let months: number | null = null;
    if (cursor != null && monthlyAfterDebts > 0) {
      months = cursor + Math.ceil(left / monthlyAfterDebts);
      cursor = months;
    }
    const finishDate = months != null && months <= MAX_MONTHS ? addMonths(i.today, months) : null;
    items.push({
      id: g.id,
      name: g.name,
      kind: "goal",
      remainingCents: left,
      finishDate,
      months,
      onTrack: g.targetDate ? (finishDate != null && finishDate <= g.targetDate) : null,
      reason: debts.length ? "Starts once your debts are cleared." : g.targetDate ? `Due ${g.targetDate}.` : "Your savings goal.",
    });
  }

  return {
    monthlyTakeHomeCents: i.monthlyTakeHomeCents,
    monthlyBillsCents: i.monthlyBillsCents,
    monthlyMinimumsCents: minimums,
    surplusCents: surplus,
    items,
    focus: items[0] ?? null,
    debtFreeDate: debts.length ? (allDebtsDone ? addMonths(i.today, debtMonths) : null) : null,
    warnings,
  };
}

/** How many days sooner the focus target is reached by `extraCents` (e.g. one shift's take-home). */
export function daysCloser(plan: PayoffPlan, extraCents: Cents): number | null {
  if (!plan.focus || plan.surplusCents <= 0) return null;
  const perDay = plan.surplusCents / 30.44;
  return Math.max(0, Math.round(extraCents / perDay));
}

export function daysUntil(today: ISODate, date: ISODate | null): number | null {
  return date ? diffDays(today, date) : null;
}

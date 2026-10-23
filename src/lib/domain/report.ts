import type { Cents } from "./money";
import type { DateRange } from "./ranges";

// A report is built from rows already filtered to the user and range.
// Earned (work done) and received (cash in) are separate sections by design.

export interface ReportInput {
  range: DateRange;
  shifts: { job_id: string; job_name: string; status: string; paid_minutes: number; gross_cents: number; work_date: string }[];
  opportunities: { name: string; status: string; earned_cents: number | null; offered_cents: number; work_date: string | null }[];
  transactions: { type: string; amount_cents: number; category: string | null; occurred_on: string; description: string | null }[];
  goalContributions: { goal_name: string; amount_cents: number }[];
  billsDue: { name: string; amount_cents: number; due_date: string; paid: boolean }[];
  expectedPaychecks: { job_name: string; pay_date: string; expected_gross_cents: number }[];
  projectedOpportunities: { name: string; offered_cents: number; work_date: string | null }[];
}

export interface Report {
  range: DateRange;
  earned: {
    totalGrossCents: Cents;
    totalMinutes: number;
    byJob: { name: string; grossCents: Cents; minutes: number; shifts: number }[];
    oneTimeWork: { name: string; earnedCents: Cents }[];
  };
  received: { paychecksCents: Cents; otherIncomeCents: Cents; totalCents: Cents };
  spending: { totalCents: Cents; byCategory: { category: string; cents: Cents }[] };
  debtPaymentsCents: Cents;
  savedToGoals: { totalCents: Cents; byGoal: { name: string; cents: Cents }[] };
  bills: { paidCents: Cents; unpaid: { name: string; amountCents: Cents; dueDate: string }[] };
  projected: {
    label: string;
    totalCents: Cents;
    paychecks: { jobName: string; payDate: string; grossCents: Cents }[];
    opportunities: { name: string; cents: Cents; date: string | null }[];
  };
  scheduledNotWorked: { minutes: number; grossCents: Cents };
  netCashFlowCents: Cents;
}

function group<T>(xs: T[], key: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}

export function buildReport(i: ReportInput): Report {
  const completed = i.shifts.filter((s) => s.status === "completed");
  const scheduled = i.shifts.filter((s) => s.status === "scheduled");
  const byJob = [...group(completed, (s) => s.job_id).values()]
    .map((rows) => ({
      name: rows[0].job_name,
      grossCents: rows.reduce((a, r) => a + r.gross_cents, 0),
      minutes: rows.reduce((a, r) => a + r.paid_minutes, 0),
      shifts: rows.length,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);
  const oneTimeWork = i.opportunities
    .filter((o) => o.status === "completed" && o.earned_cents != null)
    .map((o) => ({ name: o.name, earnedCents: o.earned_cents! }));

  const tx = i.transactions;
  const paychecksCents = tx.filter((t) => t.type === "paycheck").reduce((a, t) => a + t.amount_cents, 0);
  const otherIncomeCents = tx.filter((t) => t.type === "income").reduce((a, t) => a + t.amount_cents, 0);
  const expenses = tx.filter((t) => t.type === "expense");
  const byCategory = [...group(expenses, (t) => t.category || "uncategorised").entries()]
    .map(([category, rows]) => ({ category, cents: rows.reduce((a, r) => a + r.amount_cents, 0) }))
    .sort((a, b) => b.cents - a.cents);
  const spendingTotal = expenses.reduce((a, t) => a + t.amount_cents, 0);
  const debtPaymentsCents = tx.filter((t) => t.type === "debt_payment").reduce((a, t) => a + t.amount_cents, 0);

  const byGoal = [...group(i.goalContributions, (c) => c.goal_name).entries()].map(([name, rows]) => ({
    name,
    cents: rows.reduce((a, r) => a + r.amount_cents, 0),
  }));

  const projPay = i.expectedPaychecks.map((p) => ({ jobName: p.job_name, payDate: p.pay_date, grossCents: p.expected_gross_cents }));
  const projOpp = i.projectedOpportunities.map((o) => ({ name: o.name, cents: o.offered_cents, date: o.work_date }));

  const totalGross = byJob.reduce((a, j) => a + j.grossCents, 0) + oneTimeWork.reduce((a, o) => a + o.earnedCents, 0);

  return {
    range: i.range,
    earned: {
      totalGrossCents: totalGross,
      totalMinutes: byJob.reduce((a, j) => a + j.minutes, 0),
      byJob,
      oneTimeWork,
    },
    received: { paychecksCents, otherIncomeCents, totalCents: paychecksCents + otherIncomeCents },
    spending: { totalCents: spendingTotal, byCategory },
    debtPaymentsCents,
    savedToGoals: { totalCents: byGoal.reduce((a, g) => a + g.cents, 0), byGoal },
    bills: {
      paidCents: i.billsDue.filter((b) => b.paid).reduce((a, b) => a + b.amount_cents, 0),
      unpaid: i.billsDue.filter((b) => !b.paid).map((b) => ({ name: b.name, amountCents: b.amount_cents, dueDate: b.due_date })),
    },
    projected: {
      label: "Projection — not yet earned or received",
      totalCents: projPay.reduce((a, p) => a + p.grossCents, 0) + projOpp.reduce((a, o) => a + o.cents, 0),
      paychecks: projPay,
      opportunities: projOpp,
    },
    scheduledNotWorked: {
      minutes: scheduled.reduce((a, s) => a + s.paid_minutes, 0),
      grossCents: scheduled.reduce((a, s) => a + s.gross_cents, 0),
    },
    netCashFlowCents: paychecksCents + otherIncomeCents - spendingTotal - debtPaymentsCents,
  };
}

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const d = (c: number) => (c / 100).toFixed(2);

export function reportToCsv(r: Report): string {
  const rows: (string | number)[][] = [
    ["HARU report", r.range.label, r.range.start, r.range.end],
    [],
    ["Section", "Item", "Amount", "Detail"],
    ...r.earned.byJob.map((j) => ["Earned (gross)", j.name, d(j.grossCents), `${(j.minutes / 60).toFixed(2)} h, ${j.shifts} shifts`]),
    ...r.earned.oneTimeWork.map((o) => ["Earned (gross)", `${o.name} (one-time)`, d(o.earnedCents), ""]),
    ["Earned (gross)", "Total", d(r.earned.totalGrossCents), `${(r.earned.totalMinutes / 60).toFixed(2)} h`],
    ["Received", "Paychecks", d(r.received.paychecksCents), ""],
    ["Received", "Other income", d(r.received.otherIncomeCents), ""],
    ...r.spending.byCategory.map((c) => ["Spending", c.category, d(c.cents), ""]),
    ["Spending", "Total", d(r.spending.totalCents), ""],
    ["Debt payments", "Total", d(r.debtPaymentsCents), ""],
    ...r.savedToGoals.byGoal.map((g) => ["Saved to goals", g.name, d(g.cents), "allocation, not spending"]),
    ...r.bills.unpaid.map((b) => ["Unpaid bills", b.name, d(b.amountCents), `due ${b.dueDate}`]),
    ...r.projected.paychecks.map((p) => ["PROJECTED", `Paycheck — ${p.jobName}`, d(p.grossCents), `pay date ${p.payDate}`]),
    ...r.projected.opportunities.map((o) => ["PROJECTED", `One-time — ${o.name}`, d(o.cents), o.date ?? ""]),
    ["Net cash flow", "Received − spending − debt payments", d(r.netCashFlowCents), ""],
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

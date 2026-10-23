// The approved set of dashboard cards. The AI builds each user's dashboard by
// adding, removing and ordering these keys — it can never ship UI code.

export const CARDS = {
  next_shift: { title: "Next shift", description: "What the next shift earns after tax, which paycheck it lands in, days closer to the goal, going / can't make it" },
  paychecks: { title: "Paychecks", description: "Each job's next payday and how much is earned toward it so far" },
  week: { title: "This week", description: "The next 7 days of shifts with take-home per shift" },
  stats: { title: "Your numbers", description: "Earned this month, shift streak, show-up rate, money left on the table" },
  payoff: { title: "Payoff plan", description: "What to pay first, monthly surplus, debt-free / goal dates" },
  money: { title: "Money", description: "Cash, reserved for bills, goal money, safe to spend, expected income" },
  earnings: { title: "Take-home", description: "This week and month after tax, with an 8-week chart" },
  bills: { title: "Bills", description: "Upcoming and overdue bills with Mark paid" },
  goals: { title: "Goals", description: "Savings goals and progress" },
  debts: { title: "Debts", description: "What is owed and progress paying it down" },
  spending: { title: "Spending", description: "Spending by week and top categories" },
  opportunities: { title: "Extra work", description: "One-time shifts being considered or awaiting payment" },
  reminders: { title: "Reminders", description: "Upcoming reminders" },
  insights: { title: "Patterns", description: "Behaviour patterns HARU noticed, with evidence" },
  activity: { title: "Activity", description: "Latest changes to the records" },
} as const;

export type CardKey = keyof typeof CARDS;
export const CARD_KEYS = Object.keys(CARDS) as CardKey[];

export interface CardsState {
  show: CardKey[];
  removed: CardKey[];
}

export function isCardKey(k: unknown): k is CardKey {
  return typeof k === "string" && k in CARDS;
}

export function normalizeCards(raw: unknown): CardsState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { show?: unknown; removed?: unknown };
  const uniq = (xs: unknown) => (Array.isArray(xs) ? xs.filter(isCardKey).filter((k, i, a) => a.indexOf(k) === i) : []);
  return { show: uniq(r.show), removed: uniq(r.removed) };
}

/** Where a new card goes: shift cards lead, history-type cards trail. */
const RANK: Record<CardKey, number> = {
  next_shift: 10, paychecks: 20, week: 30, payoff: 40, money: 50, stats: 60, bills: 70, goals: 80, debts: 90,
  opportunities: 95, earnings: 100, spending: 110, reminders: 120, insights: 130, activity: 140,
};

/** Add keys in their natural position, without disturbing the user's existing order. */
export function placeCards(show: CardKey[], add: CardKey[]): CardKey[] {
  const out = [...show];
  for (const k of add) {
    if (out.includes(k)) continue;
    const idx = out.findIndex((x) => RANK[x] > RANK[k]);
    if (idx === -1) out.push(k);
    else out.splice(idx, 0, k);
  }
  return out;
}

/** Cards that make sense after a given change. Used so the dashboard grows with the conversation. */
export const CARDS_FOR: Record<string, CardKey[]> = {
  create_job: ["next_shift", "paychecks", "week"],
  update_job: ["next_shift", "paychecks", "week"],
  create_shift: ["next_shift", "week"],
  create_shifts_batch: ["next_shift", "week"],
  checkout_shift: ["stats", "earnings"],
  set_shift_attendance: ["stats"],
  create_debt: ["payoff", "debts"],
  create_savings_goal: ["payoff", "goals"],
  create_bill: ["bills", "payoff"],
  create_account: ["money"],
  set_account_balance: ["money"],
  create_expense: ["spending"],
  create_work_opportunity: ["opportunities"],
  record_paycheck: ["money"],
  create_reminder: ["reminders"],
  // manual forms (server actions)
  createJob: ["next_shift", "paychecks", "week"],
  updateJob: ["next_shift", "paychecks", "week"],
  createShift: ["next_shift", "week"],
  checkoutShift: ["stats", "earnings"],
  createDebt: ["payoff", "debts"],
  createGoal: ["payoff", "goals"],
  createBill: ["bills", "payoff"],
  createAccount: ["money"],
  setBalance: ["money"],
  recordExpense: ["spending"],
  createOpportunity: ["opportunities"],
  recordPaycheck: ["money"],
};

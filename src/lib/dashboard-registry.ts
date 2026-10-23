// The approved registry of dashboard components. The AI may only select,
// reorder, hide or show these keys — it can never ship UI code.

export const COMPONENTS = {
  attention: { title: "Needs attention", description: "Overdue bills, unlogged shifts, unconfirmed paychecks" },
  position: { title: "Money", description: "Cash, reserved, goals, safe to allocate, unpaid and expected income, debt" },
  earnings: { title: "Earnings", description: "This week and month, by job, with an 8-week chart" },
  paydays: { title: "Next paydays", description: "Per-job paycheck forecasts from saved payroll rules" },
  upcoming_work: { title: "Upcoming work", description: "Scheduled shifts and accepted one-time jobs" },
  opportunities: { title: "One-time work", description: "Offers being considered and their effective hourly rate" },
  bills: { title: "Bills", description: "Upcoming and overdue bills" },
  goals: { title: "Savings goals", description: "Progress toward goals" },
  debts: { title: "Debt", description: "What you owe and progress paying it down" },
  spending: { title: "Spending", description: "Spending by week and category" },
  reminders: { title: "Reminders", description: "Upcoming reminders and notifications" },
  insights: { title: "Insights", description: "Patterns HARU has noticed, with the evidence" },
  activity: { title: "Recent activity", description: "Latest changes to your records" },
} as const;

export type ComponentKey = keyof typeof COMPONENTS;
export const COMPONENT_KEYS = Object.keys(COMPONENTS) as ComponentKey[];

export interface LayoutEntry {
  key: ComponentKey;
  hidden?: boolean;
}

export function isComponentKey(k: string): k is ComponentKey {
  return k in COMPONENTS;
}

/**
 * Final order = relevant components sorted by contextual priority, then the
 * user's saved order applied on top; hidden components are removed. A pinned
 * (explicitly shown) component is displayed even when it has no data.
 */
export function arrange(scores: Partial<Record<ComponentKey, number | null>>, layout: LayoutEntry[]): ComponentKey[] {
  const hidden = new Set(layout.filter((l) => l.hidden).map((l) => l.key));
  const userOrder = layout.filter((l) => !l.hidden).map((l) => l.key);
  const relevant = COMPONENT_KEYS.filter((k) => scores[k] != null && !hidden.has(k)).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const ordered: ComponentKey[] = [];
  // The user's explicit order wins; "attention" always stays first when it has items.
  if (scores.attention != null && !hidden.has("attention")) ordered.push("attention");
  for (const k of userOrder) if (!ordered.includes(k) && (scores[k] != null || userOrder.includes(k))) ordered.push(k);
  for (const k of relevant) if (!ordered.includes(k)) ordered.push(k);
  return ordered;
}

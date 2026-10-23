import type { Cents } from "./money";

/**
 * The money picture, never collapsed into one misleading number.
 *  - cash: what your (manually tracked) accounts hold now
 *  - reservedForObligations: unpaid bills due before the horizon (normally your next payday)
 *  - allocatedToGoals: part of cash you've earmarked for savings goals
 *  - safeToAllocate: cash − reserved − goals (can be negative: a shortfall)
 *  - earnedUnpaid / expectedIncome / debt are shown beside cash, never added to it
 */
export interface FinancialPosition {
  cashCents: Cents;
  reservedForObligationsCents: Cents;
  allocatedToGoalsCents: Cents;
  safeToAllocateCents: Cents;
  earnedUnpaidCents: Cents;
  expectedIncomeCents: Cents;
  debtCents: Cents;
  shortfall: boolean;
}

export function computePosition(input: {
  cashCents: Cents;
  unpaidBillsBeforeHorizonCents: Cents;
  allocatedToGoalsCents: Cents;
  earnedUnpaidCents: Cents;
  expectedIncomeCents: Cents;
  debtCents: Cents;
}): FinancialPosition {
  const safe = input.cashCents - input.unpaidBillsBeforeHorizonCents - Math.max(0, input.allocatedToGoalsCents);
  return {
    cashCents: input.cashCents,
    reservedForObligationsCents: input.unpaidBillsBeforeHorizonCents,
    allocatedToGoalsCents: Math.max(0, input.allocatedToGoalsCents),
    safeToAllocateCents: safe,
    earnedUnpaidCents: input.earnedUnpaidCents,
    expectedIncomeCents: input.expectedIncomeCents,
    debtCents: input.debtCents,
    shortfall: safe < 0,
  };
}

/** "Can I afford to spend $200 this weekend?" — deterministic answer with reasoning. */
export function affordability(position: FinancialPosition, amountCents: Cents) {
  const remaining = position.safeToAllocateCents - amountCents;
  return {
    affordable: remaining >= 0,
    remainingAfterCents: remaining,
    basis:
      "Compared against cash minus bills due before your next payday and money set aside for goals. Unpaid earnings and expected income are not counted until they arrive.",
  };
}

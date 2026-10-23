import { percentOf, roundHalfAway, type Cents } from "./money";

export type OpportunityStatus = "considering" | "accepted" | "scheduled" | "completed" | "declined";

export interface OpportunityEvaluation {
  effectiveHourlyCents: Cents | null;
  reserveEstimateCents: Cents;
  planningAmountCents: Cents;
  note: string;
}

/** $100 for 6 h → $16.67/h; with a 5% reserve estimate → $5 reserve, $95 planning amount. */
export function evaluateOpportunity(offeredCents: Cents, expectedMinutes: number | null, reservePercent: number): OpportunityEvaluation {
  const effectiveHourlyCents = expectedMinutes && expectedMinutes > 0 ? roundHalfAway((offeredCents * 60) / expectedMinutes) : null;
  const reserveEstimateCents = percentOf(offeredCents, reservePercent);
  return {
    effectiveHourlyCents,
    reserveEstimateCents,
    planningAmountCents: offeredCents - reserveEstimateCents,
    note: "Planning estimate only — not guaranteed take-home pay or a tax calculation.",
  };
}

const TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  considering: ["accepted", "scheduled", "declined", "completed"],
  accepted: ["scheduled", "completed", "declined", "considering"],
  scheduled: ["completed", "declined", "accepted"],
  completed: ["scheduled"], // correction: un-complete (only if unpaid — enforced in the service)
  declined: ["considering", "accepted"],
};

export function canTransition(from: OpportunityStatus, to: OpportunityStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Opportunities that count toward expected (projected) income. */
export function isProjected(status: OpportunityStatus): boolean {
  return status === "accepted" || status === "scheduled";
}

import { addDays, addMonths, type ISODate } from "./time";

export type Recurrence = "none" | "weekly" | "biweekly" | "monthly" | "yearly";

/** Next occurrence after `due`. Monthly/yearly keep the anchor day (31st → Feb 28 → Mar 31). */
export function nextOccurrence(due: ISODate, recurrence: Recurrence, anchorDay?: number | null): ISODate | null {
  switch (recurrence) {
    case "none":
      return null;
    case "weekly":
      return addDays(due, 7);
    case "biweekly":
      return addDays(due, 14);
    case "monthly":
      return addMonths(due, 1, anchorDay ?? undefined);
    case "yearly":
      return addMonths(due, 12, anchorDay ?? undefined);
  }
}

/** Occurrences of a bill from `due` up to and including `until`. */
export function occurrencesUntil(due: ISODate, recurrence: Recurrence, until: ISODate, anchorDay?: number | null, max = 60): ISODate[] {
  const out: ISODate[] = [];
  let d: ISODate | null = due;
  while (d && d <= until && out.length < max) {
    out.push(d);
    d = nextOccurrence(d, recurrence, anchorDay);
  }
  return out;
}

/** Monthly-equivalent amount, for "how much do my bills cost per month". */
export function monthlyEquivalent(amountCents: number, recurrence: Recurrence): number {
  switch (recurrence) {
    case "weekly":
      return Math.round((amountCents * 52) / 12);
    case "biweekly":
      return Math.round((amountCents * 26) / 12);
    case "monthly":
      return amountCents;
    case "yearly":
      return Math.round(amountCents / 12);
    case "none":
      return 0;
  }
}

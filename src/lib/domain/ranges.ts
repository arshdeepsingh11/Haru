import { addDays, addMonths, endOfMonth, type ISODate, isISODate, startOfMonth, startOfWeek, splitDate } from "./time";

export type RangePreset = "today" | "this_week" | "last_week" | "this_month" | "last_month" | "next_30_days" | "custom";

export interface DateRange {
  start: ISODate;
  end: ISODate;
  label: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLabel(d: ISODate): string {
  const { year, month } = splitDate(d);
  return `${MONTHS[month - 1]} ${year}`;
}

export function resolveRange(preset: RangePreset, today: ISODate, weekStartsOn = 1, custom?: { start?: string; end?: string }): DateRange {
  switch (preset) {
    case "today":
      return { start: today, end: today, label: "Today" };
    case "this_week": {
      const s = startOfWeek(today, weekStartsOn);
      return { start: s, end: addDays(s, 6), label: "This week" };
    }
    case "last_week": {
      const s = addDays(startOfWeek(today, weekStartsOn), -7);
      return { start: s, end: addDays(s, 6), label: "Last week" };
    }
    case "this_month":
      return { start: startOfMonth(today), end: endOfMonth(today), label: monthLabel(today) };
    case "last_month": {
      const s = addMonths(startOfMonth(today), -1, 1);
      return { start: s, end: endOfMonth(s), label: monthLabel(s) };
    }
    case "next_30_days":
      return { start: today, end: addDays(today, 29), label: "Next 30 days" };
    case "custom": {
      if (!custom?.start || !custom?.end || !isISODate(custom.start) || !isISODate(custom.end))
        throw new Error("Custom ranges need start and end dates (YYYY-MM-DD).");
      if (custom.end < custom.start) throw new Error("The end date is before the start date.");
      return { start: custom.start, end: custom.end, label: `${custom.start} → ${custom.end}` };
    }
  }
}

/** The equally long range immediately before `r` (for "compare with last month"). */
export function previousRange(r: DateRange, preset: RangePreset): DateRange {
  if (preset === "this_month" || preset === "last_month") {
    const s = addMonths(r.start, -1, 1);
    return { start: s, end: endOfMonth(s), label: monthLabel(s) };
  }
  const len = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86400e3) + 1;
  return { start: addDays(r.start, -len), end: addDays(r.start, -1), label: "Previous period" };
}

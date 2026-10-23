import { z } from "zod";

// One set of schemas validates manual forms (server actions) and AI tool calls.
// Money is entered in currency units (dollars) and converted to cents server-side.

export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Calendar date, YYYY-MM-DD, in the user's time zone");
export const zTime = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM").describe("24-hour local time HH:MM");
export const zId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid id");
export const zMoney = z.number().finite().min(0).max(10_000_000).describe("Amount in currency units, e.g. 115.50");
export const zPositiveMoney = z.number().finite().gt(0).max(10_000_000).describe("Amount in currency units, e.g. 115.50");
const zText = (max: number) => z.string().trim().min(1).max(max);
const zNotes = z.string().trim().max(1000);

export const zPayFrequency = z.enum(["weekly", "biweekly", "semimonthly", "monthly"]);
export const zWeekendRule = z.enum(["none", "previous_business_day", "next_business_day"]);
export const zScheduleEntry = z.object({
  weekday: z.number().int().min(0).max(6).describe("0 = Sunday … 6 = Saturday"),
  start: zTime,
  end: zTime,
  break_minutes: z.number().int().min(0).max(600).optional(),
});

export const JobCreate = z.object({
  employer: zText(120).describe("Employer name, e.g. 'Northgate Security'"),
  title: z.string().trim().max(120).optional().describe("Job title, e.g. 'Security guard'"),
  hourly_rate: zPositiveMoney.describe("Hourly wage in currency units"),
  wage_effective_from: zDate.optional(),
  status: z.enum(["active", "paused", "ended"]).optional(),
  start_date: zDate.optional(),
  expected_weekly_hours: z.number().min(0).max(168).optional(),
  pay_frequency: zPayFrequency.optional(),
  period_anchor_date: zDate.optional().describe("First day of any one pay period (required for weekly/biweekly)"),
  semimonthly_split_day: z.number().int().min(1).max(27).optional().describe("Legacy: prefer period_start_days"),
  period_start_days: z.array(z.number().int().min(1).max(28)).min(1).max(2).optional().describe("Twice a month: days pay periods start, e.g. [10, 25]. Monthly: [1]"),
  pay_days: z.array(z.number().int().min(1).max(31)).min(1).max(2).optional().describe("Twice a month / monthly: calendar pay days, e.g. [15, 30]; 31 = last day of month"),
  payday_offset_days: z.number().int().min(0).max(31).optional().describe("Days after the period ends that pay arrives"),
  payday_weekend_rule: zWeekendRule.optional(),
  deduction_percent: z.number().min(0).max(99).optional().describe("Known payroll deductions as % of gross, only if the user states it"),
  deduction_fixed: zMoney.optional().describe("Known fixed deduction per paycheck, only if the user states it"),
  regular_schedule: z.array(zScheduleEntry).max(21).optional(),
  notes: zNotes.optional(),
});
export type JobCreate = z.infer<typeof JobCreate>;

export const JobUpdate = JobCreate.partial().extend({ job_id: zId });
export type JobUpdate = z.infer<typeof JobUpdate>;

export const ShiftCreate = z.object({
  job_id: zId,
  date: zDate,
  start: zTime.optional(),
  end: zTime.optional(),
  break_minutes: z.number().int().min(0).max(600).optional().describe("Unpaid break minutes"),
  hours: z.number().gt(0).max(24).optional().describe("Paid hours, when start/end are not given"),
  status: z.enum(["completed", "scheduled"]).optional().describe("completed = worked; scheduled = upcoming"),
  additional: z.boolean().optional().describe("true only when the user confirms this is an extra shift on a day that already has one logged"),
  notes: zNotes.optional(),
});
export type ShiftCreate = z.infer<typeof ShiftCreate>;

export const ShiftUpdate = z.object({
  shift_id: zId,
  date: zDate.optional(),
  start: zTime.optional(),
  end: zTime.optional(),
  break_minutes: z.number().int().min(0).max(600).optional(),
  hours: z.number().gt(0).max(24).optional(),
  status: z.enum(["completed", "scheduled", "cancelled", "missed"]).optional(),
  hourly_rate: zPositiveMoney.optional().describe("Only to correct the rate recorded for THIS shift"),
  notes: zNotes.optional(),
});
export type ShiftUpdate = z.infer<typeof ShiftUpdate>;

export const OpportunityCreate = z.object({
  name: zText(120).describe("Who/what, e.g. 'Restaurant shift'"),
  offered_amount: zMoney,
  pay_basis: z.enum(["gross", "net", "unknown"]).optional().describe("Whether the offer is before or after deductions; 'unknown' unless stated"),
  expected_hours: z.number().gt(0).max(24).optional(),
  date: zDate.optional(),
  start: zTime.optional(),
  end: zTime.optional(),
  status: z.enum(["considering", "accepted", "scheduled"]).optional(),
  notes: zNotes.optional(),
});
export type OpportunityCreate = z.infer<typeof OpportunityCreate>;

export const OpportunityStatusUpdate = z.object({
  opportunity_id: zId,
  status: z.enum(["considering", "accepted", "scheduled", "completed", "declined"]),
  actual_hours: z.number().gt(0).max(24).optional(),
  earned_amount: zMoney.optional().describe("What was actually earned, if different from the offer"),
  date: zDate.optional(),
});
export type OpportunityStatusUpdate = z.infer<typeof OpportunityStatusUpdate>;

export const RecordIncome = z.object({
  amount: zPositiveMoney,
  date: zDate,
  account_id: zId.optional(),
  description: z.string().trim().max(200).optional(),
  opportunity_id: zId.optional().describe("Set when this is payment for a one-time job"),
  category: z.string().trim().max(60).optional(),
});

export const ExpenseCreate = z.object({
  amount: zPositiveMoney,
  date: zDate,
  category: z.string().trim().min(1).max(60).describe("e.g. groceries, transport, dining, rent, bills, other"),
  description: z.string().trim().max(200).optional(),
  account_id: zId.optional(),
});
export type ExpenseCreate = z.infer<typeof ExpenseCreate>;

export const TransferCreate = z.object({
  from_account_id: zId,
  to_account_id: zId,
  amount: zPositiveMoney,
  date: zDate,
  description: z.string().trim().max(200).optional(),
});

export const AccountCreate = z.object({
  name: zText(80),
  kind: z.enum(["checking", "savings", "cash", "other"]).optional(),
  current_balance: z.number().finite().min(-10_000_000).max(100_000_000).optional().describe("Balance today, as the user states it"),
});

export const SetBalance = z.object({
  account_id: zId,
  balance: z.number().finite().min(-10_000_000).max(100_000_000),
  date: zDate,
});

export const BillCreate = z.object({
  name: zText(120),
  amount: zPositiveMoney,
  due_date: zDate.describe("Next due date"),
  recurrence: z.enum(["none", "weekly", "biweekly", "monthly", "yearly"]).optional(),
  category: z.string().trim().max(60).optional(),
  account_id: zId.optional(),
  notes: zNotes.optional(),
});
export type BillCreate = z.infer<typeof BillCreate>;

export const BillUpdate = BillCreate.partial().extend({ bill_id: zId, status: z.enum(["active", "archived"]).optional() });

export const BillPaid = z.object({
  bill_id: zId,
  paid_on: zDate,
  amount: zPositiveMoney.optional().describe("Only if different from the bill amount"),
  account_id: zId.optional(),
});

export const PaycheckReceived = z.object({
  job_id: zId,
  amount_received: zPositiveMoney.describe("Net amount that actually arrived"),
  received_on: zDate,
  pay_date: zDate.optional().describe("Which payday this was, if not the most recent"),
  gross_amount: zMoney.optional().describe("Gross on the pay stub, if the user knows it"),
  account_id: zId.optional(),
});

export const DebtCreate = z.object({
  name: zText(120).describe("e.g. 'Loan from Sam'"),
  creditor: z.string().trim().max(120).optional(),
  balance: zPositiveMoney.describe("Amount currently owed"),
  interest_rate_percent: z.number().min(0).max(100).optional(),
  minimum_payment: zMoney.optional(),
  notes: zNotes.optional(),
});

export const DebtPayment = z.object({
  debt_id: zId,
  amount: zPositiveMoney,
  date: zDate,
  account_id: zId.optional(),
});

export const GoalCreate = z.object({
  name: zText(120),
  target_amount: zPositiveMoney,
  target_date: zDate.optional(),
  monthly_target: zPositiveMoney.optional().describe("e.g. 'save $1000 every month'"),
  already_saved: zMoney.optional(),
});

export const GoalContribution = z.object({
  goal_id: zId,
  amount: z.number().finite().refine((x) => x !== 0, "Amount cannot be zero").describe("Positive to set aside, negative to withdraw"),
  date: zDate,
  note: z.string().trim().max(200).optional(),
});

export const ReminderCreate = z.object({
  title: zText(140),
  body: z.string().trim().max(400).optional(),
  date: zDate,
  time: zTime,
  category: z.enum(["shift", "log_hours", "payday", "bill", "goal", "opportunity", "custom"]).optional(),
});

export const PrefsUpdate = z.object({
  display_name: z.string().trim().max(60).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  timezone: z.string().min(3).max(64).optional(),
  week_starts_on: z.number().int().min(0).max(6).optional(),
  reserve_percent: z.number().min(0).max(100).optional(),
  notify_enabled: z.boolean().optional(),
  notify_categories: z.record(z.string(), z.boolean()).optional(),
  shift_lead_minutes: z.number().int().min(0).max(1440).optional(),
  log_hours_time: zTime.optional(),
  bill_lead_days: z.number().int().min(0).max(14).optional(),
  bill_notify_time: zTime.optional(),
  payday_notify_time: zTime.optional(),
});
export type PrefsUpdate = z.infer<typeof PrefsUpdate>;

export const RangeInput = z.object({
  period: z.enum(["today", "this_week", "last_week", "this_month", "last_month", "next_30_days", "custom"]),
  start: zDate.optional(),
  end: zDate.optional(),
});

export const ShiftAttendance = z.object({
  shift_id: zId,
  going: z.boolean().describe("true = the user will go to this shift; false = they can't make it"),
});

export const ShiftCheckout = z.object({
  shift_id: zId,
  full: z.boolean().optional().describe("Worked the whole scheduled shift"),
  hours: z.number().gt(0).max(24).optional().describe("Paid hours actually worked, when not the full shift"),
  missed: z.boolean().optional().describe("Did not work it at all"),
});

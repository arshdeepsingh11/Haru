import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as V from "../src/lib/validation";

// The AI receives JSON Schema generated from the same Zod schemas that validate its calls.
// These tests prove the conversion works and that acceptance-test phrasings validate.

const toSpec = (s: z.ZodType) => {
  const js = z.toJSONSchema(s, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
};

test("every tool input schema converts to an object JSON Schema", () => {
  const schemas = Object.entries(V).filter(([, v]) => v instanceof z.ZodObject) as [string, z.ZodObject][];
  assert.ok(schemas.length >= 20);
  for (const [name, s] of schemas) {
    const js = toSpec(s);
    assert.equal(js.type, "object", `${name} must be an object schema`);
    assert.ok(js.properties, `${name} has properties`);
  }
  const shift = toSpec(V.ShiftCreate) as { required: string[]; properties: Record<string, { description?: string; pattern?: string }> };
  assert.deepEqual(shift.required.sort(), ["date", "job_id"]);
  assert.match(shift.properties.date.description ?? "", /YYYY-MM-DD/);
});

const JOB = "6f1c2a9e-4b7d-4c1e-9f3a-2b8d7e6c5a41";

test("Test A: 'I worked 6 hours at my security job today' → valid create_shift args", () => {
  const r = V.ShiftCreate.safeParse({ job_id: JOB, date: "2026-10-22", hours: 6 });
  assert.ok(r.success);
  assert.equal(V.ShiftCreate.safeParse({ job_id: JOB, date: "today", hours: 6 }).success, false);
  assert.equal(V.ShiftCreate.safeParse({ job_id: "security", date: "2026-10-22", hours: 6 }).success, false);
  assert.equal(V.ShiftCreate.safeParse({ job_id: JOB, date: "2026-10-22", hours: 30 }).success, false);
});

test("4 PM–11 PM with 30-min break → valid times", () => {
  assert.ok(V.ShiftCreate.safeParse({ job_id: JOB, date: "2026-10-22", start: "16:00", end: "23:00", break_minutes: 30 }).success);
  assert.equal(V.ShiftCreate.safeParse({ job_id: JOB, date: "2026-10-22", start: "4 PM", end: "23:00" }).success, false);
});

test("Test B: one-time offer validates and never needs a job id", () => {
  const r = V.OpportunityCreate.safeParse({ name: "Restaurant shift", offered_amount: 100, expected_hours: 6, date: "2026-10-24" });
  assert.ok(r.success);
  assert.equal("job_id" in V.OpportunityCreate.shape, false);
});

test("Test D: expense validates; negative or zero amounts are rejected", () => {
  assert.ok(V.ExpenseCreate.safeParse({ amount: 42, date: "2026-10-22", category: "groceries" }).success);
  assert.equal(V.ExpenseCreate.safeParse({ amount: -42, date: "2026-10-22", category: "groceries" }).success, false);
  assert.equal(V.ExpenseCreate.safeParse({ amount: 0, date: "2026-10-22", category: "groceries" }).success, false);
});

test("bill, goal, debt, reminder phrasings from the brief validate", () => {
  assert.ok(V.BillCreate.safeParse({ name: "Phone", amount: 115, due_date: "2026-10-25", recurrence: "monthly" }).success);
  assert.ok(V.BillCreate.safeParse({ name: "Rent", amount: 600, due_date: "2026-11-01", recurrence: "monthly" }).success);
  assert.ok(V.GoalCreate.safeParse({ name: "Savings", target_amount: 5000 }).success);
  assert.ok(V.GoalCreate.safeParse({ name: "Monthly saving", target_amount: 12000, monthly_target: 1000 }).success);
  assert.ok(V.DebtCreate.safeParse({ name: "Loan from friend", balance: 6400 }).success);
  assert.ok(V.ReminderCreate.safeParse({ title: "Confirm tomorrow's shift", date: "2026-10-23", time: "09:00" }).success);
  assert.equal(V.ReminderCreate.safeParse({ title: "x", date: "2026-10-23", time: "25:00" }).success, false);
});

test("Test C/E: report period input", () => {
  assert.ok(V.RangeInput.safeParse({ period: "this_week" }).success);
  assert.equal(V.RangeInput.safeParse({ period: "fortnight" }).success, false);
});

test("job pay rules: unknown deductions are optional, bad frequencies rejected", () => {
  assert.ok(V.JobCreate.safeParse({ employer: "Northgate Security", hourly_rate: 20, pay_frequency: "biweekly", period_anchor_date: "2026-10-05", payday_offset_days: 5 }).success);
  assert.equal(V.JobCreate.safeParse({ employer: "X", hourly_rate: 20, pay_frequency: "fortnightly" }).success, false);
  assert.equal(V.JobCreate.safeParse({ employer: "", hourly_rate: 20 }).success, false);
});

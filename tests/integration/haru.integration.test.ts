// End-to-end tests of HARU's server layer against a real, migrated PostgreSQL database.
//   HARU_TEST_DATABASE_URL=postgres://... npm run test:integration
// Uses throwaway users; never point this at production.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = process.env.HARU_TEST_DATABASE_URL;
process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public";
process.env.VAPID_PRIVATE_KEY = "test-private";
process.env.VAPID_SUBJECT = "mailto:test@example.com";

const skip = !process.env.HARU_TEST_DATABASE_URL;

const { sql } = await import("../../src/lib/server/db");
const { ctxForUser } = await import("../../src/lib/server/user-context");
const jobs = await import("../../src/lib/server/services/jobs");
const shifts = await import("../../src/lib/server/services/shifts");
const opps = await import("../../src/lib/server/services/opportunities");
const payroll = await import("../../src/lib/server/services/payroll");
const fin = await import("../../src/lib/server/services/finance");
const reports = await import("../../src/lib/server/services/reports");
const dash = await import("../../src/lib/server/services/dashboard");
const reminders = await import("../../src/lib/server/services/reminders");
const obs = await import("../../src/lib/server/services/observations");
const sched = await import("../../src/lib/server/notifications/scheduler");
const { applyUndo } = await import("../../src/lib/server/undo");
const agent = await import("../../src/lib/ai/agent");
const { AppError } = await import("../../src/lib/server/errors");
const { addDays, weekdayOf } = await import("../../src/lib/domain/time");
import type { ChatProvider, ChatResponse } from "../../src/lib/ai/provider";
import type { Ctx } from "../../src/lib/server/user-context";

declare global {
  // Populated by the test double for web-push.
  var __pushCalls: { endpoint: string; payload: { tag: string } }[];
}

const A = randomUUID();
const B = randomUUID();
let a: Ctx;
let b: Ctx;
let securityId = "";
let cafeId = "";
let chequingId = "";

async function makeUser(id: string) {
  await sql`insert into app_users (id, email) values (${id}, ${`${id}@test.local`})`;
  await sql`insert into user_preferences (user_id, display_name, onboarded_at) values (${id}, 'Tester', now())`;
  return ctxForUser(id);
}
const cash = async (ctx: Ctx) => (await fin.listAccounts(ctx)).reduce((s, x) => s + x.balance_cents, 0);

/** A scripted stand-in for the model: each step sees the conversation and returns blocks. */
function scripted(steps: ((msgs: Parameters<ChatProvider["chat"]>[0]["messages"]) => ChatResponse)[]): ChatProvider {
  let i = 0;
  return { name: "scripted", chat: async (req) => steps[Math.min(i++, steps.length - 1)](req.messages) };
}
const say = (text: string): ChatResponse => ({ content: [{ type: "text", text }], stopReason: "end" });
const call = (name: string, input: unknown): ChatResponse => ({ content: [{ type: "tool_call", id: `t${Math.random()}`, name, input }], stopReason: "tool_use" });

before(async () => {
  if (skip) return;
  a = await makeUser(A);
  b = await makeUser(B);
});

test("setup: jobs with independent payroll rules (biweekly + semimonthly)", { skip }, async () => {
  const anchor = addDays(a.today, -((weekdayOf(a.today) + 6) % 7) - 14); // a Monday two weeks back
  const s = await jobs.createJob(a, { employer: "Northgate Security", title: "Guard", hourly_rate: 20, pay_frequency: "biweekly", period_anchor_date: anchor, payday_offset_days: 5 }, "user");
  securityId = (s.data as { id: string }).id;
  const c = await jobs.createJob(a, { employer: "Bean Cafe", hourly_rate: 16.5, pay_frequency: "semimonthly", payday_offset_days: 0, payday_weekend_rule: "previous_business_day" }, "user");
  cafeId = (c.data as { id: string }).id;
  const acct = await fin.createAccount(a, { name: "Chequing", kind: "checking", current_balance: 1000 }, "user");
  chequingId = (acct.data as { id: string }).id;
  assert.equal(await cash(a), 100000);
});

test("Test A + H: logging a shift computes earnings and does NOT change cash", { skip }, async () => {
  const r = await shifts.createShift(a, { job_id: securityId, date: a.today, start: "08:00", end: "15:00", break_minutes: 30 }, "ai");
  const s = r.data as { paid_minutes: number; gross_cents: number; rate_cents: number };
  assert.equal(s.paid_minutes, 390);
  assert.equal(s.gross_cents, 13000);
  assert.equal(s.rate_cents, 2000);
  assert.equal(await cash(a), 100000, "cash unchanged by work");
  // Same day again without saying it's additional → asks instead of double-logging
  await assert.rejects(shifts.createShift(a, { job_id: securityId, date: a.today, hours: 6.5 }, "ai"), (e: unknown) => e instanceof AppError && e.code === "possible_duplicate");
});

test("wage change keeps historical shift earnings", { skip }, async () => {
  await jobs.updateJob(a, { job_id: securityId, hourly_rate: 22, wage_effective_from: addDays(a.today, 1) }, "user");
  const [s] = await shifts.listShifts(a, { start: a.today, end: a.today, jobId: securityId });
  assert.equal(s.rate_cents, 2000);
  assert.equal(s.gross_cents, 13000);
});

test("scheduled shift is completed (not duplicated) when work is logged", { skip }, async () => {
  const y = addDays(a.today, -1);
  await shifts.createShift(a, { job_id: cafeId, date: y, status: "completed", hours: 4 }, "user");
  const tomorrow = addDays(a.today, 1);
  await shifts.createShift(a, { job_id: cafeId, date: tomorrow, status: "scheduled", start: "10:00", end: "14:00" }, "user");
  const rows = await shifts.listShifts(a, { start: tomorrow, end: tomorrow, jobId: cafeId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "scheduled");
  await assert.rejects(shifts.createShift(a, { job_id: cafeId, date: tomorrow, hours: 4 }, "user"), /future/);
});

test("Test B: one-time work is an opportunity, not a job; $100/6h = $16.67/h, $5 reserve", { skip }, async () => {
  const before = (await jobs.listJobs(a)).length;
  const r = await opps.createOpportunity(a, { name: "Restaurant shift", offered_amount: 100, expected_hours: 6, date: addDays(a.today, 2) }, "ai");
  const d = r.data as { effectiveHourlyCents: number; reserveEstimateCents: number; planningAmountCents: number; status: string };
  assert.equal(d.effectiveHourlyCents, 1667);
  assert.equal(d.reserveEstimateCents, 500);
  assert.equal(d.planningAmountCents, 9500);
  assert.equal(d.status, "considering");
  assert.equal((await jobs.listJobs(a)).length, before, "no job created");
  assert.match(r.summary, /not guaranteed take-home/);
});

test("one-time work: accepted ≠ earned; completed ≠ paid; paid once", { skip }, async () => {
  const r = await opps.createOpportunity(a, { name: "Event setup", offered_amount: 120, expected_hours: 5, date: addDays(a.today, -1), status: "accepted" }, "user");
  const id = (r.data as { id: string }).id;
  let d = await dash.getDashboard(a);
  const earnedBefore = d.earnings.weekCents + d.earnings.monthCents;
  await opps.updateOpportunityStatus(a, { opportunity_id: id, status: "completed" }, "user");
  d = await dash.getDashboard(a);
  assert.ok(d.earnings.monthCents + d.earnings.weekCents > earnedBefore, "counts as earned once completed");
  assert.ok(d.position.earnedUnpaidCents >= 12000, "earned but unpaid");
  const cashBefore = await cash(a);
  await fin.recordIncome(a, { amount: 120, date: a.today, opportunity_id: id }, "user");
  assert.equal(await cash(a), cashBefore + 12000);
  await assert.rejects(fin.recordIncome(a, { amount: 120, date: a.today, opportunity_id: id }, "user"), /duplicate|unique|already/i);
});

test("Test C: per-job payday forecasts from saved rules, with uncertainty", { skip }, async () => {
  const f = await payroll.forecastAll(a);
  assert.equal(f.length, 2);
  for (const x of f) {
    assert.ok(x.configured && x.period && x.forecast);
    assert.ok(x.period!.payDate >= a.today);
    assert.ok(x.forecast!.uncertainty.some((u) => /deductions are unknown/.test(u)));
  }
  assert.notEqual(f[0].period!.payDate === f[1].period!.payDate && f[0].period!.start === f[1].period!.start, true);
});

test("Test D: expense updates spending, not earnings", { skip }, async () => {
  const before = await dash.getDashboard(a);
  await fin.recordExpense(a, { amount: 42, date: a.today, category: "groceries" }, "ai");
  const after = await dash.getDashboard(a);
  assert.equal(after.earnings.weekCents, before.earnings.weekCents);
  assert.equal(after.position.cashCents, before.position.cashCents - 4200);
  assert.equal(after.spending.monthCents, before.spending.monthCents + 4200);
});

test("Test H: paycheck deposits once and links its shifts; transfers are neutral", { skip }, async () => {
  // Log a shift in a period that has already been paid out, then receive that paycheck.
  const f = (await payroll.forecastAll(a)).find((x) => x.jobId === securityId)!;
  const prevStart = addDays(f.period!.start, -14);
  await shifts.createShift(a, { job_id: securityId, date: prevStart, hours: 8 }, "user");
  const c0 = await cash(a);
  const r = await payroll.recordPaycheck(a, { job_id: securityId, amount_received: 140, received_on: a.today, pay_date: addDays(addDays(prevStart, 13), 5) }, "user");
  assert.equal(await cash(a), c0 + 14000);
  assert.match(r.summary, /deductions/);
  await assert.rejects(payroll.recordPaycheck(a, { job_id: securityId, amount_received: 140, received_on: a.today, pay_date: addDays(addDays(prevStart, 13), 5) }, "user"));
  const [linked] = await sql<{ n: number }[]>`select count(*)::int as n from shifts where user_id = ${A} and paycheck_id is not null`;
  assert.equal(linked.n, 1);
  // Undo restores everything
  await applyUndo(sql, A, r.undo!);
  assert.equal(await cash(a), c0);
  const [unlinked] = await sql<{ n: number }[]>`select count(*)::int as n from shifts where user_id = ${A} and paycheck_id is not null`;
  assert.equal(unlinked.n, 0);
  // Transfer
  const sav = await fin.createAccount(a, { name: "Savings", kind: "savings", current_balance: 0 }, "user");
  const c1 = await cash(a);
  await fin.recordTransfer(a, { from_account_id: chequingId, to_account_id: (sav.data as { id: string }).id, amount: 300, date: a.today }, "user");
  assert.equal(await cash(a), c1);
  const rep = await reports.generateReport(a, "this_month");
  assert.equal(rep.spending.byCategory.some((c) => c.category === "transfer"), false);
});

test("bills: pay once per occurrence, recurring advances, undo restores", { skip }, async () => {
  const bill = await fin.createBill(a, { name: "Phone", amount: 115, due_date: addDays(a.today, 1), recurrence: "monthly" }, "ai");
  const id = (bill.data as { id: string }).id;
  let d = await dash.getDashboard(a);
  assert.ok(d.attention.some((x) => x.title.startsWith("Phone")), "due tomorrow is prominent");
  assert.ok(d.position.reservedForObligationsCents >= 11500);
  const paid = await fin.markBillPaid(a, { bill_id: id, paid_on: a.today }, "ai");
  const [row] = await sql<{ next_due_date: string }[]>`select next_due_date from bills where id = ${id}`;
  assert.ok(row.next_due_date > addDays(a.today, 20));
  await applyUndo(sql, A, paid.undo!);
  const [row2] = await sql<{ next_due_date: string }[]>`select next_due_date from bills where id = ${id}`;
  assert.equal(row2.next_due_date, addDays(a.today, 1));
  d = await dash.getDashboard(a);
  assert.ok(d.bills.some((x) => x.id === id));
});

test("goals and debts: allocation is not spending; debt payments reduce debt", { skip }, async () => {
  const g = await fin.createGoal(a, { name: "Emergency fund", target_amount: 5000, already_saved: 200 }, "ai");
  const c0 = await cash(a);
  await fin.contributeToGoal(a, { goal_id: (g.data as { id: string }).id, amount: 50, date: a.today }, "user");
  assert.equal(await cash(a), c0);
  const debt = await fin.createDebt(a, { name: "Loan from friend", balance: 6400 }, "ai");
  await fin.recordDebtPayment(a, { debt_id: (debt.data as { id: string }).id, amount: 400, date: a.today }, "user");
  const d = await dash.getDashboard(a);
  assert.equal(d.position.debtCents, 600000);
  assert.equal(d.position.allocatedToGoalsCents, 25000);
  assert.equal(d.position.safeToAllocateCents, d.position.cashCents - d.position.reservedForObligationsCents - 25000);
});

test("Test E: weekly report separates earned, received and projected", { skip }, async () => {
  const r = await reports.generateReport(a, "this_week");
  assert.ok(r.earned.totalGrossCents >= 13000);
  assert.equal(typeof r.received.totalCents, "number");
  assert.match(r.projected.label, /Projection/);
  const cmp = await reports.compareReports(a, "this_month");
  assert.ok(cmp.previous.range.end < cmp.current.range.start);
});

test("Test I: user isolation through services and the AI tool layer", { skip }, async () => {
  await assert.rejects(jobs.getJob(b, securityId), /not found/i);
  await assert.rejects(shifts.createShift(b, { job_id: securityId, date: b.today, hours: 2 }, "ai"), /not found/i);
  await assert.rejects(fin.recordExpense(b, { amount: 1, date: b.today, category: "x", account_id: chequingId }, "ai"), /not found/i);
  const bd = await dash.getDashboard(b);
  assert.equal(bd.isEmpty, true);
  assert.equal(bd.jobs.length, 0);
  assert.equal(bd.position.cashCents, 0);
  // Through the agent: B's model tries to use A's job id
  const t = await agent.runTurn(b, { text: "log 2 hours" }, { provider: scripted([() => call("create_shift", { job_id: securityId, date: b.today, hours: 2 }), () => say("I couldn't find that job.")]) });
  assert.equal(t.changed, false);
  assert.equal(t.assistant.actions[0].status, "failed");
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from shifts where user_id = ${B}`;
  assert.equal(n.n, 0);
});

test("AI agent: tool call writes real records, persists conversation, supports undo", { skip }, async () => {
  const before = await cash(a);
  const t = await agent.runTurn(a, { text: "I spent $18.50 on lunch today" }, {
    provider: scripted([() => call("create_expense", { amount: 18.5, date: a.today, category: "dining" }), () => say("Recorded $18.50 for lunch.")]),
  });
  assert.equal(t.changed, true);
  assert.equal(t.assistant.actions[0].status, "completed");
  assert.equal(await cash(a), before - 1850);
  const conv = await agent.getConversation(a, t.conversationId);
  assert.equal(conv.messages.length, 2);
  const undone = await agent.resolveAction(a, t.assistant.actions[0].id, "undo");
  assert.equal(undone.action.status, "undone");
  assert.equal(await cash(a), before);
  await assert.rejects(agent.resolveAction(a, t.assistant.actions[0].id, "undo"));
  await assert.rejects(agent.resolveAction(b, t.assistant.actions[0].id, "undo"), /no longer exists/);
});

test("AI agent: invalid arguments are rejected before touching data", { skip }, async () => {
  const t = await agent.runTurn(a, { text: "spent minus ten" }, {
    provider: scripted([() => call("create_expense", { amount: -10, date: "yesterday", category: "x" }), (msgs) => {
      const last = msgs[msgs.length - 1].content[0] as { content: string; isError?: boolean };
      assert.equal(last.isError, true);
      assert.match(last.content, /Invalid arguments/);
      return say("Could you tell me the amount and date?");
    }]),
  });
  assert.equal(t.changed, false);
});

test("AI agent: consequential actions wait for confirmation; double-confirm is safe", { skip }, async () => {
  const [s] = await shifts.listShifts(a, { start: a.today, end: a.today, jobId: securityId });
  const t = await agent.runTurn(a, { text: "delete today's security shift" }, {
    provider: scripted([() => call("delete_shift", { shift_id: s.id }), () => say("This will delete the shift — confirm below.")]),
  });
  const act = t.assistant.actions[0];
  assert.equal(act.status, "pending_confirmation");
  assert.ok((await shifts.listShifts(a, { start: a.today, end: a.today, jobId: securityId })).length === 1, "not deleted yet");
  const ok = await agent.resolveAction(a, act.id, "confirm");
  assert.equal(ok.action.status, "completed");
  assert.equal((await shifts.listShifts(a, { start: a.today, end: a.today, jobId: securityId })).length, 0);
  await assert.rejects(agent.resolveAction(a, act.id, "confirm"), /already handled/);
  await agent.resolveAction(a, act.id, "undo"); // re-inserts the shift
  assert.equal((await shifts.listShifts(a, { start: a.today, end: a.today, jobId: securityId })).length, 1);
});

test("Test J: provider failure is reported honestly and changes nothing", { skip }, async () => {
  const before = await cash(a);
  const failing: ChatProvider = { name: "down", chat: async () => { const { ProviderUnavailable } = await import("../../src/lib/ai/provider"); throw new ProviderUnavailable("The AI service is unavailable right now."); } };
  const t = await agent.runTurn(a, { text: "I spent $5" }, { provider: failing });
  assert.equal(t.assistant.error, true);
  assert.match(t.assistant.content, /Nothing was changed/);
  assert.equal(await cash(a), before);
});

test("AI tool layer: every tool's JSON schema is generated and the dashboard tool reads real data", { skip }, async () => {
  const { toolSpecs } = await import("../../src/lib/ai/tools");
  const specs = toolSpecs();
  assert.ok(specs.length >= 35);
  assert.ok(specs.every((s) => s.inputSchema.type === "object"));
  const t = await agent.runTurn(a, { text: "how am I doing?" }, {
    provider: scripted([() => call("get_dashboard_summary", {}), (msgs) => {
      const r = JSON.parse((msgs[msgs.length - 1].content[0] as { content: string }).content);
      assert.equal(r.ok, true);
      assert.match(r.data.money.cash_manually_tracked, /\$/);
      return say("Here's where you stand.");
    }]),
  });
  assert.equal(t.changed, false);
});

test("Test F: reminders are durable, delivered by the server, exactly once", { skip }, async () => {
  globalThis.__pushCalls = [];
  await sql`update user_preferences set notify_enabled = true where user_id = ${A}`;
  a = await ctxForUser(A);
  await sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values
    (${A}, 'https://push.example/ok-1', 'p256dh-key-xxxxx', 'auth-xxxx'),
    (${A}, 'https://push.example/gone-1', 'p256dh-key-xxxxx', 'auth-xxxx')`;
  // A custom reminder that is already due
  const r = await reminders.createReminder(a, { title: "Confirm tomorrow's shift", date: a.today, time: "00:00" }, "ai").catch(async () => {
    // "00:00 today" may be in the past — create one due one minute from now and backdate it in SQL
    return reminders.createReminder(a, { title: "Confirm tomorrow's shift", date: addDays(a.today, 1), time: "09:00" }, "ai");
  });
  const rid = (r.data as { id: string }).id;
  await sql`update reminders set fire_at = now() - interval '1 minute' where id = ${rid}`;
  // An upcoming scheduled shift → the planner creates an automatic reminder
  const first = await sched.runScheduler();
  assert.ok(first.planned >= 1, "planner created automatic reminders");
  const [rem] = await sql<{ status: string }[]>`select status from reminders where id = ${rid}`;
  assert.equal(rem.status, "sent");
  const deliveries = await sql<{ status: string }[]>`select status from notification_deliveries where reminder_id = ${rid} order by status`;
  assert.deepEqual(deliveries.map((d) => d.status), ["accepted", "gone"]);
  const [subs] = await sql<{ n: number }[]>`select count(*)::int as n from push_subscriptions where user_id = ${A}`;
  assert.equal(subs.n, 1, "expired subscription removed");
  const sentFor = globalThis.__pushCalls.filter((c) => c.payload.tag === rid).length;
  // Second and third runs must not resend
  await sched.runScheduler();
  await sched.runScheduler();
  assert.equal(globalThis.__pushCalls.filter((c) => c.payload.tag === rid).length, sentFor);
  // Planner is idempotent
  const [auto] = await sql<{ n: number }[]>`select count(*)::int as n from reminders where user_id = ${A} and origin = 'auto'`;
  await sched.runScheduler();
  const [auto2] = await sql<{ n: number }[]>`select count(*)::int as n from reminders where user_id = ${A} and origin = 'auto'`;
  assert.equal(auto2.n, auto.n);
});

test("Test F: retry on push-service outage, then give up; stale reminders expire", { skip }, async () => {
  await sql`delete from push_subscriptions where user_id = ${A}`;
  await sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (${A}, 'https://push.example/down-1', 'p256dh-key-xxxxx', 'auth-xxxx')`;
  const r = await reminders.createReminder(a, { title: "Retry me", date: addDays(a.today, 1), time: "09:00" }, "user");
  const id = (r.data as { id: string }).id;
  await sql`update reminders set fire_at = now() - interval '1 minute' where id = ${id}`;
  await sched.runScheduler();
  let [x] = await sql<{ status: string; next_attempt_at: Date | null; attempts: number }[]>`select status, next_attempt_at, attempts from reminders where id = ${id}`;
  assert.equal(x.status, "pending");
  assert.ok(x.next_attempt_at && x.next_attempt_at.getTime() > Date.now());
  for (let i = 0; i < 4; i++) {
    await sql`update reminders set next_attempt_at = now() - interval '1 second' where id = ${id} and status = 'pending'`;
    await sched.runScheduler();
  }
  [x] = await sql<{ status: string; next_attempt_at: Date | null; attempts: number }[]>`select status, next_attempt_at, attempts from reminders where id = ${id}`;
  assert.equal(x.status, "failed");
  // Stale
  const s = await reminders.createReminder(a, { title: "Old", date: addDays(a.today, 1), time: "09:00" }, "user");
  await sql`update reminders set fire_at = now() - interval '13 hours' where id = ${(s.data as { id: string }).id}`;
  await sched.runScheduler();
  const [y] = await sql<{ status: string }[]>`select status from reminders where id = ${(s.data as { id: string }).id}`;
  assert.equal(y.status, "expired");
});

test("Test G: everything persists — a fresh context sees the same data", { skip }, async () => {
  const fresh = await ctxForUser(A);
  const d = await dash.getDashboard(fresh);
  assert.ok(d.jobs.length === 2 && d.bills.length >= 1 && d.goals.length === 1);
  const convs = await agent.listConversations(fresh);
  assert.ok(convs.length >= 4);
  await obs.refreshObservations(fresh);
});

test("regular schedule materialises once", { skip }, async () => {
  const wd = weekdayOf(addDays(a.today, 2));
  await jobs.updateJob(a, { job_id: cafeId, regular_schedule: [{ weekday: wd, start: "09:00", end: "13:00" }] }, "user");
  const n1 = await shifts.materializeSchedules(a, 7);
  const n2 = await shifts.materializeSchedules(a, 7);
  assert.equal(n1, 1);
  assert.equal(n2, 0);
});

test("cleanup: deleting the account removes every row", { skip }, async () => {
  await sql`delete from app_users where id in (${A}, ${B})`;
  const [r] = await sql<{ n: number }[]>`select (select count(*) from shifts where user_id = ${A}) + (select count(*) from ai_messages where user_id = ${A}) + (select count(*) from transactions where user_id = ${A}) as n`;
  assert.equal(r.n, 0);
});

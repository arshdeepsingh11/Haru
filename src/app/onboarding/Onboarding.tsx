"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, Loader2, Sparkles } from "lucide-react";
import { act, finishOnboarding } from "@/app/actions";
import { LogoMark } from "@/components/Wordmark";
import { enablePush } from "@/lib/push-client";

// HARU's interview. One question at a time, tap to answer.
// It never asks monthly income: money comes from jobs × rates × schedule.

type Freq = "weekly" | "biweekly" | "semimonthly" | "monthly";
interface Job {
  employer: string;
  rate: string;
  freq: Freq | "";
  nextPayday: string;
  paidAfter: string; // days after period end (weekly/biweekly)
  payDays: [string, string];
  startDays: [string, string];
  monthlyDay: string;
  days: number[];
  start: string;
  end: string;
  brk: string;
  noSchedule: boolean;
}
interface Debt {
  kind: string;
  name: string;
  balance: string;
  apr: string;
  min: string;
}
interface Saving {
  name: string;
  target: string;
  by: string;
}
interface Expense {
  key: string;
  label: string;
  amount: string;
  freq: "weekly" | "biweekly" | "monthly";
  dueDay: string;
}

const GOALS = [
  { key: "card", label: "Pay off a credit card", debt: true, name: "Credit card" },
  { key: "loan", label: "Pay off a loan", debt: true, name: "Loan" },
  { key: "person", label: "Pay someone back", debt: true, name: "Money I owe" },
  { key: "emergency", label: "Build an emergency fund", debt: false, name: "Emergency fund" },
  { key: "save", label: "Save for something", debt: false, name: "Savings" },
];
const EXPENSES: { key: string; label: string; freq: Expense["freq"] }[] = [
  { key: "rent", label: "Rent", freq: "monthly" },
  { key: "phone", label: "Phone", freq: "monthly" },
  { key: "internet", label: "Internet", freq: "monthly" },
  { key: "groceries", label: "Groceries", freq: "weekly" },
  { key: "gas", label: "Gas", freq: "weekly" },
  { key: "car", label: "Car payment", freq: "monthly" },
  { key: "insurance", label: "Car insurance", freq: "monthly" },
  { key: "utilities", label: "Utilities", freq: "monthly" },
  { key: "transit", label: "Transit pass", freq: "monthly" },
  { key: "subs", label: "Subscriptions", freq: "monthly" },
  { key: "gym", label: "Gym", freq: "monthly" },
  { key: "food", label: "Eating out", freq: "weekly" },
];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const newJob = (): Job => ({ employer: "", rate: "", freq: "", nextPayday: "", paidAfter: "5", payDays: ["15", "30"], startDays: ["1", "16"], monthlyDay: "1", days: [], start: "16:00", end: "23:00", brk: "30", noSchedule: false });

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}
function addDays(s: string, n: number) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
function nextDayOfMonth(today: string, day: number) {
  const [y, m] = today.split("-").map(Number);
  for (let k = 0; k < 2; k++) {
    const dim = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
    const d = iso(new Date(Date.UTC(y, m - 1 + k, Math.min(day, dim), 12)));
    if (d >= today) return d;
  }
  return today;
}
const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

type Step =
  | { id: "name" }
  | { id: "goals" }
  | { id: "goal"; i: number }
  | { id: "jobcount" }
  | { id: "job"; i: number }
  | { id: "pay"; i: number }
  | { id: "schedule"; i: number }
  | { id: "expenses" }
  | { id: "amounts" }
  | { id: "cash" }
  | { id: "tax" }
  | { id: "notify" }
  | { id: "build" };

export function Onboarding({ today, defaults, vapidPublicKey }: { today: string; defaults: { name: string; currency: string; timezone: string }; vapidPublicKey: string | null }) {
  const [name, setName] = useState(defaults.name);
  const [goalKeys, setGoalKeys] = useState<string[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [savings, setSavings] = useState<Saving[]>([]);
  const [jobCount, setJobCount] = useState(1);
  const [jobs, setJobs] = useState<Job[]>([newJob()]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [cash, setCash] = useState("");
  const [tax, setTax] = useState("5");
  const [notify, setNotify] = useState<"on" | "later" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [log, setLog] = useState<{ q: string; a: string }[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const goalItems = useMemo(() => goalKeys.map((k) => GOALS.find((g) => g.key === k)!), [goalKeys]);
  const steps: Step[] = useMemo(() => {
    const s: Step[] = [{ id: "name" }, { id: "goals" }];
    goalItems.forEach((_, i) => s.push({ id: "goal", i }));
    s.push({ id: "jobcount" });
    for (let i = 0; i < jobCount; i++) s.push({ id: "job", i }, { id: "pay", i }, { id: "schedule", i });
    s.push({ id: "expenses" });
    if (expenses.length) s.push({ id: "amounts" });
    s.push({ id: "cash" }, { id: "tax" }, { id: "notify" }, { id: "build" });
    return s;
  }, [goalItems, jobCount, expenses.length]);
  const step = steps[Math.min(cursor, steps.length - 1)];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [cursor]);

  const job = (i: number) => jobs[i] ?? newJob();
  const setJob = (i: number, patch: Partial<Job>) => setJobs((js) => js.map((j, k) => (k === i ? { ...j, ...patch } : j)));

  function next(q: string, a: string) {
    setError(null);
    setLog((l) => [...l, { q, a }]);
    setCursor((c) => c + 1);
  }
  function fail(msg: string) {
    setError(msg);
    return false;
  }

  const first = name.trim() || "there";

  // ---------------------------------------------------------------- questions
  const Q: Record<Step["id"], () => { q: string; body: ReactNode; onNext?: () => void; nextLabel?: string }> = {
    name: () => ({
      q: "Hey, I'm HARU. I'll set everything up by asking a few quick questions. What should I call you?",
      body: <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />,
      onNext: () => (name.trim() ? next("name", name.trim()) : fail("Tell me what to call you.")),
    }),
    goals: () => ({
      q: `Nice to meet you, ${first}. What do you want to get done? Pick everything that fits.`,
      body: (
        <div className="flex flex-wrap gap-2">
          {GOALS.map((g) => (
            <button key={g.key} type="button" className="choice" aria-pressed={goalKeys.includes(g.key)} onClick={() => setGoalKeys((k) => (k.includes(g.key) ? k.filter((x) => x !== g.key) : [...k, g.key]))}>
              {g.label}
            </button>
          ))}
        </div>
      ),
      onNext: () => {
        setDebts(goalItems.filter((g) => g.debt).map((g) => ({ kind: g.key, name: g.name, balance: "", apr: "", min: "" })));
        setSavings(goalItems.filter((g) => !g.debt).map((g) => ({ name: g.name, target: "", by: "" })));
        next("goals", goalItems.length ? goalItems.map((g) => g.label).join(", ") : "Nothing specific yet");
      },
    }),
    goal: () => {
      const i = (step as { i: number }).i;
      const g = goalItems[i];
      const di = goalItems.slice(0, i).filter((x) => x.debt).length;
      const si = goalItems.slice(0, i).filter((x) => !x.debt).length;
      if (g.debt) {
        const d = debts[di] ?? { kind: g.key, name: g.name, balance: "", apr: "", min: "" };
        const set = (p: Partial<Debt>) => setDebts((ds) => ds.map((x, k) => (k === di ? { ...x, ...p } : x)));
        return {
          q: `${g.label}: tell me about it. Interest and minimum payment help me decide what to pay first.`,
          body: (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field">
                Name it
                <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={g.key === "card" ? "Visa" : g.name} />
              </label>
              <label className="field">
                How much is left?
                <input className="input" inputMode="decimal" autoFocus value={d.balance} onChange={(e) => set({ balance: e.target.value })} placeholder="2000" />
              </label>
              <label className="field">
                Interest rate % (if any)
                <input className="input" inputMode="decimal" value={d.apr} onChange={(e) => set({ apr: e.target.value })} placeholder={g.key === "card" ? "22.99" : "0"} />
              </label>
              <label className="field">
                Minimum monthly payment
                <input className="input" inputMode="decimal" value={d.min} onChange={(e) => set({ min: e.target.value })} placeholder="60" />
              </label>
            </div>
          ),
          onNext: () => (Number(d.balance) > 0 ? next(g.label, `${d.name || g.name}: $${d.balance}${d.apr ? ` at ${d.apr}%` : ""}`) : fail("How much is left on it?")),
        };
      }
      const sv = savings[si] ?? { name: g.name, target: "", by: "" };
      const set = (p: Partial<Saving>) => setSavings((ss) => ss.map((x, k) => (k === si ? { ...x, ...p } : x)));
      return {
        q: `${g.label}: how much, and by when?`,
        body: (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="field">
              Name it
              <input className="input" value={sv.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="field">
              Amount
              <input className="input" inputMode="decimal" autoFocus value={sv.target} onChange={(e) => set({ target: e.target.value })} placeholder="5000" />
            </label>
            <label className="field">
              By (optional)
              <input className="input" type="date" min={today} value={sv.by} onChange={(e) => set({ by: e.target.value })} />
            </label>
          </div>
        ),
        onNext: () => (Number(sv.target) > 0 ? next(g.label, `$${sv.target}${sv.by ? ` by ${sv.by}` : ""}`) : fail("How much do you want to reach?")),
      };
    },
    jobcount: () => ({
      q: "Now your work. How many jobs do you have right now?",
      body: (
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4].map((n) => (
            <button key={n} type="button" className="choice" aria-pressed={jobCount === n} onClick={() => { setJobCount(n); setJobs((js) => Array.from({ length: n }, (_, k) => js[k] ?? newJob())); }}>
              {n === 4 ? "4+" : n}
            </button>
          ))}
        </div>
      ),
      onNext: () => next("jobs", `${jobCount} job${jobCount > 1 ? "s" : ""}`),
    }),
    job: () => {
      const i = (step as { i: number }).i;
      const j = job(i);
      return {
        q: jobCount > 1 ? `Job ${i + 1} of ${jobCount}: where is it, and what does it pay per hour?` : "Where do you work, and what does it pay per hour?",
        body: (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field">
              Employer
              <input className="input" autoFocus value={j.employer} onChange={(e) => setJob(i, { employer: e.target.value })} placeholder="Northgate Security" />
            </label>
            <label className="field">
              Hourly rate
              <input className="input" inputMode="decimal" value={j.rate} onChange={(e) => setJob(i, { rate: e.target.value })} placeholder="20.00" />
            </label>
          </div>
        ),
        onNext: () => (!j.employer.trim() ? fail("What's the employer called?") : !(Number(j.rate) > 0) ? fail("What's the hourly rate?") : next(`job ${i + 1}`, `${j.employer}, $${j.rate}/h`)),
      };
    },
    pay: () => {
      const i = (step as { i: number }).i;
      const j = job(i);
      return {
        q: `How does ${j.employer || "this job"} pay you?`,
        body: (
          <div className="grid gap-4">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["weekly", "Every week"],
                  ["biweekly", "Every 2 weeks"],
                  ["semimonthly", "Twice a month"],
                  ["monthly", "Once a month"],
                ] as const
              ).map(([f, l]) => (
                <button key={f} type="button" className="choice" aria-pressed={j.freq === f} onClick={() => setJob(i, { freq: f })}>
                  {l}
                </button>
              ))}
            </div>
            {(j.freq === "weekly" || j.freq === "biweekly") && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="field">
                  Your next payday
                  <input className="input" type="date" value={j.nextPayday} min={today} onChange={(e) => setJob(i, { nextPayday: e.target.value })} />
                </label>
                <label className="field">
                  Paid how many days after the pay period ends?
                  <input className="input" type="number" min={0} max={14} value={j.paidAfter} onChange={(e) => setJob(i, { paidAfter: e.target.value })} />
                  <span className="text-xs text-ink-3">Period ends Friday, paid next Wednesday = 5</span>
                </label>
              </div>
            )}
            {j.freq === "semimonthly" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="field">
                  Which days are you paid?
                  <div className="flex items-center gap-2">
                    <input className="input w-20" inputMode="numeric" value={j.payDays[0]} onChange={(e) => setJob(i, { payDays: [e.target.value, j.payDays[1]] })} />
                    and
                    <input className="input w-20" inputMode="numeric" value={j.payDays[1]} onChange={(e) => setJob(i, { payDays: [j.payDays[0], e.target.value] })} />
                  </div>
                  <span className="text-xs text-ink-3">Use 31 for "last day of the month"</span>
                </div>
                <div className="field">
                  Pay periods start on day
                  <div className="flex items-center gap-2">
                    <input className="input w-20" inputMode="numeric" value={j.startDays[0]} onChange={(e) => setJob(i, { startDays: [e.target.value, j.startDays[1]] })} />
                    and
                    <input className="input w-20" inputMode="numeric" value={j.startDays[1]} onChange={(e) => setJob(i, { startDays: [j.startDays[0], e.target.value] })} />
                  </div>
                  <span className="text-xs text-ink-3">Periods 10th–24th and 25th–9th = 10 and 25</span>
                </div>
              </div>
            )}
            {j.freq === "monthly" && (
              <label className="field w-48">
                Day of the month you're paid
                <input className="input" inputMode="numeric" value={j.monthlyDay} onChange={(e) => setJob(i, { monthlyDay: e.target.value })} />
              </label>
            )}
          </div>
        ),
        onNext: () => {
          if (!j.freq) return fail("How often are you paid?");
          if ((j.freq === "weekly" || j.freq === "biweekly") && !j.nextPayday) return fail("When is your next payday?");
          const label =
            j.freq === "semimonthly" ? `Twice a month, on the ${j.payDays[0]} and ${j.payDays[1]}` : j.freq === "monthly" ? `Monthly, on the ${j.monthlyDay}` : `${j.freq === "weekly" ? "Weekly" : "Every 2 weeks"}, next ${j.nextPayday}`;
          next(`pay ${i + 1}`, label);
        },
      };
    },
    schedule: () => {
      const i = (step as { i: number }).i;
      const j = job(i);
      return {
        q: `Which days do you usually work at ${j.employer || "this job"}? I'll put every shift on your calendar and remind you an hour before.`,
        body: (
          <div className="grid gap-4">
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button key={d} type="button" className="choice" aria-pressed={j.days.includes(d)} onClick={() => setJob(i, { noSchedule: false, days: j.days.includes(d) ? j.days.filter((x) => x !== d) : [...j.days, d] })}>
                  {WD[d]}
                </button>
              ))}
              <button type="button" className="choice" aria-pressed={j.noSchedule} onClick={() => setJob(i, { noSchedule: !j.noSchedule, days: [] })}>
                It changes every week
              </button>
            </div>
            {j.days.length > 0 && (
              <div className="grid grid-cols-3 gap-3">
                <label className="field">
                  Start
                  <input className="input" type="time" value={j.start} onChange={(e) => setJob(i, { start: e.target.value })} />
                </label>
                <label className="field">
                  End
                  <input className="input" type="time" value={j.end} onChange={(e) => setJob(i, { end: e.target.value })} />
                </label>
                <label className="field">
                  Unpaid break (min)
                  <input className="input" type="number" min={0} value={j.brk} onChange={(e) => setJob(i, { brk: e.target.value })} />
                </label>
              </div>
            )}
            {j.noSchedule && <p className="text-sm text-ink-2">No problem. Add shifts in Schedule as you get them, or just tell me.</p>}
          </div>
        ),
        onNext: () =>
          j.days.length || j.noSchedule
            ? next(`schedule ${i + 1}`, j.noSchedule ? "Changes every week" : `${[1, 2, 3, 4, 5, 6, 0].filter((d) => j.days.includes(d)).map((d) => WD[d]).join(", ")}, ${j.start}–${j.end}`)
            : fail("Pick your usual days, or choose \"It changes every week\"."),
      };
    },
    expenses: () => ({
      q: "What do you pay for regularly? Tap everything that applies.",
      body: (
        <div className="flex flex-wrap gap-2">
          {EXPENSES.map((x) => {
            const on = expenses.some((e) => e.key === x.key);
            return (
              <button
                key={x.key}
                type="button"
                className="choice"
                aria-pressed={on}
                onClick={() => setExpenses((es) => (on ? es.filter((e) => e.key !== x.key) : [...es, { key: x.key, label: x.label, amount: "", freq: x.freq, dueDay: "1" }]))}
              >
                {x.label}
              </button>
            );
          })}
        </div>
      ),
      onNext: () => next("expenses", expenses.length ? expenses.map((e) => e.label).join(", ") : "None of these"),
    }),
    amounts: () => ({
      q: "How much is each one, and when is it due?",
      body: (
        <ul className="grid gap-3">
          {expenses.map((e, k) => (
            <li key={e.key} className="grid grid-cols-[1fr_6rem_8rem] items-end gap-2 sm:grid-cols-[10rem_7rem_9rem_7rem]">
              <span className="pb-2.5 font-medium">{e.label}</span>
              <label className="field">
                Amount
                <input className="input" inputMode="decimal" value={e.amount} autoFocus={k === 0} onChange={(ev) => setExpenses((es) => es.map((x, n) => (n === k ? { ...x, amount: ev.target.value } : x)))} />
              </label>
              <label className="field">
                How often
                <select className="input" value={e.freq} onChange={(ev) => setExpenses((es) => es.map((x, n) => (n === k ? { ...x, freq: ev.target.value as Expense["freq"] } : x)))}>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {e.freq === "monthly" && (
                <label className="field col-span-3 sm:col-span-1">
                  Due day
                  <input className="input" inputMode="numeric" value={e.dueDay} onChange={(ev) => setExpenses((es) => es.map((x, n) => (n === k ? { ...x, dueDay: ev.target.value } : x)))} />
                </label>
              )}
            </li>
          ))}
        </ul>
      ),
      onNext: () => (expenses.every((e) => Number(e.amount) > 0) ? next("amounts", expenses.map((e) => `${e.label} $${e.amount}`).join(", ")) : fail("Add an amount for each one (a rough number is fine).")),
    }),
    cash: () => ({
      q: "How much is in your bank account right now? A rough number is fine. It's how I know what's safe to spend.",
      body: <input className="input max-w-xs" inputMode="decimal" autoFocus value={cash} onChange={(e) => setCash(e.target.value)} placeholder="850" />,
      onNext: () => next("cash", cash.trim() ? `$${cash}` : "Skipped"),
      nextLabel: cash.trim() ? "Continue" : "Skip",
    }),
    tax: () => ({
      q: "I'll set aside a tax estimate from every shift so the numbers you see are closer to what you keep. 5% okay?",
      body: (
        <div className="flex flex-wrap items-center gap-2">
          {["5", "10", "15"].map((t) => (
            <button key={t} type="button" className="choice" aria-pressed={tax === t} onClick={() => setTax(t)}>
              {t}%
            </button>
          ))}
          <input className="input w-24" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} aria-label="Custom tax percent" />
        </div>
      ),
      onNext: () => (Number(tax) >= 0 && Number(tax) <= 60 ? next("tax", `${tax}%`) : fail("Pick a percentage between 0 and 60.")),
    }),
    notify: () => ({
      q: "Last thing. Want me to ping you an hour before every shift with what it'll earn, and check in after?",
      body: (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              const r = await enablePush(vapidPublicKey);
              if (r.ok) {
                setNotify("on");
                next("notify", "Yes, notify me");
              } else setError(r.error);
            }}
          >
            <Bell size={16} /> Yes, notify me
          </button>
          <button type="button" className="btn btn-line" onClick={() => { setNotify("later"); next("notify", "Later"); }}>
            Later
          </button>
        </div>
      ),
    }),
    build: () => ({ q: "", body: <Builder tasks={buildTasks} first={first} /> }),
  };

  // ---------------------------------------------------------------- build
  function buildTasks(): BuildTask[] {
    const tasks: BuildTask[] = [];
    tasks.push({
      text: "Saving your preferences",
      run: () => act("updatePrefs", { display_name: name.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || defaults.timezone, reserve_percent: Number(tax) }),
    });
    jobs.slice(0, jobCount).forEach((j) => {
      const rate = Number(j.rate);
      const len = j.freq === "weekly" ? 7 : 14;
      const payload: Record<string, unknown> = {
        employer: j.employer.trim(),
        hourly_rate: rate,
        pay_frequency: j.freq,
        regular_schedule: j.days.map((d) => ({ weekday: d, start: j.start, end: j.end, break_minutes: Number(j.brk) || 0 })),
      };
      if (j.freq === "weekly" || j.freq === "biweekly") {
        const periodEnd = addDays(j.nextPayday, -(Number(j.paidAfter) || 0));
        payload.period_anchor_date = addDays(periodEnd, -(len - 1));
        payload.payday_offset_days = Number(j.paidAfter) || 0;
      } else if (j.freq === "semimonthly") {
        payload.pay_days = j.payDays.map(Number);
        payload.period_start_days = j.startDays.map((x) => Math.min(28, Number(x)));
      } else if (j.freq === "monthly") {
        payload.pay_days = [Number(j.monthlyDay)];
        payload.period_start_days = [1];
      }
      tasks.push({ text: `Adding ${j.employer} and its shifts`, run: () => act("createJob", payload) });
    });
    debts.forEach((d) =>
      tasks.push({ text: `Tracking ${d.name}`, run: () => act("createDebt", { name: d.name, balance: Number(d.balance), interest_rate_percent: num(d.apr), minimum_payment: num(d.min) }) }),
    );
    savings.forEach((s) => tasks.push({ text: `Creating your ${s.name} goal`, run: () => act("createGoal", { name: s.name, target_amount: Number(s.target), target_date: s.by || undefined }) }));
    expenses.forEach((e) => {
      const due = e.freq === "monthly" ? nextDayOfMonth(today, Math.min(31, Number(e.dueDay) || 1)) : addDays(today, e.freq === "weekly" ? 7 : 14);
      tasks.push({ text: `Adding ${e.label}`, run: () => act("createBill", { name: e.label, amount: Number(e.amount), due_date: due, recurrence: e.freq, category: e.key === "groceries" || e.key === "food" ? "food" : "bills" }) });
    });
    if (cash.trim()) tasks.push({ text: "Setting your bank balance", run: () => act("createAccount", { name: "Bank account", kind: "checking", current_balance: Number(cash) }) });

    if (notify === "on") tasks.push({ text: "Turning on shift reminders", run: () => act("updatePrefs", { notify_enabled: true, shift_lead_minutes: 60 }) });
    return tasks;
  }

  const cur = Q[step.id]();
  const progress = Math.round((Math.min(cursor, steps.length - 1) / (steps.length - 1)) * 100);

  return (
    <main className="mx-auto grid min-h-dvh max-w-2xl content-start gap-6 px-4 py-8 sm:py-12">
      <div className="flex items-center gap-3">
        <LogoMark size={34} />
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/60">
          <div className="h-full rounded-full bg-gradient-to-r from-violet to-violet-2 transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>
        <span className="figure text-xs text-ink-3">{progress}%</span>
      </div>

      <ol className="grid gap-3" aria-label="Your answers so far">
        {log.map((l, k) => (
          <li key={k} className="flex justify-end">
            <span className="rounded-2xl rounded-br-md bg-gradient-to-br from-violet to-violet-2 px-4 py-2 text-sm text-white shadow-lg shadow-violet/20">{l.a}</span>
          </li>
        ))}
      </ol>

      <form
        className="glass sheet-enter grid gap-4 p-5 sm:p-7"
        key={cursor}
        onSubmit={(e) => {
          e.preventDefault();
          cur.onNext?.();
        }}
      >
        {cur.q && (
          <div className="flex gap-3">
            <LogoMark size={26} />
            <p className="text-lg font-medium leading-snug">{cur.q}</p>
          </div>
        )}
        {cur.body}
        {error && (
          <p role="alert" className="text-sm text-brick">
            {error}
          </p>
        )}
        {cur.onNext && (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary">{cur.nextLabel ?? "Continue"}</button>
            {cursor > 0 && step.id !== "build" && (
              <button type="button" className="btn btn-quiet" onClick={() => { setCursor((c) => c - 1); setLog((l) => l.slice(0, -1)); setError(null); }}>
                Back
              </button>
            )}
          </div>
        )}
      </form>
      <div ref={endRef} />
    </main>
  );
}

type BuildTask = { text: string; run: () => Promise<{ ok: boolean; error?: string }> };

function Builder({ tasks, first }: { tasks: () => BuildTask[]; first: string }) {
  const [lines, setLines] = useState<{ text: string; ok: boolean | null }[]>([]);
  const [done, setDone] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      for (const t of tasks()) {
        setLines((l) => [...l, { text: t.text, ok: null }]);
        const r = await t.run().catch(() => ({ ok: false, error: "Network error" }));
        setLines((l) => l.map((x, k) => (k === l.length - 1 ? { text: r.ok ? x.text : `${x.text}: ${r.error ?? "failed"}`, ok: r.ok } : x)));
      }
      await finishOnboarding();
      setDone(true);
    })();
  }, [tasks]);
  return (
    <div className="grid gap-3">
      <p className="text-lg font-semibold">{done ? `You're all set, ${first}.` : "Building your dashboard…"}</p>
      <ul className="grid gap-1.5 text-sm">
        {lines.map((l, k) => (
          <li key={k} className={`flex items-center gap-2 ${l.ok === false ? "text-brick" : ""}`}>
            {l.ok == null ? <Loader2 size={14} className="animate-spin text-violet" /> : l.ok ? <Check size={14} className="text-violet" /> : <span>!</span>}
            {l.text}
          </li>
        ))}
      </ul>
      {done && (
        <button className="btn btn-primary w-fit" onClick={() => (window.location.href = "/")}>
          <Sparkles size={16} /> Show me my money
        </button>
      )}
    </div>
  );
}

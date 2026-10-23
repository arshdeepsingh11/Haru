"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { loadRecords, type RecordsData } from "@/app/actions";
import type { ActionKind } from "@/app/actions";
import { dayLabel, dayLabelInline, Empty, hours, Sheet, useAct, useMoney } from "./ui";

const TABS = [
  { key: "jobs", label: "Jobs" },
  { key: "shifts", label: "Shifts" },
  { key: "money", label: "Money" },
  { key: "bills", label: "Bills" },
  { key: "goals", label: "Goals & debt" },
  { key: "work", label: "One-time work" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---- form helpers: read FormData into typed values, dropping empty fields
function vals(fd: FormData) {
  const o: Record<string, string> = {};
  fd.forEach((v, k) => {
    if (typeof v === "string" && v.trim() !== "") o[k] = v.trim();
  });
  return o;
}
const num = (s?: string) => (s == null ? undefined : Number(s));

function useForm() {
  const { run, pending } = useAct();
  const submit = (kind: ActionKind, build: (v: Record<string, string>) => unknown, after?: () => void) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    run(kind, build(vals(new FormData(form))), (r) => {
      if (r.ok) {
        form.reset();
        after?.();
      }
    });
  };
  return { submit, pending };
}

function F({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      {label}
      {children}
    </label>
  );
}

function Fold({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
        <Plus size={15} aria-hidden /> {title}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export function RecordsSheet({ open, onClose, initialTab }: { open: boolean; onClose: () => void; initialTab?: string | null }) {
  const [tab, setTab] = useState<Tab>("jobs");
  const [data, setData] = useState<RecordsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setData(await loadRecords());
    } catch {
      setError("Couldn't load your records. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    if (open) {
      if (initialTab && TABS.some((t) => t.key === initialTab)) setTab(initialTab as Tab);
      refresh();
    }
  }, [open, initialTab, refresh]);

  return (
    <Sheet open={open} onClose={onClose} title="Records" wide>
      <div role="tablist" aria-label="Record types" className="scroll-thin -mx-1 mb-5 flex gap-1 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`btn shrink-0 ${tab === t.key ? "btn-primary" : "btn-quiet"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="text-brick">{error}</p>
      ) : !data ? (
        <p className="flex items-center gap-2 text-ink-3">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </p>
      ) : (
        <div role="tabpanel" className="grid gap-4">
          {tab === "jobs" && <Jobs d={data} done={refresh} />}
          {tab === "shifts" && <Shifts d={data} done={refresh} />}
          {tab === "money" && <Money d={data} done={refresh} />}
          {tab === "bills" && <Bills d={data} done={refresh} />}
          {tab === "goals" && <Goals d={data} done={refresh} />}
          {tab === "work" && <Work d={data} done={refresh} />}
        </div>
      )}
    </Sheet>
  );
}

type P = { d: RecordsData; done: () => void };

// ------------------------------------------------------------------ jobs
type Job = RecordsData["jobs"][number];

function JobForm({ job, done }: { job?: Job; done: () => void }) {
  const { submit, pending } = useForm();
  const [freq, setFreq] = useState(job?.pay_frequency ?? "");
  const [schedule, setSchedule] = useState<{ weekday: number; start: string; end: string; break_minutes?: number }[]>(job?.regular_schedule ?? []);
  const build = (v: Record<string, string>) => {
    const base = {
      employer: v.employer,
      title: v.title,
      hourly_rate: num(v.hourly_rate),
      wage_effective_from: v.wage_effective_from,
      start_date: v.start_date,
      expected_weekly_hours: num(v.expected_weekly_hours),
      pay_frequency: v.pay_frequency,
      period_anchor_date: v.period_anchor_date,
      semimonthly_split_day: num(v.semimonthly_split_day),
      payday_offset_days: num(v.payday_offset_days),
      payday_weekend_rule: v.payday_weekend_rule,
      deduction_percent: num(v.deduction_percent),
      deduction_fixed: num(v.deduction_fixed),
      regular_schedule: schedule,
      notes: v.notes,
      status: v.status,
    };
    if (!job) return base;
    // Only send what changed — a wage is sent only when it differs (it adds wage history).
    const out: Record<string, unknown> = { job_id: job.id };
    for (const [k, val] of Object.entries(base)) if (val !== undefined) out[k] = val;
    if (job.current_rate_cents != null && out.hourly_rate === job.current_rate_cents / 100) delete out.hourly_rate;
    if (JSON.stringify(schedule) === JSON.stringify(job.regular_schedule)) delete out.regular_schedule;
    return out;
  };
  return (
    <form onSubmit={submit(job ? "updateJob" : "createJob", build, done)} className="grid gap-3 sm:grid-cols-2">
      <F label="Employer">
        <input className="input" name="employer" required defaultValue={job?.employer} />
      </F>
      <F label="Job title (optional)">
        <input className="input" name="title" defaultValue={job?.title ?? ""} />
      </F>
      <F label="Hourly wage">
        <input className="input" name="hourly_rate" inputMode="decimal" required={!job} defaultValue={job?.current_rate_cents != null ? (job.current_rate_cents / 100).toFixed(2) : ""} />
      </F>
      <F label={job ? "New wage applies from" : "Started on (optional)"}>
        <input className="input" type="date" name={job ? "wage_effective_from" : "start_date"} />
      </F>
      <F label="How often you're paid">
        <select className="input" name="pay_frequency" value={freq} onChange={(e) => setFreq(e.target.value as never)}>
          <option value="">Not sure yet</option>
          <option value="weekly">Weekly</option>
          <option value="biweekly">Every two weeks</option>
          <option value="semimonthly">Twice a month</option>
          <option value="monthly">Monthly</option>
        </select>
      </F>
      {(freq === "weekly" || freq === "biweekly") && (
        <F label="First day of any one pay period">
          <input className="input" type="date" name="period_anchor_date" required defaultValue={job?.period_anchor_date ?? ""} />
        </F>
      )}
      {freq === "semimonthly" && (
        <F label="First period ends on day">
          <input className="input" type="number" min={1} max={27} name="semimonthly_split_day" defaultValue={job?.semimonthly_split_day ?? 15} />
        </F>
      )}
      {freq && (
        <>
          <F label="Pay arrives this many days after the period ends">
            <input className="input" type="number" min={0} max={31} name="payday_offset_days" defaultValue={job?.payday_offset_days ?? 0} />
          </F>
          <F label="If payday falls on a weekend">
            <select className="input" name="payday_weekend_rule" defaultValue={job?.payday_weekend_rule ?? "none"}>
              <option value="none">Still that day</option>
              <option value="previous_business_day">Friday before</option>
              <option value="next_business_day">Monday after</option>
            </select>
          </F>
        </>
      )}
      <F label="Known deductions, % of gross (optional)">
        <input className="input" name="deduction_percent" inputMode="decimal" defaultValue={job?.deduction_percent ?? ""} />
      </F>
      <F label="Expected hours per week (optional)">
        <input className="input" name="expected_weekly_hours" inputMode="decimal" defaultValue={job?.expected_weekly_minutes != null ? job.expected_weekly_minutes / 60 : ""} />
      </F>
      {job && (
        <F label="Status">
          <select className="input" name="status" defaultValue={job.status}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="ended">Ended</option>
          </select>
        </F>
      )}
      <fieldset className="grid gap-2 sm:col-span-2">
        <legend className="text-sm text-ink-2">Regular schedule (optional — HARU adds these as upcoming shifts)</legend>
        {schedule.map((s, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <select aria-label="Day" className="input w-24" value={s.weekday} onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>
              {WEEKDAYS.map((w, n) => (
                <option key={w} value={n}>{w}</option>
              ))}
            </select>
            <input aria-label="Start" type="time" className="input w-32" value={s.start} onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
            <input aria-label="End" type="time" className="input w-32" value={s.end} onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
            <input aria-label="Unpaid break minutes" type="number" min={0} className="input w-24" placeholder="Break" value={s.break_minutes ?? ""} onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, break_minutes: e.target.value ? Number(e.target.value) : undefined } : x)))} />
            <button type="button" className="btn btn-quiet px-2" aria-label="Remove day" onClick={() => setSchedule(schedule.filter((_, j) => j !== i))}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-line w-fit text-xs" onClick={() => setSchedule([...schedule, { weekday: 1, start: "09:00", end: "17:00" }])}>
          <Plus size={13} /> Add a day
        </button>
      </fieldset>
      <button className="btn btn-primary sm:col-span-2" disabled={pending}>
        {job ? "Save job" : "Add job"}
      </button>
    </form>
  );
}

function Jobs({ d, done }: P) {
  const money = useMoney();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      {d.jobs.length === 0 && <Empty>No jobs yet.</Empty>}
      {d.jobs.map((j) => (
        <div key={j.id} className="rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">
                {j.employer} {j.title && <span className="font-normal text-ink-2">({j.title})</span>}
                {j.status !== "active" && <span className="chip chip-slate ml-2">{j.status}</span>}
              </p>
              <p className="text-sm text-ink-2">
                {money(j.current_rate_cents)}/h, {j.pay_frequency ? { weekly: "paid weekly", biweekly: "paid every two weeks", semimonthly: "paid twice a month", monthly: "paid monthly" }[j.pay_frequency] : "pay schedule not set"}
              </p>
            </div>
            <button className="btn btn-quiet px-2" aria-label={`Edit ${j.employer}`} onClick={() => setEditing(editing === j.id ? null : j.id)}>
              <Pencil size={15} />
            </button>
          </div>
          {editing === j.id && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="mb-3 text-xs text-ink-3">Changing the wage adds it to wage history; shifts already logged keep the rate they were paid at.</p>
              <JobForm job={j} done={() => { setEditing(null); done(); }} />
            </div>
          )}
        </div>
      ))}
      <Fold title="Add a job" defaultOpen={d.jobs.length === 0}>
        <JobForm done={done} />
      </Fold>
    </>
  );
}

// ------------------------------------------------------------------ shifts
function Shifts({ d, done }: P) {
  const money = useMoney();
  const { submit, pending } = useForm();
  const { run } = useAct();
  const [mode, setMode] = useState<"times" | "hours">("times");
  const [editing, setEditing] = useState<string | null>(null);
  if (d.jobs.length === 0) return <Empty>Add a job first, then log shifts for it.</Empty>;
  return (
    <>
      <Fold title="Log or schedule a shift" defaultOpen>
        <form
          onSubmit={submit("createShift", (v) => ({ job_id: v.job_id, date: v.date, status: v.status, start: mode === "times" ? v.start : undefined, end: mode === "times" ? v.end : undefined, hours: mode === "hours" ? num(v.hours) : undefined, break_minutes: num(v.break_minutes), notes: v.notes }), done)}
          className="grid gap-3 sm:grid-cols-2"
        >
          <F label="Job">
            <select className="input" name="job_id" required>
              {d.jobs.filter((j) => j.status !== "ended").map((j) => (
                <option key={j.id} value={j.id}>{j.employer}</option>
              ))}
            </select>
          </F>
          <F label="Date">
            <input className="input" type="date" name="date" required defaultValue={d.today} />
          </F>
          <F label="This shift">
            <select className="input" name="status" defaultValue="completed">
              <option value="completed">Worked</option>
              <option value="scheduled">Is coming up</option>
            </select>
          </F>
          <F label="Enter">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as "times" | "hours")}>
              <option value="times">Start and end times</option>
              <option value="hours">Paid hours</option>
            </select>
          </F>
          {mode === "times" ? (
            <>
              <F label="Start"><input className="input" type="time" name="start" required /></F>
              <F label="End"><input className="input" type="time" name="end" required /></F>
              <F label="Unpaid break (minutes)"><input className="input" type="number" min={0} name="break_minutes" /></F>
            </>
          ) : (
            <F label="Paid hours"><input className="input" name="hours" inputMode="decimal" required /></F>
          )}
          <button className="btn btn-primary sm:col-span-2" disabled={pending}>Save shift</button>
        </form>
      </Fold>
      <ul className="divide-y divide-line">
        {d.shifts.length === 0 && <Empty>No shifts in the last 45 days.</Empty>}
        {d.shifts.map((s) => (
          <li key={s.id} className="py-2.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {s.job_name}
                  <span className={`chip ml-2 ${s.status === "completed" ? "chip-moss" : s.status === "scheduled" ? "chip-slate" : "chip-brick"}`}>{s.status === "completed" ? (s.paid ? "paid" : "worked") : s.status}</span>
                </p>
                <p className="text-sm text-ink-2">
                  {dayLabel(s.work_date, d.today)}
                  {s.start ? `, ${s.start}–${s.end}` : ""}, {hours(s.paid_minutes)} at {money(s.rate_cents)}/h
                </p>
              </div>
              <span className="figure font-semibold">{money(s.gross_cents)}</span>
              <button className="btn btn-quiet px-2" aria-label="Edit shift" onClick={() => setEditing(editing === s.id ? null : s.id)}>
                <Pencil size={14} />
              </button>
              <button className="btn btn-quiet px-2" aria-label="Delete shift" onClick={() => confirm(`Delete the ${s.job_name} shift on ${s.work_date}?`) && run("deleteShift", { shift_id: s.id }, (r) => r.ok && done())}>
                <Trash2 size={14} />
              </button>
            </div>
            {editing === s.id && (
              <form
                className="mt-2 grid gap-2 sm:grid-cols-5"
                onSubmit={submit("updateShift", (v) => ({ shift_id: s.id, date: v.date, start: v.start, end: v.end, break_minutes: num(v.break_minutes), hours: num(v.hours), status: v.status }), () => { setEditing(null); done(); })}
              >
                <F label="Date"><input className="input" type="date" name="date" defaultValue={s.work_date} /></F>
                <F label="Start"><input className="input" type="time" name="start" defaultValue={s.start ?? ""} /></F>
                <F label="End"><input className="input" type="time" name="end" defaultValue={s.end ?? ""} /></F>
                <F label="Break (min)"><input className="input" type="number" min={0} name="break_minutes" defaultValue={s.break_minutes} /></F>
                <F label="Status">
                  <select className="input" name="status" defaultValue={s.status}>
                    <option value="completed">Worked</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="cancelled">Didn't happen</option>
                  </select>
                </F>
                <button className="btn btn-primary sm:col-span-5" disabled={pending}>Save correction</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ money
function Money({ d, done }: P) {
  const money = useMoney();
  const { submit, pending } = useForm();
  const { run } = useAct();
  const accountSelect = (name = "account_id") =>
    d.accounts.length > 0 ? (
      <F label="Account">
        <select className="input" name={name}>
          {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </F>
    ) : null;
  return (
    <>
      <section className="grid gap-2">
        <h3 className="section-title">Accounts</h3>
        <p className="text-xs text-ink-3">Balances are tracked by HARU from what you record. There's no bank connection.</p>
        {d.accounts.map((a) => (
          <form key={a.id} className="flex flex-wrap items-end gap-2 rounded-2xl bg-surface px-4 py-3 ring-1 ring-line" onSubmit={submit("setBalance", (v) => ({ account_id: a.id, balance: num(v.balance), date: d.today }), done)}>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{a.name} {!a.balance_confirmed && <span className="chip chip-amber ml-1">not confirmed</span>}</p>
              <p className="figure text-lg">{money(a.balance_cents)}</p>
            </div>
            <F label="Actual balance today"><input className="input w-36" name="balance" inputMode="decimal" required /></F>
            <button className="btn btn-line" disabled={pending}>Set</button>
          </form>
        ))}
        <Fold title="Add an account" defaultOpen={d.accounts.length === 0}>
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={submit("createAccount", (v) => ({ name: v.name, kind: v.kind, current_balance: num(v.current_balance) }), done)}>
            <F label="Name"><input className="input" name="name" required placeholder="Chequing" /></F>
            <F label="Type">
              <select className="input" name="kind"><option value="checking">Chequing</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="other">Other</option></select>
            </F>
            <F label="Balance today"><input className="input" name="current_balance" inputMode="decimal" /></F>
            <button className="btn btn-primary sm:col-span-3" disabled={pending}>Add account</button>
          </form>
        </Fold>
      </section>

      <Fold title="Record spending">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("recordExpense", (v) => ({ amount: num(v.amount), date: v.date, category: v.category, description: v.description, account_id: v.account_id }), done)}>
          <F label="Amount"><input className="input" name="amount" inputMode="decimal" required /></F>
          <F label="Date"><input className="input" type="date" name="date" required defaultValue={d.today} /></F>
          <F label="Category"><input className="input" name="category" required placeholder="groceries" list="cats" /></F>
          <datalist id="cats">{["groceries", "transport", "dining", "rent", "bills", "health", "shopping", "entertainment", "other"].map((c) => <option key={c} value={c} />)}</datalist>
          <F label="Note (optional)"><input className="input" name="description" /></F>
          {accountSelect()}
          <button className="btn btn-primary sm:col-span-2" disabled={pending}>Save spending</button>
        </form>
      </Fold>

      {d.jobs.length > 0 && (
        <Fold title="A paycheck arrived">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("recordPaycheck", (v) => ({ job_id: v.job_id, amount_received: num(v.amount_received), received_on: v.received_on, gross_amount: num(v.gross_amount), account_id: v.account_id }), done)}>
            <F label="From"><select className="input" name="job_id">{d.jobs.map((j) => <option key={j.id} value={j.id}>{j.employer}</option>)}</select></F>
            <F label="Amount deposited"><input className="input" name="amount_received" inputMode="decimal" required /></F>
            <F label="Arrived on"><input className="input" type="date" name="received_on" required defaultValue={d.today} /></F>
            <F label="Gross on pay stub (optional)"><input className="input" name="gross_amount" inputMode="decimal" /></F>
            {accountSelect()}
            <button className="btn btn-primary sm:col-span-2" disabled={pending}>Record paycheck</button>
          </form>
        </Fold>
      )}

      <Fold title="Other money in">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("recordIncome", (v) => ({ amount: num(v.amount), date: v.date, description: v.description, account_id: v.account_id }), done)}>
          <F label="Amount"><input className="input" name="amount" inputMode="decimal" required /></F>
          <F label="Date"><input className="input" type="date" name="date" required defaultValue={d.today} /></F>
          <F label="What was it?"><input className="input" name="description" placeholder="Refund" /></F>
          {accountSelect()}
          <button className="btn btn-primary sm:col-span-2" disabled={pending}>Save</button>
        </form>
      </Fold>

      {d.accounts.length > 1 && (
        <Fold title="Move money between accounts">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("recordTransfer", (v) => ({ from_account_id: v.from, to_account_id: v.to, amount: num(v.amount), date: v.date }), done)}>
            <F label="From"><select className="input" name="from">{d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></F>
            <F label="To"><select className="input" name="to" defaultValue={d.accounts[1]?.id}>{d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></F>
            <F label="Amount"><input className="input" name="amount" inputMode="decimal" required /></F>
            <F label="Date"><input className="input" type="date" name="date" required defaultValue={d.today} /></F>
            <button className="btn btn-primary sm:col-span-2" disabled={pending}>Move money</button>
          </form>
        </Fold>
      )}

      <section>
        <h3 className="section-title mb-2">Recent activity</h3>
        {d.transactions.length === 0 && <Empty>Nothing recorded in the last 90 days.</Empty>}
        <ul className="divide-y divide-line">
          {d.transactions.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="capitalize">{t.description || t.category || t.type.replace("_", " ")}</p>
                <p className="text-xs text-ink-3">{dayLabel(t.occurred_on, d.today)}, {t.account_name}, {t.type.replace("_", " ")}</p>
              </div>
              <span className={`figure font-semibold ${["income", "paycheck"].includes(t.type) || (t.type === "adjustment" && t.amount_cents > 0) ? "text-moss" : ""}`}>
                {["income", "paycheck"].includes(t.type) ? "+" : t.type === "transfer" ? "" : t.type === "adjustment" ? "" : "−"}
                {money(Math.abs(t.amount_cents))}
              </span>
              {t.type !== "paycheck" && (
                <button className="btn btn-quiet px-2" aria-label="Remove" onClick={() => confirm("Remove this transaction? It stays in history as voided.") && run("voidTransaction", { transaction_id: t.id }, (r) => r.ok && done())}>
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ bills
function Bills({ d, done }: P) {
  const money = useMoney();
  const { submit, pending } = useForm();
  const { run } = useAct();
  return (
    <>
      <Fold title="Add a bill" defaultOpen={d.bills.length === 0}>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("createBill", (v) => ({ name: v.name, amount: num(v.amount), due_date: v.due_date, recurrence: v.recurrence, category: v.category }), done)}>
          <F label="Name"><input className="input" name="name" required placeholder="Phone" /></F>
          <F label="Amount"><input className="input" name="amount" inputMode="decimal" required /></F>
          <F label="Next due date"><input className="input" type="date" name="due_date" required /></F>
          <F label="Repeats">
            <select className="input" name="recurrence" defaultValue="monthly"><option value="none">Doesn't repeat</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
          </F>
          <button className="btn btn-primary sm:col-span-2" disabled={pending}>Add bill</button>
        </form>
      </Fold>
      <ul className="divide-y divide-line">
        {d.bills.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{b.name}</p>
              <p className="text-sm text-ink-2">Due {dayLabelInline(b.next_due_date, d.today)}{b.recurrence !== "none" ? `, ${b.recurrence}` : ""}</p>
            </div>
            <span className="figure font-semibold">{money(b.amount_cents)}</span>
            <button className="btn btn-line text-xs" disabled={pending} onClick={() => run("markBillPaid", { bill_id: b.id, paid_on: d.today }, (r) => r.ok && done())}>Mark paid</button>
            <button className="btn btn-quiet px-2" aria-label={`Stop tracking ${b.name}`} onClick={() => confirm(`Stop tracking ${b.name}? Past payments stay in history.`) && run("updateBill", { bill_id: b.id, status: "archived" }, (r) => r.ok && done())}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ goals & debts
function Goals({ d, done }: P) {
  const money = useMoney();
  const { submit, pending } = useForm();
  return (
    <>
      {d.goals.map((g) => (
        <p key={g.goal_id} className="flex justify-between rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
          <span className="font-medium">{g.name}</span>
          <span className="figure">{money(g.saved_cents)} of {money(g.target_cents)}</span>
        </p>
      ))}
      <Fold title="New savings goal" defaultOpen={d.goals.length === 0}>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("createGoal", (v) => ({ name: v.name, target_amount: num(v.target_amount), target_date: v.target_date, monthly_target: num(v.monthly_target), already_saved: num(v.already_saved) }), done)}>
          <F label="Goal"><input className="input" name="name" required placeholder="Emergency fund" /></F>
          <F label="Target amount"><input className="input" name="target_amount" inputMode="decimal" required /></F>
          <F label="Monthly target (optional)"><input className="input" name="monthly_target" inputMode="decimal" /></F>
          <F label="By (optional)"><input className="input" type="date" name="target_date" /></F>
          <F label="Already set aside (optional)"><input className="input" name="already_saved" inputMode="decimal" /></F>
          <button className="btn btn-primary sm:col-span-2" disabled={pending}>Create goal</button>
        </form>
      </Fold>
      <h3 className="section-title mt-2">Debts</h3>
      {d.debts.map((x) => (
        <form key={x.debt_id} className="flex flex-wrap items-end gap-2 rounded-2xl bg-surface px-4 py-3 ring-1 ring-line" onSubmit={submit("recordDebtPayment", (v) => ({ debt_id: x.debt_id, amount: num(v.amount), date: d.today }), done)}>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{x.name}</p>
            <p className="figure text-sm text-ink-2">{money(x.balance_cents)} left of {money(x.starting_balance_cents)}</p>
          </div>
          <F label="Payment today"><input className="input w-32" name="amount" inputMode="decimal" required /></F>
          <button className="btn btn-line" disabled={pending}>Record</button>
        </form>
      ))}
      <Fold title="Add a debt">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("createDebt", (v) => ({ name: v.name, creditor: v.creditor, balance: num(v.balance), minimum_payment: num(v.minimum_payment) }), done)}>
          <F label="Name"><input className="input" name="name" required placeholder="Loan from Sam" /></F>
          <F label="Owed to (optional)"><input className="input" name="creditor" /></F>
          <F label="Amount owed now"><input className="input" name="balance" inputMode="decimal" required /></F>
          <F label="Minimum payment (optional)"><input className="input" name="minimum_payment" inputMode="decimal" /></F>
          <button className="btn btn-primary sm:col-span-2" disabled={pending}>Add debt</button>
        </form>
      </Fold>
    </>
  );
}

// ------------------------------------------------------------------ one-time work
function Work({ d, done }: P) {
  const money = useMoney();
  const { submit, pending } = useForm();
  return (
    <>
      <p className="text-sm text-ink-2">One-time offers stay separate from your regular jobs. They count as expected income once accepted, and as earnings only once done.</p>
      <Fold title="Track an offer" defaultOpen>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit("createOpportunity", (v) => ({ name: v.name, offered_amount: num(v.offered_amount), expected_hours: num(v.expected_hours), date: v.date, start: v.start, end: v.end, pay_basis: v.pay_basis, status: v.status }), done)}>
          <F label="Who or what"><input className="input" name="name" required placeholder="Restaurant shift" /></F>
          <F label="Amount offered"><input className="input" name="offered_amount" inputMode="decimal" required /></F>
          <F label="Hours"><input className="input" name="expected_hours" inputMode="decimal" /></F>
          <F label="Date"><input className="input" type="date" name="date" /></F>
          <F label="Start (optional)"><input className="input" type="time" name="start" /></F>
          <F label="End (optional)"><input className="input" type="time" name="end" /></F>
          <F label="That amount is">
            <select className="input" name="pay_basis" defaultValue="unknown"><option value="unknown">Not sure</option><option value="gross">Before deductions</option><option value="net">What I'd take home</option></select>
          </F>
          <F label="Status">
            <select className="input" name="status" defaultValue="considering"><option value="considering">Thinking about it</option><option value="accepted">Accepted</option></select>
          </F>
          <button className="btn btn-primary sm:col-span-2" disabled={pending}>Save offer</button>
        </form>
      </Fold>
      <ul className="divide-y divide-line">
        {d.opportunities.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              {o.name} <span className="text-ink-3">{o.work_date ?? ""}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="figure">{money(o.offered_cents)}</span>
              <span className={`chip ${o.status === "completed" ? "chip-moss" : o.status === "declined" ? "chip-brick" : "chip-slate"}`}>{o.paid ? "paid" : o.status}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

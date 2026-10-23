"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { act, loadJobs, type JobsData } from "@/app/actions";
import { anchorFromNextPayday, nextPayPeriod, nextWeekday, validateRule, type PayRule } from "@/lib/domain/payroll";
import { Sheet, useAct, useToast } from "./ui";
import { useRouter } from "next/navigation";

// Jobs & pay: the pay calendar and weekly pattern for each job, set with taps.
// The next payday is shown live, from the same maths the server uses.

type Job = JobsData["jobs"][number];
type Freq = "weekly" | "biweekly" | "semimonthly" | "monthly";
type Entry = { weekday: number; start: string; end: string; break_minutes?: number };

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${WD[new Date(`${d}T12:00:00Z`).getUTCDay()]}, ${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
const ord = (n: number) => (n >= 31 ? "last day" : `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`);

export function JobsSheet({ open, onClose, focusJobId }: { open: boolean; onClose: () => void; focusJobId?: string | null }) {
  const [data, setData] = useState<JobsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const d = await loadJobs();
      setData(d);
      setOpenId((cur) => cur ?? focusJobId ?? d.jobs.find((j) => !j.confirmed)?.id ?? d.jobs[0]?.id ?? null);
    } catch {
      setError("Couldn't load your jobs. Check your connection and try again.");
    }
  }, [focusJobId]);
  useEffect(() => {
    if (open) {
      setOpenId(focusJobId ?? null);
      refresh();
    }
  }, [open, focusJobId, refresh]);

  return (
    <Sheet open={open} onClose={onClose} title="Jobs & pay">
      {error ? (
        <p className="text-brick">{error}</p>
      ) : !data ? (
        <p className="flex items-center gap-2 py-8 text-ink-3">
          <Loader2 size={15} className="animate-spin" /> Loading your jobs…
        </p>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-ink-2">Set how each job pays you and your usual week. Haru counts every shift toward the right paycheck.</p>
          {data.jobs.map((j) =>
            openId === j.id ? (
              <JobEditor key={j.id} job={j} today={data.today} onSaved={refresh} onClose={() => setOpenId(null)} />
            ) : (
              <button key={j.id} className="glass flex items-center gap-3 p-4 text-left" onClick={() => setOpenId(j.id)}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{j.name}</p>
                  <p className="text-sm text-ink-2">{summary(j, data.today)}</p>
                </div>
                {!j.confirmed && <span className="chip chip-amber">Check paydays</span>}
              </button>
            ),
          )}
          {adding ? (
            <NewJob
              onDone={async (ok) => {
                setAdding(false);
                if (ok) {
                  setOpenId(null);
                  const d = await loadJobs();
                  setData(d);
                  setOpenId(d.jobs[d.jobs.length - 1]?.id ?? null);
                }
              }}
            />
          ) : (
            <button className="btn btn-line" onClick={() => setAdding(true)}>
              <Plus size={16} /> Add a job
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

function ruleOf(j: Job): PayRule | null {
  if (!j.payFrequency) return null;
  return { frequency: j.payFrequency, anchorDate: j.anchorDate, splitDay: j.splitDay, periodStartDays: j.periodStartDays, payDays: j.payDays, paydayOffsetDays: j.offsetDays, weekendRule: j.weekendRule };
}
function nextPay(rule: PayRule | null, today: string) {
  if (!rule || validateRule(rule)) return null;
  try {
    return nextPayPeriod(rule, today);
  } catch {
    return null;
  }
}
function summary(j: Job, today: string) {
  const p = nextPay(ruleOf(j), today);
  const rate = j.rateCents != null ? `$${(j.rateCents / 100).toFixed(2)}/h` : "no rate";
  const days = j.schedule.length ? `${new Set(j.schedule.map((e) => e.weekday)).size} days a week` : "no weekly pattern";
  return `${rate}, ${days}. ${p ? `Next payday ${p.payDate === today ? "today" : fmt(p.payDate)}` : "Paydays not set"}`;
}

function JobEditor({ job, today, onSaved, onClose }: { job: Job; today: string; onSaved: () => void; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { pending } = useAct();
  const [saving, setSaving] = useState(false);
  const [rate, setRate] = useState(job.rateCents != null ? (job.rateCents / 100).toFixed(2) : "");
  const [freq, setFreq] = useState<Freq | "">(job.payFrequency ?? "");
  const current = nextPay(ruleOf(job), today);
  // weekly / every 2 weeks
  const [weekday, setWeekday] = useState<number>(current && (job.payFrequency === "weekly" || job.payFrequency === "biweekly") ? new Date(`${current.payDate}T12:00:00Z`).getUTCDay() : 5);
  const [nextDate, setNextDate] = useState<string>(current && job.payFrequency === "biweekly" ? current.payDate : nextWeekday(today, 5));
  const [gap, setGap] = useState(String(job.payFrequency === "weekly" || job.payFrequency === "biweekly" ? job.offsetDays : 6));
  // twice a month / monthly
  const [d1, setD1] = useState(String(job.payDays?.[0] ?? 15));
  const [d2, setD2] = useState(String(job.payDays?.[1] ?? 31));
  const [md, setMd] = useState(String(job.payDays?.[0] ?? 1));
  const [schedule, setSchedule] = useState<Entry[]>(job.schedule.length ? job.schedule : []);

  const draft: PayRule | null = useMemo(() => {
    if (!freq) return null;
    const off = Math.max(0, Math.min(31, Number(gap) || 0));
    if (freq === "weekly") return { frequency: "weekly", anchorDate: anchorFromNextPayday("weekly", nextWeekday(today, weekday), off), paydayOffsetDays: off, weekendRule: "none" };
    if (freq === "biweekly") return nextDate ? { frequency: "biweekly", anchorDate: anchorFromNextPayday("biweekly", nextDate, off), paydayOffsetDays: off, weekendRule: "none" } : null;
    if (freq === "semimonthly") return { frequency: "semimonthly", payDays: [Number(d1) || 15, Number(d2) || 31], paydayOffsetDays: 0, weekendRule: job.weekendRule };
    return { frequency: "monthly", payDays: [Number(md) || 1], paydayOffsetDays: 0, weekendRule: job.weekendRule };
  }, [freq, gap, weekday, nextDate, d1, d2, md, today, job.weekendRule]);
  const preview = nextPay(draft, today);

  const setEntry = (i: number, p: Partial<Entry>) => setSchedule((s) => s.map((e, k) => (k === i ? { ...e, ...p } : e)));

  async function save(onlyConfirm = false) {
    setSaving(true);
    const input: Record<string, unknown> = { job_id: job.id };
    if (onlyConfirm) input.confirm_pay = true;
    else {
      if (freq) {
        input.pay_frequency = freq;
        if (freq === "weekly") Object.assign(input, { payday_weekday: weekday, payday_offset_days: Number(gap) || 0 });
        if (freq === "biweekly") Object.assign(input, { next_payday: nextDate, payday_offset_days: Number(gap) || 0 });
        if (freq === "semimonthly") Object.assign(input, { pay_days: [Number(d1), Number(d2)] });
        if (freq === "monthly") Object.assign(input, { pay_days: [Number(md)] });
        input.confirm_pay = true;
      }
      input.regular_schedule = schedule.filter((e) => e.start && e.end).map((e) => ({ ...e, break_minutes: Number(e.break_minutes) || 0 }));
      const r = Number(rate);
      if (r > 0 && Math.round(r * 100) !== job.rateCents) input.hourly_rate = r;
    }
    const res = await act("updateJob", input).catch(() => ({ ok: false as const, error: "HARU couldn't reach the server. Nothing was saved." }));
    setSaving(false);
    toast(res.ok ? (onlyConfirm ? "Thanks, paydays confirmed." : "Saved. Your calendar and paychecks are updated.") : res.error, res.ok ? "ok" : "error");
    if (res.ok) {
      router.refresh();
      onSaved();
    }
  }

  return (
    <section className="glass grid gap-5 p-4" aria-label={`Edit ${job.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold">{job.name}</p>
          {!job.confirmed && current && (
            <p className="mt-1 text-sm text-amber">
              Haru has {current.payDate === today ? "today" : fmt(current.payDate)} as the next payday. Is that right?
            </p>
          )}
        </div>
        <button className="btn btn-quiet h-9 min-h-0 px-3 text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      {!job.confirmed && current && (
        <button className="btn btn-line w-fit" disabled={saving} onClick={() => save(true)}>
          <Check size={15} /> Yes, that's right
        </button>
      )}

      <label className="field w-40">
        Pay per hour
        <input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
      </label>

      <div className="grid gap-2.5">
        <p className="text-sm font-semibold">How are you paid?</p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["weekly", "Every week"],
              ["biweekly", "Every 2 weeks"],
              ["semimonthly", "Twice a month"],
              ["monthly", "Once a month"],
            ] as const
          ).map(([f, l]) => (
            <button key={f} type="button" className="choice" aria-pressed={freq === f} onClick={() => setFreq(f)}>
              {l}
            </button>
          ))}
        </div>

        {freq === "weekly" && (
          <div className="grid gap-2">
            <p className="text-sm text-ink-2">Which day?</p>
            <div className="flex flex-wrap gap-1.5">
              {ORDER.map((d) => (
                <button key={d} type="button" className="choice px-3.5" aria-pressed={weekday === d} onClick={() => setWeekday(d)}>
                  {WD[d]}
                </button>
              ))}
            </div>
          </div>
        )}
        {freq === "biweekly" && (
          <label className="field w-48">
            Your next payday
            <input className="input" type="date" min={today} value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </label>
        )}
        {(freq === "weekly" || freq === "biweekly") && (
          <details className="text-sm text-ink-2">
            <summary className="cursor-pointer">Which week's work does it pay for?</summary>
            <label className="field mt-2 w-56">
              Days from the end of the work week to payday
              <input className="input" inputMode="numeric" value={gap} onChange={(e) => setGap(e.target.value)} />
              <span className="text-xs text-ink-3">6 = paid Friday for the week ending the Saturday before (common). 0 = paid on the last day worked.</span>
            </label>
          </details>
        )}
        {freq === "semimonthly" && (
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  [15, 31, "15th & last day"],
                  [15, 30, "15th & 30th"],
                  [1, 15, "1st & 15th"],
                ] as const
              ).map(([a, b, l]) => (
                <button key={l} type="button" className="choice text-sm" aria-pressed={Number(d1) === a && Number(d2) === b} onClick={() => (setD1(String(a)), setD2(String(b)))}>
                  {l}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm text-ink-2">
              Paid on the
              <input className="input w-16 text-center" inputMode="numeric" value={d1} onChange={(e) => setD1(e.target.value)} aria-label="First pay day" />
              and
              <input className="input w-16 text-center" inputMode="numeric" value={d2} onChange={(e) => setD2(e.target.value)} aria-label="Second pay day" />
            </div>
            <p className="text-xs text-ink-3">31 means the last day of the month. Each paycheck covers the work since the previous payday.</p>
          </div>
        )}
        {freq === "monthly" && (
          <label className="field w-40">
            Day of the month
            <input className="input" inputMode="numeric" value={md} onChange={(e) => setMd(e.target.value)} />
          </label>
        )}

        {preview && (
          <p className="rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--aurora-soft)" }}>
            Next payday <strong className="text-iris">{preview.payDate === today ? "today" : fmt(preview.payDate)}</strong>, for work {fmt(preview.start)} to {fmt(preview.end)}.
            {freq === "semimonthly" && ` Then the ${ord(Number(d1))} and ${ord(Number(d2))} every month.`}
          </p>
        )}
      </div>

      <div className="grid gap-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">Your usual week</p>
          {schedule.length > 0 && (
            <button
              type="button"
              className="text-xs text-iris"
              onClick={() => {
                const f = schedule[0];
                const others = schedule.filter((e) => !(e.start === f.start && e.end === f.end));
                setSchedule([...[1, 2, 3, 4, 5].map((weekday) => ({ ...f, weekday })), ...others]);
              }}
            >
              Same time Mon to Fri
            </button>
          )}
        </div>
        {schedule.length === 0 && <p className="text-sm text-ink-3">No fixed shifts. Add the times you usually work, or leave it empty if it changes every week.</p>}
        <ul className="grid gap-2">
          {schedule
            .map((e, i) => ({ e, i }))
            .sort((a, b) => ORDER.indexOf(a.e.weekday) - ORDER.indexOf(b.e.weekday) || a.e.start.localeCompare(b.e.start))
            .map(({ e, i }) => (
              <li key={i} className="grid grid-cols-[4.6rem_minmax(0,1fr)_minmax(0,1fr)_3.2rem_2.5rem] items-center gap-1.5">
                <select className="input min-h-10 px-2 py-1.5" value={e.weekday} onChange={(ev) => setEntry(i, { weekday: Number(ev.target.value) })} aria-label="Day">
                  {ORDER.map((d) => (
                    <option key={d} value={d}>
                      {WD[d]}
                    </option>
                  ))}
                </select>
                <input type="time" className="input min-h-10 min-w-0 px-2 py-1.5" value={e.start} onChange={(ev) => setEntry(i, { start: ev.target.value })} aria-label="Start" />
                <input type="time" className="input min-h-10 min-w-0 px-2 py-1.5" value={e.end} onChange={(ev) => setEntry(i, { end: ev.target.value })} aria-label="End" />
                <input className="input min-h-10 min-w-0 px-2 py-1.5" inputMode="numeric" placeholder="Brk" value={e.break_minutes || ""} onChange={(ev) => setEntry(i, { break_minutes: Number(ev.target.value) || 0 })} aria-label="Unpaid break minutes" />
                <button type="button" className="btn btn-quiet h-10 w-10 p-0" onClick={() => setSchedule((s) => s.filter((_, k) => k !== i))} aria-label="Remove">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
        </ul>
        <button type="button" className="btn btn-line w-fit" onClick={() => setSchedule((s) => [...s, { weekday: 1, start: "09:00", end: "17:00", break_minutes: 0 }])}>
          <Plus size={15} /> Add a shift time
        </button>
        <p className="text-xs text-ink-3">Two shifts on one day and overnight shifts (23:30 to 03:30) are fine. Changing your usual week updates upcoming shifts you haven't answered yet.</p>
      </div>

      <button className="btn btn-primary" disabled={saving || pending} onClick={() => save(false)}>
        {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Save {job.employer}
      </button>
    </section>
  );
}

function NewJob({ onDone }: { onDone: (ok: boolean) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="glass grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await act("createJob", { employer: name.trim(), hourly_rate: Number(rate) });
        setBusy(false);
        if (!r.ok) toast(r.error, "error");
        onDone(r.ok);
      }}
    >
      <label className="field">
        Job
        <input className="input" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Employer" />
      </label>
      <label className="field">
        $ per hour
        <input className="input" inputMode="decimal" required value={rate} onChange={(e) => setRate(e.target.value)} />
      </label>
      <div className="col-span-2 flex gap-2">
        <button className="btn btn-primary flex-1" disabled={busy || !name.trim() || !(Number(rate) > 0)}>
          Add job
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

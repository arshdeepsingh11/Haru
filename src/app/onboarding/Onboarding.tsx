"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { act, finishOnboarding } from "@/app/actions";
import { Wordmark } from "@/components/Wordmark";

type Step = "you" | "job" | "cash" | "bills" | "goal" | "done";
const ORDER: Step[] = ["you", "job", "cash", "bills", "goal", "done"];
const LABELS: Record<Step, string> = { you: "You", job: "Work", cash: "Cash", bills: "Bills", goal: "Saving", done: "Reminders" };

export function Onboarding({ today, defaults }: { today: string; defaults: { name: string; currency: string; timezone: string } }) {
  const [step, setStep] = useState<Step>("you");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [freq, setFreq] = useState("biweekly");
  const [tz, setTz] = useState(defaults.timezone);

  useEffect(() => {
    // Suggest the browser's zone if the user hasn't chosen one.
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local && defaults.timezone === "America/Edmonton" && local !== defaults.timezone) setTz(local);
  }, [defaults.timezone]);

  const next = () => setStep(ORDER[ORDER.indexOf(step) + 1]);

  async function save(kind: Parameters<typeof act>[0], input: unknown, advance = true) {
    setBusy(true);
    setError(null);
    const r = await act(kind, input);
    setBusy(false);
    if (!r.ok) return setError(r.error), false;
    setSaved((s) => [...s, r.summary]);
    if (advance) next();
    return true;
  }

  async function finish(ask?: boolean) {
    await finishOnboarding();
    window.location.href = ask ? "/?ask=start" : "/";
  }

  const form = (handler: (v: Record<string, string>) => void) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    new FormData(e.currentTarget).forEach((val, k) => typeof val === "string" && val.trim() && (v[k] = val.trim()));
    handler(v);
  };
  const n = (s?: string) => (s ? Number(s) : undefined);

  return (
    <main className="mx-auto grid min-h-dvh max-w-xl content-start gap-8 px-5 py-10 sm:py-16">
      <Wordmark tagline />
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Setup progress">
        {ORDER.map((s, i) => (
          <li key={s} aria-current={s === step ? "step" : undefined} className={s === step ? "font-semibold text-ink" : i < ORDER.indexOf(step) ? "text-moss" : "text-ink-3"}>
            {i < ORDER.indexOf(step) && <Check size={12} className="mr-1 inline" aria-hidden />}
            {LABELS[s]}
          </li>
        ))}
      </ol>

      <section className="panel grid gap-5 p-5 sm:p-7">
        {step === "you" && (
          <form className="grid gap-4" onSubmit={form((v) => save("updatePrefs", { display_name: v.name ?? "", currency: v.currency, timezone: v.timezone }))}>
            <h1 className="text-xl font-semibold">Let's set HARU up. It takes a minute, and you can skip anything.</h1>
            <label className="field">What should HARU call you?<input className="input" name="name" defaultValue={defaults.name} autoFocus /></label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">
                Currency
                <select className="input" name="currency" defaultValue={defaults.currency}>
                  {["CAD", "USD", "EUR", "GBP", "INR", "AUD", "JPY"].map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="field">
                Time zone
                <input className="input" name="timezone" value={tz} onChange={(e) => setTz(e.target.value)} />
              </label>
            </div>
            <Actions busy={busy} />
          </form>
        )}

        {step === "job" && (
          <form className="grid gap-4" onSubmit={form((v) => save("createJob", { employer: v.employer, title: v.title, hourly_rate: n(v.hourly_rate), pay_frequency: v.pay_frequency, period_anchor_date: v.period_anchor_date, payday_offset_days: n(v.payday_offset_days) }))}>
            <h1 className="text-xl font-semibold">Where do you work?</h1>
            <p className="-mt-2 text-sm text-ink-2">Add one job now — you can add more later, or tell HARU about them. One-off gigs don't go here.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">Employer<input className="input" name="employer" required placeholder="Northgate Security" /></label>
              <label className="field">Job title (optional)<input className="input" name="title" /></label>
              <label className="field">Hourly wage<input className="input" name="hourly_rate" inputMode="decimal" required /></label>
              <label className="field">
                Paid
                <select className="input" name="pay_frequency" value={freq} onChange={(e) => setFreq(e.target.value)}>
                  <option value="">Not sure yet</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every two weeks</option>
                  <option value="semimonthly">Twice a month</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {(freq === "weekly" || freq === "biweekly") && (
                <label className="field">First day of a recent pay period<input className="input" type="date" name="period_anchor_date" required /></label>
              )}
              {freq && <label className="field">Pay arrives __ days after the period ends<input className="input" type="number" min={0} max={31} name="payday_offset_days" defaultValue={freq === "semimonthly" || freq === "monthly" ? 0 : 5} /></label>}
            </div>
            <Actions busy={busy} onSkip={next} />
          </form>
        )}

        {step === "cash" && (
          <form className="grid gap-4" onSubmit={form((v) => save("createAccount", { name: v.name || "Chequing", kind: "checking", current_balance: n(v.balance) }))}>
            <h1 className="text-xl font-semibold">How much is in your main account today?</h1>
            <p className="-mt-2 text-sm text-ink-2">HARU tracks this from what you tell it. There's no bank connection, so it's only as current as your records.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">Account name<input className="input" name="name" placeholder="Chequing" /></label>
              <label className="field">Balance<input className="input" name="balance" inputMode="decimal" required /></label>
            </div>
            <Actions busy={busy} onSkip={next} />
          </form>
        )}

        {step === "bills" && (
          <form
            className="grid gap-4"
            onSubmit={form(async (v) => {
              const ok = await save("createBill", { name: v.name, amount: n(v.amount), due_date: v.due_date, recurrence: v.recurrence }, false);
              if (ok) (document.getElementById("bill-form") as HTMLFormElement | null)?.reset();
            })}
            id="bill-form"
          >
            <h1 className="text-xl font-semibold">Any regular bills?</h1>
            <p className="-mt-2 text-sm text-ink-2">Rent, phone, insurance. Add as many as you like, then continue.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">Bill<input className="input" name="name" required placeholder="Phone" /></label>
              <label className="field">Amount<input className="input" name="amount" inputMode="decimal" required /></label>
              <label className="field">Next due<input className="input" type="date" name="due_date" required min={today} /></label>
              <label className="field">
                Repeats
                <select className="input" name="recurrence" defaultValue="monthly">
                  <option value="monthly">Monthly</option><option value="biweekly">Every two weeks</option><option value="weekly">Weekly</option><option value="yearly">Yearly</option><option value="none">Doesn't repeat</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-line" disabled={busy}>Add this bill</button>
              <button type="button" className="btn btn-primary" onClick={next}>Continue</button>
            </div>
          </form>
        )}

        {step === "goal" && (
          <form className="grid gap-4" onSubmit={form((v) => save("createGoal", { name: v.name, target_amount: n(v.target), monthly_target: n(v.monthly) }))}>
            <h1 className="text-xl font-semibold">Saving for something?</h1>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">Goal<input className="input" name="name" required placeholder="Emergency fund" /></label>
              <label className="field">Target<input className="input" name="target" inputMode="decimal" required /></label>
              <label className="field">Per month (optional)<input className="input" name="monthly" inputMode="decimal" /></label>
            </div>
            <Actions busy={busy} onSkip={next} />
          </form>
        )}

        {step === "done" && (
          <div className="grid gap-4">
            <h1 className="text-xl font-semibold">You're set.</h1>
            <p className="text-ink-2">To get reminders before shifts, on paydays and before bills, open Settings on your dashboard and turn on notifications for this device.</p>
            {saved.length > 0 && (
              <ul className="grid gap-1 text-sm text-ink-2">
                {saved.map((s, i) => (
                  <li key={i} className="flex gap-2"><Check size={14} className="mt-1 shrink-0 text-moss" /> {s}</li>
                ))}
              </ul>
            )}
            <button className="btn btn-primary w-fit" onClick={() => finish()}>Open my dashboard</button>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-brick">{error}</p>}
      </section>

      {step !== "done" && (
        <button className="btn btn-quiet w-fit text-sm" onClick={() => finish(true)}>
          I'd rather just tell HARU in my own words
        </button>
      )}
    </main>
  );
}

function Actions({ busy, onSkip }: { busy: boolean; onSkip?: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Continue"}</button>
      {onSkip && <button type="button" className="btn btn-quiet" onClick={onSkip}>Skip</button>}
    </div>
  );
}

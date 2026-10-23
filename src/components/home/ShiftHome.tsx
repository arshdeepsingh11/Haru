"use client";

import { useState } from "react";
import { CalendarDays, Check, Clock, Flame, Sparkles, Target, TrendingUp, X } from "lucide-react";
import type { CoachData, ShiftCard } from "@/lib/server/services/coach";
import type { DashboardData } from "@/lib/server/services/dashboard";
import { dayLabel, hours, useAct, useMoney } from "../ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(d: string | null | undefined) {
  if (!d) return "";
  const [, m, day] = d.split("-").map(Number);
  return `${MONTHS[m - 1]} ${day}`;
}
function to12h(t: string | null) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
export function timeRange(s: { start: string | null; end: string | null }) {
  return s.start ? `${to12h(s.start)} – ${to12h(s.end)}` : "";
}

/** The loud one: what your next shift is worth. */
export function NextShiftHero({ c, today, onOpenSchedule }: { c: CoachData; today: string; onOpenSchedule: () => void }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const s = c.nextShift;
  if (!s)
    return (
      <section className="hero p-6 sm:p-8">
        <p className="text-sm text-white/80">No shifts coming up</p>
        <h2 className="mt-1 text-2xl font-semibold sm:text-3xl">Add your schedule and every shift gets a price tag.</h2>
        <button className="btn btn-white mt-5" onClick={onOpenSchedule}>
          <CalendarDays size={16} /> Open schedule
        </button>
      </section>
    );
  const going = s.attendance === "going";
  return (
    <section className="hero p-6 sm:p-8" aria-label="Next shift">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-white/85">
        <span className="inline-flex items-center gap-1.5">
          <Clock size={15} aria-hidden /> {dayLabel(s.date, today)}, {timeRange(s)}
        </span>
        <span className="rounded-full bg-white/18 px-3 py-1 text-xs font-semibold">{s.jobName}</span>
      </div>
      <p className="mt-5 text-sm text-white/80">If you go, you earn</p>
      <p className="rise figure text-[3.4rem] font-bold leading-none sm:text-7xl">+{money(s.takeHomeCents)}</p>
      <p className="mt-2 text-sm text-white/80">
        after {c.taxPercent}% tax ({money(s.grossCents)} gross, {hours(s.minutes)})
      </p>
      <div className="mt-6 grid gap-2 text-sm sm:grid-cols-2">
        {s.payDate && (
          <div className="rounded-2xl bg-white/14 px-4 py-3 ring-1 ring-white/25">
            <p className="text-white/75">Lands in your {shortDate(s.payDate)} paycheck</p>
            <p className="figure text-lg font-semibold">{money(s.paycheckProjectedCents)} projected</p>
          </div>
        )}
        {c.plan.focus && s.daysCloser != null && s.daysCloser > 0 && (
          <div className="rounded-2xl bg-white/14 px-4 py-3 ring-1 ring-white/25">
            <p className="text-white/75">Gets {c.plan.focus.name} paid off</p>
            <p className="text-lg font-semibold">
              {s.daysCloser} day{s.daysCloser === 1 ? "" : "s"} sooner
            </p>
          </div>
        )}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {going ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-semibold text-violet">
            <Check size={16} /> You're going. Let's get it.
          </span>
        ) : (
          <>
            <button className="btn btn-white" disabled={pending} onClick={() => run("setAttendance", { shift_id: s.id, going: true })}>
              <Check size={16} /> I'm going
            </button>
            <button className="btn btn-ghost-white" disabled={pending} onClick={() => confirm(`Skip this shift? That's ${money(s.takeHomeCents)} you won't earn.`) && run("setAttendance", { shift_id: s.id, going: false })}>
              Can't make it
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** After a shift: one tap to log it, or enter the real hours. */
export function CheckoutCards({ items, today, taxPercent }: { items: ShiftCard[]; today: string; taxPercent: number }) {
  if (!items.length) return null;
  return (
    <section aria-label="Shifts to check out" className="grid gap-3">
      {items.map((s) => (
        <CheckoutCard key={s.id} s={s} today={today} taxPercent={taxPercent} />
      ))}
    </section>
  );
}

export function CheckoutCard({ s, today, taxPercent, autoFocus = false }: { s: ShiftCard; today: string; taxPercent: number; autoFocus?: boolean }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const [partial, setPartial] = useState(autoFocus);
  const [h, setH] = useState("");
  const est = Number(h) > 0 ? Math.round((s.grossCents / s.minutes) * Number(h) * 60 * (1 - taxPercent / 100)) : null;
  return (
    <div className="glass p-5">
      <p className="text-sm text-ink-2">
        {s.jobName}, {dayLabel(s.date, today).toLowerCase() === "yesterday" ? "yesterday" : dayLabel(s.date, today)} {timeRange(s)}
      </p>
      <h3 className="mt-0.5 text-lg font-semibold">Did you finish this shift?</h3>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={pending} onClick={() => run("checkoutShift", { shift_id: s.id, full: true })}>
          <Check size={16} /> Full shift, +{money(s.takeHomeCents)}
        </button>
        <button className="btn btn-line" aria-expanded={partial} onClick={() => setPartial(!partial)}>
          Fewer hours
        </button>
        <button className="btn btn-quiet" disabled={pending} onClick={() => run("checkoutShift", { shift_id: s.id, missed: true })}>
          <X size={16} /> Missed it
        </button>
      </div>
      {partial && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run("checkoutShift", { shift_id: s.id, hours: Number(h) });
          }}
        >
          <label className="field w-36">
            Hours worked
            <input className="input" inputMode="decimal" autoFocus value={h} onChange={(e) => setH(e.target.value)} placeholder={String(s.minutes / 60)} />
          </label>
          <button className="btn btn-primary" disabled={pending || !(Number(h) > 0)}>
            Save{est != null ? `, +${money(est)}` : ""}
          </button>
        </form>
      )}
    </div>
  );
}

export function StatTiles({ c }: { c: CoachData }) {
  const money = useMoney();
  const rate = c.stats.attendanceRate;
  const tiles = [
    { icon: TrendingUp, label: "Earned this month", value: money(c.stats.monthTakeHomeCents), note: "after tax" },
    { icon: Flame, label: "Shift streak", value: String(c.stats.streak), note: c.stats.streak === 1 ? "shift in a row" : "shifts in a row" },
    { icon: Check, label: "Showed up", value: rate == null ? "—" : `${Math.round(rate * 100)}%`, note: "last 30 days" },
    { icon: Target, label: "Left on the table", value: money(c.stats.missedTakeHomeCents), note: `${c.stats.missedShifts} missed shift${c.stats.missedShifts === 1 ? "" : "s"}` },
  ];
  return (
    <section aria-label="Your numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="glass p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
            <t.icon size={14} className="text-violet" aria-hidden /> {t.label}
          </p>
          <p className="figure mt-2 text-2xl font-bold">{t.value}</p>
          <p className="text-xs text-ink-3">{t.note}</p>
        </div>
      ))}
    </section>
  );
}

function Ring({ pct, children }: { pct: number; children: React.ReactNode }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, pct));
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90" aria-hidden>
        <defs>
          <linearGradient id="ring-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#c084fc" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r={r} fill="none" stroke="rgb(124 58 237 / 0.12)" strokeWidth="8" />
        <circle cx="40" cy="40" r={r} fill="none" stroke="url(#ring-g)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Each job's next paycheck: logged so far vs. what the schedule adds. */
export function PaycheckCards({ paydays, taxPercent, today, onOpenRecords }: { paydays: DashboardData["paydays"]; taxPercent: number; today: string; onOpenRecords: (t?: string) => void }) {
  const money = useMoney();
  if (!paydays.length) return null;
  const net = (c?: number) => (c == null ? 0 : Math.round(c * (1 - taxPercent / 100)));
  return (
    <section aria-labelledby="pay-h">
      <h2 id="pay-h" className="section-title mb-3">
        Your next paychecks
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {paydays.map((p) =>
          p.configured ? (
            <div key={p.jobId} className="glass flex items-center gap-4 p-5">
              <Ring pct={(p.expectedGrossCents ?? 0) ? (p.loggedGrossCents ?? 0) / (p.expectedGrossCents ?? 1) : 0}>
                <span className="text-[0.65rem] leading-tight text-ink-3">
                  in
                  <br />
                  <span className="text-lg font-bold text-ink">{p.daysUntil ?? 0}</span>
                  <br />
                  day{p.daysUntil === 1 ? "" : "s"}
                </span>
              </Ring>
              <div className="min-w-0">
                <p className="truncate font-semibold">{p.jobName}</p>
                <p className="text-sm text-ink-2">Payday {dayLabel(p.payDate!, today)}</p>
                <p className="figure mt-1 text-2xl font-bold text-violet">{money(net(p.expectedGrossCents))}</p>
                <p className="text-xs text-ink-3">
                  {money(net(p.loggedGrossCents))} earned so far
                  {p.scheduledGrossCents ? `, +${money(net(p.scheduledGrossCents))} if you work your shifts` : ""}
                </p>
              </div>
            </div>
          ) : (
            <button key={p.jobId} className="glass p-5 text-left" onClick={() => onOpenRecords("jobs")}>
              <p className="font-semibold">{p.jobName}</p>
              <p className="text-sm text-ink-2">Set your paydays so HARU can count toward them.</p>
            </button>
          ),
        )}
      </div>
    </section>
  );
}

/** What to pay first, and when you're done. */
export function PayoffPlanCard({ c, onAsk }: { c: CoachData; onAsk: (t: string) => void }) {
  const money = useMoney();
  const p = c.plan;
  if (!p.items.length && !p.warnings.length) return null;
  return (
    <section aria-labelledby="plan-h" className="glass p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="plan-h" className="section-title">
          Your payoff plan
        </h2>
        {p.debtFreeDate && (
          <span className="chip chip-moss">
            <Sparkles size={12} /> Debt-free {shortDate(p.debtFreeDate)} {p.debtFreeDate.slice(0, 4)}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-2">
        Your schedule brings in about <strong className="text-ink">{money(p.monthlyTakeHomeCents)}</strong> a month after tax. After bills ({money(p.monthlyBillsCents)})
        {p.monthlyMinimumsCents ? ` and minimum payments (${money(p.monthlyMinimumsCents)})` : ""}, <strong className={p.surplusCents > 0 ? "text-violet" : "text-brick"}>{money(p.surplusCents)}</strong> is free each month.
      </p>
      {p.warnings.map((w) => (
        <p key={w} className="mt-3 rounded-2xl bg-amber-soft px-4 py-2.5 text-sm text-ink">
          {w}
        </p>
      ))}
      <ol className="mt-4 grid gap-2">
        {p.items.map((it, i) => (
          <li key={it.id} className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${i === 0 ? "bg-violet-soft ring-1 ring-violet/25" : "bg-white/50"}`}>
            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${i === 0 ? "bg-violet text-white" : "bg-white text-ink-2"}`}>{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {it.name} {i === 0 && <span className="ml-1 text-xs font-medium text-violet">focus here</span>}
              </p>
              <p className="text-xs text-ink-3">{it.reason}</p>
            </div>
            <div className="text-right">
              <p className="figure font-semibold">{money(it.remainingCents)}</p>
              <p className="text-xs text-ink-3">{it.finishDate ? `done ${shortDate(it.finishDate)} ${it.finishDate.slice(0, 4)}` : "needs more shifts"}</p>
            </div>
          </li>
        ))}
      </ol>
      <button className="btn btn-quiet mt-3 px-0 text-sm text-violet" onClick={() => onAsk("How can I pay off my debt faster?")}>
        Ask HARU how to get there faster
      </button>
    </section>
  );
}

/** The next seven days at a glance. */
export function WeekStrip({ c, today, onOpenSchedule }: { c: CoachData; today: string; onOpenSchedule: () => void }) {
  const money = useMoney();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const total = c.week.filter((s) => s.attendance !== "not_going").reduce((a, s) => a + s.takeHomeCents, 0);
  return (
    <section aria-labelledby="week-h" className="glass p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="week-h" className="section-title">
          This week
        </h2>
        <button className="text-sm font-semibold text-violet" onClick={onOpenSchedule}>
          Schedule
        </button>
      </div>
      <p className="text-sm text-ink-2">
        Work every shift and you take home <strong className="text-violet">{money(total)}</strong>.
      </p>
      <div className="scroll-thin -mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-1">
        {days.map((d) => {
          const list = c.week.filter((s) => s.date === d);
          return (
            <button key={d} onClick={onOpenSchedule} className={`min-w-[5.6rem] flex-1 rounded-2xl px-3 py-3 text-left ${list.length ? "bg-white/75 ring-1 ring-violet/15" : "bg-white/35"}`}>
              <p className="text-xs font-semibold text-ink-3">{d === today ? "Today" : new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", timeZone: "UTC" })}</p>
              {list.length ? (
                list.map((s) => (
                  <p key={s.id} className={`mt-1 text-sm ${s.attendance === "not_going" ? "text-ink-3 line-through" : ""}`}>
                    <span className="figure block font-bold text-violet">+{money(s.takeHomeCents)}</span>
                    <span className="block truncate text-xs text-ink-2">{to12h(s.start)}</span>
                  </p>
                ))
              ) : (
                <p className="mt-1 text-xs text-ink-3">Off</p>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

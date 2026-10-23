"use client";

import { useState } from "react";
import { Check, Clock, Flame, Sparkles, Target, TrendingUp, X } from "lucide-react";
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

/** The one big card: what your next shift is worth, and the two ways to answer it. */
export function NextShiftHero({ c, today, onOpenSchedule }: { c: CoachData; today: string; onOpenSchedule: () => void }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const s = c.nextShift;
  if (!s)
    return (
      <section className="hero p-6">
        <p className="text-sm text-ink-2">No shifts on your calendar yet</p>
        <p className="mt-1 text-xl font-semibold leading-snug">Add your schedule and every shift shows what it pays.</p>
        <button className="btn btn-primary mt-5" onClick={onOpenSchedule}>
          Open schedule
        </button>
      </section>
    );
  const going = s.attendance === "going";
  return (
    <section className="hero p-6" aria-label="Next shift">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <Clock size={15} aria-hidden /> {dayLabel(s.date, today)}, {timeRange(s)}
        </span>
        <span className="truncate rounded-full bg-paper-2 px-3 py-1 text-xs font-semibold text-ink">{s.jobName}</span>
      </div>
      <p className="mt-6 text-sm text-ink-2">Go, and you earn</p>
      <p className="rise figure aurora-text mt-1 text-[2.9rem] leading-none sm:text-6xl">+{money(s.takeHomeCents)}</p>
      <p className="mt-2.5 text-sm text-ink-3">
        After {c.taxPercent}% tax. {money(s.grossCents)} for {hours(s.minutes)}.
      </p>

      <dl className="mt-6 grid grid-cols-2 border-t border-line pt-4 text-sm">
        <div className="pr-4">
          <dt className="text-ink-3">{s.payDate ? `${shortDate(s.payDate)} paycheck` : "Next paycheck"}</dt>
          <dd className="figure mt-0.5 text-base">{money(s.paycheckProjectedCents)}</dd>
        </div>
        <div className="border-l border-line pl-4">
          <dt className="text-ink-3">{c.plan.focus ? `${c.plan.focus.name} paid off` : "Goal"}</dt>
          <dd className="mt-0.5 text-base font-semibold">{c.plan.focus && s.daysCloser != null && s.daysCloser > 0 ? `${s.daysCloser} day${s.daysCloser === 1 ? "" : "s"} sooner` : "Tell Haru a goal"}</dd>
        </div>
      </dl>

      <div className="mt-5 flex gap-2">
        {going ? (
          <p className="inline-flex items-center gap-2 text-sm font-semibold text-iris">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-violet-soft">
              <Check size={15} />
            </span>
            You're going. Haru will check in when it ends.
          </p>
        ) : (
          <>
            <button className="btn btn-primary flex-1" disabled={pending} onClick={() => run("setAttendance", { shift_id: s.id, going: true })}>
              <Check size={16} /> I'm going
            </button>
            <button className="btn btn-line" disabled={pending} onClick={() => confirm(`Skip this shift? That's ${money(s.takeHomeCents)} you won't earn.`) && run("setAttendance", { shift_id: s.id, going: false })}>
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
      <div className="mt-4 grid gap-2 sm:flex">
        <button className="btn btn-primary" disabled={pending} onClick={() => run("checkoutShift", { shift_id: s.id, full: true })}>
          <Check size={16} /> Full shift, +{money(s.takeHomeCents)}
        </button>
        <div className="flex gap-2">
          <button className="btn btn-line flex-1" aria-expanded={partial} onClick={() => setPartial(!partial)}>
            Fewer hours
          </button>
          <button className="btn btn-quiet flex-1" disabled={pending} onClick={() => run("checkoutShift", { shift_id: s.id, missed: true })}>
            <X size={16} /> Missed it
          </button>
        </div>
      </div>
      {partial && (
        <form
          className="mt-4 flex items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run("checkoutShift", { shift_id: s.id, hours: Number(h) });
          }}
        >
          <label className="field w-32">
            Hours worked
            <input className="input" inputMode="decimal" autoFocus value={h} onChange={(e) => setH(e.target.value)} placeholder={String(s.minutes / 60)} />
          </label>
          <button className="btn btn-primary flex-1" disabled={pending || !(Number(h) > 0)}>
            Save{est != null ? `, +${money(est)}` : ""}
          </button>
        </form>
      )}
    </div>
  );
}

/** Four numbers in one strip: how the month is going. */
export function StatTiles({ c }: { c: CoachData }) {
  const money = useMoney();
  const rate = c.stats.attendanceRate;
  const tiles = [
    { icon: TrendingUp, label: "Earned this month", value: money(c.stats.monthTakeHomeCents) },
    { icon: Flame, label: c.stats.streak === 1 ? "Shift in a row" : "Shifts in a row", value: String(c.stats.streak) },
    { icon: Check, label: "Showed up, 30 days", value: rate == null ? "–" : `${Math.round(rate * 100)}%` },
    { icon: Target, label: `Missed (${c.stats.missedShifts})`, value: money(c.stats.missedTakeHomeCents) },
  ];
  return (
    <section aria-label="Your numbers" className="glass grid grid-cols-2 gap-px overflow-hidden p-0 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="bg-white/40 px-4 py-3.5">
          <p className="flex items-center gap-1.5 text-xs text-ink-2">
            <t.icon size={13} className="text-iris" aria-hidden /> {t.label}
          </p>
          <p className="figure mt-1.5 text-xl">{t.value}</p>
        </div>
      ))}
    </section>
  );
}

function Ring({ pct, children }: { pct: number; children: React.ReactNode }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, pct));
  return (
    <div className="relative h-[4.6rem] w-[4.6rem] shrink-0">
      <svg viewBox="0 0 72 72" className="h-full w-full -rotate-90" aria-hidden>
        <defs>
          <linearGradient id="ring-aurora" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6e56ff" />
            <stop offset="0.6" stopColor="#2bc8e8" />
            <stop offset="1" stopColor="#ff6fb5" />
          </linearGradient>
        </defs>
        <circle cx="36" cy="36" r={r} fill="none" stroke="rgb(18 20 43 / 0.07)" strokeWidth="6" />
        <circle cx="36" cy="36" r={r} fill="none" stroke="url(#ring-aurora)" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${Math.max(c * v, 0.01)} ${c}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Each job's next paycheck: logged so far vs. what the schedule adds. Swipe sideways on a phone. */
export function PaycheckCards({ paydays, taxPercent, today, onOpenRecords }: { paydays: DashboardData["paydays"]; taxPercent: number; today: string; onOpenRecords: (t?: string) => void }) {
  const money = useMoney();
  if (!paydays.length) return null;
  const net = (c?: number) => (c == null ? 0 : Math.round(c * (1 - taxPercent / 100)));
  return (
    <section aria-labelledby="pay-h">
      <h2 id="pay-h" className="section-title mb-2.5 px-1">
        Paychecks
      </h2>
      <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2">
        {paydays.map((p) =>
          p.configured ? (
            <div key={p.jobId} className="glass flex w-[82%] max-w-sm shrink-0 snap-start items-center gap-4 p-4 sm:w-auto sm:flex-1">
              <Ring pct={(p.expectedGrossCents ?? 0) ? (p.loggedGrossCents ?? 0) / (p.expectedGrossCents ?? 1) : 0}>
                <span className="leading-none">
                  <span className="figure block text-lg">{p.daysUntil ?? 0}</span>
                  <span className="text-[0.65rem] text-ink-3">day{p.daysUntil === 1 ? "" : "s"}</span>
                </span>
              </Ring>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{p.jobName}</p>
                <p className="text-xs text-ink-3">Payday {dayLabel(p.payDate!, today)}</p>
                <p className="figure mt-1.5 text-xl">{money(net(p.expectedGrossCents))}</p>
                <p className="text-xs text-ink-2">{money(net(p.loggedGrossCents))} earned so far</p>
              </div>
            </div>
          ) : (
            <button key={p.jobId} className="glass w-[82%] max-w-sm shrink-0 snap-start p-4 text-left sm:w-auto sm:flex-1" onClick={() => onOpenRecords("jobs")}>
              <p className="text-sm font-semibold">{p.jobName}</p>
              <p className="mt-1 text-sm text-ink-2">Set the paydays so Haru can count toward them.</p>
            </button>
          ),
        )}
      </div>
    </section>
  );
}

/** What to pay first, and when you're done. A sequence, so it's numbered. */
export function PayoffPlanCard({ c, onAsk }: { c: CoachData; onAsk: (t: string) => void }) {
  const money = useMoney();
  const p = c.plan;
  if (!p.items.length && !p.warnings.length) return null;
  return (
    <section aria-labelledby="plan-h" className="glass p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="plan-h" className="section-title">
            Payoff plan
          </h2>
          <p className="mt-0.5 text-sm text-ink-2">
            <span className={`figure ${p.surplusCents > 0 ? "text-iris" : "text-brick"}`}>{money(p.surplusCents)}</span> free each month after bills and minimums
          </p>
        </div>
        {p.debtFreeDate && (
          <div className="shrink-0 text-right">
            <p className="text-xs text-ink-3">Debt-free</p>
            <p className="figure aurora-text text-base">
              {shortDate(p.debtFreeDate)} {p.debtFreeDate.slice(2, 4) === new Date().getFullYear().toString().slice(2) ? "" : `’${p.debtFreeDate.slice(2, 4)}`}
            </p>
          </div>
        )}
      </div>
      {p.warnings.map((w) => (
        <p key={w} className="mt-3 rounded-2xl bg-amber-soft px-4 py-2.5 text-sm text-ink">
          {w}
        </p>
      ))}
      <ol className="mt-4 grid gap-1">
        {p.items.map((it, i) => (
          <li key={it.id} className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 ${i === 0 ? "bg-violet-soft" : ""}`}>
            <span className={`figure grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs ${i === 0 ? "bg-ink text-white" : "bg-paper-2 text-ink-2"}`}>{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{it.name}</p>
              <p className="truncate text-xs text-ink-3">{i === 0 ? "Put every extra dollar here" : it.reason}</p>
            </div>
            <div className="text-right">
              <p className="figure text-sm">{money(it.remainingCents)}</p>
              <p className="text-xs text-ink-3">{it.finishDate ? `done ${shortDate(it.finishDate)}` : "needs more shifts"}</p>
            </div>
          </li>
        ))}
      </ol>
      <button className="btn btn-quiet mt-2 px-2 text-sm text-iris" onClick={() => onAsk("How can I pay this off faster?")}>
        <Sparkles size={15} /> Ask Haru how to get there faster
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
    <section aria-labelledby="week-h">
      <div className="mb-2.5 flex items-baseline justify-between gap-2 px-1">
        <h2 id="week-h" className="section-title">
          Next 7 days
        </h2>
        <p className="text-sm text-ink-2">
          <span className="figure text-ink">{money(total)}</span> if you work them all
        </p>
      </div>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {days.map((d) => {
          const list = c.week.filter((s) => s.date === d);
          const isToday = d === today;
          return (
            <button
              key={d}
              onClick={onOpenSchedule}
              className={`min-w-[4.9rem] flex-1 rounded-[20px] px-3 py-3 text-left transition ${list.length ? "glass" : "border border-dashed border-line"} ${isToday ? "ring-2 ring-iris/40" : ""}`}
            >
              <p className={`text-xs font-semibold ${isToday ? "text-iris" : "text-ink-3"}`}>{isToday ? "Today" : new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", timeZone: "UTC" })}</p>
              <p className="text-[0.7rem] text-ink-3">{shortDate(d)}</p>
              {list.length ? (
                list.map((s) => (
                  <p key={s.id} className={`mt-2 ${s.attendance === "not_going" ? "text-ink-3 line-through" : ""}`}>
                    <span className="figure block text-sm">+{money(s.takeHomeCents)}</span>
                    <span className="block truncate text-[0.7rem] text-ink-2">{to12h(s.start)}</span>
                  </p>
                ))
              ) : (
                <p className="mt-2 text-xs text-ink-3">Off</p>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

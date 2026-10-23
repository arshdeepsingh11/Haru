"use client";

import { useState } from "react";
import { AlertCircle, BellRing, CalendarClock, Check, ChevronDown, Sparkles, X } from "lucide-react";
import type { DashboardData } from "@/lib/server/services/dashboard";
import type { ComponentKey } from "@/lib/dashboard-registry";
import { cancelReminderAction, observationAction, resetDashboardLayout } from "@/app/actions";
import { MoneyBar } from "./MoneyBar";
import { EarningsChart, SpendingChart } from "./Charts";
import { dayLabel, dayLabelInline, Empty, hours, Progress, useAct, useMoney, useToast } from "../ui";
import { useRouter } from "next/navigation";

export interface DashboardProps {
  data: DashboardData;
  onAsk: (text: string) => void;
  onOpenRecords: (tab?: string) => void;
}

function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="border-t border-line pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={`${id}-h`} className="section-title">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Dashboard({ data, onAsk, onOpenRecords }: DashboardProps) {
  const money = useMoney();
  const { run, pending } = useAct();
  const toast = useToast();
  const router = useRouter();
  const t = data.today;
  const custom = data.layout.length > 0;

  const render: Record<ComponentKey, () => React.ReactNode> = {
    attention: () => (
      <AttentionList items={data.attention} onAsk={onAsk} />
    ),
    position: () => <MoneyBar p={data.position} today={t} onSetBalance={() => onOpenRecords("money")} />,

    earnings: () => (
      <Section id="earn" title="Earnings" aside={<span className="text-xs text-ink-3">Gross, from logged work</span>}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-ink-2">This week</p>
            <p className="figure text-2xl font-[650]">{money(data.earnings.weekCents)}</p>
            <p className="text-xs text-ink-3">{hours(data.earnings.weekMinutes)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-2">This month</p>
            <p className="figure text-2xl font-[650]">{money(data.earnings.monthCents)}</p>
            <p className="text-xs text-ink-3">{hours(data.earnings.monthMinutes)}</p>
          </div>
        </div>
        {data.earnings.weekly.some((w) => w.total > 0) ? (
          <div className="mt-4">
            <EarningsChart weekly={data.earnings.weekly} jobNames={data.earnings.jobNames} />
            {data.earnings.byJobMonth.length > 1 && (
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                {data.earnings.byJobMonth.map((j) => (
                  <li key={j.name}>
                    <span className="text-ink-2">{j.name}</span> <span className="figure font-semibold">{money(j.cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="mt-3">
            <Empty>No hours logged in the last 8 weeks. Tell HARU when you finish a shift — “I worked 6 hours at the hotel today.”</Empty>
          </div>
        )}
      </Section>
    ),

    paydays: () => (
      <Section id="pay" title="Next paydays" aside={<span className="text-xs text-ink-3">Estimates from your payroll rules</span>}>
        <ul className="grid gap-2">
          {data.paydays.map((p) =>
            p.configured ? (
              <li key={p.jobId}>
                <details className="group rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
                  <summary className="flex cursor-pointer list-none items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{p.jobName}</p>
                      <p className="text-sm text-ink-2">
                        {dayLabel(p.payDate!, t)}
                        {p.daysUntil != null && p.daysUntil > 1 ? ` (in ${p.daysUntil} days)` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="figure text-lg font-semibold">{money(p.expectedGrossCents)}</p>
                      <p className="text-xs text-ink-3">{p.expectedNetCents != null ? `≈ ${money(p.expectedNetCents)} after your deductions` : "gross"}</p>
                    </div>
                    <ChevronDown size={16} className="text-ink-3 transition group-open:rotate-180" aria-hidden />
                  </summary>
                  <div className="mt-3 grid gap-1 border-t border-line pt-3 text-sm">
                    <Row k={`Logged hours (${p.periodStart} to ${p.periodEnd})`} v={money(p.loggedGrossCents)} />
                    {!!p.scheduledGrossCents && <Row k="Scheduled, not yet worked" v={money(p.scheduledGrossCents)} dashed />}
                    <Row k={`Reserve estimate (${data.reservePercent}%) — planning only`} v={money(p.reserveCents)} />
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink-3">
                      {p.uncertainty?.map((u) => <li key={u}>{u}</li>)}
                    </ul>
                  </div>
                </details>
              </li>
            ) : (
              <li key={p.jobId} className="flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
                <div>
                  <p className="font-semibold">{p.jobName}</p>
                  <p className="text-sm text-ink-3">Pay schedule not set, so HARU can't predict paydays.</p>
                </div>
                <button className="btn btn-line text-xs" onClick={() => onOpenRecords("jobs")}>
                  Set pay schedule
                </button>
              </li>
            ),
          )}
        </ul>
      </Section>
    ),

    upcoming_work: () => {
      const opps = data.opportunities.filter((o) => o.status === "accepted" || o.status === "scheduled");
      return (
        <Section id="work" title="Upcoming work">
          <ul className="divide-y divide-line">
            {data.upcomingShifts.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                <CalendarClock size={16} className="shrink-0 text-ink-3" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.jobName}</p>
                  <p className="text-sm text-ink-2">
                    {dayLabel(s.date, t)}
                    {s.start ? `, ${s.start}–${s.end}` : ""}, {hours(s.minutes)}
                  </p>
                </div>
                <span className="figure text-sm text-ink-2">{money(s.grossCents)} expected</span>
              </li>
            ))}
            {opps.map((o) => (
              <li key={o.id} className="flex items-center gap-3 py-2.5">
                <Sparkles size={16} className="shrink-0 text-goal" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {o.name} <span className="chip chip-goal ml-1">one-time</span>
                  </p>
                  <p className="text-sm text-ink-2">{o.date ? dayLabel(o.date, t) : "Date not set"}</p>
                </div>
                <button className="btn btn-line text-xs" disabled={pending || (o.date != null && o.date > t)} onClick={() => run("updateOpportunity", { opportunity_id: o.id, status: "completed" })} title={o.date && o.date > t ? "Available once the day arrives" : undefined}>
                  Mark done
                </button>
              </li>
            ))}
          </ul>
        </Section>
      );
    },

    opportunities: () => (
      <Section id="opp" title="One-time work">
        <ul className="grid gap-2">
          {data.opportunities
            .filter((o) => o.status === "considering" || (o.status === "completed" && !o.paid))
            .map((o) => (
              <OpportunityRow key={o.id} o={o} today={t} />
            ))}
        </ul>
      </Section>
    ),

    bills: () => (
      <Section id="bills" title="Bills" aside={<button className="text-xs text-ink-2 underline underline-offset-4" onClick={() => onOpenRecords("bills")}>All bills</button>}>
        <ul className="divide-y divide-line">
          {data.bills.slice(0, 6).map((b) => (
            <li key={b.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{b.name}</p>
                <p className="text-sm">
                  <span className={`chip ${b.daysUntil < 0 ? "chip-brick" : b.daysUntil <= 2 ? "chip-amber" : "chip-slate"}`}>
                    {b.daysUntil < 0 ? `Overdue since ${dayLabel(b.dueDate, t)}` : `Due ${dayLabelInline(b.dueDate, t)}`}
                  </span>
                  {b.recurrence !== "none" && <span className="ml-2 text-ink-3">{b.recurrence}</span>}
                </p>
              </div>
              <span className="figure font-semibold">{money(b.amountCents)}</span>
              <button className="btn btn-line text-xs" disabled={pending} onClick={() => run("markBillPaid", { bill_id: b.id, paid_on: t })}>
                Mark paid
              </button>
            </li>
          ))}
        </ul>
      </Section>
    ),

    goals: () => (
      <Section id="goals" title="Savings goals" aside={<span className="text-xs text-ink-3">Money set aside from your cash</span>}>
        <ul className="grid gap-4">
          {data.goals.map((g) => (
            <GoalRow key={g.id} g={g} today={t} />
          ))}
        </ul>
      </Section>
    ),

    debts: () => (
      <Section id="debts" title="Debt">
        <ul className="grid gap-4">
          {data.debts.map((d) => (
            <li key={d.id}>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="font-medium">{d.name}</span>
                <span className="figure text-sm">
                  <span className="font-semibold">{money(d.balanceCents)}</span> <span className="text-ink-3">left of {money(d.startingCents)}</span>
                </span>
              </div>
              <Progress value={(d.paidCents / d.startingCents) * 100} tone="slate" label={`${d.name} paid off`} />
            </li>
          ))}
        </ul>
      </Section>
    ),

    spending: () => (
      <Section id="spend" title="Spending" aside={<span className="figure text-sm text-ink-2">{money(data.spending.monthCents)} this month</span>}>
        <SpendingChart weekly={data.spending.weekly} />
        {data.spending.topCategories.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {data.spending.topCategories.map((c) => (
              <li key={c.category}>
                <span className="capitalize text-ink-2">{c.category}</span> <span className="figure font-semibold">{money(c.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    ),

    reminders: () => (
      <Section id="rem" title="Reminders">
        <ul className="divide-y divide-line">
          {data.reminders.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <BellRing size={15} className="shrink-0 text-ink-3" aria-hidden />
              <p className="min-w-0 flex-1 text-sm">
                {r.title}
                <span className="block text-xs text-ink-3">{new Date(r.fireAt).toLocaleString("en-CA", { timeZone: data.tz, weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}</span>
              </p>
              <button
                className="btn btn-quiet px-2 text-xs"
                aria-label={`Cancel reminder ${r.title}`}
                onClick={async () => {
                  const res = await cancelReminderAction(r.id);
                  toast(res.ok ? "Reminder cancelled" : res.error, res.ok ? "ok" : "error");
                  router.refresh();
                }}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      </Section>
    ),

    insights: () => (
      <Section id="ins" title="Patterns HARU noticed">
        <ul className="grid gap-3">
          {data.insights.map((i) => (
            <li key={i.id} className="rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
              <p>{i.statement}</p>
              <p className="mt-1 text-xs text-ink-3">
                <span className={`chip ${i.confidence === "observed" ? "chip-moss" : "chip-slate"} mr-2`}>{i.confidence === "observed" ? "Consistent pattern" : "Early pattern"}</span>
                Based on {i.basis.charAt(0).toLowerCase() + i.basis.slice(1)}
              </p>
              <div className="mt-2 flex gap-2">
                <button className="btn btn-line py-1 text-xs" onClick={async () => { await observationAction(i.id, "accepted"); toast("Thanks — noted."); router.refresh(); }}>
                  <Check size={13} /> Useful
                </button>
                <button className="btn btn-quiet py-1 text-xs" onClick={async () => { await observationAction(i.id, "dismissed"); toast("Dismissed. HARU won't use it."); router.refresh(); }}>
                  Not right
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    ),

    activity: () => (
      <Section id="act" title="Recent activity">
        <ul className="grid gap-1.5 text-sm">
          {data.activity.map((a) => (
            <li key={a.id} className="flex gap-3">
              <span className="w-16 shrink-0 text-xs text-ink-3">{new Date(a.at).toLocaleDateString("en-CA", { timeZone: data.tz, month: "short", day: "numeric" })}</span>
              <span className="min-w-0 text-ink-2">
                {a.summary}
                {a.actor === "ai" && <span className="ml-1.5 text-xs text-ink-3">via HARU</span>}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    ),
  };

  const hour = Number(new Date().toLocaleString("en-US", { timeZone: data.tz, hour: "numeric", hourCycle: "h23" }));
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-[650] tracking-tight sm:text-[1.75rem]">
          {greeting}
          {data.displayName ? `, ${data.displayName}` : ""}
        </h1>
        <p className="text-ink-2">{new Date(`${t}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</p>
      </div>

      {data.isEmpty && <FirstSteps onAsk={onAsk} onOpenRecords={onOpenRecords} />}

      {data.order.map((k) => (
        <div key={k}>{render[k]()}</div>
      ))}

      {custom && (
        <p className="text-xs text-ink-3">
          You've customised this layout.{" "}
          <button className="underline underline-offset-4" onClick={async () => { await resetDashboardLayout(); router.refresh(); }}>
            Let HARU arrange it again
          </button>
        </p>
      )}
    </div>
  );
}

/** Calm, capped list: the most urgent first; the rest behind "Show N more". */
function AttentionList({ items, onAsk }: { items: DashboardData["attention"]; onAsk: (t: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 3);
  return (
    <section aria-label="Needs attention" className="grid gap-2">
      {shown.map((a) => (
        <div key={a.id} className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-2xl px-4 py-3 sm:flex-nowrap ${a.tone === "urgent" ? "bg-brick-soft" : a.tone === "warn" ? "bg-amber-soft" : "bg-slate-soft"}`}>
          <AlertCircle size={18} className={`mt-0.5 shrink-0 ${a.tone === "urgent" ? "text-brick" : a.tone === "warn" ? "text-amber" : "text-slate"}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{a.title}</p>
            <p className="text-sm text-ink-2">{a.detail}</p>
          </div>
          {a.ask && (
            <button className="btn btn-line ml-[1.875rem] shrink-0 py-1 text-xs sm:ml-0" onClick={() => onAsk(a.ask!)}>
              Tell HARU
            </button>
          )}
        </div>
      ))}
      {items.length > 3 && (
        <button className="w-fit text-sm text-ink-2 underline underline-offset-4" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show ${items.length - 3} more`}
        </button>
      )}
    </section>
  );
}

function Row({ k, v, dashed }: { k: string; v: string; dashed?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className={dashed ? "text-slate" : "text-ink-2"}>{k}</span>
      <span className="figure font-medium">{v}</span>
    </div>
  );
}

function OpportunityRow({ o, today }: { o: DashboardData["opportunities"][number]; today: string }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const [amount, setAmount] = useState((o.offeredCents / 100).toFixed(2));
  return (
    <li className="rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{o.name}</p>
          <p className="text-sm text-ink-2">
            {o.date ? dayLabel(o.date, today) : "No date yet"}
            {o.minutes ? `, ${hours(o.minutes)}` : ""}
          </p>
        </div>
        <span className={`chip ${o.status === "completed" ? "chip-moss" : "chip-slate"}`}>{o.status === "completed" ? "Done, awaiting payment" : "Considering"}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
        <div>
          <p className="text-xs text-ink-3">Offered</p>
          <p className="figure font-semibold">{money(o.offeredCents)}</p>
        </div>
        <div>
          <p className="text-xs text-ink-3">Per hour</p>
          <p className="figure font-semibold">{o.hourlyCents != null ? money(o.hourlyCents) : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-ink-3">Reserve est.</p>
          <p className="figure font-semibold">{money(o.reserveCents)}</p>
        </div>
      </div>
      {o.payBasis === "unknown" && <p className="mt-1 text-xs text-ink-3">Not known yet whether this is before or after deductions.</p>}
      {o.status === "considering" ? (
        <div className="mt-3 flex gap-2">
          <button className="btn btn-primary py-1 text-xs" disabled={pending} onClick={() => run("updateOpportunity", { opportunity_id: o.id, status: o.date ? "scheduled" : "accepted" })}>
            Accept
          </button>
          <button className="btn btn-quiet py-1 text-xs" disabled={pending} onClick={() => run("updateOpportunity", { opportunity_id: o.id, status: "declined" })}>
            Decline
          </button>
        </div>
      ) : (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run("recordIncome", { amount: Number(amount), date: today, opportunity_id: o.id, description: o.name });
          }}
        >
          <label className="field flex-1">
            Amount that arrived
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={pending || !(Number(amount) > 0)}>
            Payment arrived
          </button>
        </form>
      )}
    </li>
  );
}

function GoalRow({ g, today }: { g: DashboardData["goals"][number]; today: string }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const pct = (g.savedCents / g.targetCents) * 100;
  return (
    <li>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-medium">{g.name}</span>
        <span className="figure text-sm">
          <span className="font-semibold">{money(g.savedCents)}</span> <span className="text-ink-3">of {money(g.targetCents)}</span>
        </span>
      </div>
      <Progress value={pct} tone="goal" label={`${g.name} progress`} />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
        <span>
          {g.monthlyTargetCents ? `${money(g.thisMonthCents)} of ${money(g.monthlyTargetCents)} this month` : `${Math.round(pct)}%`}
          {g.targetDate ? `, by ${g.targetDate}` : ""}
        </span>
        <button className="underline underline-offset-4" onClick={() => setOpen(!open)}>
          Set money aside
        </button>
      </div>
      {open && (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run("contributeToGoal", { goal_id: g.id, amount: Number(amount), date: today }, (r) => r.ok && (setOpen(false), setAmount("")));
          }}
        >
          <label className="field flex-1">
            Amount (negative to take back)
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </label>
          <button className="btn btn-primary" disabled={pending || !Number(amount)}>
            Save
          </button>
        </form>
      )}
    </li>
  );
}

function FirstSteps({ onAsk, onOpenRecords }: { onAsk: (t: string) => void; onOpenRecords: (tab?: string) => void }) {
  const prompts = ["I work at Northgate Security for $20/h, paid every two weeks", "I have $850 in my chequing account", "My phone bill is $115 due on the 25th", "I want to save $5,000"];
  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="text-lg font-semibold">Tell HARU about your work and money</h2>
      <p className="mt-1 max-w-[60ch] text-ink-2">Type it the way you'd say it. Nothing appears here until you add it — HARU never fills your dashboard with made-up numbers.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {prompts.map((p) => (
          <button key={p} className="btn btn-line text-left text-sm font-normal" onClick={() => onAsk(p)}>
            {p}
          </button>
        ))}
      </div>
      <button className="btn btn-quiet mt-3 px-0 text-sm underline underline-offset-4" onClick={() => onOpenRecords("jobs")}>
        Or add things with forms
      </button>
    </section>
  );
}

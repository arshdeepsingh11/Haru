"use client";

import { useState } from "react";
import { AlertCircle, BellRing, Check, Minus, Sparkles, X } from "lucide-react";
import type { DashboardData } from "@/lib/server/services/dashboard";
import { CARDS, type CardKey } from "@/lib/dashboard-registry";
import { cancelReminderAction, editCards, observationAction } from "@/app/actions";
import { AuroraOrb } from "../AuroraOrb";
import { MoneyBar } from "./MoneyBar";
import { EarningsChart, SpendingChart } from "./Charts";
import { CheckoutCards, NextShiftHero, PaycheckCards, PayoffPlanCard, StatTiles, WeekStrip } from "../home/ShiftHome";
import { dayLabel, dayLabelInline, Empty, hours, Progress, useAct, useMoney, useToast } from "../ui";
import { useRouter } from "next/navigation";

export interface DashboardProps {
  data: DashboardData;
  onAsk: (text: string) => void;
  onOpenRecords: (tab?: string) => void;
  onOpenSchedule: () => void;
  /** Cards Haru just added, so they can shimmer in once. */
  fresh?: CardKey[];
}

function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="glass p-5">
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

export function Dashboard({ data, onAsk, onOpenRecords, onOpenSchedule, fresh = [] }: DashboardProps) {
  const money = useMoney();
  const { run, pending } = useAct();
  const toast = useToast();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const t = data.today;
  const c = data.coach;

  // Each card renders its content, or null when it has nothing real to show yet.
  const render: Record<CardKey, () => React.ReactNode> = {
    next_shift: () => <NextShiftHero c={c} today={t} onOpenSchedule={onOpenSchedule} />,
    paychecks: () => (data.paydays.length ? <PaycheckCards paydays={data.paydays} taxPercent={c.taxPercent} today={t} onOpenRecords={onOpenRecords} /> : null),
    week: () => <WeekStrip c={c} today={t} onOpenSchedule={onOpenSchedule} />,
    stats: () => <StatTiles c={c} />,
    payoff: () => <PayoffPlanCard c={c} onAsk={onAsk} />,
    money: () => <MoneyBar p={data.position} today={t} onSetBalance={() => onOpenRecords("money")} />,

    earnings: () => (
      <section aria-labelledby="earn-h" className="glass p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="earn-h" className="section-title">
            Take-home
          </h2>
          <span className="text-xs text-ink-3">after {data.reservePercent}% tax, from logged shifts</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-ink-2">This week</p>
            <p className="figure text-3xl font-bold text-violet">{money(Math.round(data.earnings.weekCents * (1 - data.reservePercent / 100)))}</p>
            <p className="text-xs text-ink-3">{hours(data.earnings.weekMinutes)} worked</p>
          </div>
          <div>
            <p className="text-xs text-ink-2">This month</p>
            <p className="figure text-3xl font-bold">{money(Math.round(data.earnings.monthCents * (1 - data.reservePercent / 100)))}</p>
            <p className="text-xs text-ink-3">{hours(data.earnings.monthMinutes)} worked</p>
          </div>
        </div>
        {data.earnings.weekly.some((w) => w.total > 0) ? (
          <div className="mt-4">
            <EarningsChart weekly={data.earnings.weekly} taxPercent={data.reservePercent} />
          </div>
        ) : (
          <div className="mt-3">
            <Empty>Your chart fills in as you check out of shifts.</Empty>
          </div>
        )}
      </section>
    ),

    opportunities: () =>
      !data.opportunities.some((o) => o.status === "considering" || (o.status === "completed" && !o.paid)) ? null : (
      <Section id="opp" title="Extra work">
        <ul className="grid gap-2">
          {data.opportunities
            .filter((o) => o.status === "considering" || (o.status === "completed" && !o.paid))
            .map((o) => (
              <OpportunityRow key={o.id} o={o} today={t} />
            ))}
        </ul>
      </Section>
    ),

    bills: () =>
      !data.bills.length ? null : (
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

    goals: () =>
      !data.goals.length ? null : (
      <Section id="goals" title="Goals" aside={<span className="text-xs text-ink-3">Money set aside from your cash</span>}>
        <ul className="grid gap-4">
          {data.goals.map((g) => (
            <GoalRow key={g.id} g={g} today={t} />
          ))}
        </ul>
      </Section>
    ),

    debts: () =>
      !data.debts.length ? null : (
      <Section id="debts" title="Debts">
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

    spending: () =>
      !data.spending.weekly.some((w) => w.cents > 0) ? null : (
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

    reminders: () =>
      !data.reminders.length ? null : (
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

    insights: () =>
      !data.insights.length ? null : (
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

    activity: () =>
      !data.activity.length ? null : (
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
  const greeting = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const shown = data.cards.map((k) => ({ k, node: render[k]() })).filter((x) => x.node != null);

  async function remove(k: CardKey) {
    const r = await editCards({ remove: [k] });
    toast(r.ok ? `Removed ${CARDS[k].title}. Ask Haru to bring it back anytime.` : r.error, r.ok ? "ok" : "error");
    router.refresh();
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="px-1">
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight">
          {greeting}
          {data.displayName ? `, ${data.displayName}` : ""}
        </h1>
        <p className="text-ink-3">{new Date(`${t}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</p>
      </div>

      <CheckoutCards items={c.checkouts} today={t} taxPercent={c.taxPercent} />
      {data.attention.length > 0 && <AttentionList items={data.attention} onAsk={onAsk} />}

      {shown.length === 0 ? (
        <section className="glass grid justify-items-center gap-3 px-6 py-10 text-center">
          <AuroraOrb size={72} />
          <p className="text-lg font-semibold">Nothing on your dashboard yet</p>
          <p className="max-w-xs text-sm text-ink-2">Tell Haru about your jobs, bills and goals. Cards appear here as you talk.</p>
          <button className="btn btn-primary mt-1" onClick={() => onAsk("")}>
            Talk to Haru
          </button>
        </section>
      ) : (
        shown.map(({ k, node }) => (
          <div key={k} className={`relative ${fresh.includes(k) ? "card-new" : ""}`}>
            {node}
            {editing && (
              <button className="absolute -right-1.5 -top-1.5 z-10 grid h-8 w-8 place-items-center rounded-full bg-ink text-white shadow-lg" onClick={() => remove(k)} aria-label={`Remove ${CARDS[k].title}`}>
                <Minus size={16} />
              </button>
            )}
          </div>
        ))
      )}

      {shown.length > 0 && (
        <div className="flex items-center justify-center gap-4 pt-2 text-sm text-ink-3">
          <button className="underline-offset-4 hover:underline" onClick={() => setEditing(!editing)}>
            {editing ? "Done" : "Edit dashboard"}
          </button>
          <button className="inline-flex items-center gap-1 underline-offset-4 hover:underline" onClick={() => onAsk("Change my dashboard: ")}>
            <Sparkles size={13} /> Ask Haru to change it
          </button>
        </div>
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

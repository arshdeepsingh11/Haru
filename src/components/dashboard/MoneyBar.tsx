"use client";

import type { DashboardData } from "@/lib/server/services/dashboard";
import { dayLabelInline, useMoney } from "../ui";

/**
 * The signature view: cash as one solid bar split into reserved / goals / safe,
 * with unpaid and expected income drawn as dashed ghosts beyond it. They are
 * never added into the cash figure.
 */
export function MoneyBar({ p, today, onSetBalance }: { p: DashboardData["position"]; today: string; onSetBalance: () => void }) {
  const money = useMoney();
  const cash = Math.max(0, p.cashCents);
  const reserved = p.reservedForObligationsCents;
  const goals = p.allocatedToGoalsCents;
  const safe = Math.max(0, p.safeToAllocateCents);
  const short = p.shortfall ? -p.safeToAllocateCents : 0;
  const unpaid = p.earnedUnpaidCents;
  const moreExpected = Math.max(0, p.expectedIncomeCents - unpaid);
  const solid = Math.max(cash, reserved + goals);
  const total = solid + unpaid + moreExpected || 1;
  const w = (c: number) => `${(c / total) * 100}%`;
  // Segments inside the cash bar (reserved first, then goals, then what's free)
  const resIn = Math.min(reserved, cash);
  const goalsIn = Math.min(goals, Math.max(0, cash - resIn));

  return (
    <section aria-labelledby="money-h" className="glass p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="money-h" className="section-title">
          Cash you have
        </h2>
        {p.hasAccounts ? (
          <span className="text-xs text-ink-3">Tracked in Haru, not a bank feed</span>
        ) : null}
      </div>
      <p className={`figure mt-2 text-[2.3rem] leading-none sm:text-5xl ${p.cashCents < 0 ? "text-brick" : ""}`}>{money(p.cashCents)}</p>
      {!p.balanceConfirmed && (
        <button onClick={onSetBalance} className="mt-2 text-left text-sm text-amber underline decoration-dotted underline-offset-4">
          {p.hasAccounts ? "Some balances haven't been confirmed — set what's really in your accounts" : "Add your account balance so this number is real"}
        </button>
      )}

      <div className="mt-5 flex h-3.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {resIn > 0 && <div className="bar-grow h-full bg-amber" style={{ width: w(resIn) }} />}
        {goalsIn > 0 && <div className="bar-grow h-full bg-goal" style={{ width: w(goalsIn) }} />}
        {safe > 0 && <div className="bar-grow h-full bg-moss" style={{ width: w(safe) }} />}
        {short > 0 && <div className="h-full bg-brick-soft" style={{ width: w(short), backgroundImage: "repeating-linear-gradient(135deg, var(--brick) 0 2px, transparent 2px 7px)" }} />}
        {unpaid > 0 && <div className="unpaid ml-1 h-full rounded-md" style={{ width: w(unpaid) }} />}
        {moreExpected > 0 && <div className="projected ml-1 h-full rounded-md" style={{ width: w(moreExpected) }} />}
        {total === 1 && <div className="h-full w-full rounded-lg bg-paper-2" />}
      </div>
      <p className="mt-2 text-xs text-ink-3">Solid is money in your accounts. Dashed hasn't arrived yet.</p>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Stat dot="bg-amber" label={`Reserved for bills until ${p.horizonIsPayday ? "payday" : dayLabelInline(p.horizon, today)}`} value={money(reserved)} />
        <Stat dot="bg-goal" label="Set aside for goals" value={money(goals)} />
        <Stat dot={p.shortfall ? "bg-brick" : "bg-moss"} label={p.shortfall ? "Short before payday" : "Safe to use"} value={money(p.shortfall ? -short : safe)} strong tone={p.shortfall ? "text-brick" : "text-moss"} />
        <Stat dashed="unpaid" label="Earned, not paid yet" value={money(unpaid)} />
        <Stat dashed="projected" label="Expected next (estimate)" value={money(p.expectedIncomeCents)} />
        <Stat label="Debt owed" value={money(p.debtCents)} />
      </dl>
    </section>
  );
}

function Stat({ label, value, dot, dashed, strong, tone }: { label: string; value: string; dot?: string; dashed?: "unpaid" | "projected"; strong?: boolean; tone?: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-ink-2">
        {dot && <span className={`inline-block h-2.5 w-2.5 rounded-sm ${dot}`} />}
        {dashed && <span className={`inline-block h-2.5 w-2.5 rounded-sm ${dashed}`} style={{ borderWidth: 1 }} />}
        {label}
      </dt>
      <dd className={`figure mt-0.5 ${strong ? "text-xl" : "text-base"} ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

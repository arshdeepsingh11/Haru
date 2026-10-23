"use client";

import { Download } from "lucide-react";
import type { Report } from "@/lib/domain/report";
import { hours, useMoney } from "./ui";

/** A report rendered from deterministic data. Projections sit in a dashed box, never in the totals. */
export function ReportCard({ display }: { display: { report: Report; compare?: Report; period: string; start?: string; end?: string } }) {
  const money = useMoney();
  const r = display.report;
  const c = display.compare;
  const qs = new URLSearchParams({ period: display.period, ...(display.start ? { start: display.start } : {}), ...(display.end ? { end: display.end } : {}) });
  const delta = (now: number, before?: number) =>
    before == null ? null : <span className={`ml-1 text-xs ${now - before >= 0 ? "text-moss" : "text-brick"}`}>{money(now - before, { signed: true })}</span>;

  return (
    <article className="rounded-2xl border border-line bg-surface p-4 text-sm" aria-label={`Report ${r.range.label}`}>
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{r.range.label}</p>
          <p className="text-xs text-ink-3">
            {r.range.start} to {r.range.end}
            {c ? `, compared with ${c.range.label}` : ""}
          </p>
        </div>
        <a className="btn btn-line py-1 text-xs" href={`/api/export?${qs}`} download>
          <Download size={13} aria-hidden /> CSV
        </a>
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-ink-2">Earned (gross)</dt>
          <dd className="figure text-lg font-semibold">
            {money(r.earned.totalGrossCents)}
            {delta(r.earned.totalGrossCents, c?.earned.totalGrossCents)}
          </dd>
          <dd className="text-xs text-ink-3">{hours(r.earned.totalMinutes)} logged</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Money received</dt>
          <dd className="figure text-lg font-semibold">
            {money(r.received.totalCents)}
            {delta(r.received.totalCents, c?.received.totalCents)}
          </dd>
          <dd className="text-xs text-ink-3">paychecks and other income</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Spent</dt>
          <dd className="figure text-lg font-semibold">
            {money(r.spending.totalCents)}
            {delta(r.spending.totalCents, c?.spending.totalCents)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Net cash flow</dt>
          <dd className={`figure text-lg font-semibold ${r.netCashFlowCents < 0 ? "text-brick" : ""}`}>{money(r.netCashFlowCents)}</dd>
          <dd className="text-xs text-ink-3">received − spent − debt payments</dd>
        </div>
      </dl>

      {(r.earned.byJob.length > 0 || r.earned.oneTimeWork.length > 0) && (
        <section className="mt-3 border-t border-line pt-3">
          <h3 className="text-xs font-semibold text-ink-2">Earned by job</h3>
          <ul className="mt-1 grid gap-0.5">
            {r.earned.byJob.map((j) => (
              <li key={j.name} className="flex justify-between">
                <span>
                  {j.name} <span className="text-ink-3">({hours(j.minutes)}, {j.shifts} shift{j.shifts === 1 ? "" : "s"})</span>
                </span>
                <span className="figure">{money(j.grossCents)}</span>
              </li>
            ))}
            {r.earned.oneTimeWork.map((o) => (
              <li key={o.name} className="flex justify-between">
                <span>{o.name} <span className="text-ink-3">(one-time)</span></span>
                <span className="figure">{money(o.earnedCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.spending.byCategory.length > 0 && (
        <section className="mt-3 border-t border-line pt-3">
          <h3 className="text-xs font-semibold text-ink-2">Spending by category</h3>
          <ul className="mt-1 grid gap-0.5">
            {r.spending.byCategory.map((s) => (
              <li key={s.category} className="flex justify-between capitalize">
                <span>{s.category}</span>
                <span className="figure">{money(s.cents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(r.debtPaymentsCents > 0 || r.savedToGoals.totalCents !== 0 || r.bills.unpaid.length > 0) && (
        <section className="mt-3 grid gap-0.5 border-t border-line pt-3">
          {r.debtPaymentsCents > 0 && <Line k="Debt payments" v={money(r.debtPaymentsCents)} />}
          {r.savedToGoals.totalCents !== 0 && <Line k="Set aside for goals (not spending)" v={money(r.savedToGoals.totalCents)} />}
          {r.bills.unpaid.map((b) => (
            <Line key={`${b.name}${b.dueDate}`} k={`Unpaid: ${b.name}, due ${b.dueDate}`} v={money(b.amountCents)} />
          ))}
        </section>
      )}

      {r.projected.totalCents > 0 && (
        <section className="projected mt-3 rounded-xl p-3">
          <h3 className="text-xs font-semibold text-slate">Projected — not earned or received yet</h3>
          <ul className="mt-1 grid gap-0.5">
            {r.projected.paychecks.map((p) => (
              <Line key={`${p.jobName}${p.payDate}`} k={`${p.jobName} paycheck, ${p.payDate} (gross)`} v={money(p.grossCents)} />
            ))}
            {r.projected.opportunities.map((o) => (
              <Line key={o.name} k={`${o.name} (one-time${o.date ? `, ${o.date}` : ""})`} v={money(o.cents)} />
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-2">{k}</span>
      <span className="figure">{v}</span>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Loader2, PiggyBank, Send } from "lucide-react";
import type { PlanData } from "@/lib/server/invest/planning";
import { monthlyFor, sip } from "@/lib/invest/plan";
import { buildPayoffPlan } from "@/lib/domain/payoff";
import { Sheet } from "../ui";
import { PriceChart } from "./PriceChart";
import { fmtPrice } from "./format";

// The SIP / goal planner and the send-home planner. Every number is computed on the phone from
// HARU's own records and the official CAD→INR rate, so moving a slider answers instantly.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthYear = (d: string | null) => (d ? `${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "not within 50 years");
const monthsUntil = (from: string, to: string | null) => (to ? Math.max(0, (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7))) : 0);

function usePlanData(open: boolean) {
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || data) return;
    fetch("/api/invest/plan")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Couldn't load your plan.");
        setData(j);
      })
      .catch((e) => setError((e as Error).message));
  }, [open, data]);
  return { data, error };
}

/** Two entry cards on the Invest tab. */
export function PlanCards({ onSip, onSend }: { onSip: () => void; onSend: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <button onClick={onSip} className="glass grid gap-1.5 p-3.5 text-left">
        <span className="coin grid h-9 w-9 place-items-center rounded-xl">
          <PiggyBank size={18} />
        </span>
        <span className="font-semibold leading-tight">SIP & goals</span>
        <span className="text-xs leading-snug text-ink-3">What monthly investing grows to, from your real budget</span>
      </button>
      <button onClick={onSend} className="glass grid gap-1.5 p-3.5 text-left">
        <span className="coin grid h-9 w-9 place-items-center rounded-xl">
          <Send size={17} />
        </span>
        <span className="font-semibold leading-tight">Send home</span>
        <span className="text-xs leading-snug text-ink-3">Today's CAD→INR rate and how much you can safely send</span>
      </button>
    </div>
  );
}

function Num({ label, value, onChange, suffix, step = "1" }: { label: string; value: string; onChange: (v: string) => void; suffix?: string; step?: string }) {
  return (
    <label className="field min-w-0">
      {label}
      <div className="relative">
        <input className="input w-full pr-10" inputMode="decimal" step={step} value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-3">{suffix}</span>}
      </div>
    </label>
  );
}

function Chips<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" className="choice px-3 text-sm" aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ SIP / goal
const RETURNS: [number, string][] = [
  [0.07, "7% steady"],
  [0.1, "10% balanced"],
  [0.12, "12% index"],
];

export function SipSheet({ open, onClose, country }: { open: boolean; onClose: () => void; country: "IN" | "CA" | "WORLD" }) {
  const { data, error } = usePlanData(open);
  const [mode, setMode] = useState<"grow" | "goal">("grow");
  const [cur, setCur] = useState<"INR" | "CAD">(country === "IN" ? "INR" : "CAD");
  const [monthly, setMonthly] = useState(country === "IN" ? "10000" : "200");
  const [target, setTarget] = useState(country === "IN" ? "1000000" : "20000");
  const [years, setYears] = useState(10);
  const [ret, setRet] = useState(0.1);
  const [step, setStep] = useState(0);
  const [afterDebts, setAfterDebts] = useState(false);

  const fx = data?.fx.rate ?? null; // rupees per CAD
  const homeCur = data?.currency ?? "CAD";
  const inflation = cur === "INR" ? 0.05 : 0.025;
  const delay = afterDebts && data ? monthsUntil(data.inputs.today, data.plan.debtFreeDate) : 0;
  const m = Number(monthly) || 0;
  const res = useMemo(() => sip({ monthly: m, years, annualReturn: ret, stepUp: step, inflation, delayMonths: delay }), [m, years, ret, step, inflation, delay]);
  const need = useMemo(() => monthlyFor(Number(target) || 0, years, ret), [target, years, ret]);
  const toHome = (v: number) => (cur === homeCur ? v : cur === "INR" && homeCur === "CAD" && fx ? v / fx : homeCur === "INR" && cur === "CAD" && fx ? v * fx : null);
  const surplus = data ? data.plan.surplusCents / 100 : null;
  const monthlyNow = mode === "grow" ? m : need;
  const share = surplus && surplus > 0 && toHome(monthlyNow) != null ? toHome(monthlyNow)! / surplus : null;
  const maxV = Math.max(1, ...res.byYear.map((y) => y.value));

  return (
    <Sheet open={open} onClose={onClose} title="SIP & goals">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Chips<"grow" | "goal">
          value={mode}
          onChange={setMode}
          options={[
            ["grow", "What will it grow to?"],
            ["goal", "How much a month?"],
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          {mode === "grow" ? <Num label="Each month" value={monthly} onChange={setMonthly} suffix={cur === "INR" ? "₹" : "$"} /> : <Num label="Goal amount" value={target} onChange={setTarget} suffix={cur === "INR" ? "₹" : "$"} />}
          <label className="field">
            Currency
            <select className="input" value={cur} onChange={(e) => setCur(e.target.value as "INR" | "CAD")}>
              <option value="INR">Rupees (₹)</option>
              <option value="CAD">Canadian $</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span className="flex justify-between">
            For <b>{years} years</b>
          </span>
          <input type="range" min={1} max={30} value={years} onChange={(e) => setYears(Number(e.target.value))} className="w-full accent-[var(--iris)]" />
        </label>
        <div className="grid gap-2">
          <p className="text-sm font-semibold">Expected return a year</p>
          <Chips value={ret} onChange={setRet} options={RETURNS} />
          <p className="text-xs text-ink-3">Assumptions, not promises. 7% is close to deposits and debt funds, 10–12% to long-run stock index averages. Real years swing well above and below.</p>
        </div>
        {mode === "grow" && (
          <div className="grid gap-2">
            <p className="text-sm font-semibold">Raise it every year by</p>
            <Chips
              value={step}
              onChange={setStep}
              options={[
                [0, "0%"],
                [0.05, "5%"],
                [0.1, "10%"],
              ]}
            />
          </div>
        )}
        {data?.plan.focus && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={afterDebts} onChange={(e) => setAfterDebts(e.target.checked)} />
            <span>
              Start after my debts are cleared (<b>{monthYear(data.plan.debtFreeDate)}</b>)
            </span>
          </label>
        )}

        {/* Result */}
        <section className="hero grid gap-3 p-4" aria-live="polite">
          {mode === "grow" ? (
            <>
              <div>
                <p className="text-sm text-ink-2">{delay ? `Starting ${monthYear(data?.plan.debtFreeDate ?? null)}, after ${years} years you could have` : `In ${years} years you could have`}</p>
                <p className="figure text-[2rem] leading-tight">{fmtPrice(res.value, cur, { compact: true })}</p>
                <p className="text-sm text-ink-2">
                  You put in {fmtPrice(res.invested, cur, { compact: true })}, growth {fmtPrice(res.gain, cur, { compact: true })}. Worth about <b>{fmtPrice(res.real, cur, { compact: true })}</b> in today's money ({(inflation * 100).toFixed(1)}% inflation).
                </p>
              </div>
              <div className="flex h-24 items-end gap-[3px]" aria-hidden>
                {res.byYear.map((y) => (
                  <div key={y.year} className="relative flex-1 rounded-t" style={{ height: `${Math.max(3, (y.value / maxV) * 100)}%`, background: "var(--iris)", opacity: 0.85 }}>
                    <div className="absolute bottom-0 w-full rounded-t" style={{ height: `${(y.invested / y.value) * 100}%`, background: "rgb(255 255 255 / 0.25)" }} />
                  </div>
                ))}
              </div>
              <p className="text-xs text-ink-3">Light part: what you put in. Gold: growth.</p>
            </>
          ) : (
            <div>
              <p className="text-sm text-ink-2">To reach {fmtPrice(Number(target) || 0, cur, { compact: true })} in {years} years</p>
              <p className="figure text-[2rem] leading-tight">{fmtPrice(need, cur, { compact: true })}/month</p>
              <p className="text-sm text-ink-2">at {(ret * 100).toFixed(0)}% a year, invested at the start of each month.</p>
            </div>
          )}
          {data && surplus != null && (
            <p className="rounded-xl bg-paper-2 px-3 py-2 text-sm">
              {surplus <= 0
                ? "Your budget shows nothing free each month yet, so any SIP would come from savings. Clear the gap first."
                : share == null
                  ? `You have about ${fmtPrice(surplus, homeCur)} free a month.`
                  : share > 1
                    ? `That's ${fmtPrice(toHome(monthlyNow)!, homeCur)} a month, more than the ${fmtPrice(surplus, homeCur)} you have free. Try a smaller amount or more years.`
                    : `That's ${fmtPrice(toHome(monthlyNow)!, homeCur)} a month, ${Math.round(share * 100)}% of the ${fmtPrice(surplus, homeCur)} you have free.${data.plan.focus && !afterDebts ? ` It would slow paying off ${data.plan.focus.name}.` : ""}`}
            </p>
          )}
          {error && <p className="text-sm text-brick">{error}</p>}
          <p className="border-t border-line pt-2.5 text-[0.72rem] leading-snug text-ink-3">An estimate with a fixed return. Real markets go up and down, and fees and taxes reduce returns. Not financial advice.</p>
        </section>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ send home
export function SendHomeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error } = usePlanData(open);
  const [cur, setCur] = useState<"CAD" | "INR">("CAD");
  const [amount, setAmount] = useState("500");
  const fx = data?.fx.rate ?? null;
  const a = Number(amount) || 0;
  const cad = cur === "CAD" ? a : fx ? a / fx : 0;
  const inr = cur === "INR" ? a : fx ? a * fx : 0;

  const impact = useMemo(() => {
    if (!data) return null;
    const base = buildPayoffPlan(data.inputs);
    const withSend = buildPayoffPlan({ ...data.inputs, monthlyBillsCents: data.inputs.monthlyBillsCents + Math.round(cad * 100) });
    return { base, withSend };
  }, [data, cad]);
  const surplus = data ? data.plan.surplusCents / 100 : 0;
  const left = surplus - cad;

  return (
    <Sheet open={open} onClose={onClose} title="Send home">
      {!data ? (
        error ? (
          <p className="text-brick">{error}</p>
        ) : (
          <p className="flex items-center gap-2 py-8 text-ink-3">
            <Loader2 size={15} className="animate-spin" /> Loading the rate and your budget…
          </p>
        )
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          <section className="glass grid gap-2 p-4">
            <p className="text-sm text-ink-2">1 Canadian dollar today</p>
            <p className="figure text-[2rem] leading-none">{fx ? fmtPrice(fx, "INR") : "–"}</p>
            <p className="text-xs text-ink-3">
              Official rate{data.fx.source ? `, ${data.fx.source}` : ""}
              {data.fx.asOf ? `, ${new Date(data.fx.asOf).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}` : ""}. Banks and transfer apps pay a little less and may charge a fee; compare before you send.
            </p>
            {data.fx.series.length > 10 && (
              <div className="min-w-0 overflow-hidden">
                <PriceChart candles={data.fx.series.map((p) => ({ t: p.t, o: p.c, h: p.c, l: p.c, c: p.c }))} currency="INR" intraday={false} height={150} />
              </div>
            )}
            {data.fx.read && (
              <>
                <p className="text-sm">{data.fx.read.read}</p>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  {[
                    ["90-day avg", data.fx.read.avg90],
                    ["1-year high", data.fx.read.high1y],
                    ["1-year low", data.fx.read.low1y],
                  ].map(([k, v]) => (
                    <div key={k as string} className="rounded-xl bg-paper-2 px-2.5 py-2">
                      <dt className="text-[0.7rem] text-ink-3">{k}</dt>
                      <dd className="figure text-sm">{v != null ? fmtPrice(v as number, "INR") : "–"}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </section>

          <section className="grid gap-3">
            <h3 className="section-title flex items-center gap-2">
              <ArrowRightLeft size={16} /> How much each month?
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <Num label="Amount" value={amount} onChange={setAmount} suffix={cur === "INR" ? "₹" : "$"} />
              <label className="field">
                In
                <select className="input" value={cur} onChange={(e) => setCur(e.target.value as "CAD" | "INR")}>
                  <option value="CAD">Canadian $</option>
                  <option value="INR">Rupees (₹)</option>
                </select>
              </label>
            </div>
            <p className="text-sm text-ink-2">
              {fmtPrice(cad, "CAD")} ≈ <b>{fmtPrice(inr, "INR", { compact: true })}</b> at today's official rate.
            </p>
            <div className="hero grid gap-2 p-4 text-sm" aria-live="polite">
              {surplus <= 0 ? (
                <p>Your budget has nothing free each month yet (bills and minimum payments use it all). Sending money now would come from savings or put bills at risk.</p>
              ) : left < 0 ? (
                <p>
                  That's <b>{fmtPrice(-left, "CAD")} more</b> than the {fmtPrice(surplus, "CAD")} you have free each month. To send this much you'd need extra shifts or a smaller amount; ask Haru how many shifts it would take.
                </p>
              ) : (
                <p>
                  Fits your budget: {fmtPrice(left, "CAD")} a month stays free after sending.
                  {impact?.base.debtFreeDate && (
                    <>
                      {" "}
                      {impact.withSend.debtFreeDate === impact.base.debtFreeDate ? (
                        <>
                          Your debt-free date stays <b>{monthYear(impact.base.debtFreeDate)}</b>.
                        </>
                      ) : (
                        <>
                          Debt-free date moves from <b>{monthYear(impact.base.debtFreeDate)}</b> to <b>{monthYear(impact.withSend.debtFreeDate)}</b>.
                        </>
                      )}
                    </>
                  )}
                </p>
              )}
              {impact?.base.focus && (
                <p className="text-ink-2">
                  Paying off {impact.base.focus.name} first saves interest; a smaller amount now and more after {monthYear(impact.base.debtFreeDate)} often ends with more money sent in total.
                </p>
              )}
              <p className="border-t border-line pt-2 text-[0.72rem] text-ink-3">Based on HARU's records of your shifts, bills and debts. The rate read describes the past; nobody can promise where rates go next.</p>
            </div>
          </section>
        </div>
      )}
    </Sheet>
  );
}

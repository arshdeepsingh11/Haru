"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useMoney } from "../ui";

const SERIES = ["var(--moss)", "var(--goal)", "var(--amber)", "var(--slate)", "var(--brick)", "var(--ink-2)"];

function weekTick(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Weekly gross earnings stacked by job — real records only. */
export function EarningsChart({ weekly, jobNames }: { weekly: { weekStart: string; byJob: Record<string, number>; total: number }[]; jobNames: string[] }) {
  const money = useMoney();
  const rows = weekly.map((w) => ({ week: w.weekStart, ...Object.fromEntries(jobNames.map((j) => [j, (w.byJob[j] ?? 0) / 100])) }));
  return (
    <div className="h-44 w-full" role="img" aria-label="Weekly gross earnings for the last 8 weeks, by job">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 0, bottom: 0, left: -18 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="week" tickFormatter={weekTick} tick={{ fontSize: 11, fill: "var(--ink-3)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--ink-3)" }} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`)} />
          <Tooltip
            cursor={{ fill: "var(--paper-2)" }}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12, color: "var(--ink)" }}
            labelFormatter={(l: unknown) => `Week of ${weekTick(String(l))}`}
            formatter={(v: unknown, name: unknown) => [money(Math.round(Number(v) * 100)), String(name)]}
          />
          {jobNames.map((j, i) => (
            <Bar key={j} dataKey={j} stackId="e" fill={SERIES[i % SERIES.length]} radius={i === jobNames.length - 1 ? [4, 4, 0, 0] : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendingChart({ weekly }: { weekly: { weekStart: string; cents: number }[] }) {
  const money = useMoney();
  const rows = weekly.map((w) => ({ week: w.weekStart, spent: w.cents / 100 }));
  return (
    <div className="h-28 w-full" role="img" aria-label="Weekly spending for the last 8 weeks">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: -18 }} barCategoryGap="30%">
          <XAxis dataKey="week" tickFormatter={weekTick} tick={{ fontSize: 10, fill: "var(--ink-3)" }} axisLine={false} tickLine={false} />
          <YAxis hide />
          <Tooltip
            cursor={{ fill: "var(--paper-2)" }}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12, color: "var(--ink)" }}
            labelFormatter={(l: unknown) => `Week of ${weekTick(String(l))}`}
            formatter={(v: unknown) => [money(Math.round(Number(v) * 100)), "Spent"]}
          />
          <Bar dataKey="spent" fill="var(--ink-3)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useMoney } from "../ui";

function weekTick(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
}
const tooltipStyle = {
  background: "rgb(255 255 255 / 0.9)",
  backdropFilter: "blur(12px)",
  border: "1px solid rgb(124 58 237 / 0.18)",
  borderRadius: 14,
  fontSize: 12,
  color: "#1e1537",
  boxShadow: "0 12px 30px -12px rgb(76 29 149 / 0.35)",
};

/** What you took home each week (after the tax estimate) — real logged work only. */
export function EarningsChart({ weekly, taxPercent = 5 }: { weekly: { weekStart: string; total: number }[]; jobNames?: string[]; taxPercent?: number }) {
  const money = useMoney();
  const rows = weekly.map((w) => ({ week: w.weekStart, net: Math.round(w.total * (1 - taxPercent / 100)) / 100 }));
  return (
    <div className="h-48 w-full" role="img" aria-label="Weekly take-home for the last 8 weeks">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 10, right: 4, bottom: 0, left: -14 }}>
          <defs>
            <linearGradient id="earn-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#c4b5fd" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="earn-line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#6d28d9" />
              <stop offset="100%" stopColor="#c084fc" />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="rgb(124 58 237 / 0.1)" />
          <XAxis dataKey="week" tickFormatter={weekTick} tick={{ fontSize: 11, fill: "#8b84a6" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#8b84a6" }} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`)} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(l: unknown) => `Week of ${weekTick(String(l))}`} formatter={(v: unknown) => [money(Math.round(Number(v) * 100)), "Took home"]} />
          <Area type="monotone" dataKey="net" stroke="url(#earn-line)" strokeWidth={3} fill="url(#earn-fill)" dot={{ r: 3, fill: "#7c3aed", strokeWidth: 0 }} activeDot={{ r: 6, fill: "#7c3aed", stroke: "#fff", strokeWidth: 2 }} />
        </AreaChart>
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
          <defs>
            <linearGradient id="spend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#c4b5fd" />
              <stop offset="100%" stopColor="#ede9fe" />
            </linearGradient>
          </defs>
          <XAxis dataKey="week" tickFormatter={weekTick} tick={{ fontSize: 10, fill: "#8b84a6" }} axisLine={false} tickLine={false} />
          <YAxis hide />
          <Tooltip cursor={{ fill: "rgb(124 58 237 / 0.06)" }} contentStyle={tooltipStyle} labelFormatter={(l: unknown) => `Week of ${weekTick(String(l))}`} formatter={(v: unknown) => [money(Math.round(Number(v) * 100)), "Spent"]} />
          <Bar dataKey="spent" fill="url(#spend-fill)" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

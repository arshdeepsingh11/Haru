"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/invest/analytics";
import { fmtPrice } from "./format";

type PointerLike = { clientX: number; pointerType: string; buttons: number };

// A touch-first price chart: area or candles, price grid, and a crosshair you drag with a finger.

export function PriceChart({
  candles,
  currency,
  intraday,
  mode = "area",
  height = 230,
  onHover,
}: {
  candles: Candle[];
  currency: string;
  intraday: boolean;
  mode?: "area" | "candle";
  height?: number;
  onHover?: (c: Candle | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver((e) => setW(Math.max(200, Math.round(e[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 4, r: 56, t: 14, b: 22 };
  const data = candles;
  const geo = useMemo(() => {
    if (data.length < 2) return null;
    const lo = Math.min(...data.map((c) => (mode === "candle" ? c.l : c.c)));
    const hi = Math.max(...data.map((c) => (mode === "candle" ? c.h : c.c)));
    const span = hi - lo || hi * 0.01 || 1;
    const min = lo - span * 0.06;
    const max = hi + span * 0.06;
    const iw = w - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const x = (i: number) => pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
    const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * ih;
    const up = data[data.length - 1].c >= data[0].c;
    const line = data.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(c.c).toFixed(1)}`).join(" ");
    const area = `${line} L${x(data.length - 1).toFixed(1)} ${pad.t + ih} L${x(0).toFixed(1)} ${pad.t + ih} Z`;
    const ticks = [0, 0.5, 1].map((f) => min + (max - min) * (0.12 + f * 0.76));
    return { x, y, up, line, area, ticks, iw, ih, min, max };
  }, [data, w, height, mode]);

  if (!geo) return <div ref={ref} className="grid place-items-center text-sm text-ink-3" style={{ height }}>Not enough history to draw a chart.</div>;

  const color = geo.up ? "var(--moss)" : "var(--brick)";
  const idx = hover ?? data.length - 1;
  const point = data[idx];
  const fmtT = (t: number) =>
    new Date(t).toLocaleString("en-CA", intraday ? { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  const labels = [0, Math.floor((data.length - 1) / 2), data.length - 1];

  const pick = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const px = clientX - rect.left - pad.l;
    const i = Math.round((px / geo.iw) * (data.length - 1));
    const v = Math.max(0, Math.min(data.length - 1, i));
    setHover(v);
    onHover?.(data[v]);
  };
  const leave = () => {
    setHover(null);
    onHover?.(null);
  };
  const cw = Math.max(1, Math.min(9, (geo.iw / data.length) * 0.65));

  return (
    <div ref={ref} className="relative w-full min-w-0 touch-pan-y select-none overflow-hidden" style={{ height }}>
      <svg
        width={w}
        height={height}
        className="block"
        role="img"
        aria-label={`Price chart, ${fmtPrice(data[0].c, currency)} to ${fmtPrice(data[data.length - 1].c, currency)}`}
        onPointerDown={(e: PointerLike) => pick(e.clientX)}
        onPointerMove={(e: PointerLike) => (e.pointerType === "mouse" || e.buttons ? pick(e.clientX) : undefined)}
        onPointerLeave={leave}
        onPointerUp={(e: PointerLike) => e.pointerType !== "mouse" && leave()}
      >
        <defs>
          <linearGradient id="pc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={geo.up ? "#7fd3a0" : "#ff8f80"} stopOpacity="0.28" />
            <stop offset="1" stopColor={geo.up ? "#7fd3a0" : "#ff8f80"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {geo.ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={pad.l + geo.iw} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--line)" strokeDasharray="2 4" />
            <text x={w - pad.r + 6} y={geo.y(v) + 4} fontSize="10.5" fill="var(--ink-3)">
              {fmtPrice(v, currency, { compact: true })}
            </text>
          </g>
        ))}
        {mode === "area" ? (
          <>
            <path d={geo.area} fill="url(#pc-fill)" />
            <path d={geo.line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          </>
        ) : (
          data.map((c, i) => {
            const upC = c.c >= c.o;
            const col = upC ? "var(--moss)" : "var(--brick)";
            const top = geo.y(Math.max(c.o, c.c));
            const bot = geo.y(Math.min(c.o, c.c));
            return (
              <g key={c.t}>
                <line x1={geo.x(i)} x2={geo.x(i)} y1={geo.y(c.h)} y2={geo.y(c.l)} stroke={col} strokeWidth="1" />
                <rect x={geo.x(i) - cw / 2} y={top} width={cw} height={Math.max(1, bot - top)} fill={col} rx="1" />
              </g>
            );
          })
        )}
        {labels.map((i, k) => (
          <text key={k} x={Math.min(Math.max(geo.x(i), 30), pad.l + geo.iw - 30)} y={height - 5} fontSize="10.5" textAnchor="middle" fill="var(--ink-3)">
            {new Date(data[i].t).toLocaleDateString("en-CA", intraday ? { hour: "numeric", minute: "2-digit" } : data[data.length - 1].t - data[0].t > 300 * 86400e3 ? { year: "numeric", month: "short" } : { month: "short", day: "numeric" })}
          </text>
        ))}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={geo.x(idx)} x2={geo.x(idx)} y1={pad.t} y2={pad.t + geo.ih} stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={geo.x(idx)} cy={geo.y(point.c)} r="4.5" fill={color} stroke="#fff" strokeWidth="1.5" />
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute top-0 rounded-lg bg-black/55 px-2 py-1 text-[0.7rem] text-white backdrop-blur" style={{ left: Math.min(Math.max(geo.x(idx) - 60, 0), w - 130) }}>
          {fmtT(point.t)} · {fmtPrice(point.c, currency)}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, width = 64, height = 26 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span style={{ width, height }} className="inline-block" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0">
      <path d={values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")} fill="none" stroke={up ? "var(--moss)" : "var(--brick)"} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

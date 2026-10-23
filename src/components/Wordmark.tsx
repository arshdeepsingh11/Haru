import { useId } from "react";

// The HARU mark: a $ where human and AI meet. The upper curve is the AI (jointed, cut like a robot
// finger), the lower curve is the human (one smooth stroke). They almost touch, and a spark lights the gap.
const UPPER = "M43 22.6c-1.9-3.1-5.6-5-10.6-5-6.5 0-11 3.2-11 8.2 0 4.8 3.7 6.8 11 8.2";
const LOWER = "M32.4 34c7.5 1.4 11.6 3.6 11.6 8.8 0 5.2-4.8 8.7-11.6 8.7-5.4 0-9.7-2.2-11.5-5.8";

export function LogoMark({ size = 30, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const small = size <= 28; // favicon sizes: no joints, simpler spark
  const w = small ? 6.4 : 5.6;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6e56ff" />
          <stop offset="0.55" stopColor="#4b6dff" />
          <stop offset="1" stopColor="#1fb6dc" />
        </linearGradient>
        <radialGradient id={`${id}g`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.35" stopColor="#e3faff" stopOpacity="0.8" />
          <stop offset="1" stopColor="#9bf2ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}s`} cx="0.25" cy="0.15" r="0.9">
          <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}t)`} />
      <rect width="64" height="64" rx="16" fill={`url(#${id}s)`} />
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <path d="M32.2 10.5v4.3" strokeWidth={w - 0.6} />
        <path d="M32.2 54.6v-3.3" strokeWidth={w - 0.6} />
        <path d={UPPER} pathLength={100} strokeWidth={w} strokeLinecap={small ? "round" : "butt"} strokeDasharray={small ? "86 100" : "15 5.5 38 5.5 22 100"} />
        <path d={LOWER} pathLength={100} strokeWidth={w} strokeDasharray="0 14 86 100" />
      </g>
      <circle cx="32.3" cy="33.4" r={small ? 5 : 7.5} fill={`url(#${id}g)`} />
      {small ? (
        <circle cx="32.3" cy="33.4" r="1.6" fill="#fff" />
      ) : (
        <path d="M32.3 29.2 L33.05 32.65 L36.5 33.4 L33.05 34.15 L32.3 37.6 L31.55 34.15 L28.1 33.4 L31.55 32.65 Z" fill="#fff" />
      )}
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      <span className="font-[family-name:var(--font-display)] text-[1.02rem] font-semibold tracking-[0.06em] text-ink">HARU</span>
    </span>
  );
}

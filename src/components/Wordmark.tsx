import { useId } from "react";

// The HARU mark: an H whose crossbar is a rising market line; the spark at its peak is the AI.
// Charcoal tile, stone stems, champagne line. Favicon sizes use a simpler line and a dot.
export function LogoMark({ size = 30, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const small = size <= 28;
  const w = small ? 7.2 : 6.2;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#585c5e" />
          <stop offset="1" stopColor="#3a3e40" />
        </linearGradient>
        <linearGradient id={`${id}c`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#c9a464" />
          <stop offset="0.6" stopColor="#ead2a1" />
          <stop offset="1" stopColor="#fbf1dc" />
        </linearGradient>
        <radialGradient id={`${id}s`} cx="0.3" cy="0.1" r="0.9">
          <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}t)`} />
      <rect width="64" height="64" rx="16" fill={`url(#${id}s)`} />
      <rect x="0.5" y="0.5" width="63" height="63" rx="15.5" fill="none" stroke="#fff" strokeOpacity="0.1" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 17v30M45 17v30" stroke="#f3f1f0" strokeWidth={w} />
        <path d={small ? "M19 38 L32 31 L45 24" : "M19 38.5 L27 33.5 L32.5 36 L45 25"} stroke={`url(#${id}c)`} strokeWidth={w} />
      </g>
      {small ? <circle cx="51" cy="13" r="3.4" fill="#ead2a1" /> : <path d="M51.5 7.5 L52.7 12.3 L57.5 13.5 L52.7 14.7 L51.5 19.5 L50.3 14.7 L45.5 13.5 L50.3 12.3 Z" fill="#f1dcb1" />}
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      <span className="font-[family-name:var(--font-display)] text-[1rem] font-medium tracking-[0.16em] text-ink">HARU</span>
    </span>
  );
}

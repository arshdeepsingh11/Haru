/** HARU mark: a $ cut from an aurora tile. */
export function LogoMark({ size = 30, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="haru-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6e56ff" />
          <stop offset="0.55" stopColor="#4f8bff" />
          <stop offset="1" stopColor="#2bc8e8" />
        </linearGradient>
        <radialGradient id="haru-glint" cx="0.28" cy="0.2" r="0.6">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#haru-tile)" />
      <rect width="64" height="64" rx="18" fill="url(#haru-glint)" />
      <path d="M32 11v42" stroke="#fff" strokeWidth="4.6" strokeLinecap="round" />
      <path
        d="M42.5 22.5c-1.8-3-5.4-4.8-10.2-4.8-6.3 0-10.6 3.1-10.6 7.9 0 4.6 3.6 6.6 10.6 7.9 7.2 1.3 11.2 3.4 11.2 8.4 0 5-4.6 8.4-11.2 8.4-5.2 0-9.3-2.1-11.1-5.6"
        fill="none"
        stroke="#fff"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

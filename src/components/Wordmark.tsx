/** HARU mark: a dollar sign in a violet glass tile, beside the name. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="haru-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6d28d9" />
          <stop offset="0.6" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#c084fc" />
        </linearGradient>
        <linearGradient id="haru-s" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="18" fill="url(#haru-g)" />
      <rect x="2" y="2" width="60" height="60" rx="18" fill="url(#haru-s)" />
      <rect x="2.5" y="2.5" width="59" height="59" rx="17.5" fill="none" stroke="#fff" strokeOpacity="0.45" />
      {/* dollar sign */}
      <path d="M32 12v40" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" />
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

export function Wordmark({ size = "md", tagline = false }: { size?: "md" | "lg"; tagline?: boolean }) {
  const lg = size === "lg";
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-2.5">
        <LogoMark size={lg ? 40 : 30} />
        <span className={`${lg ? "text-3xl" : "text-[1.1rem]"} font-bold tracking-[0.16em] text-ink`}>HARU</span>
      </span>
      {tagline && <span className={`${lg ? "mt-2 text-lg" : "text-sm"} gradient-text font-semibold`}>Work for Haru.</span>}
    </span>
  );
}

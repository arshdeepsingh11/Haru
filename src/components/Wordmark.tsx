/** HARU wordmark: a rising-sun arc over the name. */
export function Wordmark({ size = "md", tagline = false }: { size?: "md" | "lg"; tagline?: boolean }) {
  const lg = size === "lg";
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-2">
        <svg width={lg ? 30 : 22} height={lg ? 30 : 22} viewBox="0 0 32 32" aria-hidden="true">
          <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--ink)" />
          <path d="M8 21a8 8 0 0 1 16 0" fill="none" stroke="var(--paper)" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M6 24.5h20" stroke="var(--moss)" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
        <span className={`${lg ? "text-2xl" : "text-[1.05rem]"} font-[750] tracking-[0.14em]`}>HARU</span>
      </span>
      {tagline && <span className={`${lg ? "mt-2 text-lg" : "text-sm"} text-ink-2`}>Work for Haru.</span>}
    </span>
  );
}

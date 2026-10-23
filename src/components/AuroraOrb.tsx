/** HARU's presence: a living aurora sphere. Idle drifts, thinking swirls, speaking breathes. */
export type OrbState = "idle" | "thinking" | "speaking";

export function AuroraOrb({ size = 64, state = "idle", className = "", label }: { size?: number; state?: OrbState; className?: string; label?: string }) {
  return (
    <div className={`orb ${className}`} data-state={state} style={{ ["--s" as string]: `${size}px` }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <div className="orb-halo" />
      <div className="orb-ring" />
      <div className="orb-body">
        <i />
        <i />
        <i />
        <i />
        <div className="orb-sheen" />
      </div>
    </div>
  );
}

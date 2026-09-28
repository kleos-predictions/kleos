import { RESOLUTION_STAGES } from "@/lib/data";

/** Five evenly spaced stops joined by dotted lines, lit up to the current stage. */
export function ResolutionTrack({ stage }: { stage: number }) {
  const last = RESOLUTION_STAGES.length - 1;
  return (
    <ol className="grid grid-cols-5" aria-label="Resolution progress">
      {RESOLUTION_STAGES.map((label, i) => {
        const done = i <= stage;
        return (
          <li key={label} className="relative flex flex-col items-center gap-3 text-center" aria-current={i === stage ? "step" : undefined}>
            {i < last && (
              // Connector from this stop's center to the next one's.
              <span
                aria-hidden="true"
                className="absolute left-1/2 w-full"
                style={{
                  backgroundImage: `radial-gradient(circle, ${i < stage ? "var(--color-accent)" : "var(--color-line-strong)"} 1.5px, transparent 2px)`,
                  backgroundSize: "10px 4px",
                  backgroundPosition: "center",
                  height: 4,
                  top: 5,
                }}
              />
            )}
            <span
              className={`relative z-10 size-3.5 rounded-full ${done ? "bg-accent" : "border-2 border-line-strong bg-card"}`}
            />
            <span className={`lbl !text-[10px] leading-tight md:!text-[11px] ${i === stage ? "!text-ink" : ""}`}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

import { boostFraction } from "@/lib/math";
import { DotNumber } from "./dot-number";

/** Dotted ring, lit in proportion to (M − 1) / (M_max − 1). */
export function BoostGauge({ mult, size = 148 }: { mult: number; size?: number }) {
  const r = 66;
  const n = Math.round((2 * Math.PI * r) / 12.9);
  const lit = Math.round(boostFraction(mult) * n);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 148 148" width={size} height={size} role="img" aria-label={`Boost ${mult.toFixed(1)}×`}>
        {Array.from({ length: n }, (_, i) => {
          const a = (i / n) * 2 * Math.PI - Math.PI / 2;
          return (
            <circle
              key={i}
              cx={(74 + r * Math.cos(a)).toFixed(2)}
              cy={(74 + r * Math.sin(a)).toFixed(2)}
              r={3.4}
              fill={i < lit ? "var(--color-accent)" : "var(--color-dot-off)"}
            />
          );
        })}
      </svg>
      {/* Text sits inside the ring's inner ~60%, so it never touches the dots. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1" aria-hidden="true">
        <span className="flex items-baseline leading-none" style={{ fontSize: size * 0.2 }}>
          <DotNumber value={mult.toFixed(1)} />
          <span className="ml-[0.06em] font-mono text-[0.55em] font-medium text-muted">×</span>
        </span>
        <span className="lbl" style={{ fontSize: Math.max(9, size * 0.075) }}>Boost</span>
      </div>
    </div>
  );
}

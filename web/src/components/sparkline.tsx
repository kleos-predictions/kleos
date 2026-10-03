import type { PricePoint } from "@/lib/data";
import { downsample, linearPath } from "@/lib/path";

/** Tiny dotted sparkline: reputation in accent, money in dim lavender. */
export function Sparkline({ points, muted = false }: { points: PricePoint[]; muted?: boolean }) {
  const w = 150;
  const h = 64;
  const pts = downsample(points, 8);
  if (pts.length < 2) return null;
  // Scale to the data's own range so small moves stay visible at this size.
  const values = pts.flatMap((p) => [p.rep, p.money]);
  const lo = Math.min(...values);
  const span = Math.max(Math.max(...values) - lo, 0.1);
  const path = (key: "rep" | "money") =>
    linearPath(pts.map((p, i) => [4 + (i / (pts.length - 1)) * (w - 8), 6 + (1 - (p[key] - lo) / span) * (h - 12)]));
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0">
      {!muted && (
        <path d={path("money")} fill="none" stroke="var(--color-lavender-dim)" strokeWidth={3} strokeLinecap="round" strokeDasharray="0 9" />
      )}
      <path
        d={path("rep")}
        fill="none"
        stroke={muted ? "var(--color-faint)" : "var(--color-accent)"}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray="0 9"
      />
    </svg>
  );
}

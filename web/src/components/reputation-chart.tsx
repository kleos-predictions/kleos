import { stepPath } from "@/lib/path";
import { TIER_NAMES, TIER_THRESHOLDS } from "@/lib/tiers";

const W = 800;
const PAD = { l: 56, r: 16, t: 14, b: 30 };
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** R over time on real axes: months along the bottom, tier thresholds up the side. */
export function ReputationChart({ points, height = 240 }: { points: { t: number; r: number }[]; height?: number }) {
  const H = height;
  if (points.length < 2) {
    return <p className="lbl py-12 text-center">No resolved bets yet. Reputation starts moving after your first market resolves.</p>;
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const maxR = Math.max(...points.map((p) => p.r));
  // Headroom up to the next tier, so the line has somewhere to climb.
  const nextTier = TIER_THRESHOLDS.find((t) => t > maxR) ?? maxR;
  const yMax = Math.max(nextTier, maxR) * 1.08 || 1;

  const x = (t: number) => PAD.l + ((t - t0) / Math.max(t1 - t0, 1)) * (W - PAD.l - PAD.r);
  const y = (r: number) => PAD.t + (1 - r / yMax) * (H - PAD.t - PAD.b);
  const line = stepPath(points.map((p) => [x(p.t), y(p.r)]));

  // One tick per month boundary inside the range; fall back to the end dates for short ranges.
  const months: { t: number; label: string }[] = [];
  const d = new Date(t0 * 1000);
  const cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  for (let t = cursor; t < t1; ) {
    months.push({ t, label: MONTH.format(new Date(t * 1000)) });
    const m = new Date(t * 1000);
    t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1) / 1000;
  }
  const xTicks = months.length >= 2 ? months : [{ t: t0, label: DAY.format(new Date(t0 * 1000)) }, { t: t1, label: DAY.format(new Date(t1 * 1000)) }];

  const tiers = TIER_THRESHOLDS.map((r, i) => ({ r, name: TIER_NAMES[i + 1] })).filter((t) => t.r <= yMax);
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Reputation from ${DAY.format(new Date(t0 * 1000))} to ${DAY.format(new Date(t1 * 1000))}, now ${last.r.toFixed(1)}`}
    >
      {/* Tier thresholds */}
      {tiers.map((t) => (
        <g key={t.r}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t.r)} y2={y(t.r)} stroke="var(--color-line)" strokeDasharray="2 6" />
          <text x={PAD.l - 10} y={y(t.r) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)" fontFamily="var(--font-mono)">
            {t.r} · {t.name}
          </text>
        </g>
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" />
      <text x={PAD.l - 10} y={y(0) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)" fontFamily="var(--font-mono)">
        0
      </text>

      {/* Months */}
      {xTicks.map((m, i) => (
        <g key={`${m.t}-${i}`}>
          <line x1={x(m.t)} x2={x(m.t)} y1={y(0)} y2={y(0) + 5} stroke="var(--color-line-strong)" />
          <text x={x(m.t)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-muted)" fontFamily="var(--font-mono)">
            {m.label.toUpperCase()}
          </text>
        </g>
      ))}

      <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth={5} strokeLinecap="round" strokeDasharray="0 10" />
      <circle cx={x(last.t)} cy={y(last.r)} r={7} fill="var(--color-ink)" />
    </svg>
  );
}

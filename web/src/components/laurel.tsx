import { litPairs, tierOf, tierOfWad, TIER_NAMES } from "@/lib/tiers";

// Dot-matrix laurel, 7 pairs per side, listed bottom → top. Right side mirrors x → 64 − x.
const STEM: [number, number][] = [[28, 57], [21, 53], [16, 47], [13, 40], [12, 32], [13, 24], [16, 17]];
const LEAF: [number, number][] = [[21, 59], [13, 55], [8, 49], [5, 41], [5, 32], [6, 23], [10, 15]];

function Dots({ lit }: { lit: number }) {
  return (
    <>
      {STEM.map(([x, y], i) => {
        const [lx, ly] = LEAF[i];
        const fill = i < lit ? "var(--color-accent)" : "var(--color-dot-off)";
        return (
          <g key={i} fill={fill}>
            <circle cx={x} cy={y} r={2.4} />
            <circle cx={lx} cy={ly} r={3} />
            <circle cx={64 - x} cy={y} r={2.4} />
            <circle cx={64 - lx} cy={ly} r={3} />
          </g>
        );
      })}
    </>
  );
}

export function LaurelLogo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <Dots lit={7} />
    </svg>
  );
}

/** Laurel that fills in bottom-up as the tier rises. */
export function LaurelBadge({ r, rawR, size = 20, label = true }: { r: number; rawR?: string; size?: number; label?: boolean }) {
  const tier = rawR === undefined ? tierOf(r) : tierOfWad(BigInt(rawR));
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={label ? "img" : undefined} aria-hidden={label ? undefined : true}>
      {label && <title>{tier ? `Tier ${TIER_NAMES[tier]}` : "No tier yet"}</title>}
      <Dots lit={litPairs(tier)} />
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="flex items-center gap-3">
      <LaurelLogo size={size + 2} />
      <span className="font-dot font-black tracking-[0.14em]" style={{ fontSize: size }}>
        KLEOS
      </span>
    </span>
  );
}

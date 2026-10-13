// Reputation tiers. The laurel lights one more pair of leaves as R crosses each threshold.

export const TIER_THRESHOLDS = [1, 4, 9, 16, 36] as const; // R needed for tiers I–V
export const TIER_NAMES = ["—", "I", "II", "III", "IV", "V"] as const;

/** 0 = no tier yet, 1–5 = tiers I–V */
export function tierOf(r: number): number {
  return TIER_THRESHOLDS.filter((t) => r >= t).length;
}

/** Use exact contract units for threshold labels; Number can round a value below a tier up. */
export function tierOfWad(r: bigint): number {
  return TIER_THRESHOLDS.filter((threshold) => r >= BigInt(threshold) * 10n ** 18n).length;
}

/** Lit leaf pairs per side (out of 7), bottom up. */
export function litPairs(tier: number): number {
  return [1, 2, 3, 5, 6, 7][tier];
}

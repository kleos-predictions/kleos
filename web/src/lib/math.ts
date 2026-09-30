// Kleos formulas. Mirrors contracts/src/Kleos.sol so the UI can preview what the chain will do.

export const PARAMS = {
  alpha: 0.5,
  mMax: 5,
  k: 1,
  lambda: 1.5,
  stakeRef: 50,
  boostCap: 0.1,
  boostCapMinPool: 5_000,
  feeBps: 200, // bonus for winners who beat the market
  protocolFeeBps: 100, // protocol revenue
  deltaRMax: 0.8,
  nMin: 10,
} as const;

/** M = min(1 + α·√R, M_max) */
export function multiplier(r: number): number {
  return Math.min(1 + PARAMS.alpha * Math.sqrt(Math.max(r, 0)), PARAMS.mMax);
}

/** Share of the gauge that is lit: (M − 1) / (M_max − 1) */
export function boostFraction(m: number): number {
  return (m - 1) / (PARAMS.mMax - 1);
}

/** E = m · M, with the boost trimmed so one address stays under 10% of a deep pool. */
export function effectiveBet(amount: number, m: number, pool = 0, userEff = 0): number {
  const eff = amount * m;
  if (eff <= amount || pool < PARAMS.boostCapMinPool) return eff;
  const bound = Math.max((PARAMS.boostCap * pool - userEff) / (1 - PARAMS.boostCap), amount);
  return Math.min(eff, bound);
}

/** Stake factor s = min(m / $50, 1) */
export function stakeFactor(amount: number): number {
  return Math.min(amount / PARAMS.stakeRef, 1);
}

/** Right: +k·s·(1 − p). Wrong: −λ·k·s·p. p = price of the side you picked, at entry. */
export function reputationDelta(won: boolean, p: number, amount: number): number {
  const ks = PARAMS.k * stakeFactor(amount);
  return won ? Math.min(ks * (1 - p), PARAMS.deltaRMax) : -PARAMS.lambda * ks * p;
}

/** Human-readable version of the update, so anyone can check the math. */
export function reputationFormula(won: boolean, p: number, amount: number): string {
  const s = stakeFactor(amount);
  const d = reputationDelta(won, p, amount);
  const f = (n: number) => n.toFixed(2);
  const capped = won && PARAMS.k * s * (1 - p) > PARAMS.deltaRMax;
  return won
    ? `+k·s·(1 − p) = ${PARAMS.k}·${f(s)}·(1 − ${f(p)}) = +${f(d)}${capped ? " (per-market cap)" : ""}`
    : `−λ·k·s·p = ${PARAMS.lambda}·${PARAMS.k}·${f(s)}·${f(p)} = ${f(d)}`;
}

/** Money pays money: payout = m + (m / ΣwinningMoney) · (L − bonus fee − protocol fee). */
export function payout(amount: number, winMoneyTotal: number, losingMoney: number): number {
  return amount + (amount / winMoneyTotal) * losingMoney * (1 - (PARAMS.feeBps + PARAMS.protocolFeeBps) / 10_000);
}

/** Protocol revenue from a market's losing pool. */
export function protocolFee(losingMoney: number): number {
  return (losingMoney * PARAMS.protocolFeeBps) / 10_000;
}

/** The fee that funds the market's bonus pool. */
export function fee(losingMoney: number): number {
  return (losingMoney * PARAMS.feeBps) / 10_000;
}

/**
 * The math behind one recorded reputation change, rebuilt from what the event carries
 * (entry price and delta), so anyone can check it without trusting the UI.
 */
export function explainChange(row: { delta: number; entryPrice: number; isBet?: boolean; marketId: number }): string {
  const f = (n: number) => n.toFixed(2);
  if (row.marketId === 0) return `Demo seed, published on-chain: ${row.delta >= 0 ? "+" : ""}${f(row.delta)}`;
  if (row.isBet === false) {
    return row.delta >= 0 ? `Juror voted with the verdict: +${f(row.delta)} (vests)` : `Juror penalty: ${f(row.delta)}`;
  }
  const p = row.entryPrice;
  if (row.delta >= 0) {
    const s = row.delta / (1 - p);
    return `+k·s·(1 − p) = 1·${f(Math.min(s, 1))}·(1 − ${f(p)}) = +${f(row.delta)}${s > 1.0001 ? " (per-market cap)" : ""}`;
  }
  const s = -row.delta / (PARAMS.lambda * p);
  return `−λ·k·s·p = ${PARAMS.lambda}·1·${f(s)}·${f(p)} = ${f(row.delta)}`;
}

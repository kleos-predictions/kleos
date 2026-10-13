// Integer educational replay of Kleos.sol: whale first, then distinct YES accounts.
// All sharps have ten qualifying prior positions and no flag; this is not proof of skill.
const WAD = 10n ** 18n;
const USD = 10n ** 6n;
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;
function sqrt(x: bigint): bigint {
  if (x === 0n) return 0n;
  let y = x, z = (x + 1n) / 2n;
  while (z < y) { y = z; z = (x / z + z) / 2n; }
  return y;
}
export function whaleScenario(whaleDollars: number, count: number, stakeDollars: number, r: number) {
  if (![whaleDollars, count, stakeDollars, r].every(Number.isSafeInteger) || whaleDollars < 1 || count < 1 || count > 100 || stakeDollars < 1 || r < 0) throw new Error("Invalid scenario.");
  const whale = BigInt(whaleDollars) * USD, stake = BigInt(stakeDollars) * USD;
  const mult = min(WAD + sqrt(BigInt(r) * WAD * WAD) / 2n, 5n * WAD);
  const entries: { entry: bigint; effective: bigint; gain: bigint; weight: bigint }[] = [];
  let yesEff = 0n;
  const qualifies = whale + stake * BigInt(count) >= 1_000n * USD && count + 1 >= 10;
  for (let i = 0; i < count; i++) {
    const pool = whale + yesEff;
    const entry = max(WAD / 20n, min(19n * WAD / 20n, yesEff * WAD / pool));
    let effective = stake * mult / WAD;
    if (effective > stake && pool + stake >= 5_000n * USD) {
      // Each address is new to this market: userEff=0. Preserve every integer division.
      const room = pool / 10n;
      const bound = max(room * WAD / (WAD - WAD / 10n), stake);
      effective = min(effective, bound);
    }
    const factor = min(stake * WAD / (50n * USD), WAD);
    const gain = qualifies ? min(factor * (WAD - entry) / WAD, 4n * WAD / 5n) : 0n;
    const weight = gain * (effective * WAD / stake) / WAD;
    entries.push({ entry, effective, gain, weight });
    yesEff += effective;
  }
  const yesMoney = stake * BigInt(count);
  const bonusPool = whale * 200n / 10_000n;
  const protocol = whale * 100n / 10_000n;
  const principal = stake + stake * (whale - bonusPool - protocol) / yesMoney;
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0n);
  const bonuses = entries.map(e => totalWeight > 0n ? bonusPool * e.weight / totalWeight : 0n);
  const totals = bonuses.map(b => principal + b);
  const dollars = (n: bigint) => Number(n) / 1e6;
  return {
    qualifies, multiplier: Number(mult) / 1e18, yesMoney: dollars(yesMoney), yesEffective: dollars(yesEff),
    repYes: Number(yesEff * WAD / (yesEff + whale)) / 1e18,
    moneyYes: Number(yesMoney * WAD / (yesMoney + whale)) / 1e18,
    principal: dollars(principal), bonusPool: dollars(bonusPool), protocol: dollars(protocol),
    minBonus: dollars(bonuses.reduce(min)), maxBonus: dollars(bonuses.reduce(max)),
    minTotal: dollars(totals.reduce(min)), maxTotal: dollars(totals.reduce(max)),
    averageTotal: dollars(totals.reduce((a,b) => a+b,0n)) / count,
    effectiveMin: dollars(entries.map(e => e.effective).reduce(min)), effectiveMax: dollars(entries.map(e => e.effective).reduce(max)),
    entryMin: Number(entries.map(e => e.entry).reduce(min)) / 1e18, entryMax: Number(entries.map(e => e.entry).reduce(max)) / 1e18,
    rollover: totalWeight === 0n ? dollars(bonusPool) : 0,
    raw: { entries, bonuses, principal, totalWeight, bonusPool, protocol, yesEff, yesMoney },
  };
}

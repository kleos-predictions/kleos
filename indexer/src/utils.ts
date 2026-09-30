import type { EvmOnEventContext, Trader } from "envio";

export const WAD = 10n ** 18n;
/** Reputation and bet buddies only count in markets at least this deep (Kleos.sol MIN_REP_POOL, MIN_BETTORS). */
export const MIN_REP_POOL = 1_000_000_000n; // $1,000 at 6 decimals
export const MIN_BETTORS = 10;

/** Unique within a chain (the config sets disable_default_cross_chain). */
export const eventId = (event: { block: { number: number }; logIndex: number }) => `${event.block.number}_${event.logIndex}`;

export const addressId = (address: string) => address.toLowerCase();

export const positionId = (marketId: bigint | string, user: string) => `${marketId}_${addressId(user)}`;

export const countsForReputation = (m: { yesMoney: bigint; noMoney: bigint; bettorCount: number }) =>
  m.yesMoney + m.noMoney >= MIN_REP_POOL && m.bettorCount >= MIN_BETTORS;

export function getTrader(context: EvmOnEventContext, address: string): Promise<Trader> {
  return context.Trader.getOrCreate({
    id: addressId(address),
    r: 0n,
    pending: 0n,
    resolvedBets: 0,
    flagged: false,
    wins: 0,
    losses: 0,
    betCount: 0,
    volume: 0n,
    marketCount: 0,
    callCount: 0,
  });
}

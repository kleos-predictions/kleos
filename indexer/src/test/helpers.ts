// Builders for simulated Kleos events, so tests read like the scenario they describe.
import { keccak256, toHex } from "viem";
import { WAD } from "../utils.js";

export { WAD, positionId } from "../utils.js";
export const usd = (n: number) => BigInt(Math.round(n * 1e6));
export const wad = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
export const tx = (label: string) => keccak256(toHex(label));

const block = (number: number, timestamp = 1_700_000_000 + number) => ({ number, timestamp });

export const categoryAdded = (id = 1, name = "Crypto") =>
  ({ contract: "Kleos", event: "CategoryAdded", block: block(1), params: { id: BigInt(id), name } }) as const;

/** The team's address in tests: it creates markets for free. Mixed case, as real events are checksummed. */
export const TEAM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

export const marketCreated = (marketId = 1n, n = 2, creator: `0x${string}` = TEAM) =>
  ({
    contract: "Kleos",
    event: "MarketCreated",
    block: block(n),
    params: { marketId, creator, question: "BTC above $120K?", category: 1n, oracle: "Chainlink", criteria: "YES if…", closeTime: 2_000_000_000n },
  }) as const;

export function betPlaced(o: { marketId?: bigint; user: `0x${string}`; side: boolean; amount: bigint; effective?: bigint; entryPrice?: bigint; n: number; logIndex?: number; hash?: `0x${string}` }) {
  return {
    contract: "Kleos",
    event: "BetPlaced",
    block: block(o.n),
    logIndex: o.logIndex ?? 0,
    transaction: { hash: o.hash ?? tx(`bet-${o.n}-${o.logIndex ?? 0}`) },
    params: {
      marketId: o.marketId ?? 1n,
      user: o.user,
      side: o.side,
      amount: o.amount,
      effective: o.effective ?? o.amount,
      multiplier: WAD,
      entryPrice: o.entryPrice ?? WAD / 2n,
      priceRepYes: WAD / 2n,
      priceMoneyYes: WAD / 2n,
    },
  } as const;
}

export const callPosted = (o: { callId: bigint; user: `0x${string}`; side: boolean; text: string; n: number; logIndex: number; hash: `0x${string}`; marketId?: bigint }) =>
  ({
    contract: "Kleos",
    event: "CallPosted",
    block: block(o.n),
    logIndex: o.logIndex,
    transaction: { hash: o.hash },
    params: { callId: o.callId, marketId: o.marketId ?? 1n, user: o.user, side: o.side, amount: usd(10), entryPrice: WAD / 2n, text: o.text },
  }) as const;

export const marketResolved = (outcome: boolean, n: number, fee = 0n, marketId = 1n) =>
  ({ contract: "Kleos", event: "MarketResolved", block: block(n), params: { marketId, outcome, fee } }) as const;

export const marketVoided = (n: number, marketId = 1n) =>
  ({ contract: "Kleos", event: "MarketVoided", block: block(n), params: { marketId } }) as const;

export const reputationChanged = (o: { user: `0x${string}`; marketId: bigint; delta: bigint; newR: bigint; pendingR?: bigint; entryPrice?: bigint; side?: boolean; outcome?: boolean; n: number; logIndex?: number }) =>
  ({
    contract: "Kleos",
    event: "ReputationChanged",
    block: block(o.n),
    logIndex: o.logIndex ?? 0,
    transaction: { hash: tx(`rep-${o.n}-${o.logIndex ?? 0}`) },
    params: { user: o.user, marketId: o.marketId, delta: o.delta, newR: o.newR, pendingR: o.pendingR ?? 0n, entryPrice: o.entryPrice ?? 0n, side: o.side ?? false, outcome: o.outcome ?? false },
  }) as const;

export const settled = (user: `0x${string}`, n: number, logIndex = 0, payout = 0n, marketId = 1n) =>
  ({ contract: "Kleos", event: "Settled", block: block(n), logIndex, params: { marketId, user, payout, bonusWeight: 0n } }) as const;

export const vested = (user: `0x${string}`, newR: bigint, n: number) =>
  ({ contract: "Kleos", event: "Vested", block: block(n), params: { user, amount: 0n, newR } }) as const;

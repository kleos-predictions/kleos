// Server-side reads straight from the contract. The Envio indexer replaces these for lists and
// history (see issue #1); until then they keep live profiles honest instead of showing samples.

import type { Address } from "viem";
import { kleosAbi } from "./abi";
import { KLEOS_ADDRESS, publicClient } from "./chain";
import type { Call, RepChange } from "./data";

const WAD = 1e18;
const DEPLOY_BLOCK = BigInt(process.env.NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK ?? "0");
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export type LiveProfile = {
  r: number;
  pending: number;
  resolvedBets: number;
  flagged: boolean;
  wins: number;
  losses: number;
  history: RepChange[]; // newest first
  historyError: boolean;
};

export async function readProfile(user: Address): Promise<LiveProfile> {
  const rep = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "reputation", args: [user] });

  let history: RepChange[] = [];
  let historyError = false;
  try {
    const logs = await publicClient.getContractEvents({
      address: KLEOS_ADDRESS!,
      abi: kleosAbi,
      eventName: "ReputationChanged",
      args: { user },
      fromBlock: DEPLOY_BLOCK,
    });
    const blocks = new Map<bigint, number>();
    const questions = new Map<bigint, string>();
    for (const log of logs) {
      if (!blocks.has(log.blockNumber)) {
        const b = await publicClient.getBlock({ blockNumber: log.blockNumber });
        blocks.set(log.blockNumber, Number(b.timestamp));
      }
      const id = log.args.marketId!;
      if (id > 0n && !questions.has(id)) {
        const m = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "getMarket", args: [id] });
        questions.set(id, m.question);
      }
    }
    history = logs
      .map((log) => {
        const a = log.args;
        const ts = blocks.get(log.blockNumber)!;
        const entryPrice = Number(a.entryPrice!) / WAD;
        const id = a.marketId!;
        // Seeds (market 0) and jury duty (no entry price) aren't bets.
        const kind = id === 0n ? "Genesis seed (demo)" : entryPrice === 0 ? "Jury duty" : null;
        return {
          marketId: Number(id),
          question: kind ? `${kind}${id > 0n ? ` · ${questions.get(id)}` : ""}` : questions.get(id) ?? `Market ${id}`,
          side: a.side!,
          outcome: a.outcome!,
          entryPrice,
          amount: 0,
          delta: Number(a.delta!) / WAD,
          newR: Number(a.newR!) / WAD,
          tx: log.transactionHash,
          date: DAY.format(new Date(ts * 1000)),
          timestamp: ts,
          isBet: !kind,
        };
      })
      .reverse();
  } catch {
    // Public RPCs cap log ranges; the indexer is the real source for long histories.
    historyError = true;
  }

  const bets = history.filter((h) => h.isBet);
  return {
    r: Number(rep.r) / WAD,
    pending: Number(rep.pending) / WAD,
    resolvedBets: rep.resolvedBets,
    flagged: rep.flagged,
    wins: bets.filter((h) => h.delta > 0).length,
    losses: bets.filter((h) => h.delta < 0).length,
    history,
    historyError,
  };
}

/** Latest calls on a market, straight from CallPosted events. */
export async function readCalls(marketId: number, limit = 10): Promise<Call[]> {
  const logs = await publicClient.getContractEvents({
    address: KLEOS_ADDRESS!,
    abi: kleosAbi,
    eventName: "CallPosted",
    args: { marketId: BigInt(marketId) },
    fromBlock: DEPLOY_BLOCK,
  });
  const latest = logs.slice(-limit).reverse();
  const now = Math.floor(Date.now() / 1000);
  return Promise.all(
    latest.map(async (log) => {
      const a = log.args;
      const [rep, block] = await Promise.all([
        publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "reputation", args: [a.user!] }),
        publicClient.getBlock({ blockNumber: log.blockNumber }),
      ]);
      const mins = Math.max(0, Math.round((now - Number(block.timestamp)) / 60));
      return {
        address: a.user!,
        r: Number(rep.r) / WAD,
        side: a.side!,
        amount: Number(a.amount!) / 1e6,
        entryPrice: Number(a.entryPrice!) / WAD,
        text: a.text!,
        ago: mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`,
      };
    }),
  );
}

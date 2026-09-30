// Server-side reads straight from the contract. The Envio indexer replaces these for lists and
// history (see issue #1); until then they keep live profiles honest instead of showing samples.

import { connection } from "next/server";
import type { Address } from "viem";
import { kleosAbi } from "./abi";
import { KLEOS_ADDRESS, SOCIAL_ADDRESS, publicClient } from "./chain";
import { kleosSocialAbi } from "./abi";
import type { Call, FeedItem, Market, RepChange } from "./data";

const WAD = 1e18;
const DEPLOY_BLOCK = BigInt(process.env.NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK ?? "0");
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export type LiveProfile = {
  name?: string;
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
  await connection(); // live chain data: render per request, never at build time
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
  const name = (await readNames([user]).catch(() => new Map<string, string>())).get(user.toLowerCase());
  return {
    name,
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

const ago = (seconds: number) => {
  const mins = Math.max(0, Math.round(seconds / 60));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
};

/** Latest calls, from CallPosted events: one market's, or every market's for the feed. */
async function readCallLogs(marketId: number | undefined, limit: number, user?: Address) {
  await connection(); // live chain data: render per request, never at build time
  const logs = await publicClient.getContractEvents({
    address: KLEOS_ADDRESS!,
    abi: kleosAbi,
    eventName: "CallPosted",
    args: { ...(marketId ? { marketId: BigInt(marketId) } : {}), ...(user ? { user } : {}) },
    fromBlock: DEPLOY_BLOCK,
  });
  const latest = logs.slice(-limit).reverse();
  const now = Math.floor(Date.now() / 1000);
  const reps = new Map<string, number>();
  return Promise.all(
    latest.map(async (log) => {
      const a = log.args;
      const user = a.user!;
      if (!reps.has(user)) {
        const rep = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "reputation", args: [user] });
        reps.set(user, Number(rep.r) / WAD);
      }
      const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
      const call: Call = {
        id: Number(a.callId!), // numbered by the contract; votes use the same id
        address: user,
        r: reps.get(user)!,
        side: a.side!,
        amount: Number(a.amount!) / 1e6,
        entryPrice: Number(a.entryPrice!) / WAD,
        text: a.text!,
        ago: ago(now - Number(block.timestamp)),
      };
      return { call, marketId: Number(a.marketId!) };
    }),
  );
}

/** Usernames from the social contract, lowercased address → name. */
export async function readNames(addresses: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))] as Address[];
  if (!SOCIAL_ADDRESS || unique.length === 0) return new Map();
  const names = await publicClient.readContract({ address: SOCIAL_ADDRESS, abi: kleosSocialAbi, functionName: "namesOf", args: [unique] });
  return new Map(unique.map((a, i) => [a, names[i]] as const).filter(([, n]) => n));
}

async function withNames<T extends { address: string }>(rows: T[]): Promise<(T & { name?: string })[]> {
  const names = await readNames(rows.map((r) => r.address)).catch(() => new Map<string, string>());
  return rows.map((r) => ({ ...r, name: names.get(r.address.toLowerCase()) }));
}

export async function readCalls(marketId: number, limit = 10): Promise<Call[]> {
  return withNames((await readCallLogs(marketId, limit)).map((x) => x.call));
}

export async function readFeed(limit = 50, user?: Address): Promise<FeedItem[]> {
  const rows = await readCallLogs(undefined, limit, user);
  const markets = new Map<number, Awaited<ReturnType<typeof readMarket>>>();
  for (const { marketId } of rows) if (!markets.has(marketId)) markets.set(marketId, await readMarket(marketId));
  const items = rows.map(({ call, marketId }) => {
    const m = markets.get(marketId)!;
    const resolved = m.state === 3; // State.Resolved
    return {
      ...call,
      marketId,
      question: m.question,
      result: !resolved ? null : m.voided ? "refunded" : call.side === m.outcome ? "right" : "wrong",
    } as FeedItem;
  });
  return withNames(items);
}

function readMarket(id: number) {
  return publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "getMarket", args: [BigInt(id)] });
}

const CATEGORY_NAMES = ["", "Crypto", "Sports", "Tech", "Culture"] as const;

/** A market created on-chain (beyond the sample set), shaped like the sample data the pages expect. */
export async function readLiveMarket(id: number): Promise<Market | null> {
  await connection();
  const count = Number(await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "marketCount" }));
  if (id < 1 || id > count) return null;
  const [m, [repYes, moneyYes], bettors] = await Promise.all([
    readMarket(id),
    publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "prices", args: [BigInt(id)] }),
    publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "getBettors", args: [BigInt(id)] }),
  ]);
  const rep = Number(repYes) / WAD;
  const money = Number(moneyYes) / WAD;
  const owner = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "owner" });
  const byTeam = m.creator.toLowerCase() === owner.toLowerCase();
  const creatorName = byTeam ? undefined : (await readNames([m.creator]).catch(() => new Map<string, string>())).get(m.creator.toLowerCase());
  const closeMs = Number(m.closeTime) * 1000;
  const status: Market["status"] = m.state === 3 ? "resolved" : m.state >= 1 ? "dispute" : closeMs - Date.now() < 86_400_000 ? "closing" : "live";
  return {
    id,
    question: m.question,
    category: (CATEGORY_NAMES[m.category] || "Culture") as Market["category"],
    status,
    oracle: m.oracle,
    criteria: m.criteria,
    creator: byTeam ? undefined : { address: m.creator, name: creatorName },
    type: byTeam ? "Curated" : "Community market",
    closesAt: new Date(closeMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC",
    volume: Number(m.yesMoney + m.noMoney) / 1e6,
    bettors: bettors.length,
    repYes: rep,
    moneyYes: money,
    history: [
      { t: 0, rep: 0.5, money: 0.5 },
      { t: 1, rep, money },
    ],
    sharps: { yes: 0, no: 0 },
    stage: 0,
  };
}

/** On-chain markets past the sample set (created by the demo seed or later). */
export async function readExtraMarkets(fromId: number): Promise<Market[]> {
  await connection();
  const count = Number(await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "marketCount" }));
  const ids = Array.from({ length: Math.max(0, count - fromId + 1) }, (_, i) => fromId + i);
  return (await Promise.all(ids.map(readLiveMarket))).filter((m): m is Market => m !== null);
}

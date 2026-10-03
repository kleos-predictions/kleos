// Server-side reads straight from the contract. The Envio indexer replaces these for lists and
// history (see issue #1); until then they keep live profiles honest instead of showing samples.

import { connection } from "next/server";
import type { Address } from "viem";
import { kleosAbi } from "./abi";
import { HAS_LOGS_RPC, KLEOS_ADDRESS, SOCIAL_ADDRESS, chain, logsClient, publicClient } from "./chain";
import { HAS_HYPERSYNC, hypersyncEvents } from "./hypersync";
import { kleosSocialAbi } from "./abi";
import { readBettorDiscovery } from "./bettors";
import type { Bet, Call, FeedItem, Market, RepChange, Trader } from "./data";

const WAD = 1e18;
const DEPLOY_BLOCK = BigInt(process.env.NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK ?? "0");
const HAS_DEPLOY_BLOCK = Boolean(process.env.NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK) || chain.id === 31337;
const READ_BUDGET_MS = 20_000;
const MAX_LOG_ROWS = 10_000;
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Event reads over block ranges. With HyperRPC (or the local node) one call covers everything.
 * The public Monad RPC allows 100 blocks per eth_getLogs, so without it we fan out in parallel
 * batches. The Envio indexer replaces this for long histories.
 */
async function inChunks<T>(read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>, latest: bigint, deadline: number): Promise<T[]> {
  if (!HAS_DEPLOY_BLOCK) throw new Error("Live history needs its deployment block.");
  if (latest < DEPLOY_BLOCK) return [];
  if (HAS_LOGS_RPC) {
    const logs = await withinBudget(read(DEPLOY_BLOCK, latest), deadline);
    if (logs.length > MAX_LOG_ROWS) throw new Error("History exceeds the application row budget. Use the indexer.");
    return logs;
  }
  if (latest - DEPLOY_BLOCK > 50_000n) throw new Error("History exceeds the public RPC scan budget. Configure the indexer or HyperSync.");
  const SIZE = 100n;
  const out: T[] = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += SIZE * 8n) {
    if (Date.now() >= deadline) throw new Error("History read timed out.");
    const ranges: [bigint, bigint][] = [];
    for (let f = from; f <= latest && f < from + SIZE * 8n; f += SIZE) ranges.push([f, f + SIZE - 1n < latest ? f + SIZE - 1n : latest]);
    const batch = await withinBudget(Promise.all(ranges.map(([f, t]) => read(f, t))), deadline);
    for (const logs of batch) out.push(...logs);
    if (out.length > MAX_LOG_ROWS) throw new Error("History exceeds the application row budget. Use the indexer.");
  }
  return out;
}

async function withinBudget<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("History read timed out.")), Math.max(1, deadline - Date.now())); })]);
  } finally { if (timer) clearTimeout(timer); }
}

type KleosEvent = "ReputationChanged" | "Vested" | "CallPosted" | "BetPlaced";
type TimedLog<E extends KleosEvent> = {
  args: Awaited<ReturnType<typeof logsClient.getContractEvents<typeof kleosAbi, E>>>[number]["args"];
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
  timestamp: number;
};

/** One Kleos event since the deploy block, with block timestamps: HyperSync when configured, RPC otherwise. */
async function kleosEvents<E extends KleosEvent>(eventName: E, args: Record<string, unknown>, toBlock?: bigint): Promise<TimedLog<E>[]> {
  if (!HAS_DEPLOY_BLOCK) throw new Error("Live history needs its deployment block.");
  const latest = toBlock ?? await publicClient.getBlockNumber();
  const deadline = Date.now() + READ_BUDGET_MS;
  if (HAS_HYPERSYNC) {
    return hypersyncEvents({ address: KLEOS_ADDRESS!, abi: kleosAbi, eventName, args, fromBlock: DEPLOY_BLOCK, toBlock: latest }) as Promise<TimedLog<E>[]>;
  }
  const logs = await inChunks((fromBlock, toBlock) =>
    logsClient.getContractEvents({ address: KLEOS_ADDRESS!, abi: kleosAbi, eventName, args, fromBlock, toBlock } as never),
    latest, deadline,
  );
  const times = new Map<bigint, number>();
  for (const log of logs as { blockNumber: bigint }[]) {
    if (!times.has(log.blockNumber)) times.set(log.blockNumber, Number((await withinBudget(publicClient.getBlock({ blockNumber: log.blockNumber }), deadline)).timestamp));
  }
  return (logs as unknown as TimedLog<E>[]).map((l) => ({ ...l, timestamp: times.get(l.blockNumber)! }));
}

export type LiveProfile = {
  name?: string;
  r: number;
  rawR: string;
  vestAt: number;
  asOfBlock: string;
  historyComplete: boolean;
  activationMin: number;
  multiplier: number;
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
  const deadline = Date.now() + READ_BUDGET_MS;
  const blockNumber = await publicClient.getBlockNumber();
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  const [rep, nMin, mult] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "reputation", args: [user] }),
    publicClient.readContract({ ...k, functionName: "N_MIN" }),
    publicClient.readContract({ ...k, functionName: "multiplierOf", args: [user] }),
  ]);

  let history: RepChange[] = [];
  let historyError = false;
  try {
    const [logs, vested] = await Promise.all([kleosEvents("ReputationChanged", { user }, blockNumber), kleosEvents("Vested", { user }, blockNumber)]);
    const questions = new Map<bigint, string>();
    const positioned = new Map<bigint, boolean>(); // a bettor's change is a bet; anyone else's is jury duty
    if (new Set(logs.map((l) => l.args.marketId)).size > 200) throw new Error("Profile history exceeds its metadata budget. Use the indexer.");
    for (const log of logs) {
      const id = log.args.marketId!;
      if (id > 0n && !questions.has(id)) {
        const [m, hasBet] = await withinBudget(Promise.all([
          publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "getMarket", args: [id], blockNumber }),
          publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "hasBet", args: [id, user], blockNumber }),
        ]), deadline);
        questions.set(id, m.question);
        positioned.set(id, hasBet);
      }
    }
    history = logs
      .map((log) => {
        const a = log.args;
        const ts = log.timestamp;
        const entryPrice = Number(a.entryPrice!) / WAD;
        const id = a.marketId!;
        // Seeds (market 0) and jury duty (no position in the market) aren't bets. The entry price can't
        // tell them apart: a bet into an empty side also enters at 0.
        const kind = id === 0n ? a.delta! < 0n ? "Admin slash" : "Admin reputation adjustment" : !positioned.get(id) ? "Jury duty" : null;
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
          logIndex: log.logIndex,
          blockNumber: log.blockNumber.toString(),
          date: DAY.format(new Date(ts * 1000)),
          timestamp: ts,
          isBet: !kind,
          kind: id === 0n ? "admin" as const : kind ? "jury" as const : "bet" as const,
        };
      });
    history.push(...vested.map((log) => ({
      marketId: 0, question: "Pending reputation vested", side: false, outcome: false, entryPrice: 0, amount: 0,
      delta: 0, newR: Number(log.args.newR!) / WAD, tx: log.transactionHash, logIndex: log.logIndex,
      blockNumber: log.blockNumber.toString(), date: DAY.format(new Date(log.timestamp * 1000)), timestamp: log.timestamp, isBet: false, kind: "vest" as const,
    })));
    history.sort((a, b) => Number(BigInt(b.blockNumber!) - BigInt(a.blockNumber!)) || b.logIndex! - a.logIndex!);
  } catch {
    // Public RPCs cap log ranges; the indexer is the real source for long histories.
    historyError = true;
  }

  const bets = history.filter((h) => h.isBet);
  const name = (await readNames([user]).catch(() => new Map<string, string>())).get(user.toLowerCase());
  return {
    name,
    r: Number(rep.r) / WAD, rawR: rep.r.toString(), vestAt: Number(rep.vestAt), asOfBlock: blockNumber.toString(), historyComplete: !historyError, activationMin: Number(nMin), multiplier: Number(mult) / WAD,
    pending: Number(rep.pending) / WAD,
    resolvedBets: rep.resolvedBets,
    flagged: rep.flagged,
    // By side vs outcome, not by the sign of ΔR: a loss at R = 0 takes nothing and emits a delta of 0.
    wins: bets.filter((h) => h.side === h.outcome).length,
    losses: bets.filter((h) => h.side !== h.outcome).length,
    history,
    historyError,
  };
}

const ago = (seconds: number) => {
  const mins = Math.max(0, Math.round(seconds / 60));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
};

export type FeedFilter = { authors?: readonly Address[]; minR?: bigint; blockNumber?: bigint };

/** Filter the complete bounded event read before selecting the latest matching calls. */
async function readCallLogs(marketId: number | undefined, limit: number, user?: Address, filter: FeedFilter = {}) {
  await connection();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid call page.");
  if (filter.authors && filter.authors.length > 100) throw new Error("Following exceeds the read budget. Use an indexed feed.");
  if (filter.authors?.length === 0) return [];
  const blockNumber = filter.blockNumber ?? await publicClient.getBlockNumber();
  const deadline = Date.now() + READ_BUDGET_MS;
  const authorArgs = user ? user : filter.authors ? [...filter.authors] : undefined;
  const logs = await kleosEvents("CallPosted", { ...(marketId ? { marketId: BigInt(marketId) } : {}), ...(authorArgs ? { user: authorArgs } : {}) }, blockNumber);
  logs.sort((a,b) => Number(a.blockNumber-b.blockNumber) || a.logIndex-b.logIndex);
  const candidates = filter.minR === undefined ? logs.slice(-limit) : logs;
  const authors = [...new Set(candidates.map(l => l.args.user!.toLowerCase()))] as Address[];
  if (authors.length > 500) throw new Error("Sharp feed exceeds the participant read budget. Use an indexed feed.");
  const reps = new Map<string, bigint>();
  for (let i = 0; i < authors.length; i += 4) {
    const batch = await withinBudget(Promise.all(authors.slice(i,i+4).map(async address => {
      const rep = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "reputation", args: [address], blockNumber });
      return [address, rep.r] as const;
    })), deadline);
    for (const [address, r] of batch) reps.set(address, r);
  }
  const latest = candidates.filter(log => filter.minR === undefined || reps.get(log.args.user!.toLowerCase())! >= filter.minR).slice(-limit).reverse();
  const now = Math.floor(Date.now() / 1000);
  return latest.map(log => {
    const a = log.args;
    const rawR = reps.get(a.user!.toLowerCase())!;
    const call: Call = { id: Number(a.callId!), address: a.user!, r: Number(rawR)/WAD, rawR: rawR.toString(), rBlock: blockNumber.toString(),
      side: a.side!, amount: Number(a.amount!)/1e6, entryPrice: Number(a.entryPrice!)/WAD, text: a.text!, ago: ago(now-log.timestamp) };
    return { call, marketId: Number(a.marketId!), blockNumber };
  });
}

/** Usernames from the social contract, lowercased address → name. */
export async function readNames(addresses: string[], blockNumber?: bigint): Promise<Map<string, string>> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))] as Address[];
  if (!SOCIAL_ADDRESS || unique.length === 0) return new Map();
  const names = await publicClient.readContract({ address: SOCIAL_ADDRESS, abi: kleosSocialAbi, functionName: "namesOf", args: [unique], blockNumber });
  return new Map(unique.map((a, i) => [a, names[i]] as const).filter(([, n]) => n));
}

async function withNames<T extends { address: string }>(rows: T[], blockNumber?: bigint): Promise<(T & { name?: string })[]> {
  const names = await readNames(rows.map((r) => r.address), blockNumber).catch(() => new Map<string, string>());
  return rows.map((r) => ({ ...r, name: names.get(r.address.toLowerCase()) }));
}

export async function readCalls(marketId: number, limit = 10): Promise<Call[]> {
  return withNames((await readCallLogs(marketId, limit)).map((x) => x.call));
}

export async function readFeed(limit = 50, user?: Address, filter: FeedFilter = {}): Promise<FeedItem[]> {
  const rows = await readCallLogs(undefined, limit, user, filter);
  if (rows.length === 0) return [];
  const blockNumber = rows[0].blockNumber;
  const deadline = Date.now() + READ_BUDGET_MS;
  const ids = [...new Set(rows.map(r => r.marketId))];
  const markets = new Map<number, Awaited<ReturnType<typeof readMarket>>>();
  for (let i = 0; i < ids.length; i += 4) {
    const batch = await withinBudget(Promise.all(ids.slice(i,i+4).map(async id => [id, await readMarket(id, blockNumber)] as const)), deadline);
    for (const [id, market] of batch) markets.set(id, market);
  }
  const items = rows.map(({ call, marketId }) => {
    const m = markets.get(marketId)!;
    return { ...call, marketId, question: m.question,
      result: m.state !== 3 ? null : m.voided ? "refunded" : call.side === m.outcome ? "right" : "wrong" } as FeedItem;
  });
  return withNames(items, blockNumber);
}

function readMarket(id: number, blockNumber?: bigint) {
  return publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "getMarket", args: [BigInt(id)], blockNumber });
}

/** A real market snapshot: every monetary field is read at the same block. */
async function readMarketAt(id: number, blockNumber: bigint, owner: Address): Promise<Market> {
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  const [m, [repYes, moneyYes], bettors] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "getMarket", args: [BigInt(id)] }),
    publicClient.readContract({ ...k, functionName: "prices", args: [BigInt(id)] }),
    readBettorDiscovery(BigInt(id), blockNumber),
  ]);
  const category = await publicClient.readContract({ ...k, functionName: "categoryName", args: [m.category] });
  const byTeam = m.creator.toLowerCase() === owner.toLowerCase();
  const creatorName = byTeam ? undefined : (await readNames([m.creator]).catch(() => new Map<string, string>())).get(m.creator.toLowerCase());
  const closeMs = Number(m.closeTime) * 1000;
  const status: Market["status"] = m.state === 3 ? "resolved" : m.state >= 1 ? "dispute" : closeMs <= Date.now() ? "closed" : closeMs - Date.now() < 86_400_000 ? "closing" : "live";
  return {
    id, question: m.question, category: category as Market["category"], status,
    oracle: m.oracle, criteria: m.criteria,
    creator: byTeam ? undefined : { address: m.creator, name: creatorName },
    type: byTeam ? "Curated" : "Community market",
    closesAt: new Date(closeMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC",
    volume: Number(m.yesMoney + m.noMoney) / 1e6, bettors: Number(bettors.count),
    repYes: Number(repYes) / WAD, moneyYes: Number(moneyYes) / WAD,
    history: [], sharps: { yes: 0, no: 0 },
    stage: m.state === 3 ? 4 : m.state === 2 ? 3 : m.state === 1 ? 2 : closeMs <= Date.now() ? 1 : 0,
    live: { block: blockNumber.toString(), chainId: chain.id, contract: KLEOS_ADDRESS!, closeTime: Number(m.closeTime), state: m.state, sharpsAvailable: false,
      yesMoney: m.yesMoney.toString(), noMoney: m.noMoney.toString(), yesEff: m.yesEff.toString(), noEff: m.noEff.toString() },
  };
}

/** Null means the id does not exist; failures stay failures, never sample transaction data. */
export async function readLiveMarket(id: number): Promise<Market | null> {
  await connection();
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const blockNumber = await publicClient.getBlockNumber();
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  const [count, owner] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "marketCount" }),
    publicClient.readContract({ ...k, functionName: "owner" }),
  ]);
  return BigInt(id) > count ? null : readMarketAt(id, blockNumber, owner);
}

/** Latest real markets, with bounded discovery and concurrency. No fixture prefix. */
export async function readExtraMarkets(fromId: number, limit = 50): Promise<Market[]> {
  await connection();
  if (!Number.isSafeInteger(fromId) || fromId < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid market page.");
  const blockNumber = await publicClient.getBlockNumber();
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  const [count, owner] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "marketCount" }),
    publicClient.readContract({ ...k, functionName: "owner" }),
  ]);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Market ids exceed the supported display range.");
  const end = Number(count);
  const first = Math.max(fromId, end - limit + 1);
  const out: Market[] = [];
  for (let id = end; id >= first; id -= 4) {
    const ids = Array.from({ length: Math.min(4, id - first + 1) }, (_, i) => id - i);
    out.push(...await Promise.all(ids.map((n) => readMarketAt(n, blockNumber, owner))));
  }
  return out;
}

/** Applied weights from real receipts. Historical R is unavailable here, so do not invent it. */
export async function readRecentBets(marketId: number, limit = 8): Promise<Bet[]> {
  await connection();
  const logs = await kleosEvents("BetPlaced", { marketId: BigInt(marketId) });
  const now = Math.floor(Date.now() / 1000);
  return logs.slice(-limit).reverse().map(({ args: a, timestamp }) => ({
    address: a.user!, side: a.side!, amount: Number(a.amount!) / 1e6,
    mult: Number(a.effective!) / Number(a.amount!), effective: Number(a.effective!) / 1e6,
    ago: ago(now - timestamp),
  }));
}

/** Ranking of a bounded observed participant set, never an exhaustive identity/skill ranking. */
export async function readLeaderboard(limit = 50): Promise<{ traders: (Trader & { multiplier: number; rawR: string; flagged: boolean })[]; asOfBlock: string; coverage: string }> {
  await connection();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid leaderboard limit.");
  const blockNumber = await publicClient.getBlockNumber();
  const deadline = Date.now() + READ_BUDGET_MS;
  const [bets, changes] = await Promise.all([kleosEvents("BetPlaced", {}, blockNumber), kleosEvents("ReputationChanged", {}, blockNumber)]);
  const observed = [...bets.map((l) => ({ user: l.args.user!, block: l.blockNumber, index: l.logIndex })), ...changes.map((l) => ({ user: l.args.user!, block: l.blockNumber, index: l.logIndex }))]
    .sort((a, b) => Number(b.block - a.block) || b.index - a.index);
  const addresses = [...new Set(observed.map((l) => l.user.toLowerCase()))].slice(0, 100) as Address[];
  const names = await readNames(addresses).catch(() => new Map<string, string>());
  const traders: (Trader & { multiplier: number; rawR: string; flagged: boolean })[] = [];
  for (let i = 0; i < addresses.length; i += 4) {
    const batch = await withinBudget(Promise.all(addresses.slice(i, i + 4).map(async (address) => {
      const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
      const [rep, mult] = await Promise.all([publicClient.readContract({ ...k, functionName: "reputation", args: [address] }), publicClient.readContract({ ...k, functionName: "multiplierOf", args: [address] })]);
      const results = changes.filter((l) => l.args.user?.toLowerCase() === address && l.args.marketId! > 0n && l.args.entryPrice! > 0n);
      return { address, name: names.get(address), r: Number(rep.r) / WAD, rawR: rep.r.toString(), flagged: rep.flagged, multiplier: Number(mult) / WAD, wins: results.filter((l) => l.args.side === l.args.outcome).length, losses: results.filter((l) => l.args.side !== l.args.outcome).length };
    })), deadline);
    traders.push(...batch);
  }
  traders.sort((a, b) => BigInt(a.rawR) === BigInt(b.rawR) ? a.address.localeCompare(b.address) : BigInt(a.rawR) > BigInt(b.rawR) ? -1 : 1);
  return { traders: traders.slice(0, limit), asOfBlock: blockNumber.toString(), coverage: "Up to 100 most recently observed participants, ranked by current R. Counts cover observed settled side-results only." };
}

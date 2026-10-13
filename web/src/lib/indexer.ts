// Server-only bounded indexed discovery/history. Every operation includes Envio's processing
// checkpoint; exact market/account state is cross-checked on chain at that same block. Unsupported,
// stale, partial or wrong-deployment indexes fail to the bounded chain reader, never sample data.
import "server-only";
import { connection } from "next/server";
import type { Address } from "viem";
import { kleosAbi, kleosSocialAbi } from "./abi";
import { IS_LIVE, IS_LOCAL_CHAIN, KLEOS_ADDRESS, SOCIAL_ADDRESS, chain, publicClient } from "./chain";
import { holdingStatus, type Bet, type Call, type FeedItem, type Holding, type Market, type RepChange, type Trader } from "./data";
import { readExtraMarkets, readLiveMarket, readNames, readProfileSnapshot, type LiveProfile } from "./onchain";

const URL = process.env.INDEXER_URL;
const TTL = { page: 10, list: 30 } as const;
const HISTORY_LIMIT = 200;
const MAX_CANDIDATES = 100;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const WAD = 1e18;
const DEPLOY_BLOCK = process.env.NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK;
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const HAS_INDEXER = Boolean(URL) && IS_LIVE && !IS_LOCAL_CHAIN;

export async function preferIndexer<T>(fromIndexer: () => Promise<T>, fromChain: () => Promise<T>): Promise<T> {
  if (!HAS_INDEXER) return fromChain();
  await connection(); // Next's dynamic rendering signal must not be caught as a read failure.
  try { return await fromIndexer(); }
  catch (err) {
    console.error("[indexer] falling back to the chain:", err instanceof Error ? err.message : err);
    return fromChain();
  }
}

type Meta = { chainId: number; startBlock: number; progressBlock: number; progressBlockTime: string | null; isReady: boolean };
type ReadyData = { _meta: Meta[]; ContractConfiguration: { id: string; source: string; nMin: string | null; vestPeriod: string | null }[] };
const READY_FIELDS = `_meta { chainId startBlock progressBlock progressBlockTime isReady }
  ContractConfiguration(where: { id: { _eq: "${KLEOS_ADDRESS?.toLowerCase() ?? ""}" } }, limit: 1) { id source nMin vestPeriod }`;
const ORDER = "[{ blockNumber: desc }, { logIndex: desc }]";

function integer(value: unknown, label: string, signed = false): bigint {
  if (typeof value !== "string" || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) throw new Error(`Invalid indexed ${label}.`);
  return BigInt(value);
}
function boundedCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid indexed ${label}.`);
  return Number(value);
}
function pageSize(limit: number): void { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid indexed page size."); }
function rowSource(row: { blockNumber: number; logIndex: number; contractAddress: string }, block: bigint) {
  const number = boundedCount(row.blockNumber, "event block");
  boundedCount(row.logIndex, "log index");
  if (typeof row.contractAddress !== "string" || row.contractAddress.toLowerCase() !== KLEOS_ADDRESS!.toLowerCase() || BigInt(number) > block) throw new Error("Indexed event has an invalid source or checkpoint.");
}

async function withinBudget<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Indexed read exceeded its time budget.")), Math.max(1, deadline - Date.now())); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function readResponse(res: Response, deadline: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Indexer response body is unavailable.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "", finished = false;
  try {
    for (;;) {
      const chunk = await withinBudget(reader.read(), deadline);
      if (chunk.done) { finished = true; return text + decoder.decode(); }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Indexed response exceeds its budget.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function query<T>(fields: string, variables: Record<string, unknown>, ttl: number, definitions = ""): Promise<{ data: T; block: bigint }> {
  const deadline = Date.now() + TIMEOUT_MS;
  if (!URL || !DEPLOY_BLOCK || !/^\d+$/.test(DEPLOY_BLOCK)) throw new Error("Indexed reads need a configured deployment block.");
  const res = await withinBudget(fetch(URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: `query${definitions ? ` (${definitions})` : ""} { ${READY_FIELDS} ${fields} }`, variables }),
    next: { revalidate: ttl }, signal: AbortSignal.timeout(TIMEOUT_MS),
  }), deadline);
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) { void res.body?.cancel().catch(() => {}); throw new Error("Indexed response exceeds its budget."); }
  const text = await readResponse(res, deadline);
  const body = JSON.parse(text) as { data?: T & ReadyData; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`indexer: ${body.errors[0].message}`);
  const data = body.data;
  if (!data || !Array.isArray(data._meta) || !Array.isArray(data.ContractConfiguration)) throw new Error("Indexer checkpoint/schema unavailable.");
  const meta = data._meta.find(m => Number(m.chainId) === chain.id);
  const config = data.ContractConfiguration[0];
  if (!meta?.isReady || !config || config.id.toLowerCase() !== KLEOS_ADDRESS!.toLowerCase()) throw new Error("Indexer is not ready for this deployment.");
  if (!["DirectCreation", "PinnedSnapshot"].includes(config.source) || config.nMin === null || config.vestPeriod === null) throw new Error("Indexer deployment configuration has unknown provenance.");
  const nMin = integer(config.nMin, "activation minimum"), vestPeriod = integer(config.vestPeriod, "vest period");
  const block = BigInt(boundedCount(meta.progressBlock, "checkpoint"));
  if (BigInt(boundedCount(meta.startBlock, "start block")) > BigInt(DEPLOY_BLOCK) || block < BigInt(DEPLOY_BLOCK)) throw new Error("Indexer does not cover the deployment.");
  const head = await withinBudget(publicClient.getBlockNumber(), deadline);
  if (block > head || head - block > 300n) throw new Error("Indexer checkpoint is stale or ahead of the chain.");
  const blockData = await withinBudget(publicClient.getBlock({ blockNumber: block }), deadline);
  const indexedTime = meta.progressBlockTime ? Date.parse(meta.progressBlockTime) / 1000 : NaN;
  if (!Number.isFinite(indexedTime) || Math.abs(indexedTime - Number(blockData.timestamp)) > 1 || Date.now() / 1000 - Number(blockData.timestamp) > 120) throw new Error("Indexer checkpoint time is unavailable or stale.");
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber: block } as const;
  const [actualMin, actualVest] = await withinBudget(Promise.all([
    publicClient.readContract({ ...k, functionName: "N_MIN" }), publicClient.readContract({ ...k, functionName: "VEST_PERIOD" }),
  ]), deadline);
  if (actualMin !== nMin || actualVest !== vestPeriod) throw new Error("Indexed configuration does not match the chain checkpoint.");
  return { data, block };
}
const ago = (timestamp: number) => {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - timestamp) / 60));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
};

// Market rows supply indexed history only. Immutable metadata, exact pools, prices, owner and
// bettors come from one pinned chain snapshot. This also prevents stale metadata reaching a trade.
type PointRow = { priceRepYes: string; priceMoneyYes: string; blockNumber: number; logIndex: number };
type MarketRow = { id: string; yesMoney: string; noMoney: string; yesEff: string; noEff: string; betCount: number; sharpYes: number; sharpNo: number; pricePoints: PointRow[] };
const marketFields = (limit: number) => `id yesMoney noMoney yesEff noEff betCount sharpYes sharpNo
  pricePoints(order_by: ${ORDER}, limit: ${limit}) { priceRepYes priceMoneyYes blockNumber logIndex }`;
function indexedMarket(market: Market, row: MarketRow | undefined, block: bigint, limit: number): Market {
  if (!row) return market; // a missing indexed row cannot fabricate a chart or a sharp signal
  for (const field of ["yesMoney", "noMoney", "yesEff", "noEff"] as const) {
    if (integer(row[field], field).toString() !== market.live![field]) throw new Error("Indexed market pools do not match their chain checkpoint.");
  }
  const points = row.pricePoints.map(p => {
    if (BigInt(boundedCount(p.blockNumber, "price block")) > block) throw new Error("Indexed price is beyond its checkpoint.");
    boundedCount(p.logIndex, "price log index");
    const rep = integer(p.priceRepYes, "price"), money = integer(p.priceMoneyYes, "money price");
    if (rep > 10n ** 18n || money > 10n ** 18n) throw new Error("Indexed price is outside its range.");
    return { ...p, rep: Number(rep) / WAD, money: Number(money) / WAD };
  }).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const count = boundedCount(row.betCount, "bet count");
  return { ...market, history: points.map((p, t) => ({ t, rep: p.rep, money: p.money })),
    historyCoverage: `Indexed through block ${block}; ${Math.min(limit, points.length)} latest price points${count > points.length ? " · earlier points omitted" : ""}.`,
    sharps: { yes: boundedCount(row.sharpYes, "sharp count"), no: boundedCount(row.sharpNo, "sharp count") },
    live: { ...market.live!, sharpsAvailable: true } };
}

export async function readMarkets(): Promise<Market[]> {
  const { data, block } = await query<{ Market: MarketRow[] }>(`Market(order_by: { createdAt: desc }, limit: 50) { ${marketFields(48)} }`, {}, TTL.list);
  const markets = await withinBudget(readExtraMarkets(1, 50, block), Date.now() + TIMEOUT_MS);
  return markets.map(m => indexedMarket(m, data.Market.find(row => row.id === String(m.id)), block, 48));
}

type EventRow = { blockNumber: number; logIndex: number; contractAddress: string; timestamp: number; txHash: string };
type BetRow = EventRow & { side: boolean; amount: string; effective: string; multiplier: string; traderR: string; trader: { id: Address } };
const BET_FIELDS = "side amount effective multiplier traderR timestamp blockNumber logIndex contractAddress txHash trader { id }";
function toBet(row: BetRow, block: bigint): Bet {
  rowSource(row, block);
  const amount = integer(row.amount, "bet amount"), effective = integer(row.effective, "effective bet"), rawR = integer(row.traderR, "bet R");
  if (amount <= 0n) throw new Error("Indexed bet amount is invalid.");
  return { address: row.trader.id, side: row.side, amount: Number(amount) / 1e6, effective: Number(effective) / 1e6,
    mult: Number(effective) / Number(amount), r: Number(rawR) / WAD, rawR: rawR.toString(), ago: ago(row.timestamp) };
}

type CallRow = EventRow & { id: string; side: boolean; amount: string; entryPrice: string; text: string; market: { id: string }; trader: { id: Address } };
const CALL_FIELDS = "id side amount entryPrice text timestamp txHash blockNumber logIndex contractAddress market { id } trader { id }";
async function callsAt(rows: CallRow[], block: bigint): Promise<FeedItem[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  const authors = [...new Set(rows.map(row => row.trader.id.toLowerCase()))] as Address[];
  const marketIds = [...new Set(rows.map(row => Number(row.market.id)))];
  const reps = new Map<string, bigint>();
  const markets = new Map<number, NonNullable<Awaited<ReturnType<typeof readLiveMarket>>>>();
  for (let i = 0; i < authors.length; i += 4) {
    if (Date.now() >= deadline) throw new Error("Indexed author reads exceeded their budget.");
    for (const [address, rep] of await withinBudget(Promise.all(authors.slice(i, i + 4).map(async address => [address, await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "reputation", args: [address], blockNumber: block })] as const)), deadline)) reps.set(address, rep.r);
  }
  for (let i = 0; i < marketIds.length; i += 4) {
    if (Date.now() >= deadline) throw new Error("Indexed market reads exceeded their budget.");
    for (const [id, market] of await withinBudget(Promise.all(marketIds.slice(i, i + 4).map(async id => [id, await readLiveMarket(id, block)] as const)), deadline)) {
      if (!market) throw new Error("Indexed call references an unknown market.");
      markets.set(id, market);
    }
  }
  const names = await withinBudget(readNames(authors, block), deadline).catch(() => new Map<string, string>());
  return rows.map(row => {
    rowSource(row, block);
    const id = Number(integer(row.id, "call id")), marketId = Number(integer(row.market.id, "market id"));
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(marketId) || marketId < 1) throw new Error("Indexed call id is unsupported.");
    const market = markets.get(marketId)!;
    const rawR = reps.get(row.trader.id.toLowerCase())!;
    const live = market.live!;
    return { id, address: row.trader.id, name: names.get(row.trader.id.toLowerCase()), r: Number(rawR) / WAD, rawR: rawR.toString(), rBlock: block.toString(),
      side: row.side, amount: Number(integer(row.amount, "call amount")) / 1e6, entryPrice: Number(integer(row.entryPrice, "entry price")) / WAD,
      text: row.text, ago: ago(row.timestamp), marketId, question: market.question,
      result: live.state !== 3 ? null : live.voided ? "refunded" : row.side === live.outcome ? "right" : "wrong" };
  });
}

export async function readMarketPage(id: number): Promise<{ market: Market | null; bets: Bet[]; calls: Call[] }> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid market id.");
  const { data, block } = await query<{ Market: MarketRow[]; Bet: BetRow[]; Call: CallRow[] }>(`
    Market(where: { id: { _eq: $id } }, limit: 1) { ${marketFields(96)} }
    Bet(where: { market_id: { _eq: $id } }, order_by: ${ORDER}, limit: 8) { ${BET_FIELDS} }
    Call(where: { market_id: { _eq: $id } }, order_by: ${ORDER}, limit: 10) { ${CALL_FIELDS} }`, { id: String(id) }, TTL.page, "$id: String!");
  const market = await withinBudget(readLiveMarket(id, block), Date.now() + TIMEOUT_MS);
  if (market && !data.Market[0]) throw new Error("Indexed market is missing at its checkpoint.");
  return { market: market ? indexedMarket(market, data.Market[0], block, 96) : null,
    bets: data.Bet.map(row => toBet(row, block)), calls: await callsAt(data.Call, block) };
}

export async function readFeed(limit = 50): Promise<FeedItem[]> {
  pageSize(limit);
  const { data, block } = await query<{ Call: CallRow[] }>(`Call(order_by: ${ORDER}, limit: $limit) { ${CALL_FIELDS} }`, { limit }, TTL.list, "$limit: Int!");
  return callsAt(data.Call, block);
}

/** Filtering is performed by GraphQL before its page boundary. The chain verifies the same
 * checkpoint's author R or the entire bounded following roster before publishing the result. */
export async function readFilteredFeed(filter: { minR?: bigint; follower?: Address }, limit = 50): Promise<FeedItem[]> {
  pageSize(limit);
  const sharp = filter.minR !== undefined;
  if (sharp === Boolean(filter.follower)) throw new Error("Choose one indexed feed filter.");
  if (sharp && (typeof filter.minR !== "bigint" || filter.minR < 0n)) throw new Error("Invalid sharp threshold.");
  if (filter.follower && (!/^0x[a-fA-F0-9]{40}$/.test(filter.follower) || !SOCIAL_ADDRESS)) throw new Error("Select a social account for the indexed following feed.");
  const where = sharp ? `trader: { r: { _gte: "${filter.minR}" } }` : "trader: { followers: { follower_id: { _eq: $follower } } }";
  const { data, block } = await query<{ Call: CallRow[]; Follow?: { followee_id: string }[] }>(`
    Call(where: { ${where} }, order_by: ${ORDER}, limit: $limit) { ${CALL_FIELDS} }
    ${sharp ? "" : "Follow(where: { follower_id: { _eq: $follower } }, limit: 101) { followee_id }"}`,
    { limit, ...(filter.follower ? { follower: filter.follower.toLowerCase() } : {}) }, TTL.page, `$limit: Int!${sharp ? "" : ", $follower: String!"}`);
  if (filter.follower) {
    const authors = await withinBudget(publicClient.readContract({ address: SOCIAL_ADDRESS!, abi: kleosSocialAbi, functionName: "following", args: [filter.follower], blockNumber: block }), Date.now() + TIMEOUT_MS);
    if (authors.length > 100 || !data.Follow || data.Follow.length > 100) throw new Error("Following exceeds the indexed read budget.");
    const actual = [...authors].map(a => a.toLowerCase()).sort();
    const indexed = data.Follow.map(f => f.followee_id.toLowerCase()).sort();
    if (actual.join(",") !== indexed.join(",")) throw new Error("Indexed follows do not match the chain checkpoint.");
    if (data.Call.some(c => !actual.includes(c.trader.id.toLowerCase()))) throw new Error("Indexed following feed contains an unfollowed author.");
  }
  const rows = await callsAt(data.Call, block);
  if (sharp && rows.some(row => BigInt(row.rawR!) < filter.minR!)) throw new Error("Indexed sharp authors do not match the chain checkpoint.");
  return rows;
}

export async function readLeaderboard(limit = 50): Promise<{ traders: (Trader & { multiplier: number; rawR: string; flagged: boolean })[]; asOfBlock: string; coverage: string }> {
  pageSize(limit);
  const { data, block } = await query<{ Trader: { id: Address; r: string; wins: number; losses: number }[] }>(`
    Trader(where: { _or: [{ r: { _gt: "0" } }, { betCount: { _gt: 0 } }] }, order_by: [{ r: desc }, { id: asc }], limit: ${MAX_CANDIDATES}) { id r wins losses }`, {}, TTL.list);
  const deadline = Date.now() + TIMEOUT_MS;
  const names = await withinBudget(readNames(data.Trader.map(t => t.id), block), deadline).catch(() => new Map<string, string>());
  const traders: (Trader & { multiplier: number; rawR: string; flagged: boolean })[] = [];
  for (let i = 0; i < data.Trader.length; i += 4) {
    traders.push(...await withinBudget(Promise.all(data.Trader.slice(i, i + 4).map(async t => {
      const rep = await readProfileSnapshot(t.id, block);
      if (integer(t.r, "trader R").toString() !== rep.rawR) throw new Error("Indexed R does not match its chain checkpoint.");
      return { address: t.id, name: names.get(t.id.toLowerCase()), r: rep.r, rawR: rep.rawR, flagged: rep.flagged, multiplier: rep.multiplier,
        wins: boundedCount(t.wins, "wins"), losses: boundedCount(t.losses, "losses") };
    })), deadline));
  }
  traders.sort((a, b) => BigInt(a.rawR) === BigInt(b.rawR) ? a.address.localeCompare(b.address) : BigInt(a.rawR) > BigInt(b.rawR) ? -1 : 1);
  return { traders: traders.slice(0, limit), asOfBlock: block.toString(), coverage: `Up to ${MAX_CANDIDATES} highest indexed-R participants, checked against the chain at this block. Counts cover indexed reputation-scored side results. Index coverage may omit participants.` };
}

type PositionRow = { market_id: string; yesMoney: string; noMoney: string; settled: boolean; payout: string };
async function holdingsAt(rows: PositionRow[], user: Address, blockNumber: bigint): Promise<Holding[]> {
  if (rows.length > 100) throw new Error("Holdings exceed the indexed profile read budget.");
  const ids = rows.map(row => {
    const id = Number(integer(row.market_id, "holding market id"));
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Indexed holding market id is unsupported.");
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Indexed holdings contain duplicate markets.");
  const deadline = Date.now() + TIMEOUT_MS;
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  const holdings: Holding[] = [];
  for (let i = 0; i < rows.length; i += 4) {
    holdings.push(...await withinBudget(Promise.all(rows.slice(i, i + 4).map(async (row, offset) => {
      const id = BigInt(ids[i + offset]);
      const [m, yesPos, noPos, settled] = await Promise.all([
        publicClient.readContract({ ...k, functionName: "getMarket", args: [id] }),
        publicClient.readContract({ ...k, functionName: "positions", args: [id, user, true] }),
        publicClient.readContract({ ...k, functionName: "positions", args: [id, user, false] }),
        publicClient.readContract({ ...k, functionName: "settled", args: [id, user] }),
      ]);
      if (yesPos[0] + noPos[0] === 0n || integer(row.yesMoney, "YES holding") !== yesPos[0] ||
          integer(row.noMoney, "NO holding") !== noPos[0] || row.settled !== settled) {
        throw new Error("Indexed holding does not match its chain checkpoint.");
      }
      const yes = Number(yesPos[0]) / 1e6, no = Number(noPos[0]) / 1e6;
      return { marketId: Number(id), question: m.question, yes, no,
        status: holdingStatus({ state: m.state, outcome: m.outcome, voided: m.voided, closeMs: Number(m.closeTime) * 1000 }, yes, no),
        ...(settled ? { payout: Number(integer(row.payout, "holding payout")) / 1e6 } : {}) };
    })), deadline));
  }
  return holdings.sort((a, b) => b.marketId - a.marketId);
}

type ChangeRow = EventRow & { kind: "Bet" | "Jury" | "Admin"; adminAction: "Seed" | "Slash" | "Unknown" | null; delta: string; newR: string; entryPrice: string; side: boolean; outcome: boolean; market: { id: string; question: string } | null };
type VestRow = EventRow & { amount: string; newR: string };
export async function readProfilePage(user: Address): Promise<{ profile: LiveProfile; calls: FeedItem[]; holdings: Holding[] }> {
  const { data, block } = await query<{ Trader: { r: string; wins: number; losses: number; resolvedBets: string | null; resolvedBetsSource: string }[]; ReputationChange: ChangeRow[]; Vesting: VestRow[]; Call: CallRow[]; Position: PositionRow[] }>(`
    Trader(where: { id: { _eq: $id } }, limit: 1) { r wins losses resolvedBets resolvedBetsSource }
    ReputationChange(where: { trader_id: { _eq: $id } }, order_by: ${ORDER}, limit: ${HISTORY_LIMIT + 1}) {
      kind adminAction delta newR entryPrice side outcome timestamp txHash blockNumber logIndex contractAddress market { id question }
    }
    Vesting(where: { trader_id: { _eq: $id } }, order_by: ${ORDER}, limit: ${HISTORY_LIMIT + 1}) { amount newR timestamp txHash blockNumber logIndex contractAddress }
    Call(where: { trader_id: { _eq: $id } }, order_by: ${ORDER}, limit: 50) { ${CALL_FIELDS} }
    Position(where: { trader_id: { _eq: $id } }, limit: 101) { market_id yesMoney noMoney settled payout }`, { id: user.toLowerCase() }, TTL.page, "$id: String!");
  const deadline = Date.now() + TIMEOUT_MS;
  const snapshot = await withinBudget(readProfileSnapshot(user, block), deadline);
  const indexedTrader = data.Trader[0];
  if (indexedTrader ? integer(indexedTrader.r, "profile R").toString() !== snapshot.rawR : BigInt(snapshot.rawR) > 0n || snapshot.pending > 0 || snapshot.resolvedBets > 0) throw new Error("Indexed profile is missing or inconsistent at its checkpoint.");
  const names = await withinBudget(readNames([user], block), deadline).catch(() => new Map<string, string>());
  const history: RepChange[] = data.ReputationChange.slice(0, HISTORY_LIMIT).map(row => {
    rowSource(row, block);
    const kind = row.kind.toLowerCase() as "bet" | "jury" | "admin";
    const label = kind === "admin" ? row.adminAction === "Seed" ? "Admin reputation seed" : row.adminAction === "Slash" ? "Admin slash" : "Admin reputation adjustment" : kind === "jury" ? "Jury duty" : null;
    return { kind, marketId: row.market ? Number(row.market.id) : 0, question: label ? `${label}${row.market ? ` · ${row.market.question}` : ""}` : row.market?.question ?? "Market",
      side: row.side, outcome: row.outcome, entryPrice: Number(integer(row.entryPrice, "entry price")) / WAD, amount: 0,
      delta: Number(integer(row.delta, "reputation delta", true)) / WAD, newR: Number(integer(row.newR, "new R")) / WAD,
      tx: row.txHash, logIndex: row.logIndex, blockNumber: String(row.blockNumber), timestamp: row.timestamp, date: DAY.format(new Date(row.timestamp * 1000)), isBet: kind === "bet" };
  });
  history.push(...data.Vesting.slice(0, HISTORY_LIMIT).map(row => {
    rowSource(row, block);
    return { kind: "vest" as const, marketId: 0, question: "Pending reputation vested", side: false, outcome: false, entryPrice: 0, amount: 0, delta: 0,
      newR: Number(integer(row.newR, "vested R")) / WAD, tx: row.txHash, logIndex: row.logIndex, blockNumber: String(row.blockNumber), timestamp: row.timestamp, date: DAY.format(new Date(row.timestamp * 1000)), isBet: false };
  }));
  history.sort((a, b) => Number(BigInt(b.blockNumber!) - BigInt(a.blockNumber!)) || b.logIndex! - a.logIndex!);
  const complete = data.ReputationChange.length <= HISTORY_LIMIT && data.Vesting.length <= HISTORY_LIMIT;
  const trader = data.Trader[0];
  return { profile: { ...snapshot, name: names.get(user.toLowerCase()), wins: trader ? boundedCount(trader.wins, "wins") : 0, losses: trader ? boundedCount(trader.losses, "losses") : 0,
    history, historyError: false, historyComplete: complete,
    historyCoverage: `Indexed through block ${block}; latest ${HISTORY_LIMIT} reputation adjustments and ${HISTORY_LIMIT} vest events${complete ? "" : " · earlier changes omitted"}. Current activation count is read directly from the contract.` },
    calls: await callsAt(data.Call, block), holdings: await holdingsAt(data.Position, user, block) };
}

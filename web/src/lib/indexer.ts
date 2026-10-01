// Server-side reads from the Envio HyperIndex indexer (../indexer): one GraphQL query per read,
// cached briefly. The Envio free plan allows 100 queries a minute across all visitors, so queries
// only ever run here on the server, never per component or from the browser.
//
// Pages read indexer → chain (onchain.ts) → sample data (data.ts): `preferIndexer` falls back to
// the chain reader whenever INDEXER_URL is unset or the indexer fails. Whatever must be exact at the
// moment of an action (balances, the trade panel, the account's own reputation) stays on the chain.
import "server-only";
import { connection } from "next/server";
import type { Address } from "viem";
import { kleosAbi } from "./abi";
import { IS_LIVE, IS_LOCAL_CHAIN, KLEOS_ADDRESS, publicClient } from "./chain";
import type { Bet, Call, Category, FeedItem, Market, RepChange, Trader } from "./data";
import type { LiveProfile } from "./onchain";

const URL = process.env.INDEXER_URL;
/** Seconds a query result is reused. Keeps the site far below the free plan's query limit. */
const TTL = 10;

/** The deployed indexer serves Monad testnet, so it's skipped in demo mode and on the local chain. */
export const HAS_INDEXER = Boolean(URL) && IS_LIVE && !IS_LOCAL_CHAIN;

const WAD = 1e18;
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Indexer first, then the chain. Logs indexer failures so a broken deployment doesn't go unnoticed. */
export async function preferIndexer<T>(fromIndexer: () => Promise<T>, fromChain: () => Promise<T>): Promise<T> {
  if (!HAS_INDEXER) return fromChain();
  try {
    return await fromIndexer();
  } catch (err) {
    console.error("[indexer] falling back to the chain:", err instanceof Error ? err.message : err);
    return fromChain();
  }
}

async function query<T>(gql: string, variables: Record<string, unknown> = {}): Promise<T> {
  await connection(); // live data: render per request, never at build time
  const res = await fetch(URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql, variables }),
    next: { revalidate: TTL },
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`indexer: ${body.errors[0].message}`);
  return body.data!;
}

// GraphQL returns BigInt and numeric fields as strings, and addresses lowercased (ids) or as stored.
const wad = (v: string) => Number(v) / WAD;
const usd = (v: string) => Number(v) / 1e6;

const ago = (seconds: number) => {
  const mins = Math.max(0, Math.round(seconds / 60));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
};
const now = () => Math.floor(Date.now() / 1000);

// ─── Markets ──────────────────────────────────────────────────────────────────

const MARKET_FIELDS = `
  id question oracle criteria creator closeTime state voided
  yesMoney noMoney bettorCount priceRepYes priceMoneyYes sharpYes sharpNo
  category { name }
  pricePoints(order_by: { timestamp: asc }) { priceRepYes priceMoneyYes }
`;

type MarketRow = {
  id: string;
  question: string;
  oracle: string;
  criteria: string;
  creator: string;
  closeTime: string;
  state: "Open" | "Proposed" | "Disputed" | "Resolved";
  voided: boolean;
  yesMoney: string;
  noMoney: string;
  bettorCount: number;
  priceRepYes: string;
  priceMoneyYes: string;
  sharpYes: number;
  sharpNo: number;
  category: { name: string };
  pricePoints: { priceRepYes: string; priceMoneyYes: string }[];
};

/** The team creates markets for free; anyone else is a tier-V trader. Read once per server process. */
let teamAddress: Promise<string> | undefined;
const team = () =>
  (teamAddress ??= publicClient
    .readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "owner" })
    .then((a) => a.toLowerCase())
    .catch((err) => {
      teamAddress = undefined; // retry on the next request
      throw err;
    }));

function toMarket(m: MarketRow, owner: string, names: Map<string, string>): Market {
  const byTeam = m.creator.toLowerCase() === owner;
  const closeMs = Number(m.closeTime) * 1000;
  const status: Market["status"] =
    m.state === "Resolved" ? "resolved" : m.state !== "Open" ? "dispute" : closeMs - Date.now() < 86_400_000 ? "closing" : "live";
  // The chart starts at 50/50 and steps through the price after every bet.
  const history = [{ t: 0, rep: 0.5, money: 0.5 }, ...m.pricePoints.map((p, i) => ({ t: i + 1, rep: wad(p.priceRepYes), money: wad(p.priceMoneyYes) }))];
  if (history.length === 1) history.push({ t: 1, rep: 0.5, money: 0.5 });
  return {
    id: Number(m.id),
    question: m.question,
    category: (m.category.name || "Culture") as Category,
    status,
    oracle: m.oracle,
    criteria: m.criteria,
    creator: byTeam ? undefined : { address: m.creator, name: names.get(m.creator.toLowerCase()) },
    type: byTeam ? "Curated" : "Community market",
    closesAt: new Date(closeMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC",
    volume: usd(m.yesMoney) + usd(m.noMoney),
    bettors: m.bettorCount,
    repYes: wad(m.priceRepYes),
    moneyYes: wad(m.priceMoneyYes),
    history,
    sharps: { yes: m.sharpYes, no: m.sharpNo },
    stage: 0,
  };
}

async function marketsWithCreators(rows: MarketRow[]): Promise<Market[]> {
  const owner = await team();
  const creators = [...new Set(rows.map((m) => m.creator.toLowerCase()).filter((c) => c !== owner))];
  const names = new Map<string, string>();
  if (creators.length) {
    const { Trader } = await query<{ Trader: { id: string; name: string | null }[] }>(
      `query ($ids: [String!]) { Trader(where: { id: { _in: $ids } }) { id name } }`,
      { ids: creators },
    );
    for (const t of Trader) if (t.name) names.set(t.id, t.name);
  }
  return rows.map((m) => toMarket(m, owner, names));
}

/** One market, or null if it doesn't exist. Mirrors onchain.readLiveMarket. */
export async function readLiveMarket(id: number): Promise<Market | null> {
  const { Market } = await query<{ Market: MarketRow[] }>(`query ($id: String!) { Market(where: { id: { _eq: $id } }) { ${MARKET_FIELDS} } }`, {
    id: String(id),
  });
  return Market.length ? (await marketsWithCreators(Market))[0] : null;
}

/** Markets with id ≥ fromId, oldest first. Mirrors onchain.readExtraMarkets. */
export async function readExtraMarkets(fromId: number): Promise<Market[]> {
  // Ids are strings in GraphQL, so filter and sort them as numbers here. There are only a few markets.
  const { Market } = await query<{ Market: MarketRow[] }>(`{ Market { ${MARKET_FIELDS} } }`);
  const rows = Market.filter((m) => Number(m.id) >= fromId).sort((a, b) => Number(a.id) - Number(b.id));
  return marketsWithCreators(rows);
}

/** The latest bets in a market, newest first. */
export async function readRecentBets(marketId: number, limit = 8): Promise<Bet[]> {
  const { Bet } = await query<{ Bet: { side: boolean; amount: string; multiplier: string; traderR: string; timestamp: number; trader: { id: string } }[] }>(
    `query ($id: String!, $limit: Int!) {
      Bet(where: { market_id: { _eq: $id } }, order_by: [{ timestamp: desc }, { id: desc }], limit: $limit) {
        side amount multiplier traderR timestamp trader { id }
      }
    }`,
    { id: String(marketId), limit },
  );
  const t = now();
  return Bet.map((b) => ({ address: b.trader.id, side: b.side, amount: usd(b.amount), mult: wad(b.multiplier), r: wad(b.traderR), ago: ago(t - b.timestamp) }));
}

// ─── Calls and the feed ───────────────────────────────────────────────────────

type CallRow = {
  id: string;
  side: boolean;
  amount: string;
  entryPrice: string;
  text: string;
  result: "Open" | "Right" | "Wrong" | "Refunded";
  timestamp: number;
  market: { id: string; question: string };
  trader: { id: string; name: string | null; r: string };
};

const CALL_FIELDS = `id side amount entryPrice text result timestamp market { id question } trader { id name r }`;
const RESULTS = { Open: null, Right: "right", Wrong: "wrong", Refunded: "refunded" } as const;

function toCall(c: CallRow, t: number): Call {
  return {
    id: Number(c.id), // numbered by the contract; KleosSocial votes use the same id
    address: c.trader.id,
    name: c.trader.name ?? undefined,
    r: wad(c.trader.r),
    side: c.side,
    amount: usd(c.amount),
    entryPrice: wad(c.entryPrice),
    text: c.text,
    ago: ago(t - c.timestamp),
  };
}

/** One market's latest calls. Mirrors onchain.readCalls. */
export async function readCalls(marketId: number, limit = 10): Promise<Call[]> {
  const { Call } = await query<{ Call: CallRow[] }>(
    `query ($id: String!, $limit: Int!) { Call(where: { market_id: { _eq: $id } }, order_by: [{ timestamp: desc }, { id: desc }], limit: $limit) { ${CALL_FIELDS} } }`,
    { id: String(marketId), limit },
  );
  const t = now();
  return Call.map((c) => toCall(c, t));
}

/** Every market's latest calls, or one trader's, with their results. Mirrors onchain.readFeed. */
export async function readFeed(limit = 50, user?: Address): Promise<FeedItem[]> {
  const { Call } = await query<{ Call: CallRow[] }>(
    `query ($where: Call_bool_exp!, $limit: Int!) { Call(where: $where, order_by: [{ timestamp: desc }, { id: desc }], limit: $limit) { ${CALL_FIELDS} } }`,
    { where: user ? { trader_id: { _eq: user.toLowerCase() } } : {}, limit },
  );
  const t = now();
  return Call.map((c) => ({ ...toCall(c, t), marketId: Number(c.market.id), question: c.market.question, result: RESULTS[c.result] }));
}

// ─── Traders ──────────────────────────────────────────────────────────────────

/** Traders by vested reputation: anyone with R or a bet. */
export async function readLeaderboard(limit = 50): Promise<Trader[]> {
  const { Trader } = await query<{ Trader: { id: string; name: string | null; r: string; wins: number; losses: number }[] }>(
    `query ($limit: Int!) {
      Trader(where: { _or: [{ r: { _gt: "0" } }, { betCount: { _gt: 0 } }] }, order_by: [{ r: desc }, { wins: desc }], limit: $limit) {
        id name r wins losses
      }
    }`,
    { limit },
  );
  return Trader.map((t) => ({ address: t.id, name: t.name ?? undefined, r: wad(t.r), wins: t.wins, losses: t.losses }));
}

type ChangeRow = {
  kind: "Bet" | "Jury" | "Admin";
  delta: string;
  newR: string;
  entryPrice: string;
  side: boolean;
  outcome: boolean;
  timestamp: number;
  txHash: string;
  market: { id: string; question: string } | null;
};

/**
 * A profile. R, pending, resolvedBets and the flag come from the contract: they must be exact, and
 * seeds set resolvedBets without an event, so the index can't know it. The name, wins, losses and
 * the full reputation history come from the indexer. Mirrors onchain.readProfile.
 */
export async function readProfile(user: Address): Promise<LiveProfile> {
  const id = user.toLowerCase();
  const [rep, { Trader, ReputationChange }] = await Promise.all([
    publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "reputation", args: [user] }),
    query<{ Trader: { name: string | null; wins: number; losses: number }[]; ReputationChange: ChangeRow[] }>(
      `query ($id: String!) {
        Trader(where: { id: { _eq: $id } }) { name wins losses }
        ReputationChange(where: { trader_id: { _eq: $id } }, order_by: [{ timestamp: desc }, { id: desc }]) {
          kind delta newR entryPrice side outcome timestamp txHash market { id question }
        }
      }`,
      { id },
    ),
  ]);
  const trader = Trader[0];
  const history: RepChange[] = ReputationChange.map((c) => {
    // Same labels as the chain reader: seeds (market 0) and jury duty aren't bets.
    const label = c.kind === "Admin" ? "Genesis seed (demo)" : c.kind === "Jury" ? "Jury duty" : null;
    const question = c.market?.question;
    return {
      marketId: c.market ? Number(c.market.id) : 0,
      question: label ? `${label}${question ? ` · ${question}` : ""}` : (question ?? "Market"),
      side: c.side,
      outcome: c.outcome,
      entryPrice: wad(c.entryPrice),
      amount: 0,
      delta: wad(c.delta),
      newR: wad(c.newR),
      tx: c.txHash,
      date: DAY.format(new Date(c.timestamp * 1000)),
      timestamp: c.timestamp,
      isBet: c.kind === "Bet",
    };
  });
  return {
    name: trader?.name ?? undefined,
    r: Number(rep.r) / WAD,
    pending: Number(rep.pending) / WAD,
    resolvedBets: rep.resolvedBets,
    flagged: rep.flagged,
    wins: trader?.wins ?? 0,
    losses: trader?.losses ?? 0,
    history,
    historyError: false,
  };
}

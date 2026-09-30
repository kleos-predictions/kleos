// Demo data shaped like the on-chain state and events. Swap these functions for contract
// reads (see lib/abi.ts) once the markets are deployed and seeded.

import { multiplier, reputationDelta } from "./math";
import { tierOf } from "./tiers";

export type Category = "Crypto" | "Sports" | "Tech" | "Culture";
export type Status = "live" | "closing" | "dispute" | "resolved";

export type PricePoint = { t: number; rep: number; money: number };

export type Market = {
  id: number;
  question: string;
  category: Category;
  status: Status;
  oracle: string;
  criteria: string; // stored on-chain at creation, shown before every bet
  creator?: { address: string; name?: string }; // markets created by a trader rather than the team
  type: string;
  closesAt: string;
  volume: number;
  bettors: number;
  repYes: number;
  moneyYes: number;
  history: PricePoint[];
  proposed?: { outcome: boolean; finalIn: string };
  stage: number; // index into RESOLUTION_STAGES
  sharps: { yes: number; no: number }; // bettors with R ≥ SHARP_R, by side
};

export type Bet = { address: string; side: boolean; amount: number; mult: number; r: number; ago: string };

export type RepChange = {
  marketId: number;
  question: string;
  side: boolean;
  outcome: boolean;
  entryPrice: number;
  amount: number;
  delta: number;
  newR: number;
  tx: string;
  date: string;
  timestamp: number; // seconds
  isBet?: boolean; // false for demo seeds and jury duty
};

export type Trader = { address: string; name?: string; r: number; wins: number; losses: number };

export const CATEGORIES: Category[] = ["Crypto", "Sports", "Tech", "Culture"];
/** "Sharp" = tier IV or above. Used for the sharp-signal flag. */
export const SHARP_R = 16;

export const RESOLUTION_STAGES = ["Open", "Closed", "Proposed", "Dispute window", "Resolved"] as const;

// Small seeded RNG so server and client render the same numbers.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function hashString(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function series(seed: number, repEnd: number, moneyEnd: number, n = 48): PricePoint[] {
  const r = rng(seed);
  let rep = repEnd + (repEnd > 0.5 ? -0.28 : 0.24);
  let money = moneyEnd + (r() - 0.5) * 0.2;
  const out: PricePoint[] = [];
  for (let i = 0; i < n; i++) {
    const pull = i / (n - 1);
    rep += (repEnd - rep) * 0.12 * pull + (r() - 0.5) * 0.07;
    money += (moneyEnd - money) * 0.1 * pull + (r() - 0.5) * 0.04;
    const clamp = (v: number) => Math.min(0.97, Math.max(0.03, v));
    out.push({ t: i, rep: clamp(i === n - 1 ? repEnd : rep), money: clamp(i === n - 1 ? moneyEnd : money) });
  }
  return out;
}

export const MARKETS: Market[] = [
  {
    id: 1,
    question: "BTC closes above $120K on Oct 31?",
    category: "Crypto",
    status: "live",
    oracle: "Chainlink BTC/USD",
    criteria: "YES if the Chainlink BTC/USD feed reads above 120,000 at 23:59 UTC on Oct 31.",
    type: "Price feed",
    closesAt: "Oct 31, 23:59 UTC",
    volume: 48_210,
    bettors: 312,
    repYes: 0.64,
    moneyYes: 0.41,
    history: series(1, 0.64, 0.41),
    stage: 0,
    sharps: { yes: 9, no: 3 },
  },
  {
    id: 2,
    question: "Monad mainnet passes 10M daily transactions by December?",
    category: "Tech",
    status: "live",
    oracle: "Monadscan daily tx count",
    criteria: "YES if Monadscan shows any UTC day with more than 10,000,000 transactions before Dec 1.",
    type: "Onchain metric",
    closesAt: "Dec 1, 00:00 UTC",
    volume: 21_904,
    bettors: 188,
    repYes: 0.38,
    moneyYes: 0.52,
    history: series(2, 0.38, 0.52),
    stage: 0,
    sharps: { yes: 4, no: 7 },
  },
  {
    id: 3,
    question: "Home side wins Sunday's derby?",
    category: "Sports",
    status: "closing",
    oracle: "Official league result",
    criteria: "YES if the home side wins in regular time, per the league's official result.",
    type: "Sports result",
    closesAt: "Sun, 15:00 UTC",
    volume: 12_730,
    bettors: 96,
    repYes: 0.71,
    moneyYes: 0.58,
    history: series(3, 0.71, 0.58),
    stage: 0,
    sharps: { yes: 8, no: 2 },
  },
  {
    id: 4,
    question: "ETH above $5K before year end?",
    category: "Crypto",
    status: "live",
    oracle: "Chainlink ETH/USD",
    criteria: "YES if the Chainlink ETH/USD feed reads above 5,000 at any point before Dec 31, 23:59 UTC.",
    type: "Price feed",
    closesAt: "Dec 31, 23:59 UTC",
    volume: 36_455,
    bettors: 241,
    repYes: 0.22,
    moneyYes: 0.35,
    history: series(4, 0.22, 0.35),
    stage: 0,
    sharps: { yes: 2, no: 9 },
  },
  {
    id: 5,
    question: "Demo day draws more than 500 attendees?",
    category: "Culture",
    status: "dispute",
    oracle: "Organizer check-in count",
    criteria: "YES if the organizer's published check-in count is above 500.",
    type: "Event count",
    closesAt: "Closed",
    volume: 5_120,
    bettors: 54,
    repYes: 0.68,
    moneyYes: 0.6,
    history: series(5, 0.68, 0.6),
    proposed: { outcome: true, finalIn: "01:42" },
    stage: 3,
    sharps: { yes: 6, no: 2 },
  },
  {
    id: 6,
    question: "An open-weights model tops the main leaderboard by November?",
    category: "Tech",
    status: "live",
    oracle: "LMArena text leaderboard",
    criteria: "YES if a model with public weights is ranked #1 on the LMArena text leaderboard on Nov 30.",
    type: "Public ranking",
    closesAt: "Nov 30, 23:59 UTC",
    volume: 18_377,
    bettors: 150,
    repYes: 0.47,
    moneyYes: 0.3,
    history: series(6, 0.47, 0.3),
    stage: 0,
    sharps: { yes: 7, no: 5 },
  },
];

export function getMarket(id: number) {
  return MARKETS.find((m) => m.id === id);
}

function fakeAddress(seed: number) {
  const r = rng(seed);
  let hex = "0x";
  for (let i = 0; i < 40; i++) hex += Math.floor(r() * 16).toString(16);
  return hex;
}

function fakeTx(seed: number) {
  const r = rng(seed * 7919);
  let hex = "0x";
  for (let i = 0; i < 64; i++) hex += Math.floor(r() * 16).toString(16);
  return hex;
}

const SAMPLE_NAMES = ["oracle_ana", "contrarian", "base_rates", "late_to_nothing", "pollster", "whale_watcher", "calm_money", "degen_no_more", "priors", "signal", "fadethecrowd"];

export const TRADERS: Trader[] = [
  { address: "0x3f1e8a4b2c9d07e6f5a1b3c8d4e2f9a07b6c9a2c", name: "kleos_maxi", r: 41.2, wins: 58, losses: 19 },
  ...Array.from({ length: 11 }, (_, i) => {
    const r = rng(100 + i);
    const rep = Math.round((36 - i * 3.2 + r() * 2) * 10) / 10;
    return { address: fakeAddress(200 + i), name: i % 4 === 3 ? undefined : SAMPLE_NAMES[i], r: Math.max(rep, 0.4), wins: 20 + Math.floor(r() * 40), losses: 5 + Math.floor(r() * 20) };
  }),
].sort((a, b) => b.r - a.r);

export function recentBets(marketId: number): Bet[] {
  const r = rng(marketId * 31);
  const agos = ["12s", "48s", "2m", "5m", "9m", "14m", "22m", "31m"];
  return agos.map((ago, i) => {
    const trader = TRADERS[Math.floor(r() * TRADERS.length)];
    const rep = i === 2 ? 0 : trader.r;
    return {
      address: i === 2 ? fakeAddress(marketId * 97) : trader.address,
      side: r() > 0.4,
      amount: [10, 25, 50, 80, 100, 250, 2000][Math.floor(r() * 7)],
      mult: multiplier(rep),
      r: rep,
      ago,
    };
  });
}

export function getTrader(address: string): Trader {
  const known = TRADERS.find((t) => t.address.toLowerCase() === address.toLowerCase());
  if (known) return known;
  const r = rng(hashString(address.toLowerCase()));
  return { address, r: Math.round(r() * 120) / 10, wins: Math.floor(r() * 20), losses: Math.floor(r() * 12) };
}

/** Rebuilds a history that ends at the trader's current R, the way the indexer replays events. */
export function reputationHistory(trader: Trader, count = 14): RepChange[] {
  const r = rng(hashString(trader.address.toLowerCase()) + 1);
  const rows: Omit<RepChange, "newR">[] = [];
  for (let i = 0; i < count; i++) {
    const market = MARKETS[Math.floor(r() * MARKETS.length)];
    const side = r() > 0.5;
    const entryPrice = Math.round((0.15 + r() * 0.7) * 100) / 100;
    const won = r() < 0.66;
    const amount = [20, 50, 80, 100][Math.floor(r() * 4)];
    rows.push({
      marketId: market.id,
      question: market.question,
      side,
      outcome: won ? side : !side,
      entryPrice,
      amount,
      delta: reputationDelta(won, entryPrice, amount),
      tx: fakeTx(hashString(trader.address) + i),
      ...(() => {
        // Roughly one resolved market a week, going back from Sep 27, 2026.
        const ts = Date.UTC(2026, 8, 27) / 1000 - i * 8 * 86_400;
        return { timestamp: ts, date: new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) };
      })(),
    });
  }
  // Walk backwards from today's R so each row's newR is consistent with its delta.
  let running = trader.r;
  return rows.map((row) => {
    const out = { ...row, newR: Math.max(running, 0) };
    running -= row.delta;
    return out;
  });
}

export function traderTier(t: Trader) {
  return tierOf(t.r);
}

/** Pool sizes implied by the displayed prices (effective pool runs ~1.6× the money pool). */
export function pools(m: Market) {
  const effTotal = m.volume * 1.6;
  return {
    yesMoney: m.volume * m.moneyYes,
    noMoney: m.volume * (1 - m.moneyYes),
    yesEff: effTotal * m.repYes,
    noEff: effTotal * (1 - m.repYes),
  };
}

/** Reputation used for the connected wallet in demo mode (R = 16 → 3× boost). */
export const DEMO_R = 16;

export type Call = { id: number; address: string; name?: string; r: number; side: boolean; amount: number; entryPrice: number; text: string; ago: string };

const SAMPLE_CALLS: Record<number, string[]> = {
  1: ["ETF inflows haven't slowed in six weeks", "Halving supply shock is priced in already", "Funding rates say leverage is too crowded"],
  2: ["Testnet already peaks above 8M on busy days", "Mainnet launches later than people think"],
  3: ["Home side is unbeaten at home since March", "Their striker is out, check the injury report"],
  4: ["No catalyst before year end", "Staking ETF approval changes everything"],
  5: ["Registrations passed 600 last week"],
  6: ["The gap to #1 closed to 8 points this month", "Leaderboard lags new releases by weeks"],
};

/** Sample calls for demo mode. Live calls come from CallPosted events. */
export function sampleCalls(marketId: number): Call[] {
  const r = rng(marketId * 53);
  return (SAMPLE_CALLS[marketId] ?? []).map((text, i) => {
    const trader = TRADERS[Math.floor(r() * TRADERS.length)];
    return {
      id: marketId * 100 + i + 1, // sample ids; live ids come from the contract
      address: trader.address,
      name: trader.name,
      r: trader.r,
      side: r() > 0.4,
      amount: [25, 50, 80, 120][Math.floor(r() * 4)],
      entryPrice: Math.round((0.2 + r() * 0.6) * 100) / 100,
      text,
      ago: ["3m", "41m", "2h", "5h"][i] ?? "1d",
    };
  });
}

export type FeedItem = Call & {
  marketId: number;
  question: string;
  /** Set once the market resolves: the call becomes a receipt. */
  result: "right" | "wrong" | "refunded" | null;
};

/** Every sample call across markets, newest first (optionally one trader's). */
export function sampleFeed(user?: string): FeedItem[] {
  const order = (ago: string) => (ago.endsWith("m") ? 1 : ago.endsWith("h") ? 60 : 1440) * parseInt(ago);
  return MARKETS.flatMap((m) =>
    sampleCalls(m.id).map((c): FeedItem => ({
      ...c,
      marketId: m.id,
      question: m.question,
      result: m.proposed ? (c.side === m.proposed.outcome ? "right" : "wrong") : null,
    })),
  )
    .filter((i) => !user || i.address.toLowerCase() === user.toLowerCase())
    .sort((a, b) => order(a.ago) - order(b.ago));
}

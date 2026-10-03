import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import {
  TEAM, WAD, addr, betPlaced, callPosted, categoryAdded, marketCreated, marketResolved, marketVoided, positionId,
  reputationChanged, settled, tx, usd, vested, wad,
} from "./helpers.js";

const CHAIN = 31337;
const run = (indexer: ReturnType<typeof createTestIndexer>, simulate: unknown[]) =>
  indexer.process({ chains: { [CHAIN]: { simulate: simulate as never } } });

const [alice, bob, carol] = [addr(1), addr(2), addr(3)];
/** Simulated events come from the first configured Kleos address, as fundFromGlobal's Sponsored does. */
const KLEOS = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as const;

describe("markets", () => {
  it("a new market starts open, empty and at 50/50", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [categoryAdded(), marketCreated()]);
    const m = await indexer.Market.getOrThrow("1");
    t.expect(m).toMatchObject({ state: "Open", category_id: "1", voided: false, bettorCount: 0, yesMoney: 0n, priceRepYes: WAD / 2n });
    t.expect((await indexer.Category.getOrThrow("1")).name).toBe("Crypto");
  });

  it("bets add up per side; bettors are counted once per address", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      betPlaced({ user: alice, side: true, amount: usd(80), effective: usd(240), n: 3 }),
      betPlaced({ user: alice, side: false, amount: usd(20), n: 4 }),
      betPlaced({ user: bob, side: false, amount: usd(100), n: 5 }),
    ]);
    const m = await indexer.Market.getOrThrow("1");
    t.expect(m).toMatchObject({ yesMoney: usd(80), noMoney: usd(120), yesEff: usd(240), noEff: usd(120), betCount: 3, bettorCount: 2 });

    const pos = await indexer.Position.getOrThrow(positionId(1n, alice));
    t.expect(pos).toMatchObject({ yesMoney: usd(80), noMoney: usd(20), settled: false });
    const trader = await indexer.Trader.getOrThrow(alice.toLowerCase());
    t.expect(trader).toMatchObject({ betCount: 2, marketCount: 1, volume: usd(100) });
    t.expect(await indexer.PricePoint.getAll()).toHaveLength(3);
  });

  it("resolution adds the fee to the bonus and scores calls; voiding refunds them", async (t) => {
    const hash = tx("call-tx");
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(), marketCreated(2n, 3),
      betPlaced({ user: alice, side: true, amount: usd(10), n: 4, logIndex: 0, hash }),
      callPosted({ callId: 1n, user: alice, side: true, text: "ETF flows", n: 4, logIndex: 1, hash }),
      callPosted({ callId: 2n, user: bob, side: false, text: "Fading it", n: 5, logIndex: 0, hash: tx("b") }),
      callPosted({ callId: 3n, user: carol, side: true, text: "Maybe", n: 6, logIndex: 0, hash: tx("c"), marketId: 2n }),
      marketResolved(true, 7, usd(2)),
      marketVoided(8, 2n),
    ]);

    // Calls are keyed by the contract's callId, the same number KleosSocial votes use.
    t.expect(await indexer.Call.getOrThrow("1")).toMatchObject({ text: "ETF flows", result: "Right", txHash: hash });
    t.expect((await indexer.Call.getOrThrow("2")).result).toBe("Wrong");
    t.expect((await indexer.Call.getOrThrow("3")).result).toBe("Refunded");

    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ state: "Resolved", outcome: true, fee: usd(2), bonusPool: usd(2), callCount: 2 });
    t.expect(await indexer.Market.getOrThrow("2")).toMatchObject({ state: "Resolved", voided: true, outcome: undefined });
  });

  it("follows a market through sponsorship, proposal, dispute, resolution, settlement and bonus", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(), marketCreated(2n, 3),
      betPlaced({ user: alice, side: true, amount: usd(100), n: 4 }),
      betPlaced({ user: bob, side: false, amount: usd(100), n: 5 }),
      // A third party sponsors; the owner also tops up from the global pool (sponsor = the contract).
      { contract: "Kleos", event: "Sponsored", block: { number: 6 }, params: { marketId: 1n, sponsor: carol, amount: usd(30) } },
      { contract: "Kleos", event: "Sponsored", block: { number: 7 }, params: { marketId: 1n, sponsor: KLEOS, amount: usd(20) } },
      { contract: "Kleos", event: "OutcomeProposed", block: { number: 8, timestamp: 800 }, params: { marketId: 1n, proposer: carol, outcome: true, evidenceHash: tx("proof"), evidenceURI: "https://example.com" } },
      { contract: "Kleos", event: "OutcomeDisputed", block: { number: 9 }, params: { marketId: 1n, disputer: bob } },
      marketResolved(true, 10, usd(2)),
      { contract: "Kleos", event: "Settled", block: { number: 11 }, params: { marketId: 1n, user: alice, payout: usd(198), bonusWeight: wad(1.5) } },
      settled(bob, 11, 1),
      { contract: "Kleos", event: "BonusOpened", block: { number: 12 }, params: { marketId: 1n, bonusPool: usd(52), totalWeight: wad(1.5) } },
      { contract: "Kleos", event: "BonusClaimed", block: { number: 13 }, params: { marketId: 1n, user: alice, amount: usd(52) } },
      // Market 2: nobody gained reputation, so the bonus rolls over and opens at 0.
      { contract: "Kleos", event: "Sponsored", block: { number: 14 }, params: { marketId: 2n, sponsor: carol, amount: usd(5) } },
      // (Kleos emits BonusRolledOver here first; nothing handles it, since BonusOpened carries the result.)
      { contract: "Kleos", event: "BonusOpened", block: { number: 15 }, logIndex: 1, params: { marketId: 2n, bonusPool: 0n, totalWeight: 0n } },
    ]);

    const m = await indexer.Market.getOrThrow("1");
    t.expect(m).toMatchObject({
      state: "Resolved", outcome: true, proposedOutcome: true, proposer: carol.toLowerCase(), proposedAt: 800,
      evidenceHash: tx("proof"), evidenceURI: "https://example.com", disputer: bob.toLowerCase(),
      // Only carol's $30 is a sponsorship; the $20 top-up and the $2 fee still reach the pool.
      sponsored: usd(30), lastSponsor: carol.toLowerCase(), fee: usd(2),
      bonusOpen: true, bonusPool: usd(52), bonusWeight: wad(1.5),
    });
    t.expect(await indexer.Position.getOrThrow(positionId(1n, alice))).toMatchObject({ settled: true, payout: usd(198), bonusWeight: wad(1.5), bonus: usd(52) });
    t.expect(await indexer.Position.getOrThrow(positionId(1n, bob))).toMatchObject({ settled: true, payout: 0n, bonusWeight: 0n, bonus: 0n });
    t.expect(await indexer.Market.getOrThrow("2")).toMatchObject({ bonusOpen: true, bonusPool: 0n, bonusWeight: 0n, sponsored: usd(5) });
  });

  it("a dispute moves the market to Disputed", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      { contract: "Kleos", event: "OutcomeProposed", block: { number: 3 }, params: { marketId: 1n, proposer: carol, outcome: false, evidenceHash: tx("p"), evidenceURI: "" } },
      { contract: "Kleos", event: "OutcomeDisputed", block: { number: 4 }, params: { marketId: 1n, disputer: bob } },
    ]);
    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ state: "Disputed", proposedOutcome: false });
  });

  it("records who created a market and what happened to a trader-creator's bond", async (t) => {
    const CREATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(),
      marketCreated(1n, 2), // the team, no bond
      marketCreated(2n, 3, CREATOR), // a tier-V trader (checksummed, like real events)
      marketCreated(3n, 4, bob),
      { contract: "Kleos", event: "CreatorBondReleased", block: { number: 5 }, params: { marketId: 2n, creator: CREATOR, amount: usd(20), forfeited: false } },
      { contract: "Kleos", event: "CreatorBondReleased", block: { number: 6 }, params: { marketId: 3n, creator: bob, amount: usd(20), forfeited: true } },
    ]);
    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ creator: TEAM.toLowerCase(), creatorBondForfeited: undefined });
    t.expect(await indexer.Market.getOrThrow("2")).toMatchObject({ creator: CREATOR.toLowerCase(), creatorBondForfeited: false });
    t.expect(await indexer.Market.getOrThrow("3")).toMatchObject({ creator: bob.toLowerCase(), creatorBondForfeited: true });
  });
});

describe("robustness", () => {
  // The contract rejects market events for ids that were never created, but if one ever arrived
  // it must not halt the indexer.
  it("skips events for markets that were never created and keeps indexing", async (t) => {
    const indexer = createTestIndexer();
    const ghost = 99n;
    await run(indexer, [
      categoryAdded(), marketCreated(),
      { contract: "Kleos", event: "Sponsored", block: { number: 3 }, params: { marketId: ghost, sponsor: addr(9), amount: usd(1) } },
      { contract: "Kleos", event: "OutcomeProposed", block: { number: 4, timestamp: 4 }, params: { marketId: ghost, proposer: bob, outcome: true, evidenceHash: tx("e"), evidenceURI: "x" } },
      { contract: "Kleos", event: "OutcomeDisputed", block: { number: 5 }, params: { marketId: ghost, disputer: carol } },
      marketResolved(true, 6, 0n, ghost),
      marketVoided(7, ghost),
      { contract: "Kleos", event: "BonusOpened", block: { number: 8 }, params: { marketId: ghost, bonusPool: 0n, totalWeight: 0n } },
      betPlaced({ user: alice, side: true, amount: usd(10), n: 10 }),
    ]);
    t.expect(await indexer.Market.get(ghost.toString())).toBeUndefined();
    t.expect((await indexer.Market.getOrThrow("1")).betCount).toBe(1);
  });
});

describe("reputation", () => {
  it("classifies changes: seed, bet (holds a position) and jury (doesn't)", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      reputationChanged({ user: alice, marketId: 0n, delta: wad(16), newR: wad(16), n: 3 }),
      betPlaced({ user: alice, side: true, amount: usd(50), n: 4 }),
      // Same entryPrice as jury duty on purpose: the position is what tells them apart.
      reputationChanged({ user: alice, marketId: 1n, delta: wad(0.7), newR: wad(16), pendingR: wad(0.7), entryPrice: 0n, side: true, outcome: true, n: 5 }),
      reputationChanged({ user: bob, marketId: 1n, delta: -wad(0.3), newR: wad(39.7), n: 6 }),
    ]);
    const kinds = (await indexer.ReputationChange.getAll()).map((c) => [c.trader_id, c.kind]).sort();
    t.expect(kinds).toEqual([[alice.toLowerCase(), "Admin"], [alice.toLowerCase(), "Bet"], [bob.toLowerCase(), "Jury"]].sort());

    t.expect(await indexer.Trader.getOrThrow(alice.toLowerCase())).toMatchObject({ r: wad(16), pending: wad(0.7), wins: 1, losses: 0 });
    // Jury penalties move R but aren't losses.
    t.expect(await indexer.Trader.getOrThrow(bob.toLowerCase())).toMatchObject({ r: wad(39.7), wins: 0, losses: 0 });
  });

  it("counts wins and losses by side vs outcome, not by the sign of delta", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      betPlaced({ user: alice, side: true, amount: usd(50), n: 3 }),
      betPlaced({ user: bob, side: false, amount: usd(50), n: 4 }),
      betPlaced({ user: carol, side: true, amount: usd(50), n: 5, logIndex: 1 }),
      // YES wins. Alice's gain event carries (side, outcome) = (true, true).
      reputationChanged({ user: alice, marketId: 1n, delta: wad(0.5), newR: 0n, pendingR: wad(0.5), side: true, outcome: true, n: 5 }),
      // Bob had no reputation to lose: the contract emits -taken = 0, with (side, outcome) = (false, true).
      reputationChanged({ user: bob, marketId: 1n, delta: 0n, newR: 0n, side: false, outcome: true, n: 6 }),
      // Carol was right but entered at a price of 1.0, so she gained k·s·(1 − p) = 0.
      reputationChanged({ user: carol, marketId: 1n, delta: 0n, newR: 0n, side: true, outcome: true, n: 7 }),
    ]);
    t.expect(await indexer.Trader.getOrThrow(alice.toLowerCase())).toMatchObject({ wins: 1, losses: 0 });
    t.expect(await indexer.Trader.getOrThrow(bob.toLowerCase())).toMatchObject({ wins: 0, losses: 1 });
    t.expect(await indexer.Trader.getOrThrow(carol.toLowerCase())).toMatchObject({ wins: 1, losses: 0 });
  });

  it("vesting moves pending into R", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      reputationChanged({ user: alice, marketId: 0n, delta: wad(10), newR: wad(10), pendingR: wad(0.7), n: 1 }),
      vested(alice, wad(10.7), 2),
    ]);
    t.expect(await indexer.Trader.getOrThrow(alice.toLowerCase())).toMatchObject({ r: wad(10.7), pending: 0n });
  });

  it("the anomaly flag is set and cleared", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      { contract: "Kleos", event: "Flagged", block: { number: 1 }, params: { user: alice, marketId: 1n } },
      { contract: "Kleos", event: "Flagged", block: { number: 2 }, params: { user: bob, marketId: 1n } },
      { contract: "Kleos", event: "FlagCleared", block: { number: 3 }, params: { user: bob } },
    ]);
    t.expect((await indexer.Trader.getOrThrow(alice.toLowerCase())).flagged).toBe(true);
    t.expect((await indexer.Trader.getOrThrow(bob.toLowerCase())).flagged).toBe(false);
  });

  it("a settle counts toward activation only in deep, non-voided markets (≥ $1,000 and ≥ 10 bettors)", async (t) => {
    const crowd = Array.from({ length: 10 }, (_, i) => addr(100 + i));
    const me = crowd[0]!;
    const fill = (marketId: bigint, amount: number, from: number) =>
      crowd.map((u, i) => betPlaced({ marketId, user: u, side: i < 5, amount: usd(amount), n: from + i }));
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(1n, 2), marketCreated(2n, 3), marketCreated(3n, 4), marketCreated(4n, 5),
      ...fill(1n, 100, 10), // deep: 10 bettors, $1,000
      ...fill(2n, 50, 30), // 10 bettors but only $500
      betPlaced({ marketId: 3n, user: me, side: true, amount: usd(500), n: 50 }), // $1,000 but 2 bettors
      betPlaced({ marketId: 3n, user: crowd[1]!, side: false, amount: usd(500), n: 51 }),
      ...fill(4n, 100, 60), // deep, then voided
      marketResolved(true, 80, 0n, 1n), marketResolved(true, 81, 0n, 2n), marketResolved(true, 82, 0n, 3n), marketVoided(83, 4n),
      settled(me, 90, 0, usd(196), 1n), settled(me, 91, 0, 0n, 2n), settled(me, 92, 0, 0n, 3n), settled(me, 93, 0, usd(100), 4n),
    ]);
    t.expect((await indexer.Trader.getOrThrow(me.toLowerCase())).resolvedBets).toBe(1n);
    t.expect(await indexer.Position.getOrThrow(positionId(1n, me))).toMatchObject({ settled: true, payout: usd(196) });
  });

  it("a settle counts toward activation only for a position of at least $50, both sides together", async (t) => {
    const crowd = Array.from({ length: 10 }, (_, i) => addr(200 + i));
    const [small, hedged, full] = [crowd[0]!, crowd[1]!, crowd[2]!];
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      betPlaced({ user: small, side: true, amount: usd(49.99), n: 3 }),
      betPlaced({ user: hedged, side: true, amount: usd(30), n: 4 }),
      betPlaced({ user: hedged, side: false, amount: usd(20), n: 5 }),
      betPlaced({ user: full, side: false, amount: usd(50), n: 6 }),
      ...crowd.slice(3).map((u, i) => betPlaced({ user: u, side: i % 2 === 0, amount: usd(150), n: 10 + i })),
      marketResolved(true, 30),
      settled(small, 31, 0), settled(hedged, 31, 1), settled(full, 31, 2),
    ]);
    const counted = async (a: string) => (await indexer.Trader.getOrThrow(a.toLowerCase())).resolvedBets;
    t.expect([await counted(small), await counted(hedged), await counted(full)]).toEqual([0n, 1n, 1n]);
  });

  it("an admin slash is recorded on the trader, and its ReputationChanged sets R", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      reputationChanged({ user: alice, marketId: 0n, delta: wad(20), newR: wad(20), n: 1 }),
      { contract: "Kleos", event: "Slashed", block: { number: 2 }, logIndex: 0, params: { user: alice, amount: wad(5) } },
      reputationChanged({ user: alice, marketId: 0n, delta: -wad(5), newR: wad(15), n: 2, logIndex: 1 }),
    ]);
    t.expect(await indexer.Trader.getOrThrow(alice.toLowerCase())).toMatchObject({ r: wad(15), slashed: wad(5) });
  });
});

describe("sharp signal", () => {
  it("counts each trader with R ≥ 16 at bet time once per side", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      reputationChanged({ user: alice, marketId: 0n, delta: wad(16), newR: wad(16), n: 3 }),
      reputationChanged({ user: bob, marketId: 0n, delta: wad(15.9), newR: wad(15.9), n: 3, logIndex: 1 }),
      betPlaced({ user: alice, side: true, amount: usd(10), n: 4 }),
      betPlaced({ user: alice, side: true, amount: usd(10), n: 5 }),
      betPlaced({ user: alice, side: false, amount: usd(10), n: 6 }),
      betPlaced({ user: bob, side: true, amount: usd(10), n: 7 }),
      // Carol becomes sharp only after her first bet: that one doesn't count, the next does.
      betPlaced({ user: carol, side: false, amount: usd(10), n: 8 }),
      reputationChanged({ user: carol, marketId: 0n, delta: wad(40), newR: wad(40), n: 9 }),
      betPlaced({ user: carol, side: false, amount: usd(10), n: 10 }),
    ]);
    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ sharpYes: 1, sharpNo: 2 });
    const bets = (await indexer.Bet.getAll()).sort((a, b) => a.timestamp - b.timestamp);
    t.expect(bets.map((b) => [b.traderR, b.sharp])).toEqual([
      [wad(16), true], [wad(16), true], [wad(16), true], [wad(15.9), false], [0n, false], [wad(40), true],
    ]);
  });
});

describe("lifecycle edges", () => {
  it("an expired market is voided, flagged as expired, and its calls refunded", async (t) => {
    const hash = tx("exp");
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      betPlaced({ user: alice, side: true, amount: usd(10), n: 3, hash }),
      callPosted({ callId: 1n, user: alice, side: true, text: "Soon", n: 3, logIndex: 1, hash }),
      marketVoided(9),
      { contract: "Kleos", event: "MarketExpired", block: { number: 9 }, logIndex: 1, params: { marketId: 1n } },
    ]);
    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ state: "Resolved", voided: true, expired: true, outcome: undefined });
    t.expect((await indexer.Call.getOrThrow("1")).result).toBe("Refunded");
  });

  it("a rolled-over bonus is recorded on the market", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      { contract: "Kleos", event: "BonusRolledOver", block: { number: 5 }, params: { marketId: 1n, amount: usd(7) } },
      { contract: "Kleos", event: "BonusOpened", block: { number: 5 }, logIndex: 1, params: { marketId: 1n, bonusPool: 0n, totalWeight: 0n } },
    ]);
    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ rolledOver: usd(7), bonusPool: 0n, bonusOpen: true });
  });
});

describe("Kleos Court", () => {
  const jurors = Array.from({ length: 6 }, (_, i) => addr(300 + i));
  const pool = (n: number, event: "JurorJoined" | "JurorLeft" | "JurorPruned", juror: `0x${string}`, logIndex = 0) =>
    ({ contract: "Kleos", event, block: { number: n }, logIndex, params: { juror } }) as const;
  const drawn = (marketId: bigint, round: number, seats: `0x${string}`[], n: number) =>
    ({ contract: "Kleos", event: "JuryDrawn", block: { number: n, timestamp: n * 10 }, params: { marketId, round: BigInt(round), jurors: seats } }) as const;
  const committed = (marketId: bigint, round: number, juror: `0x${string}`, n: number, logIndex = 0) =>
    ({ contract: "Kleos", event: "VoteCommitted", block: { number: n }, logIndex, params: { marketId, round: BigInt(round), juror } }) as const;
  const revealed = (marketId: bigint, round: number, juror: `0x${string}`, vote: number, n: number, logIndex = 0) =>
    ({ contract: "Kleos", event: "VoteRevealed", block: { number: n }, logIndex, params: { marketId, round: BigInt(round), juror, vote: BigInt(vote) } }) as const;
  const disputed = (marketId: bigint, n: number) => [
    { contract: "Kleos", event: "OutcomeProposed", block: { number: n, timestamp: n }, params: { marketId, proposer: alice, outcome: true, evidenceHash: tx("e"), evidenceURI: "" } },
    { contract: "Kleos", event: "OutcomeDisputed", block: { number: n + 1 }, params: { marketId, disputer: bob } },
  ];

  it("tracks the juror pool through joins, leaves and prunes", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      ...jurors.map((j, i) => pool(1, "JurorJoined", j, i)),
      pool(2, "JurorLeft", jurors[0]!),
      pool(3, "JurorPruned", jurors[1]!),
    ]);
    t.expect((await indexer.Protocol.getOrThrow("kleos")).jurorCount).toBe(4);
    t.expect((await indexer.Trader.getOrThrow(jurors[0]!.toLowerCase())).isJuror).toBe(false);
    t.expect((await indexer.Trader.getOrThrow(jurors[1]!.toLowerCase())).isJuror).toBe(false);
    t.expect((await indexer.Trader.getOrThrow(jurors[2]!.toLowerCase())).isJuror).toBe(true);
  });

  it("a round without a verdict is redrawn; an AMBIGUOUS verdict voids the market", async (t) => {
    const [r1, r2] = [jurors.slice(0, 5), jurors.slice(1, 6)];
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      ...disputed(1n, 3),
      drawn(1n, 1, r1, 4),
      committed(1n, 1, r1[0]!, 5), committed(1n, 1, r1[0]!, 5, 1), // re-commit: still one commit
      committed(1n, 1, r1[1]!, 6), committed(1n, 1, r1[2]!, 6, 1),
      revealed(1n, 1, r1[0]!, 1, 7), revealed(1n, 1, r1[1]!, 1, 7, 1), revealed(1n, 1, r1[2]!, 2, 7, 2),
      { contract: "Kleos", event: "CourtRedrawn", block: { number: 8 }, params: { marketId: 1n, failedRound: 1n } },
      drawn(1n, 2, r2, 8),
      ...r2.slice(0, 3).map((j, i) => committed(1n, 2, j, 9, i)),
      ...r2.slice(0, 3).map((j, i) => revealed(1n, 2, j, 3, 10, i)),
      { contract: "Kleos", event: "Verdict", block: { number: 11 }, params: { marketId: 1n, round: 2n, vote: 3n } },
      marketVoided(11),
    ]);

    t.expect(await indexer.CourtRound.getOrThrow("1_1")).toMatchObject({ round: 1, commits: 3, reveals: 3, yes: 2, no: 1, ambiguous: 0, failed: true, verdict: undefined, drawnAt: 40 });
    t.expect(await indexer.CourtRound.getOrThrow("1_2")).toMatchObject({ commits: 3, reveals: 3, ambiguous: 3, failed: false, verdict: 3 });
    t.expect((await indexer.CourtRound.getOrThrow("1_1")).jurors).toEqual(r1.map((j) => j.toLowerCase()));
    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ courtRound: 2, verdict: 3, voided: true, state: "Resolved" });
    // Seats exist from the draw, so no-shows are visible.
    t.expect(await indexer.JurorVote.getOrThrow(`1_1_${r1[4]!.toLowerCase()}`)).toMatchObject({ committed: false, vote: 0 });
    t.expect(await indexer.JurorVote.getOrThrow(`1_2_${r2[0]!.toLowerCase()}`)).toMatchObject({ committed: true, vote: 3 });
    // Jurors 2–5 sat in both rounds.
    t.expect((await indexer.Trader.getOrThrow(jurors[1]!.toLowerCase())).juryDuties).toBe(2);
  });

  it("a YES/NO verdict resolves the market; a last round without one fails the court", async (t) => {
    const seats = jurors.slice(0, 5);
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(1n, 2), marketCreated(2n, 2),
      ...disputed(1n, 3), drawn(1n, 1, seats, 5),
      ...seats.slice(0, 3).map((j, i) => revealed(1n, 1, j, 2, 6, i)),
      { contract: "Kleos", event: "Verdict", block: { number: 7 }, params: { marketId: 1n, round: 1n, vote: 2n } },
      marketResolved(false, 7, 0n, 1n),
      ...disputed(2n, 10), drawn(2n, 1, seats, 12),
      { contract: "Kleos", event: "CourtRedrawn", block: { number: 13 }, params: { marketId: 2n, failedRound: 1n } },
      drawn(2n, 2, seats, 13),
      marketVoided(14, 2n), // round 2 closed without a verdict
    ]);
    t.expect(await indexer.Market.getOrThrow("1")).toMatchObject({ verdict: 2, outcome: false, voided: false });
    t.expect((await indexer.CourtRound.getOrThrow("1_1")).failed).toBe(false);
    t.expect(await indexer.Market.getOrThrow("2")).toMatchObject({ verdict: undefined, voided: true, courtRound: 2 });
    t.expect((await indexer.CourtRound.getOrThrow("2_2")).failed).toBe(true);
  });
});

describe("protocol totals", () => {
  it("counts markets, bets, bettors, volume, calls and revenue", async (t) => {
    const hash = tx("c");
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(),
      // A trader-created market: the creation fee accrues before MarketCreated.
      { contract: "Kleos", event: "RevenueAccrued", block: { number: 2 }, params: { marketId: 1n, amount: usd(2) } },
      marketCreated(1n, 2, bob),
      marketCreated(2n, 3),
      betPlaced({ user: alice, side: true, amount: usd(10), n: 4, hash }),
      callPosted({ callId: 1n, user: alice, side: true, text: "Up", n: 4, logIndex: 1, hash }),
      betPlaced({ user: alice, side: false, amount: usd(5), n: 5, marketId: 2n }),
      betPlaced({ user: carol, side: false, amount: usd(20), n: 6 }),
      { contract: "Kleos", event: "RevenueAccrued", block: { number: 7 }, params: { marketId: 1n, amount: usd(0.1) } },
      { contract: "Kleos", event: "RevenueWithdrawn", block: { number: 8 }, params: { to: TEAM, amount: usd(2.1) } },
    ]);
    t.expect(await indexer.Protocol.getOrThrow("kleos")).toMatchObject({
      marketCount: 2, betCount: 3, bettorCount: 2, volume: usd(35), callCount: 1, revenueAccrued: usd(2.1), revenueWithdrawn: usd(2.1),
    });
  });
});

describe("social", () => {
  const social = <E extends "NameSet" | "Followed" | "Unfollowed" | "CallVoted">(event: E, n: number, params: Record<string, unknown>, logIndex = 0) =>
    ({ contract: "KleosSocial", event, block: { number: n, timestamp: n }, logIndex, params }) as const;

  it("usernames: the latest one wins", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [social("NameSet", 1, { user: alice, name: "alice" }), social("NameSet", 2, { user: alice, name: "alice_2" })]);
    t.expect((await indexer.Trader.getOrThrow(alice.toLowerCase())).name).toBe("alice_2");
  });

  it("follows and unfollows keep both counts and the edge list in step", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      social("Followed", 1, { follower: alice, followee: carol }),
      social("Followed", 2, { follower: bob, followee: carol }),
      social("Followed", 3, { follower: carol, followee: alice }),
      social("Unfollowed", 4, { follower: alice, followee: carol }),
    ]);
    const tr = async (a: string) => indexer.Trader.getOrThrow(a.toLowerCase());
    t.expect(await tr(carol)).toMatchObject({ followerCount: 1, followingCount: 1 });
    t.expect(await tr(alice)).toMatchObject({ followerCount: 1, followingCount: 0 });
    t.expect((await indexer.Follow.getAll()).map((f) => f.id).sort()).toEqual(
      [`${bob}_${carol}`, `${carol}_${alice}`].map((id) => id.toLowerCase()).sort(),
    );
    t.expect(await indexer.Follow.getOrThrow(`${bob}_${carol}`.toLowerCase())).toMatchObject({ since: 2 });
  });

  it("call votes: changes and clears move the tallies; votes before the call still count", async (t) => {
    const hash = tx("v");
    const indexer = createTestIndexer();
    await run(indexer, [
      categoryAdded(), marketCreated(),
      // KleosSocial doesn't check the call exists: these land before CallPosted.
      social("CallVoted", 3, { callId: 1n, voter: bob, vote: 1n }),
      social("CallVoted", 3, { callId: 1n, voter: carol, vote: -1n }, 1),
      betPlaced({ user: alice, side: true, amount: usd(10), n: 4, hash }),
      callPosted({ callId: 1n, user: alice, side: true, text: "Up", n: 4, logIndex: 1, hash }),
      social("CallVoted", 5, { callId: 1n, voter: carol, vote: 1n }), // down → up
      social("CallVoted", 6, { callId: 1n, voter: addr(9), vote: -1n }),
      social("CallVoted", 7, { callId: 1n, voter: bob, vote: 0n }), // cleared
    ]);
    t.expect(await indexer.Call.getOrThrow("1")).toMatchObject({ ups: 1, downs: 1 });
    t.expect((await indexer.CallVote.getAll()).map((v) => [v.voter_id, v.value]).sort()).toEqual(
      [[carol.toLowerCase(), 1], [addr(9).toLowerCase(), -1]].sort(),
    );
    // addr(9) never traded, but has a Trader row so CallVote.voter resolves.
    t.expect(await indexer.Trader.get(addr(9).toLowerCase())).toBeDefined();
  });
});

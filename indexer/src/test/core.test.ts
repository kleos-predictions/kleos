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
  // Kleos.propose and fundFromGlobal don't check that the market exists: an id that was never
  // created reads as Open with closeTime 0. Those events must not halt the indexer.
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
      // A bet into an empty side enters at price 0, like jury duty: the position is what tells them apart.
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
    t.expect((await indexer.Trader.getOrThrow(me.toLowerCase())).resolvedBets).toBe(1);
    t.expect(await indexer.Position.getOrThrow(positionId(1n, me))).toMatchObject({ settled: true, payout: usd(196) });
  });
});

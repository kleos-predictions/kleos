import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";
import { TEAM, addr, betPlaced, categoryAdded, marketCreated, marketResolved, positionId, reputationChanged, settled, tx, usd, wad } from "./helpers.js";

const CHAIN = 31337;
const KLEOS = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as const;
const calls = parseAbi(["function seedReputation(address user, uint256 r, uint32 resolvedBets)", "function commitVote(uint256 id, bytes32 commitment)"]);
const run = (indexer: ReturnType<typeof createTestIndexer>, simulate: unknown[]) =>
  indexer.process({ chains: { [CHAIN]: { simulate: simulate as never } } });
const [alice, bob] = [addr(1), addr(2)];
const zero = `0x${"0".repeat(64)}` as const;

function seed(user: `0x${string}`, r: bigint, count: number, n: number, to: `0x${string}` = KLEOS) {
  return {
    ...reputationChanged({ user, marketId: 0n, delta: r, newR: r, n }),
    transaction: { hash: tx(`seed-${n}`), to, from: TEAM, input: encodeFunctionData({ abi: calls, functionName: "seedReputation", args: [user, r, count] }) },
  };
}

function creation(n = 1, vestPeriod = 300n) {
  const args = encodeAbiParameters(parseAbiParameters("address,uint256,uint256,uint256,uint256"), [addr(99), 120n, vestPeriod, 10n, 180n]);
  return {
    ...categoryAdded(), block: { number: n },
    transaction: { hash: tx("creation"), input: `0x60006000${args.slice(2)}`, contractAddress: KLEOS, from: TEAM },
  };
}

function commit(juror: `0x${string}`, commitment: `0x${string}`, n: number, to: `0x${string}` = KLEOS, from: `0x${string}` = juror) {
  return {
    contract: "Kleos", event: "VoteCommitted", block: { number: n },
    params: { marketId: 1n, round: 1n, juror },
    transaction: { hash: tx(`commit-${n}`), to, from, input: encodeFunctionData({ abi: calls, functionName: "commitVote", args: [1n, commitment] }) },
  };
}

const drawn = () => ({ contract: "Kleos", event: "JuryDrawn", block: { number: 3 }, params: { marketId: 1n, round: 1n, jurors: [alice, bob] } });

describe("complete historical state", () => {
  it("recovers seed history, including a lowering reseed and the full uint32 range", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [seed(alice, wad(36), 0xffffffff, 1)]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ resolvedBets: 0xffffffffn, resolvedBetsSource: "DirectInput" });
    await run(indexer, [seed(alice, wad(2), 2, 2)]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ r: wad(2), resolvedBets: 2n, resolvedBetsSource: "DirectInput" });
    t.expect(await indexer.ReputationChange.getOrThrow("2_0")).toMatchObject({ adminAction: "Seed", resolvedBets: 2n });
  });

  it("marks nested or mismatched seed input unknown, and a later direct seed restores exact history", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [seed(alice, wad(10), 10, 1), seed(alice, wad(2), 2, 2, addr(999))]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ resolvedBets: undefined, resolvedBetsSource: "Unknown" });
    const mismatched = seed(alice, wad(2), 4, 3);
    await run(indexer, [{ ...mismatched, params: { ...mismatched.params, newR: wad(3) } }]);
    t.expect((await indexer.Trader.getOrThrow(alice)).resolvedBets).toBeUndefined();
    await run(indexer, [seed(alice, wad(1), 0, 4)]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ resolvedBets: 0n, resolvedBetsSource: "DirectInput" });
  });

  it("identifies a nested slash by the preceding canonical log and preserves history", async (t) => {
    const indexer = createTestIndexer();
    const hash = tx("nested-slash");
    await run(indexer, [
      seed(alice, wad(10), 12, 1),
      { contract: "Kleos", event: "Slashed", block: { number: 2 }, logIndex: 4, transaction: { hash }, params: { user: alice, amount: wad(1) } },
      { ...reputationChanged({ user: alice, marketId: 0n, delta: -wad(1), newR: wad(9), n: 2, logIndex: 5 }), transaction: { hash, to: addr(999), input: "0x" } },
    ]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ resolvedBets: 12n, resolvedBetsSource: "DirectInput", slashed: wad(1) });
    t.expect(await indexer.ReputationChange.getOrThrow("2_5")).toMatchObject({ adminAction: "Slash", blockNumber: 2, logIndex: 5, txHash: hash });
  });

  it("saturates exact history, rather than overflowing or replacing unknown history with a lower bound", async (t) => {
    const indexer = createTestIndexer();
    const crowd = Array.from({ length: 10 }, (_, i) => addr(100 + i));
    const user = crowd[0]!;
    await run(indexer, [
      categoryAdded(), marketCreated(), seed(user, wad(36), 0xffffffff, 3),
      ...crowd.map((u, i) => betPlaced({ user: u, side: i < 5, amount: usd(100), n: 4 + i })),
      marketResolved(true, 20), settled(user, 21),
    ]);
    t.expect((await indexer.Trader.getOrThrow(user)).resolvedBets).toBe(0xffffffffn);
    // A nested reseed can reset the count in either direction. Never increment a guessed zero.
    await run(indexer, [seed(user, wad(1), 5, 22, addr(999))]);
    t.expect((await indexer.Trader.getOrThrow(user)).resolvedBets).toBeUndefined();
  });

  it("records zero claims both with and without a position", async (t) => {
    const indexer = createTestIndexer();
    const hash = tx("zero-claims");
    await run(indexer, [
      categoryAdded(), marketCreated(), betPlaced({ user: alice, side: true, amount: usd(1), n: 3 }),
      ...[alice, bob].map((user, logIndex) => ({ contract: "Kleos", event: "BonusClaimed", block: { number: 4, timestamp: 400 }, logIndex, transaction: { hash }, params: { marketId: 1n, user, amount: 0n } })),
    ]);
    t.expect(await indexer.Position.getOrThrow(positionId(1n, alice))).toMatchObject({ bonus: 0n, bonusClaimed: true });
    t.expect(await indexer.Position.get(positionId(1n, bob))).toBeUndefined();
    t.expect(await indexer.BonusClaim.getOrThrow(positionId(1n, bob))).toMatchObject({ amount: 0n, eventId: "4_1", txHash: hash, timestamp: 400 });
    t.expect(await indexer.BonusClaim.getAll()).toHaveLength(2);
  });

  it("derives vest deadlines from observed creation, preserves them through losses, and records vest-before-gain", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [
      creation(), marketCreated(), betPlaced({ user: alice, side: true, amount: usd(50), n: 3 }),
      { ...reputationChanged({ user: alice, marketId: 1n, delta: wad(0.5), newR: 0n, pendingR: wad(0.5), side: true, outcome: true, n: 4 }), block: { number: 4, timestamp: 1000 } },
      { ...reputationChanged({ user: alice, marketId: 1n, delta: -wad(0.1), newR: 0n, pendingR: wad(0.4), side: false, outcome: true, n: 5 }), block: { number: 5, timestamp: 1200 } },
    ]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ vestAt: 1300n, vestAtSource: "DirectCreation", lastGainAt: 1000 });
    const hash = tx("vest-then-gain");
    await run(indexer, [
      { contract: "Kleos", event: "Vested", block: { number: 6, timestamp: 1400 }, logIndex: 2, transaction: { hash }, params: { user: alice, amount: wad(0.4), newR: wad(0.4) } },
      { ...reputationChanged({ user: alice, marketId: 1n, delta: wad(0.1), newR: wad(0.4), pendingR: wad(0.1), side: true, outcome: true, n: 6, logIndex: 3 }), block: { number: 6, timestamp: 1400 }, transaction: { hash } },
    ]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ r: wad(0.4), pending: wad(0.1), vestAt: 1700n });
    t.expect(await indexer.Vesting.getOrThrow("6_2")).toMatchObject({ amount: wad(0.4), newR: wad(0.4), txHash: hash, logIndex: 2 });
    t.expect((await indexer.ReputationChange.getOrThrow("6_3")).txHash).toBe(hash);
  });

  it("exposes unknown vest deadlines when immutable configuration is unavailable", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [categoryAdded(), marketCreated(), betPlaced({ user: alice, side: true, amount: usd(50), n: 3 }), reputationChanged({ user: alice, marketId: 1n, delta: wad(0.5), newR: 0n, pendingR: wad(0.5), side: true, outcome: true, n: 4 })]);
    t.expect(await indexer.Trader.getOrThrow(alice)).toMatchObject({ vestAt: undefined, vestAtSource: "Unknown" });
    t.expect((await indexer.ContractConfiguration.getOrThrow(KLEOS.toLowerCase())).source).toBe("Unknown");
  });

  it("tracks ownership from direct creation and from later transfers", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [creation()]);
    t.expect(await indexer.Protocol.getOrThrow("kleos")).toMatchObject({ owner: TEAM.toLowerCase(), ownerSource: "DirectCreation" });
    await run(indexer, [{ contract: "Kleos", event: "OwnershipTransferred", block: { number: 2 }, params: { previousOwner: TEAM, newOwner: bob } }]);
    t.expect(await indexer.Protocol.getOrThrow("kleos")).toMatchObject({ owner: bob, ownerSource: "Event" });
    t.expect(await indexer.OwnershipChange.getOrThrow("2_0")).toMatchObject({ previousOwner: TEAM.toLowerCase(), newOwner: bob });
  });
});

describe("current commitment state", () => {
  it("reconciles legacy zero cancellation and later recommit exactly", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [categoryAdded(), marketCreated(), drawn(), commit(alice, tx("secret"), 4)]);
    t.expect(await indexer.CourtRound.getOrThrow("1_1")).toMatchObject({ commits: 1, commitEvents: 1 });
    await run(indexer, [commit(alice, zero, 5)]);
    t.expect(await indexer.JurorVote.getOrThrow(`1_1_${alice}`)).toMatchObject({ committed: false, commitment: zero, commitmentSource: "DirectInput" });
    t.expect(await indexer.CourtRound.getOrThrow("1_1")).toMatchObject({ commits: 0, commitEvents: 2 });
    await run(indexer, [commit(alice, tx("new-secret"), 6)]);
    t.expect(await indexer.CourtRound.getOrThrow("1_1")).toMatchObject({ commits: 1, commitEvents: 3 });
  });

  it("does not treat a nested write or a mismatched sender as a known nonzero commitment", async (t) => {
    const indexer = createTestIndexer();
    await run(indexer, [categoryAdded(), marketCreated(), drawn(), commit(alice, tx("secret"), 4, addr(999)), commit(bob, tx("other"), 5, KLEOS, alice)]);
    t.expect(await indexer.CourtRound.getOrThrow("1_1")).toMatchObject({ commits: undefined, commitEvents: 2 });
    t.expect(await indexer.JurorVote.getOrThrow(`1_1_${alice}`)).toMatchObject({ committed: undefined, commitmentSource: "Unknown" });
    // A successful reveal proves a nonzero current commitment even without the original input.
    await run(indexer, [
      { contract: "Kleos", event: "VoteRevealed", block: { number: 6 }, params: { marketId: 1n, round: 1n, juror: alice, vote: 1n } },
      { contract: "Kleos", event: "VoteRevealed", block: { number: 7 }, params: { marketId: 1n, round: 1n, juror: bob, vote: 1n } },
    ]);
    t.expect(await indexer.CourtRound.getOrThrow("1_1")).toMatchObject({ commits: 2, reveals: 2 });
    t.expect(await indexer.JurorVote.getOrThrow(`1_1_${alice}`)).toMatchObject({ committed: true, commitment: undefined, commitmentSource: "Reveal" });
  });
});

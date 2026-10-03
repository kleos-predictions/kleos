// Runs the real handlers over the local Hardhat chain and compares the result with the contract's
// view functions: market pools, prices, bettors and creator; trader R, pending, flag and
// resolvedBets; call ids and their votes. The seeded market 7 is resolved and settled, so its
// positions are checked too. Needs the local stack deployed and seeded (dev-stack skill); skips
// otherwise. The live-testnet counterpart is testnet.test.ts.
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { createPublicClient, http, type Abi, type Address } from "viem";

const RPC = process.env.KLEOS_TEST_RPC ?? "http://127.0.0.1:8545";
const CONTRACTS = new URL("../../../contracts/", import.meta.url);
const client = createPublicClient({ transport: http(RPC) });

const load = (path: string) => JSON.parse(readFileSync(new URL(path, CONTRACTS), "utf8"));

type Contract = { address: Address; abi: Abi };

/** Kleos and KleosSocial on the local chain, or null when the node, the artifacts or the deployment is missing. */
async function findContracts(): Promise<{ kleos: Contract; social: Contract } | null> {
  try {
    if ((await client.getChainId()) !== 31337) return null;
    const deployed = load("ignition/deployments/chain-31337/deployed_addresses.json") as Record<string, Address>;
    const [kleos, social] = [deployed["KleosModule#Kleos"], deployed["KleosModule#KleosSocial"]];
    // A restarted node keeps no contracts even though the deployment file is still on disk.
    if (!kleos || !social || !(await client.getCode({ address: kleos }))) return null;
    return {
      kleos: { address: kleos, abi: load("artifacts/src/Kleos.sol/Kleos.json").abi as Abi },
      social: { address: social, abi: load("artifacts/src/KleosSocial.sol/KleosSocial.json").abi as Abi },
    };
  } catch {
    return null;
  }
}
const found = await findContracts();
const none: Contract = { address: "0x", abi: [] };
const { kleos, social } = found ?? { kleos: none, social: none };

describe.skipIf(!found)("seeded local chain", () => {
  it("indexed markets, traders and calls match the contracts", async (t) => {
    const blockNumber = await client.getBlockNumber();
    const read = <T>(c: Contract, functionName: string, args: unknown[] = []) =>
      client.readContract({ ...c, functionName, args, blockNumber }) as Promise<T>;
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 31337: { startBlock: 0, endBlock: Number(blockNumber) } } });
    const coverage = { historyChecked: 0, historyUnknown: 0, deadlineChecked: 0, deadlineUnknown: 0, commitCountsChecked: 0, commitCountsUnknown: 0, claimStatesChecked: 0 };

    // Markets: pools, prices and distinct bettors.
    const count = await read<bigint>(kleos, "marketCount");
    const markets = await indexer.Market.getAll();
    t.expect(markets).toHaveLength(Number(count));
    for (const m of markets) {
      const [chain, [repYes, moneyYes], bettors] = await Promise.all([
        read<{ yesMoney: bigint; noMoney: bigint; yesEff: bigint; noEff: bigint; question: string; creator: Address }>(kleos, "getMarket", [BigInt(m.id)]),
        read<[bigint, bigint]>(kleos, "prices", [BigInt(m.id)]),
        read<Address[]>(kleos, "getBettors", [BigInt(m.id)]),
      ]);
      t.expect({ q: m.question, creator: m.creator, y: m.yesMoney, n: m.noMoney, ye: m.yesEff, ne: m.noEff, bettors: m.bettorCount }, `market ${m.id}`).toEqual({
        q: chain.question, creator: chain.creator.toLowerCase(), y: chain.yesMoney, n: chain.noMoney, ye: chain.yesEff, ne: chain.noEff, bettors: bettors.length,
      });
      if (m.betCount > 0) t.expect([m.priceRepYes, m.priceMoneyYes], `prices ${m.id}`).toEqual([repYes, moneyYes]);
    }

    // Traders: R, pending and the flag come straight from the contract.
    const traders = await indexer.Trader.getAll();
    t.expect(traders.length).toBeGreaterThan(0);
    for (const tr of traders) {
      const rep = await read<{ r: bigint; pending: bigint; vestAt: bigint; flagged: boolean; resolvedBets: number }>(kleos, "reputation", [tr.id]);
      t.expect({ r: tr.r, pending: tr.pending, flagged: tr.flagged }, `trader ${tr.id}`).toEqual({ r: rep.r, pending: rep.pending, flagged: rep.flagged });
      if (tr.resolvedBets === undefined) {
        coverage.historyUnknown++;
        t.expect(tr.resolvedBetsSource).toBe("Unknown");
      } else {
        coverage.historyChecked++;
        t.expect(tr.resolvedBets, `trader ${tr.id} exact history`).toBe(BigInt(rep.resolvedBets));
      }
      if (tr.vestAt === undefined) coverage.deadlineUnknown++;
      else {
        coverage.deadlineChecked++;
        t.expect(tr.vestAt, `trader ${tr.id} vest deadline`).toBe(rep.vestAt);
      }
    }

    // Resolution and settlement: state, outcome, bonus pot and each settled position.
    for (const m of markets) {
      const [chain, pay] = await Promise.all([
        read<{ state: number; outcome: boolean; voided: boolean }>(kleos, "getMarket", [BigInt(m.id)]),
        read<[bigint, bigint, bigint, boolean]>(kleos, "payouts", [BigInt(m.id)]),
      ]);
      t.expect([m.state, m.voided, m.bonusOpen], `market ${m.id} state`).toEqual([["Open", "Proposed", "Disputed", "Resolved"][chain.state], chain.voided, pay[3]]);
      if (m.state === "Resolved" && !m.voided) t.expect(m.outcome, `market ${m.id} outcome`).toBe(chain.outcome);
      if (pay[3]) t.expect([m.bonusPool, m.bonusWeight], `market ${m.id} bonus`).toEqual([pay[0], pay[1]]);
      const positions = await indexer.Position.getWhere({ market_id: { _eq: m.id } });
      for (const pos of positions) {
        const user = pos.trader_id;
        const [isSettled, weight, claimed] = await Promise.all([
          read<boolean>(kleos, "settled", [BigInt(m.id), user]),
          read<bigint>(kleos, "bonusWeight", [BigInt(m.id), user]),
          read<boolean>(kleos, "bonusClaimed", [BigInt(m.id), user]),
        ]);
        t.expect([pos.settled, pos.bonusWeight, pos.bonusClaimed], `position ${pos.id}`).toEqual([isSettled, weight, claimed]);
        coverage.claimStatesChecked++;
      }
    }

    // Kleos Court: every round's jury, commits and reveals, as the contract stored them.
    for (const m of markets.filter((x) => x.courtRound > 0)) {
      const court = await read<{ round: number; revealed: number }>(kleos, "getCourt", [BigInt(m.id)]);
      t.expect(m.courtRound, `market ${m.id} court round`).toBe(court.round);
      for (let r = 1; r <= court.round; r++) {
        const [round, jury] = await Promise.all([indexer.CourtRound.getOrThrow(`${m.id}_${r}`), read<Address[]>(kleos, "getJury", [BigInt(m.id), r])]);
        t.expect(round.jurors, `round ${round.id} jury`).toEqual(jury.map((j) => j.toLowerCase()));
        const [commits, votes] = await Promise.all([
          Promise.all(jury.map((j) => read<`0x${string}`>(kleos, "commitments", [BigInt(m.id), r, j]))),
          Promise.all(jury.map((j) => read<number>(kleos, "votes", [BigInt(m.id), r, j]))),
        ]);
        if (round.commits === undefined) coverage.commitCountsUnknown++;
        else {
          coverage.commitCountsChecked++;
          t.expect(round.commits, `round ${round.id} current commitments`).toBe(commits.filter((c) => BigInt(c) !== 0n).length);
        }
        t.expect(round.reveals, `round ${round.id} reveals`).toBe(votes.filter((v) => v !== 0).length);
        // A round is failed when a later one was drawn, or when the court voided the market without a verdict.
        t.expect(round.failed, `round ${round.id} failed`).toBe(r < court.round || (m.voided && m.verdict === undefined));
      }
    }

    // The juror pool, and KleosSocial names and followers.
    const pool = (await read<Address[]>(kleos, "jurorPool")).map((a) => a.toLowerCase()).sort();
    t.expect(traders.filter((x) => x.isJuror).map((x) => x.id).sort()).toEqual(pool);
    t.expect(traders.map((x) => x.name ?? "")).toEqual(await read<string[]>(social, "namesOf", [traders.map((x) => x.id)]));
    for (const x of traders) t.expect(x.followerCount, `followers ${x.id}`).toBe(Number(await read<bigint>(social, "followerCount", [x.id])));

    // Calls: one per CallPosted, keyed by the contract's callId, which KleosSocial votes use too.
    const calls = await indexer.Call.getAll();
    const logs = await client.getContractEvents({ ...kleos, eventName: "CallPosted", fromBlock: 0n, toBlock: blockNumber });
    const expected = logs.map((l) => (l.args as { callId: bigint }).callId.toString());
    t.expect(calls.map((c) => c.id).sort()).toEqual(expected.sort());
    // The seed votes on its calls; with matching ids those votes are visible.
    const [ups, downs] = await read<[bigint[], bigint[], number[]]>(social, "tallies", [calls.map((c) => BigInt(c.id)), kleos.address]);
    t.expect(ups.some((u) => u > 0n) && downs.some((d) => d > 0n), "seeded votes land on indexed call ids").toBe(true);
    t.expect(calls.map((c) => [c.ups, c.downs])).toEqual(calls.map((_, i) => [Number(ups[i]), Number(downs[i])]));
    for (const claim of await indexer.BonusClaim.getAll()) {
      t.expect(await read<boolean>(kleos, "bonusClaimed", [BigInt(claim.market_id), claim.trader_id]), `claim ${claim.id}`).toBe(true);
      t.expect(await read<bigint>(kleos, "bonusOf", [BigInt(claim.market_id), claim.trader_id]), `claim ${claim.id} amount`).toBe(claim.amount);
    }
    console.log(`Pinned local reconciliation at block ${blockNumber}: ${JSON.stringify(coverage)}`);
  }, 120_000);
});

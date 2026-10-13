// The real handlers over the live Monad testnet deployment, compared with the contracts' views:
// markets, prices and bettors; R, pending and flags; the juror pool; names, follows and call
// votes. Run it with `pnpm test:testnet` (scripts/test-testnet.sh), which swaps in
// config.testnet.yaml. Skipped in the normal suite.
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { createPublicClient, http, type Abi, type Address } from "viem";

const CHAIN = 10143;
const testnet = readFileSync(new URL("../../config.testnet.yaml", import.meta.url), "utf8");
const startBlock = Number(/start_block: (\d+)/.exec(testnet)![1]);
const addressOf = (name: string) => new RegExp(`name: ${name}\\n\\s+address:\\n\\s+- "(0x[0-9a-fA-F]{40})"`).exec(testnet)![1] as Address;
const artifact = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../contracts/artifacts/src/${name}.sol/${name}.json`, import.meta.url), "utf8")).abi as Abi;

const client = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });

describe.skipIf(!process.env.KLEOS_TESTNET)("Monad testnet", () => {
  it("indexed state matches Kleos and KleosSocial", async (t) => {
    const kleos = { address: addressOf("Kleos"), abi: artifact("Kleos") };
    const social = { address: addressOf("KleosSocial"), abi: artifact("KleosSocial") };
    // Both the index and every comparison use the same block, never a moving latest head.
    const endBlock = Number(await client.getBlockNumber()) - 5;
    const read = <T>(c: typeof kleos, functionName: string, args: unknown[] = []) =>
      client.readContract({ ...c, functionName, args, blockNumber: BigInt(endBlock) }) as Promise<T>;
    const indexer = createTestIndexer();
    const started = Date.now();
    await indexer.process({ chains: { [CHAIN]: { startBlock, endBlock } } as never });
    console.log(`indexed blocks ${startBlock}–${endBlock} in ${(Date.now() - started) / 1000} s`);

    const markets = await indexer.Market.getAll();
    t.expect(markets.length).toBe(Number(await read<bigint>(kleos, "marketCount")));
    for (const m of markets) {
      const [c, [repYes, moneyYes], bettors] = await Promise.all([
        read<{ yesMoney: bigint; noMoney: bigint; yesEff: bigint; noEff: bigint; state: number; voided: boolean }>(kleos, "getMarket", [BigInt(m.id)]),
        read<[bigint, bigint]>(kleos, "prices", [BigInt(m.id)]),
        read<Address[]>(kleos, "getBettors", [BigInt(m.id)]),
      ]);
      t.expect([m.yesMoney, m.noMoney, m.yesEff, m.noEff, m.bettorCount, m.priceRepYes, m.priceMoneyYes, m.state, m.voided], `market ${m.id}`).toEqual([
        c.yesMoney, c.noMoney, c.yesEff, c.noEff, bettors.length, repYes, moneyYes, ["Open", "Proposed", "Disputed", "Resolved"][c.state], c.voided,
      ]);
    }

    const traders = await indexer.Trader.getAll();
    const coverage = { historyChecked: 0, historyUnknown: 0, deadlineChecked: 0, deadlineUnknown: 0, claimStatesChecked: 0, commitCountsChecked: 0, commitCountsUnknown: 0 };
    for (const x of traders) {
      const rep = await read<{ r: bigint; pending: bigint; vestAt: bigint; flagged: boolean; resolvedBets: number }>(kleos, "reputation", [x.id]);
      t.expect([x.r, x.pending, x.flagged], `trader ${x.id}`).toEqual([rep.r, rep.pending, rep.flagged]);
      if (x.resolvedBets === undefined) {
        coverage.historyUnknown++;
        t.expect(x.resolvedBetsSource).toBe("Unknown");
      } else {
        coverage.historyChecked++;
        t.expect(x.resolvedBets, `trader ${x.id} exact history`).toBe(BigInt(rep.resolvedBets));
      }
      if (x.vestAt === undefined) coverage.deadlineUnknown++;
      else {
        coverage.deadlineChecked++;
        t.expect(x.vestAt, `trader ${x.id} vest deadline`).toBe(rep.vestAt);
      }
      t.expect(x.followerCount, `followers ${x.id}`).toBe(Number(await read<bigint>(social, "followerCount", [x.id])));
      t.expect(x.followingCount, `following ${x.id}`).toBe((await read<Address[]>(social, "following", [x.id])).length);
    }
    t.expect(traders.map((x) => x.name ?? "")).toEqual(await read<string[]>(social, "namesOf", [traders.map((x) => x.id)]));

    const pool = (await read<Address[]>(kleos, "jurorPool")).map((a) => a.toLowerCase()).sort();
    t.expect(traders.filter((x) => x.isJuror).map((x) => x.id).sort()).toEqual(pool);
    t.expect((await indexer.Protocol.getOrThrow("kleos")).jurorCount).toBe(pool.length);

    const calls = await indexer.Call.getAll();
    t.expect(calls.length).toBe(Number(await read<bigint>(kleos, "callCount")));
    const [ups, downs] = await read<[bigint[], bigint[], number[]]>(social, "tallies", [calls.map((c) => BigInt(c.id)), kleos.address]);
    t.expect(calls.map((c) => [c.ups, c.downs])).toEqual(calls.map((_, i) => [Number(ups[i]), Number(downs[i])]));

    for (const pos of await indexer.Position.getAll()) {
      t.expect(await read<boolean>(kleos, "bonusClaimed", [BigInt(pos.market_id), pos.trader_id]), `position ${pos.id} claimed`).toBe(pos.bonusClaimed);
      coverage.claimStatesChecked++;
    }
    for (const claim of await indexer.BonusClaim.getAll()) {
      t.expect(await read<boolean>(kleos, "bonusClaimed", [BigInt(claim.market_id), claim.trader_id]), `claim ${claim.id}`).toBe(true);
      t.expect(await read<bigint>(kleos, "bonusOf", [BigInt(claim.market_id), claim.trader_id]), `claim ${claim.id} amount`).toBe(claim.amount);
    }
    for (const round of await indexer.CourtRound.getAll()) {
      if (round.commits === undefined) coverage.commitCountsUnknown++;
      else {
        const commitments = await Promise.all(round.jurors.map((j) => read<`0x${string}`>(kleos, "commitments", [BigInt(round.market_id), round.round, j])));
        t.expect(round.commits, `round ${round.id} current commitments`).toBe(commitments.filter((c) => BigInt(c) !== 0n).length);
        coverage.commitCountsChecked++;
      }
    }
    console.log(`Pinned testnet reconciliation at block ${endBlock}: ${JSON.stringify(coverage)}`);

    console.log(`${markets.length} markets, ${traders.length} traders, ${calls.length} calls, ${pool.length} jurors, ${(await indexer.Follow.getAll()).length} follows, ${(await indexer.CallVote.getAll()).length} call votes`);
  }, 600_000);
});

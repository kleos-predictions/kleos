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
    const read = <T>(c: typeof kleos, functionName: string, args: unknown[] = []) => client.readContract({ ...c, functionName, args }) as Promise<T>;

    // A few blocks behind the head, so the RPC reads below see at least the indexed state.
    const endBlock = Number(await client.getBlockNumber()) - 5;
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
    for (const x of traders) {
      const rep = await read<{ r: bigint; pending: bigint; flagged: boolean; resolvedBets: number }>(kleos, "reputation", [x.id]);
      t.expect([x.r, x.pending, x.flagged], `trader ${x.id}`).toEqual([rep.r, rep.pending, rep.flagged]);
      // Seeds set resolvedBets without an event, so the index can only undercount it.
      t.expect(x.resolvedBets).toBeLessThanOrEqual(rep.resolvedBets);
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

    console.log(`${markets.length} markets, ${traders.length} traders, ${calls.length} calls, ${pool.length} jurors, ${(await indexer.Follow.getAll()).length} follows, ${(await indexer.CallVote.getAll()).length} call votes`);
  }, 600_000);
});

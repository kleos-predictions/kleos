// Runs the real handlers over the local Hardhat chain and compares the result with the contract's
// view functions: market pools, prices, bettors and creator; trader R, pending, flag and
// resolvedBets; call ids and their votes. Resolution, settlement, bonus and court values are
// checked here in PLAN.md phase 2; until then the simulated tests
// in core.test.ts cover them. Needs the local stack deployed and seeded (dev-stack skill); skips
// otherwise.
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

const read = <T>(c: { address: Address; abi: Abi }, functionName: string, args: unknown[] = []) =>
  client.readContract({ ...c, functionName, args }) as Promise<T>;

describe.skipIf(!found)("seeded local chain", () => {
  it("indexed markets, traders and calls match the contracts", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 31337: { startBlock: 0, endBlock: Number(await client.getBlockNumber()) } } });

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
      const rep = await read<{ r: bigint; pending: bigint; flagged: boolean; resolvedBets: number }>(kleos, "reputation", [tr.id]);
      t.expect({ r: tr.r, pending: tr.pending, flagged: tr.flagged }, `trader ${tr.id}`).toEqual({ r: rep.r, pending: rep.pending, flagged: rep.flagged });
      // Seeds set resolvedBets without an event, so the index can only undercount it.
      t.expect(tr.resolvedBets).toBeLessThanOrEqual(rep.resolvedBets);
    }

    // Calls: one per CallPosted, keyed by the contract's callId, which KleosSocial votes use too.
    const calls = await indexer.Call.getAll();
    const logs = await client.getContractEvents({ ...kleos, eventName: "CallPosted", fromBlock: 0n });
    const expected = logs.map((l) => (l.args as { callId: bigint }).callId.toString());
    t.expect(calls.map((c) => c.id).sort()).toEqual(expected.sort());
    // The seed votes on its calls; with matching ids those votes are visible.
    const [ups, downs] = await read<[bigint[], bigint[], number[]]>(social, "tallies", [calls.map((c) => BigInt(c.id)), kleos.address]);
    t.expect(ups.some((u) => u > 0n) && downs.some((d) => d > 0n), "seeded votes land on indexed call ids").toBe(true);
  }, 120_000);
});

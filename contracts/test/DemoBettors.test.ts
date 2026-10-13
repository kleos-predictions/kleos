import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toFunctionSelector, type Address, type Hex } from "viem";
import { readDemoBettors } from "../scripts/demo-bettors.ts";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const paginatedCode = `0x63${toFunctionSelector("bettorCount(uint256)").slice(2)}1463${toFunctionSelector("getBettorsPage(uint256,uint256,uint256)").slice(2)}14` as Hex;
const legacyCode = `0x63${toFunctionSelector("getBettors(uint256)").slice(2)}14` as Hex;

function fixture({ legacy = false, count = 11, pageCount = count, failure }: { legacy?: boolean; count?: number; pageCount?: number; failure?: "bytecode" | "count" | "page" | "legacy" } = {}) {
  const calls: string[] = [];
  const bettors = Array.from({ length: count }, (_, i) => address(i + 1));
  const check = (name: string, args: readonly bigint[], snapshot: { blockNumber: bigint }) => {
    calls.push(name);
    assert.equal(snapshot.blockNumber, 42n);
    assert.equal(args[0], 7n);
    if (failure === name) throw new Error(`${name} transport unavailable`);
    if (legacy && name !== "legacy") throw new Error("Legacy contract has no pagination selector");
  };
  const client = {
    getBlockNumber: async () => 42n,
    getBytecode: async ({ address: target, blockNumber }: { address: Address; blockNumber: bigint }) => {
      assert.equal(target, address(99)); assert.equal(blockNumber, 42n);
      if (failure === "bytecode") throw new Error("bytecode transport unavailable");
      return legacy ? legacyCode : paginatedCode;
    },
  };
  const contract = {
    address: address(99),
    read: {
      bettorCount: async (args: readonly [bigint], snapshot: { blockNumber: bigint }) => { check("count", args, snapshot); return BigInt(count); },
      getBettorsPage: async (args: readonly [bigint, bigint, bigint], snapshot: { blockNumber: bigint }) => {
        check("page", args, snapshot); assert.deepEqual(args, [7n, 0n, 100n]); return bettors.slice(0, pageCount);
      },
      getBettors: async (args: readonly [bigint], snapshot: { blockNumber: bigint }) => { check("legacy", args, snapshot); return bettors; },
    },
  };
  return { calls, bettors, run: () => readDemoBettors(client, contract, 7n), client, contract };
}

describe("demo bettor discovery", () => {
  it("settles a legacy ABI fixture without calling its unavailable pagination selectors", async () => {
    const f = fixture({ legacy: true });
    assert.deepEqual(await f.run(), f.bettors);
    assert.deepEqual(f.calls, ["legacy"]);
  });
  it("pins paginated count and page to the same block", async () => {
    const f = fixture();
    assert.deepEqual(await f.run(), f.bettors);
    assert.deepEqual(f.calls, ["count", "page"]);
  });
  for (const legacy of [false, true]) {
    it(`rejects over 100 bettors on ${legacy ? "legacy" : "paginated"} deployments without truncating settlement`, async () => {
      const f = fixture({ legacy, count: 101 });
      await assert.rejects(f.run(), /over 100 bettors/);
      assert.deepEqual(f.calls, [legacy ? "legacy" : "count"]);
    });
    it(`preserves an empty settlement on ${legacy ? "legacy" : "paginated"} deployments`, async () => {
      assert.deepEqual(await fixture({ legacy, count: 0 }).run(), []);
    });
  }
  for (const failure of ["bytecode", "count", "page", "legacy"] as const) {
    it(`propagates a ${failure} transport failure instead of changing ABI paths`, async () => {
      const f = fixture({ legacy: failure === "legacy", failure });
      await assert.rejects(f.run(), new RegExp(`${failure} transport unavailable`));
      if (failure !== "legacy") assert.ok(!f.calls.includes("legacy"));
    });
  }
  it("rejects a truncated page even when its count is under the limit", async () => {
    await assert.rejects(fixture({ count: 11, pageCount: 10 }).run(), /pinned count/);
  });
  it("does not treat missing bytecode as a legacy deployment", async () => {
    const f = fixture();
    await assert.rejects(readDemoBettors({ ...f.client, getBytecode: async () => "0x" }, f.contract, 7n), /unavailable/);
    assert.deepEqual(f.calls, []);
  });
});

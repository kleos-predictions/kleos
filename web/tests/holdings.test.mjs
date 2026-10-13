import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const user = "0x1111111111111111111111111111111111111111";
const contract = "0x3333333333333333333333333333333333333333";
const unexpected = () => { throw new Error("Unexpected history or fixture dependency"); };
function load(file, stubs) {
  const source = readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(output, {
    module: loadedModule, exports: loadedModule.exports,
    require: name => { if (!(name in stubs)) throw new Error(`Unexpected import ${name}`); return stubs[name]; },
    process: { env: {} }, Date, setTimeout, clearTimeout,
  });
  return loadedModule.exports;
}
const data = load("data", { "./math": { multiplier: unexpected, reputationDelta: unexpected }, "./tiers": { tierOf: unexpected } });
function harness({ count = 3n, held = id => id !== 2n, fail } = {}) {
  const reads = [];
  let blockReads = 0, active = 0, maxActive = 0;
  const client = {
    getBlockNumber: async () => { blockReads++; return 100n; },
    getBlock: unexpected, getContractEvents: unexpected,
    readContract: async request => {
      reads.push(request);
      const { functionName: fn, args } = request;
      if (fn === fail) throw new Error(`RPC failed: ${fn}`);
      if (fn === "marketCount") return count;
      if (fn === "hasBet") {
        active++;
        maxActive = Math.max(maxActive, active);
        try { await new Promise(resolve => setImmediate(resolve)); return held(args[0]); }
        finally { active--; }
      }
      if (fn === "getMarket") return { question: `Market ${args[0]}`, state: 3, outcome: args[0] === 1n, voided: false, closeTime: 1n };
      if (fn === "positions") return [args[0] === 1n ? args[2] ? 1_250_000n : 750_000n : args[2] ? 0n : 1_500_000n, 0n, 0n, false];
      throw new Error(`Unexpected RPC method ${fn}`);
    },
  };
  const api = load("onchain", {
    "next/server": { connection: async () => {} },
    "./abi": { kleosAbi: [], kleosSocialAbi: [] },
    "./chain": { HAS_LOGS_RPC: false, KLEOS_ADDRESS: contract, SOCIAL_ADDRESS: contract, chain: { id: 10143 }, logsClient: client, publicClient: client },
    "./hypersync": { HAS_HYPERSYNC: false, hypersyncEvents: unexpected },
    "./bettors": { readBettorDiscovery: unexpected }, "./data": data,
  });
  return { ...api, reads, get blockReads() { return blockReads; }, get maxActive() { return maxActive; } };
}

for (const atBlock of [undefined, 80n]) {
  test(`holdings include positions without calls, newest first, at ${atBlock ?? "the latest block"}`, async () => {
    const h = harness();
    const rows = await h.readHoldings(user, atBlock);
    assert.deepEqual(Array.from(rows, row => ({ ...row })), [
      { marketId: 3, question: "Market 3", yes: 0, no: 1.5, status: "won" },
      { marketId: 1, question: "Market 1", yes: 1.25, no: 0.75, status: "won" },
    ]);
    assert.equal(rows[1].yes + rows[1].no, 2, "both sides contribute to the displayed stake");
    assert.equal(h.blockReads, atBlock === undefined ? 1 : 0);
    assert.ok(h.reads.every(read => read.blockNumber === (atBlock ?? 100n) && read.address === contract), "count, discovery, positions and metadata share the selected block");
    assert.ok(h.reads.filter(read => ["hasBet", "positions"].includes(read.functionName)).every(read => read.args[1] === user));
    assert.equal(h.reads.filter(read => read.functionName === "positions").length, 4, "read both sides of each held market");
  });
}

test("holdings reject excessive market discovery before per-market reads", async () => {
  const h = harness({ count: 1_001n });
  await assert.rejects(h.readHoldings(user), /market read budget/);
  assert.deepEqual(h.reads.map(read => read.functionName), ["marketCount"]);
});

test("holdings reject more than 100 held markets before fetching their details", async () => {
  const h = harness({ count: 101n, held: () => true });
  await assert.rejects(h.readHoldings(user), /profile read budget/);
  assert.equal(h.reads.filter(read => read.functionName === "hasBet").length, 101);
  assert.ok(h.reads.every(read => ["marketCount", "hasBet"].includes(read.functionName)));
});

test("holdings discovery runs at most four market reads concurrently", async () => {
  const h = harness({ count: 9n, held: () => false });
  assert.equal((await h.readHoldings(user)).length, 0);
  assert.equal(h.maxActive, 4);
  assert.deepEqual(h.reads.filter(read => read.functionName === "hasBet").map(read => read.args[0]), [9n, 8n, 7n, 6n, 5n, 4n, 3n, 2n, 1n]);
});

for (const fail of ["hasBet", "positions", "getMarket"]) {
  test(`holdings propagate ${fail} failures instead of presenting empty holdings`, async () => {
    const h = harness({ fail });
    await assert.rejects(h.readHoldings(user), new RegExp(`RPC failed: ${fail}`));
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const CONTRACT = "0x1111111111111111111111111111111111111111";

function oldSchemaHarness() {
  const requests = [];
  const warnings = [];
  let connections = 0;
  const stubs = {
    "server-only": {},
    "next/server": { connection: async () => { connections++; } },
    "./abi": { kleosAbi: [], kleosSocialAbi: [] },
    "./chain": {
      IS_LIVE: true,
      IS_LOCAL_CHAIN: false,
      KLEOS_ADDRESS: CONTRACT,
      SOCIAL_ADDRESS: CONTRACT,
      chain: { id: 10143 },
      publicClient: new Proxy({}, {
        get: (_, method) => () => { throw new Error(`Unexpected indexed chain check: ${String(method)}`); },
      }),
    },
    "./onchain": {},
  };
  const source = readFileSync(new URL("../src/lib/indexer.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(output, {
    module: loadedModule,
    exports: loadedModule.exports,
    require: name => {
      if (!(name in stubs)) throw new Error(`Unexpected import: ${name}`);
      return stubs[name];
    },
    process: { env: { INDEXER_URL: "https://indexer.invalid/graphql", NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK: "1" } },
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({
        errors: [{ message: 'field "ContractConfiguration" not found in type: query_root' }],
        data: { Call: [{ id: "999", text: "Partial data must not be rendered" }] },
      });
    },
    console: { error: (...args) => warnings.push(args.join(" ")) },
    AbortSignal, TextDecoder, Date, setTimeout, clearTimeout,
  });
  return { ...loadedModule.exports, requests, warnings, connections: () => connections };
}

test("an old hosted schema falls back to the chain instead of using partial indexed data", async () => {
  const h = oldSchemaHarness();
  const chainItems = [{ id: 7, text: "Verified chain call" }];
  let fallbackReads = 0;
  const result = await h.preferIndexer(h.readFeed, async () => {
    fallbackReads++;
    return chainItems;
  });
  assert.equal(result, chainItems);
  assert.equal(fallbackReads, 1);
  assert.equal(h.connections(), 1);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].query, /ContractConfiguration/);
  assert.match(h.requests[0].query, /_meta/);
  assert.match(h.warnings[0], /ContractConfiguration.*not found/);
});

test("an old schema cannot hide a failed chain fallback", async () => {
  const h = oldSchemaHarness();
  const unavailable = new Error("Chain read unavailable");
  await assert.rejects(h.preferIndexer(h.readFeed, async () => { throw unavailable; }), error => error === unavailable);
});

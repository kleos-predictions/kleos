import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sender = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const hash = `0x${"44".repeat(32)}`;
const sourceRoot = new URL("../src/", import.meta.url);
const jsx = (type, props) => ({ type, props });
const runtime = { jsx, jsxs: jsx, Fragment: "fragment" };
function load(file, stubs = {}, extra = "", globals = {}) {
  const source = readFileSync(new URL(file, sourceRoot), "utf8") + extra;
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(output, { module: loadedModule, exports: loadedModule.exports, require: name => name in stubs ? stubs[name] : require(name), Date, URL, ...globals });
  return loadedModule.exports;
}
const abi = load("lib/abi.ts");
function harness() {
  const states = [], effects = [], timers = [], reads = [], writes = [];
  let cursor = 0;
  let currentOwner = sender;
  const now = Math.floor(Date.now() / 1000);
  const react = {
    useState(initial) { const n = cursor++; if (!(n in states)) states[n] = typeof initial === "function" ? initial() : initial; return [states[n], next => { states[n] = typeof next === "function" ? next(states[n]) : next; }]; },
    useRef(initial) { const n = cursor++; if (!(n in states)) states[n] = { current: initial }; return states[n]; },
    useCallback: callback => callback,
    useEffect: callback => effects.push(callback),
  };
  const client = {
    getBlockNumber: async () => 100n,
    readContract: async request => {
      reads.push(request);
      const fn = request.functionName;
      if (["DISPUTE_WINDOW", "COURT_PERIOD", "RESOLVER_MIN_R", "EXPIRY_WINDOWS"].includes(fn)) return ({ DISPUTE_WINDOW: 120n, COURT_PERIOD: 180n, RESOLVER_MIN_R: 4n * 10n ** 18n, EXPIRY_WINDOWS: 5n })[fn];
      assert.equal(request.blockNumber, 100n, `${fn} must use snapshot block`);
      if (fn === "getMarket") return { state: 2, closeTime: BigInt(now - 60), proposedAt: BigInt(now - 30), creator: other, proposer: other, proposedOutcome: true };
      if (fn === "getCourt") return { round: 1, commitEnd: BigInt(now + 120), revealEnd: BigInt(now + 300), revealed: 0, tally: [0, 0, 0, 0] };
      if (fn === "payouts") return [0n, 0n, 0n, false];
      if (fn === "owner") return currentOwner;
      if (fn === "getJury") return [sender];
      if (fn === "namesOf") return ["juror"];
      if (fn === "votes") return 0;
      if (fn === "commitments") return `0x${"00".repeat(32)}`;
      if (fn === "reputation") return { r: 36n * 10n ** 18n, flagged: false };
      if (fn === "hasBet") return false;
      throw new Error(`Unexpected or secret-bearing RPC method ${fn}`);
    },
  };
  const signature = `0x${"55".repeat(65)}`;
  const wallet = { account: { address: sender }, signMessage: async () => signature, writeContract: async request => { writes.push(request); return hash; } };
  const pending = { pending: null, hasPending: () => false, confirm: async () => ({ transactionHash: hash, status: "success" }), complete() {} };
  const exports = load("components/resolution-panel.tsx", {
    react, "react/jsx-runtime": runtime, "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/chain": { KLEOS_ADDRESS: target, SOCIAL_ADDRESS: other, USD_ADDRESS: other, chain: { id: 31337 }, publicClient: client, shortAddress: address => address },
    "@/lib/abi": abi, "@/lib/mera": { describeAccountError: failure => failure.message },
    "@/lib/data": { RESOLUTION_STAGES: ["Open", "Closed", "Proposed", "Court", "Resolved"] },
    "./account": { useKleosAccount: () => ({ address: sender, authorize: async () => wallet, whenFunded: async address => assert.equal(address, sender) }) },
    "./resolution-track": { ResolutionTrack: "track" },
    "./pending-transaction": { usePendingTransaction: () => pending, PendingTransactionNotice: "pending" },
    "@/lib/bettors": { readBettorDiscovery: async () => { throw new Error("Unexpected discovery"); } },
    "@/lib/usd-spend": { ensureUsdAllowance: async () => { throw new Error("Unexpected approval"); } },
  }, "\nexport const testBoundary = { readSnapshot, safeEvidenceUrl };", {
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  });
  return { reads, writes, signature, api: exports.testBoundary, setOwner: owner => { currentOwner = owner; },
    render() { cursor = 0; return exports.ResolutionPanel({ marketId: 1, oracle: "Official source" }); },
    async mount() { this.render(); effects.splice(0).forEach(callback => callback()); timers.splice(0).forEach(callback => callback()); await new Promise(resolve => setImmediate(resolve)); },
  };
}
function nodes(node) { return node && typeof node === "object" ? [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] : []; }

test("resolution snapshots pin account and court reads and refresh changed ownership", async () => {
  const h = harness();
  assert.equal((await h.api.readSnapshot(1n, sender)).isOwner, true);
  h.setOwner(other);
  assert.equal((await h.api.readSnapshot(1n, sender)).isOwner, false);
  assert.equal(h.reads.filter(read => read.functionName === "owner").length, 2);
});

test("resolution evidence keeps executable, insecure and oversized URIs unclickable", () => {
  const h = harness();
  for (const uri of ["javascript:alert(1)", "data:text/html,test", "http://example.com", "https://example.com/" + "a".repeat(300), "not a URL"]) assert.equal(h.api.safeEvidenceUrl(uri), null);
  assert.equal(h.api.safeEvidenceUrl("https://example.com/result"), "https://example.com/result");
});

test("the actual jury commit action never sends its vote or derived salt in an RPC read", async () => {
  const h = harness(); await h.mount();
  const yes = nodes(h.render()).find(node => node.props?.label === "Yes");
  assert.ok(yes, "eligible juror must have a commit action");
  await yes.props.onClick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].functionName, "commitVote");
  assert.equal(h.writes[0].args[0], 1n);
  const salt = require("viem").keccak256(h.signature);
  assert.ok(h.reads.every(read => read.functionName !== "voteCommitment"));
  assert.ok(h.reads.every(read => !read.args?.includes(salt)));
});

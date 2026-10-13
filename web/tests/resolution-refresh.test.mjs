import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sourceRoot = new URL("../src/", import.meta.url);
const sender = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const jsx = (type, props) => ({ type, props });
function load(file, stubs = {}, globals = {}) {
  const source = readFileSync(new URL(file, sourceRoot), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(output, { module: loadedModule, exports: loadedModule.exports, require: name => name in stubs ? stubs[name] : require(name), URL, ...globals });
  return loadedModule.exports;
}
const abi = load("lib/abi.ts");
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const nodes = node => node && typeof node === "object" ? [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] : [];

function harness() {
  const hooks = [], effects = [], timers = new Map(), listeners = new Set();
  const snapshots = [], reads = [];
  let cursor = 0, dirty = false, tree, timerId = 0, elapsed = 0, address, marketId = 1, blockReads = 0;
  const epoch = 1_800_000_000;
  let releaseRead, rejectRead;
  const heldRead = new Promise((resolve, reject) => { releaseRead = resolve; rejectRead = reject; });
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === "function" ? initial() : initial;
      return [hooks[i], next => {
        const value = typeof next === "function" ? next(hooks[i]) : next;
        if (Object.is(value, hooks[i])) return;
        hooks[i] = value;
        dirty = true;
        if (value && typeof value === "object" && "marketId" in value) snapshots.push(value);
      }];
    },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useCallback(callback, deps) {
      const i = cursor++;
      if (!sameDeps(hooks[i]?.deps, deps)) hooks[i] = { callback, deps };
      return hooks[i].callback;
    },
    useEffect(callback, deps) {
      const i = cursor++;
      if (!sameDeps(hooks[i]?.deps, deps)) effects.push({ i, callback, deps });
    },
  };
  const schedule = (callback, delay, interval = false) => {
    const id = ++timerId;
    timers.set(id, { callback, due: elapsed + delay, interval: interval ? delay : 0 });
    return id;
  };
  const client = {
    getBlockNumber: async () => ++blockReads === 2 ? heldRead : BigInt(99 + blockReads),
    readContract: async request => {
      reads.push(request);
      const fn = request.functionName;
      if (["DISPUTE_WINDOW", "COURT_PERIOD", "RESOLVER_MIN_R", "EXPIRY_WINDOWS"].includes(fn)) return ({ DISPUTE_WINDOW: 120n, COURT_PERIOD: 180n, RESOLVER_MIN_R: 4n * 10n ** 18n, EXPIRY_WINDOWS: 5n })[fn];
      assert.equal(typeof request.blockNumber, "bigint", `${fn} must use the snapshot block`);
      if (fn === "getMarket") return { state: request.args[0] === 1n ? 3 : 1, closeTime: BigInt(epoch - 180), proposedAt: BigInt(epoch - 130), creator: other, proposer: other, proposedOutcome: true, outcome: true };
      if (fn === "getCourt") return { round: 0, commitEnd: 0n, revealEnd: 0n, revealed: 0, tally: [0, 0, 0, 0] };
      if (fn === "payouts") return [0n, 0n, 0n, request.args[0] === 1n];
      if (fn === "owner") return other;
      if (fn === "reputation") return { r: 4n * 10n ** 18n, flagged: false };
      if (fn === "hasBet") return false;
      if (fn === "bonusOf") { assert.equal(request.args[1], sender); return 2_000_000n; }
      if (fn === "bonusClaimed") return false;
      throw new Error(`Unexpected RPC method ${fn}`);
    },
  };
  const unexpectedAction = () => { throw new Error("This regression must only read"); };
  const { ResolutionPanel } = load("components/resolution-panel.tsx", {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next/navigation": { useRouter: () => ({ refresh: unexpectedAction }) },
    "@/lib/chain": { KLEOS_ADDRESS: other, SOCIAL_ADDRESS: other, chain: { id: 31337 }, publicClient: client, shortAddress: value => value },
    "@/lib/abi": abi, "@/lib/mera": { describeAccountError: failure => failure.message },
    "@/lib/data": { RESOLUTION_STAGES: ["Open", "Closed", "Proposed", "Court", "Resolved"] },
    "./account": { useKleosAccount: () => ({ address, authorize: unexpectedAction }) },
    "./resolution-track": { ResolutionTrack: "track" },
    "./pending-transaction": { usePendingTransaction: () => ({ pending: null, hasPending: () => false }), PendingTransactionNotice: "pending" },
    "@/lib/bettors": { readBettorDiscovery: unexpectedAction },
    "@/lib/usd-spend": { ensureUsdAllowance: unexpectedAction },
  }, {
    Date: class extends Date { static now() { return epoch * 1000 + elapsed; } },
    setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: id => timers.delete(id),
    document: { hidden: false, addEventListener: (_, callback) => listeners.add(callback), removeEventListener: (_, callback) => listeners.delete(callback) },
  });
  function render() {
    cursor = 0;
    dirty = false;
    tree = ResolutionPanel({ marketId, oracle: "Official source" });
    const pendingEffects = effects.splice(0);
    for (const { i } of pendingEffects) hooks[i]?.cleanup?.();
    for (const { i, callback, deps } of pendingEffects) hooks[i] = { deps, cleanup: callback() };
  }
  async function settle() {
    // Drain complete RPC promise chains, then commit one batched state update and its effects.
    do {
      await new Promise(resolve => setImmediate(resolve));
      if (!dirty) break;
      render();
    } while (true);
  }
  async function advance(ms) {
    const end = elapsed + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      elapsed = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else timers.delete(id);
      timer.callback();
      await settle();
    }
    elapsed = end;
    await settle();
  }
  return {
    reads, snapshots, advance,
    async mount() { render(); await advance(0); },
    async change(next) { address = next.address; marketId = next.marketId; render(); await advance(0); },
    async finishOldRead(failure) { if (failure) rejectRead(failure); else releaseRead(101n); await settle(); },
    get blockReads() { return blockReads; },
    get actions() { return nodes(tree).filter(node => typeof node.props?.label === "string"); },
    get status() { return nodes(tree).find(node => node.props?.role === "status")?.props.children; },
    dispose() { for (const hook of hooks) hook?.cleanup?.(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0); },
  };
}

test("a failed refresh of a terminal resolution snapshot resumes reads without a visibility event", async t => {
  const h = harness();
  t.after(() => h.dispose());
  await h.mount();
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.blockReads, 2);
  await h.finishOldRead(new Error("Temporary RPC failure"));
  await h.advance(10_000);
  assert.ok(h.blockReads > 2, "a failed terminal refresh must automatically retry");
  assert.ok(h.snapshots.at(-1).blockNumber >= 102n, "a successful retry must replace the failed snapshot");
  assert.match(h.status, /^Snapshot block /);
});

for (const scenario of [
  { name: "signing in with an unclaimed bonus", next: { marketId: 1, address: sender }, action: "Claim bonus · $2.00" },
  { name: "switching to an actionable market", next: { marketId: 2, address: undefined }, action: "Finalize" },
]) {
  test(`resolution polling recovers after ${scenario.name} during a terminal snapshot refresh`, async t => {
    const h = harness();
    t.after(() => h.dispose());
    await h.mount();
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.snapshots[0].market.state, 3);
    assert.equal(h.snapshots[0].bonusOpen, true);
    assert.equal(h.snapshots[0].me.bonus, 0n);
    assert.equal(h.blockReads, 2, "the terminal snapshot's follow-up refresh must be held in flight");

    await h.change(scenario.next);
    assert.equal(h.blockReads, 2, "the identity-change refresh is skipped while the old read is active");
    assert.equal(h.status, "Reading the market from the chain…");
    await h.finishOldRead();
    assert.equal(h.snapshots.length, 1, "effect cleanup must prevent the old read from committing");
    assert.equal(h.status, "Reading the market from the chain…");

    await h.advance(10_000);
    const action = h.actions.find(node => node.props.label === scenario.action);
    assert.ok(action, "normal polling must recover the current identity without visibility events or reloads");
    assert.equal(action.props.stale, false);
    assert.equal(h.snapshots.at(-1).marketId, BigInt(scenario.next.marketId));
    assert.equal(h.snapshots.at(-1).accountAddress, scenario.next.address);
    assert.ok(h.snapshots.every(snapshot => snapshot.blockNumber !== 101n), "the invalidated snapshot must never be accepted");
  });
}

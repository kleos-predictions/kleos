import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../src/", import.meta.url);
const sender = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const hash = "0x" + "33".repeat(32);
const jsx = (type, props) => ({ type, props });
const runtime = { jsx, jsxs: jsx, Fragment: "fragment" };

/** Load actual production modules; only browser, hooks and network boundaries are inert. */
function load(file, stubs = {}, globals = {}) {
  const source = readFileSync(new URL(file, root), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const runtimeModule = { exports: {} };
  runInNewContext(output, { module: runtimeModule, exports: runtimeModule.exports, require: name => name in stubs ? stubs[name] : require(name), Date, setTimeout, clearTimeout, setInterval, clearInterval, ...globals }, { filename: file });
  return runtimeModule.exports;
}

function hookHarness() {
  const states = [];
  let cursor = 0;
  return {
    render(renderComponent) { cursor = 0; return renderComponent(); },
    react: {
      useEffect() {},
      useCallback: callback => callback,
      useMemo: factory => factory(),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = { current: initial };
        return states[index];
      },
    },
  };
}

function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
function textContent(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return [node.props?.children].flat(Infinity).map(textContent).join(" ");
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const abi = load("lib/abi.ts");
const tiers = load("lib/tiers.ts");
const item = { id: 1, address: sender, r: 16, rawR: (16n * 10n ** 18n - 1n).toString(), side: true, amount: 50, entryPrice: .5, text: "Recorded call", ago: "1m", marketId: 1, question: "Question", result: null };

function feedHarness() {
  const hooks = hookHarness();
  const state = { recorded: 0, tally: [[0n], [0n], [0]], failRefresh: false, failAuthorize: false, writes: [], authorizations: 0, completions: 0 };
  const account = {
    address: sender, status: "unlocked",
    authorize: async () => { state.authorizations++; if (state.failAuthorize) throw new Error("Authorization unavailable"); return { account: { address: sender }, writeContract: async params => { state.writes.push(params); state.recorded = Number(params.args[1]); return hash; } }; },
    whenFunded: async address => assert.equal(address, sender),
  };
  const pending = { pending: null, hasPending: () => false, confirm: async () => ({ transactionHash: hash }), complete: () => state.completions++ };
  const component = load("components/feed-list.tsx", {
    react: hooks.react, "react/jsx-runtime": runtime, "next/link": { default: "link" },
    wagmi: { useReadContract: ({ functionName }) => functionName === "following" ? { data: [] } : { data: state.tally, refetch: async () => {
      if (state.failRefresh) return { isError: true, error: new Error("Counts unavailable") };
      state.tally = [[BigInt(state.recorded === 1 ? 1 : 0)], [BigInt(state.recorded === -1 ? 1 : 0)], [state.recorded]];
      return { isError: false, data: state.tally };
    } } },
    "@/lib/data": { SHARP_R: 16 },
    "@/lib/chain": { SOCIAL_ADDRESS: target, chain: { id: 10143 }, shortAddress: a => a, publicClient: { readContract: async params => { assert.equal(params.functionName, "voteOf"); assert.equal(params.args[1], sender); return state.recorded; } } },
    "@/lib/abi": abi, "@/lib/tiers": tiers,
    "./account": { useKleosAccount: () => account }, "./laurel": { LaurelBadge: "badge" },
    "./pending-transaction": { usePendingTransaction: () => pending, PendingTransactionNotice: "pending" },
    "@/lib/mera": { describeAccountError: error => error.message },
  });
  const render = () => hooks.render(() => component.FeedList({ items: [item], tabs: false }));
  return { state, render, upvote: () => nodes(render()).find(node => node.props?.["aria-label"]?.startsWith("Upvote")), downvote: () => nodes(render()).find(node => node.props?.["aria-label"]?.startsWith("Downvote")) };
}

test("a confirmed social vote remains selected when authoritative count refresh fails", async () => {
  const h = feedHarness();
  h.state.failRefresh = true;
  await h.upvote().props.onClick();
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.completions, 1, "the exact receipt completed before the count read failed");
  assert.equal(h.upvote().props["aria-pressed"], true);
  assert.match(textContent(h.render()), /Vote confirmed, but counts could not be refreshed/);
});

test("a successful authoritative refresh removes the optimistic vote override", async () => {
  const h = feedHarness();
  await h.upvote().props.onClick();
  assert.equal(h.upvote().props["aria-pressed"], true);
  // A later external transaction by this account changes the real tallies.
  h.state.recorded = -1;
  h.state.tally = [[0n], [1n], [-1]];
  assert.equal(h.upvote().props["aria-pressed"], false, "a stale local override cannot mask the new chain vote");
  assert.equal(h.downvote().props["aria-pressed"], true);
});

test("failed account authorization releases the social in-flight guard for a later attempt", async () => {
  const h = feedHarness();
  h.state.failAuthorize = true;
  await h.upvote().props.onClick();
  assert.equal(h.state.writes.length, 0);
  h.state.failAuthorize = false;
  await h.upvote().props.onClick();
  assert.equal(h.state.authorizations, 2);
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.upvote().props["aria-pressed"], true);
});

test("social toggling reads the actually authorized signer's prior vote", async () => {
  const h = feedHarness();
  h.state.recorded = 1; // the displayed snapshot is still 0 when the account authorizes
  await h.upvote().props.onClick();
  assert.equal(h.state.writes[0].args[1], 0, "tapping an already recorded upvote clears it despite the stale display");
});

test("an anonymous user can reconcile a persisted reputation action without signing", async () => {
  const hooks = hookHarness();
  const records = load("lib/pending-transactions.ts");
  const transactions = load("lib/transactions.ts");
  const intent = { sender, to: target, data: require("viem").encodeFunctionData({ abi: abi.kleosAbi, functionName: "vest", args: [sender] }) };
  const key = `kleos.pending.v1.10143.reputation:${target}`;
  const storage = new Map([[key, records.serializePendingTransaction({ hash, intent })]]);
  let receiptReads = 0;
  let refreshes = 0;
  const client = {
    waitForTransactionReceipt: async ({ hash: requested }) => { assert.equal(requested, hash); receiptReads++; return { status: "success", transactionHash: hash, logs: [] }; },
    getTransaction: async () => ({ from: sender, to: target, input: intent.data, value: 0n }),
    readContract: async () => { throw new Error("Anonymous reconciliation must not read a selected account"); },
  };
  const chainModule = { chain: { id: 10143 }, KLEOS_ADDRESS: target, publicClient: client, shortAddress: a => a, txUrl: value => value };
  const pending = load("components/pending-transaction.tsx", { react: hooks.react, "react/jsx-runtime": runtime, "@/lib/chain": chainModule, "@/lib/transactions": transactions, "@/lib/pending-transactions": records }, {
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, value) => storage.set(k, value), removeItem: k => storage.delete(k) },
    window: { addEventListener() {}, removeEventListener() {} },
  });
  const component = load("components/reputation-actions.tsx", {
    react: hooks.react, "react/jsx-runtime": runtime, "next/navigation": { useRouter: () => ({ refresh: () => refreshes++ }) },
    "@/lib/abi": abi, "@/lib/chain": chainModule,
    "@/lib/mera": { describeAccountError: error => error.message },
    "./account": { useKleosAccount: () => ({ authorize: async () => { throw new Error("Anonymous check must not authorize"); }, whenFunded: async () => { throw new Error("Anonymous check must not fund"); } }) },
    "./pending-transaction": pending,
  });
  const render = () => hooks.render(() => component.ReputationActions());
  const tree = render(); // Previously dereferenced account.address when only a pending record existed.
  assert.ok(tree);
  const notice = nodes(tree).find(node => node.type === pending.PendingTransactionNotice);
  assert.equal(notice.props.transaction.pending.hash, hash);
  const renderedNotice = pending.PendingTransactionNotice(notice.props);
  nodes(renderedNotice).find(node => node.type === "button").props.onClick();
  await flush();
  assert.equal(receiptReads, 1);
  assert.equal(refreshes, 1);
  assert.equal(storage.size, 0);
  assert.equal(render(), null, "the anonymous control disappears after its journal is resolved");
});

test("market calls preserve the exact reputation value for tier artwork", () => {
  const calls = load("components/calls-list.tsx", { "react/jsx-runtime": runtime, "next/link": { default: "link" }, "@/lib/chain": { shortAddress: a => a }, "./laurel": { LaurelBadge: "badge" } });
  const badge = nodes(calls.CallsList({ calls: [item] })).find(node => node.type === "badge");
  assert.equal(badge.props.rawR, item.rawR, "floating 16 cannot promote an address one wei below tier IV");
});

test("a missing live reputation read stays unknown in the trade panel", () => {
  const hooks = hookHarness();
  const math = load("lib/math.ts");
  const data = load("lib/data.ts", { "./math": math, "./tiers": tiers });
  const component = load("components/trade-panel.tsx", {
    react: hooks.react, "react/jsx-runtime": runtime, "next/link": { default: "link" },
    "next/navigation": { useRouter: () => ({ refresh() {} }), useSearchParams: () => new URLSearchParams() },
    wagmi: { useReadContract: () => ({ data: undefined }) },
    "@/lib/data": data, "@/lib/math": math,
    "@/lib/chain": { IS_LIVE: true, IS_LOCAL_CHAIN: false, KLEOS_ADDRESS: target, USD_ADDRESS: target, chain: { id: 10143 }, publicClient: {}, txUrl: value => value },
    "@/lib/mera": { describeAccountError: error => error.message },
    "./account": { PROMPT_FREE_LIMIT: 100, useKleosAccount: () => ({ address: sender, status: "unlocked" }) },
    "@/lib/abi": abi, "@/lib/transactions": {},
    "./pending-transaction": { usePendingTransaction: () => ({ pending: null }), PendingTransactionNotice: "pending" },
    "./reputation-actions": { ReputationActions: "reputation-controls" },
    "@/lib/tiers": tiers, "./boost-gauge": { BoostGauge: "gauge" }, "./laurel": { LaurelBadge: "badge" },
  }, { URLSearchParams, TextEncoder });
  const tree = hooks.render(() => component.TradePanel({ market: data.getMarket(1) }));
  assert.match(textContent(tree), /Reputation unavailable/);
  assert.doesNotMatch(textContent(tree), /NO TIER YET|R = 0\.0/);
  assert.equal(nodes(tree).filter(node => node.type === "badge").length, 0);
});

test("a missing live reputation read stays unknown in the account button", () => {
  const hooks = hookHarness();
  const component = load("components/account-button.tsx", {
    react: hooks.react, "react/jsx-runtime": runtime, "next/link": { default: "link" },
    wagmi: { useReadContract: () => ({ data: undefined }) },
    "@/lib/chain": { IS_LIVE: true, KLEOS_ADDRESS: target, USD_ADDRESS: target, shortAddress: a => a, txUrl: value => value },
    "@/lib/abi": abi,
    "./account": { useKleosAccount: () => ({ address: sender, status: "unlocked", epoch: 0, prompting: false, funding: false, fundingTransactions: [], error: null }) },
    "./laurel": { LaurelBadge: "badge" },
  });
  const tree = hooks.render(() => component.AccountButton());
  assert.match(textContent(tree), /R \?/);
  assert.equal(nodes(tree).filter(node => node.type === "badge").length, 0);
});

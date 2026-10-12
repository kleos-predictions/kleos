import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { providerHarness } from "./helpers/account-provider.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const viem = require("viem");
const address = "0x0000000000000000000000000000000000000003";
const kleos = "0x0000000000000000000000000000000000000001";
const now = Math.floor(Date.now() / 1000);

function snapshot(state = 1) {
  return {
    market: { state, closeTime: 0n, proposedAt: 0n, creator: kleos, proposer: kleos, proposedOutcome: true },
    court: { round: 1, commitEnd: BigInt(now + 300), revealEnd: BigInt(now + 600), revealed: 0, tally: [0, 0, 0, 0] },
    disputeWindow: 60,
    courtPeriod: 300,
    isOwner: false,
    bonusOpen: false,
    jury: [{ address, committed: false, vote: 0 }],
    me: { r: 36, flagged: false, hasBet: false, settled: false, bonus: 0n, bonusClaimed: false },
  };
}

// Run the real component event handlers with a small hook/JSX runtime. No browser,
// wallet, RPC or timers are used; state is rendered again after each action.
function harness(component, { receipts = ["success"], approval = false, snap = snapshot(), bettors = [], wait, funding } = {}) {
  const states = component === "ResolutionPanel" ? [now, snap] : [];
  let cursor = 0;
  let refreshes = 0;
  let receiptIndex = 0;
  const writes = [];
  const hashes = [];
  const client = {
    account: { address },
    signMessage: async () => "0x1234",
    writeContract: async (input) => {
      writes.push(input);
      return `0x${String(writes.length).padStart(64, "0")}`;
    },
  };
  const fundingState = funding && providerHarness(funding.response, {
    address, client, getBalance: funding.getBalance, balanceOf: funding.balanceOf,
  });
  const account = {
    address,
    status: "unlocked",
    authorize: async () => client,
    whenFunded: async () => {},
    requestFunds: async () => {},
    ...(fundingState ? fundingState() : {}),
    // The component is rendered for this signed-in address; the real provider still runs
    // authorization, background sponsorship and its action-specific funding gate.
    ...(fundingState ? { address, status: "unlocked" } : {}),
  };
  const publicClient = {
    readContract: async ({ functionName }) => {
      const reads = {
        balanceOf: 1_000_000_000n,
        allowance: 0n,
        market: approval ? viem.zeroAddress : kleos,
        getBettors: bettors,
        getMarket: snap.market,
        getCourt: snap.court,
        payouts: [0n, 0n, 0n, false],
        DISPUTE_WINDOW: 60n,
        COURT_PERIOD: 300n,
        owner: kleos,
        getJury: [],
        reputation: { r: 0n, flagged: false },
        hasBet: false,
        settled: false,
        bonusOf: 0n,
        bonusClaimed: false,
        commitments: viem.keccak256(viem.encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "uint8" }, { type: "bytes32" }],
          [1n, 1, address, 1, viem.keccak256("0x1234")],
        )),
      };
      assert.ok(functionName in reads, `Unexpected contract read: ${functionName}`);
      return reads[functionName];
    },
    waitForTransactionReceipt: async ({ hash }) => {
      hashes.push(hash);
      if (wait) return wait();
      assert.ok(receiptIndex < receipts.length, "Unexpected receipt wait");
      return { status: receipts[receiptIndex++] };
    },
  };
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props };
  const stubs = {
    react: {
      useState: (initial) => {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next/link": { __esModule: true, default: "a" },
    "next/navigation": { useRouter: () => ({ refresh: () => { refreshes++; } }), useSearchParams: () => new URLSearchParams() },
    wagmi: { useReadContract: () => ({ data: { r: 0n, resolvedBets: 0 } }) },
    viem,
    "@/lib/data": { DEMO_R: 0, pools: () => ({ yesEff: 100, noEff: 100, yesMoney: 100, noMoney: 100 }), RESOLUTION_STAGES: [] },
    "@/lib/math": { PARAMS: { nMin: 3 }, effectiveBet: (amount) => amount, multiplier: () => 1, payout: (amount) => amount },
    "@/lib/chain": { IS_LIVE: true, IS_LOCAL_CHAIN: false, KLEOS_ADDRESS: kleos, USD_ADDRESS: kleos, chain: { id: 10143 }, publicClient, shortAddress: (a) => a, txUrl: (hash) => `https://example.test/tx/${hash}` },
    "@/lib/mera": { describeAccountError: (error) => error.message },
    "@/lib/abi": { kleosAbi: [], kleosUsdAbi: [], kleosSocialAbi: [] },
    "@/lib/tiers": { tierOf: () => 0, TIER_NAMES: ["", "I"], TIER_THRESHOLDS: [1] },
    "./account": { PROMPT_FREE_LIMIT: 100, useKleosAccount: () => account },
    "./boost-gauge": { BoostGauge: () => null },
    "./laurel": { LaurelBadge: () => null },
    "./resolution-track": { ResolutionTrack: () => null },
  };
  const file = component === "TradePanel" ? "trade-panel" : "resolution-panel";
  const source = readFileSync(new URL(`../src/components/${file}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", compiled.outputText)((name) => {
    assert.ok(name in stubs, `Unexpected import: ${name}`);
    return stubs[name];
  }, compiledModule, compiledModule.exports);
  const render = () => {
    cursor = 0;
    return compiledModule.exports[component]({ market: { id: 1, status: "live", repYes: 0.5 }, marketId: 1, oracle: "Official result" });
  };
  return { render, writes, hashes, refreshes: () => refreshes, fundingState };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

function text(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree?.props ? text(tree.props.children) : "";
}

function click(h, label) {
  const button = nodes(h.render()).find((node) => node.type === "button" && text(node) === label);
  assert.ok(button, `Button not found: ${label}`);
  assert.ok(!button.props.disabled, `Button disabled: ${label}`);
  return button.props.onClick();
}

function error(h) {
  return text(nodes(h.render()).find((node) => node.props?.role === "alert"));
}

test("reverted approval stops before placing a bet", async () => {
  const h = harness("TradePanel", { approval: true, receipts: ["reverted"] });
  await click(h, "Place bet · Yes");
  assert.deepEqual(h.writes.map((tx) => tx.functionName), ["approve"]);
  assert.match(error(h), /approval reverted/);
  assert.doesNotMatch(text(h.render()), /BET PLACED/);
  assert.equal(h.refreshes(), 0);
});

test("reverted bet shows an error and keeps the call without showing a receipt", async () => {
  const h = harness("TradePanel", { receipts: ["reverted"] });
  nodes(h.render()).find((node) => node.props?.["aria-label"] === "Your call, optional").props.onChange({ target: { value: "My demo call" } });
  await click(h, "Place bet · Yes");
  assert.deepEqual(h.writes.map((tx) => tx.functionName), ["betWithCall"]);
  assert.match(error(h), /bet reverted/);
  assert.doesNotMatch(text(h.render()), /BET PLACED/);
  assert.equal(nodes(h.render()).find((node) => node.props?.["aria-label"] === "Your call, optional").props.value, "My demo call");
  assert.equal(h.refreshes(), 0);
});

test("successful approval and bet show the confirmed receipt and refresh", async () => {
  const h = harness("TradePanel", { approval: true, receipts: ["success", "success"] });
  await click(h, "Place bet · Yes");
  assert.deepEqual(h.writes.map((tx) => tx.functionName), ["approve", "bet"]);
  assert.match(text(h.render()), /BET PLACED/);
  assert.equal(error(h), "");
  assert.equal(h.refreshes(), 1);
});

test("reverted court action does not refresh or report success", async () => {
  const h = harness("ResolutionPanel", { receipts: ["reverted"] });
  await click(h, "Finalize");
  assert.match(error(h), /transaction reverted/);
  assert.equal(h.refreshes(), 0);
});

test("a reverted settlement batch stops later batches and preserves the partial-result warning", async () => {
  const h = harness("ResolutionPanel", { snap: snapshot(3), bettors: Array(201).fill(address), receipts: ["success", "reverted"] });
  await click(h, "Settle everyone");
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes.map((tx) => tx.args[1].length), [100, 100]);
  assert.match(error(h), /Already confirmed batches remain settled/);
  assert.equal(h.refreshes(), 0);
});

for (const status of ["success", "reverted"]) {
  test(`hidden vote notice waits for confirmation (${status})`, async () => {
    let finish;
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const receipt = new Promise((resolve) => { finish = resolve; });
    const h = harness("ResolutionPanel", { snap: snapshot(2), wait: () => { started(); return receipt; } });
    const pending = click(h, "Yes");
    await waiting;
    assert.doesNotMatch(text(h.render()), /Hidden vote (sent|confirmed)/);
    finish({ status });
    await pending;
    if (status === "success") {
      assert.match(text(h.render()), /Hidden vote confirmed/);
      assert.equal(h.refreshes(), 1);
    } else {
      assert.doesNotMatch(text(h.render()), /Hidden vote (sent|confirmed)/);
      assert.match(error(h), /transaction reverted/);
      assert.equal(h.refreshes(), 0);
    }
  });
}

const sponsorUnavailable = async () => ({ ok: false, json: async () => ({ error: "Sponsorship is not configured" }) });

test("a funded $10 bet proceeds during sponsor failure with less than either faucet threshold", async () => {
  const h = harness("TradePanel", { funding: {
    response: sponsorUnavailable,
    getBalance: async () => viem.parseEther("0.01"),
    balanceOf: async () => viem.parseUnits("10", 6),
  } });
  nodes(h.render()).find((node) => node.props?.["aria-label"] === "Amount in test USD").props.onChange({ target: { value: "10" } });
  await click(h, "Place bet · Yes");
  assert.deepEqual(h.writes.map((tx) => tx.functionName), ["bet"]);
  assert.equal(h.writes[0].args[2], viem.parseUnits("10", 6));
  assert.match(text(h.render()), /BET PLACED/);
  assert.match(h.fundingState().error, /not configured/, "optional sponsorship failure stays visible");
});

for (const action of ["Finalize", "Reveal my vote", "Settle everyone"]) {
  test(`${action} needs gas but no kUSD when the sponsor is unreachable`, async () => {
    const snap = snapshot(action === "Finalize" ? 1 : action === "Reveal my vote" ? 2 : 3);
    if (action === "Reveal my vote") {
      snap.court.commitEnd = BigInt(now - 1);
      snap.jury[0].committed = true;
    }
    const h = harness("ResolutionPanel", { snap, bettors: [address], funding: {
      response: async () => { throw new Error("Sponsor network unavailable"); },
      getBalance: async () => viem.parseEther("0.01"),
      balanceOf: async () => { assert.fail("Token-free actions must not read or require kUSD"); },
    } });
    await click(h, action);
    assert.equal(h.writes.length, 1);
    assert.equal(error(h), "");
    assert.equal(h.refreshes(), 1);
    assert.match(h.fundingState().error, /network unavailable/);
  });
}

for (const missing of ["gas", "usd"]) {
  test(`a bet with insufficient ${missing} remains blocked when sponsorship fails`, async () => {
    const h = harness("TradePanel", { funding: {
      response: sponsorUnavailable,
      getBalance: async () => missing === "gas" ? 0n : viem.parseEther("0.01"),
      balanceOf: async () => viem.parseUnits(missing === "usd" ? "79" : "80", 6),
    } });
    await click(h, "Place bet · Yes");
    assert.equal(h.writes.length, 0);
    assert.match(error(h), /not configured/);
    assert.doesNotMatch(text(h.render()), /BET PLACED/);
  });
}

test("a token-free court action still blocks when it has no native gas", async () => {
  const h = harness("ResolutionPanel", { funding: {
    response: sponsorUnavailable,
    getBalance: async () => 0n,
    balanceOf: async () => { assert.fail("Finalize has no token requirement"); },
  } });
  await click(h, "Finalize");
  assert.equal(h.writes.length, 0);
  assert.match(error(h), /not configured/);
});

for (const tokens of [14, 15]) {
  test(`a $15 dispute bond with $${tokens} uses the action amount rather than the faucet threshold`, async () => {
    const snap = snapshot();
    snap.market.proposedAt = BigInt(now);
    const h = harness("ResolutionPanel", { snap, funding: {
      response: sponsorUnavailable,
      getBalance: async () => viem.parseEther("0.01"),
      balanceOf: async () => viem.parseUnits(String(tokens), 6),
    } });
    await click(h, "Dispute · $15 bond");
    assert.equal(h.writes.length, tokens === 15 ? 1 : 0);
    if (tokens === 15) assert.equal(h.writes[0].functionName, "dispute");
    else assert.match(error(h), /not configured/);
  });
}

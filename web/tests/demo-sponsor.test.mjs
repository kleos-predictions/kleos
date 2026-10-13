import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isAddress, parseEther, parseUnits, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { providerHarness } from "./helpers/account-provider.mjs";

const require = createRequire(import.meta.url);
const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

// Exercise the production modules with fake RPC and passkey boundaries; no keys or network.
function load(file, stubs, globals = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const runtimeModule = { exports: {} };
  runInNewContext(output, { module: runtimeModule, exports: runtimeModule.exports, require: (id) => id in stubs ? stubs[id] : require(id), ...globals });
  return runtimeModule.exports;
}

function sponsorHarness() {
  const sent = [];
  const events = [];
  const balances = new Map();
  const outcomes = { gas: "success", usd: "success" };
  const rpc = { receiptError: null, transactionError: null, nonceError: null, pendingNonce: null, confirmedNonce: null };
  const mined = new Map();
  let confirmedNonce = 0;
  let timestamp = 1_000_000;
  class Clock extends Date { static now() { return timestamp; } }
  function balance(address) {
    if (!balances.has(address)) balances.set(address, { gas: 0n, usd: 0n });
    return balances.get(address);
  }
  function mine(tx, outcome = "success") {
    if (mined.has(tx.nonce) && mined.get(tx.nonce) !== tx.hash) throw new Error("Nonce already consumed");
    mined.set(tx.nonce, tx.hash);
    confirmedNonce = Math.max(confirmedNonce, tx.nonce + 1);
    tx.receipt = { status: outcome === "reverted" ? "reverted" : "success", transactionHash: tx.hash };
    if (outcome === "success" && !tx.applied) { balance(tx.to)[tx.purpose] += tx.amount; tx.applied = true; }
    return tx.receipt;
  }
  async function send(purpose, to, amount, nonce) {
    assert.ok(Number.isInteger(nonce), "each grant must pin its nonce before submitting");
    const hash = `0x${(sent.length + 1).toString(16).padStart(64, "0")}`;
    sent.push({ hash, purpose, to, amount, nonce, applied: false, dropped: false });
    events.push(`send ${purpose}`);
    return hash;
  }
  const { POST } = load("app/api/sponsor/route.ts", {
    viem: { isAddress, parseEther, parseUnits, TransactionNotFoundError, TransactionReceiptNotFoundError, http: () => ({}), createWalletClient: () => ({
      sendTransaction: ({ to, value, nonce }) => send("gas", to, value, nonce),
      writeContract: ({ args, nonce }) => send("usd", args[0], args[1], nonce),
    }) },
    "viem/accounts": { privateKeyToAccount: () => ({ address: OTHER }) },
    "@/lib/abi": { kleosUsdAbi: [] },
    "@/lib/funding": load("lib/funding.ts", {}),
    "@/lib/chain": { chain: {}, USD_ADDRESS: OTHER, publicClient: {
      getBalance: async ({ address }) => balance(address).gas,
      readContract: async ({ args }) => balance(args[0]).usd,
      getTransactionCount: async ({ address, blockTag }) => {
        assert.equal(address, OTHER, "nonce evidence must belong to the sponsor");
        if (rpc.nonceError) throw rpc.nonceError;
        if (blockTag === "latest") return rpc.confirmedNonce ?? confirmedNonce;
        return rpc.pendingNonce ?? Math.max(confirmedNonce, ...sent.filter((tx) => !tx.dropped).map((tx) => tx.nonce + 1));
      },
      getTransactionReceipt: async ({ hash }) => {
        if (rpc.receiptError) throw rpc.receiptError;
        const tx = sent.find((entry) => entry.hash === hash);
        if (!tx?.receipt) throw new TransactionReceiptNotFoundError({ hash });
        return tx.receipt;
      },
      getTransaction: async ({ hash }) => {
        if (rpc.transactionError) throw rpc.transactionError;
        const tx = sent.find((entry) => entry.hash === hash);
        if (!tx || tx.dropped) throw new TransactionNotFoundError({ hash });
        return { hash, nonce: tx.nonce, from: OTHER };
      },
      waitForTransactionReceipt: async ({ hash, onReplaced }) => {
        const tx = sent.find((entry) => entry.hash === hash);
        events.push(`confirm ${tx.purpose}`);
        const outcome = outcomes[tx.purpose];
        if (outcome === "timeout") throw new Error("Synthetic receipt timeout");
        const receipt = mine(tx, outcome);
        if (outcome === "cancelled") onReplaced({ reason: "cancelled", transactionReceipt: receipt });
        return receipt;
      },
    } },
  }, { Request, Response, URL, Date: Clock, process: { env: { SPONSOR_PRIVATE_KEY: "stub-never-used-as-a-key" } } });
  return {
    sent, events, outcomes, rpc, balance, mine,
    consumeNonce: (nonce) => { mined.set(nonce, "external replacement"); confirmedNonce = Math.max(confirmedNonce, nonce + 1); },
    advance: () => { timestamp += 31_000; },
    request: (address = ADDRESS) => POST(new Request("https://kleos.example/api/sponsor", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://kleos.example", host: "kleos.example" },
      body: JSON.stringify({ address }),
    })),
  };
}

test("fresh account funding confirms gas before minting and preserves grant sizes", async () => {
  const h = sponsorHarness();
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).funded, { gas: true, usd: true });
  assert.deepEqual(h.events, ["send gas", "confirm gas", "send usd", "confirm usd"]);
  assert.deepEqual(h.sent.map((tx) => tx.amount), [parseEther("0.3"), parseUnits("1000", 6)]);
  assert.equal((await h.request()).status, 200, "an already funded account does not fail on cooldown");
  assert.equal(h.sent.length, 2);
});

test("a reverted or cancelled gas transfer never reports funding or sends a mint", async () => {
  for (const outcome of ["reverted", "cancelled"]) {
    const h = sponsorHarness();
    h.outcomes.gas = outcome;
    const response = await h.request();
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).funded, { gas: false, usd: false });
    assert.equal(h.sent.length, 1);
    assert.equal((await h.request()).status, 429, "failed attempts retain their cooldown");
  }
});

test("a reverted mint reports confirmed gas and retry only sends the missing USD", async () => {
  const h = sponsorHarness();
  h.outcomes.usd = "reverted";
  const response = await h.request();
  assert.equal(response.status, 503);
  const partial = await response.json();
  assert.deepEqual(partial.funded, { gas: true, usd: false });
  assert.equal(partial.hashes.length, 2);
  assert.match(partial.error, /Gas funding is confirmed/);
  assert.equal(partial.pending, undefined);
  assert.equal((await h.request()).status, 429);
  h.advance();
  h.outcomes.usd = "success";
  assert.equal((await h.request()).status, 200);
  assert.deepEqual(h.sent.map((tx) => tx.purpose), ["gas", "usd", "usd"]);
});

test("an uncertain gas receipt blocks another recipient until reconciliation", async () => {
  const h = sponsorHarness();
  h.outcomes.gas = "timeout";
  const partial = await (await h.request()).json();
  assert.equal(partial.pending.hash, h.sent[0].hash);
  h.advance();
  assert.equal((await h.request(OTHER)).status, 503);
  assert.equal(h.sent.length, 1);
  h.outcomes.gas = "success";
  assert.equal((await h.request()).status, 200);
  assert.deepEqual(h.sent.map((tx) => tx.purpose), ["gas", "usd"], "reconciled gas is not sent twice");
});

test("an uncertain mint retains its hash and never repeats after it confirms", async () => {
  const h = sponsorHarness();
  h.outcomes.usd = "timeout";
  const partial = await (await h.request()).json();
  assert.deepEqual(partial.funded, { gas: true, usd: false });
  assert.equal(partial.pending.hash, h.sent[1].hash);
  assert.equal((await h.request()).status, 503);
  h.outcomes.usd = "success";
  assert.equal((await h.request()).status, 200);
  assert.equal(h.sent.length, 2);
});

for (const purpose of ["gas", "usd"]) {
  test(`a dropped ${purpose} grant retries its original recipient at the same nonce`, async () => {
    const h = sponsorHarness();
    h.outcomes[purpose] = "timeout";
    assert.equal((await h.request()).status, 503);
    const original = h.sent.at(-1);
    original.dropped = true;
    h.advance();
    h.outcomes[purpose] = "success";

    assert.equal((await h.request(OTHER)).status, 200, "a dropped grant must not block every other account forever");
    const attempts = h.sent.filter((tx) => tx.to === ADDRESS && tx.purpose === purpose);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].nonce, original.nonce, "retrying at a new nonce could duplicate the grant");
    assert.equal(attempts[1].amount, original.amount);
    assert.throws(() => h.mine(original), /Nonce already consumed/, "a late original cannot also execute");
    assert.equal((await h.request()).status, 200);
    assert.equal(h.balance(ADDRESS).gas, parseEther("0.3"));
    assert.equal(h.balance(ADDRESS).usd, parseUnits("1000", 6));
    assert.equal(h.balance(OTHER).gas, parseEther("0.3"));
    assert.equal(h.balance(OTHER).usd, parseUnits("1000", 6));
  });
}

test("a late receipt reconciles the original grant without resending it", async () => {
  const h = sponsorHarness();
  h.outcomes.gas = "timeout";
  assert.equal((await h.request()).status, 503);
  h.mine(h.sent[0]);
  h.advance();
  assert.equal((await h.request()).status, 200);
  assert.deepEqual(h.sent.map((tx) => tx.purpose), ["gas", "usd"]);
});

test("a consumed sponsor nonce releases a missing transaction after balances refresh", async () => {
  const h = sponsorHarness();
  h.outcomes.gas = "timeout";
  assert.equal((await h.request()).status, 503);
  h.sent[0].dropped = true;
  h.consumeNonce(h.sent[0].nonce);
  h.advance();
  h.outcomes.gas = "success";
  assert.equal((await h.request()).status, 200);
  assert.deepEqual(h.sent.map((tx) => tx.nonce), [0, 1, 2], "a consumed nonce must never be reused");
  assert.equal(h.balance(ADDRESS).gas, parseEther("0.3"));
});

test("a missing hash with a higher pending nonce stays blocked regardless of elapsed time", async () => {
  const h = sponsorHarness();
  h.outcomes.gas = "timeout";
  assert.equal((await h.request()).status, 503);
  h.sent[0].dropped = true;
  h.rpc.pendingNonce = h.sent[0].nonce + 1;
  for (let i = 0; i < 100; i++) h.advance();
  const response = await h.request(OTHER);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).pending.hash, h.sent[0].hash);
  assert.equal(h.sent.length, 1, "an unseen pending replacement must not cause a second payout");
});

for (const boundary of ["receiptError", "transactionError", "nonceError"]) {
  test(`a ${boundary} RPC failure preserves the pending grant`, async () => {
    const h = sponsorHarness();
    h.outcomes.gas = "timeout";
    assert.equal((await h.request()).status, 503);
    h.sent[0].dropped = true;
    h.rpc[boundary] = new Error("Synthetic RPC unavailable");
    h.advance();
    const response = await h.request(OTHER);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).pending.hash, h.sent[0].hash);
    assert.equal(h.sent.length, 1, "RPC errors are not proof that a transaction was dropped");
  });
}

for (const purpose of ["gas", "usd"]) {
  test(`an already-funded account bypasses another account's uncertain ${purpose} receipt`, async () => {
    const h = sponsorHarness();
    assert.equal((await h.request(ADDRESS)).status, 200);
    h.outcomes[purpose] = "timeout";
    const blocked = await h.request(OTHER);
    assert.equal(blocked.status, 503);
    const pendingHash = (await blocked.json()).pending.hash;
    const submitted = h.sent.length;
    const eventsBeforeFundedRequest = [...h.events];

    const alreadyFunded = await h.request(ADDRESS);
    assert.equal(alreadyFunded.status, 200, "an account that needs no funding must not wait on another account's receipt");
    assert.deepEqual((await alreadyFunded.json()).funded, { gas: false, usd: false });
    assert.equal(h.sent.length, submitted, "the already-funded account submits no transfers");
    assert.deepEqual(h.events, eventsBeforeFundedRequest, "the already-funded account does not attempt pending receipt confirmation");

    const stillBlocked = await h.request(OTHER);
    assert.equal(stillBlocked.status, 503);
    assert.equal((await stillBlocked.json()).pending.hash, pendingHash, "the no-op request preserves the other account's pending hash");
    assert.equal(h.sent.length, submitted, "the unfunded account remains blocked while its receipt is uncertain");

    h.outcomes[purpose] = "success";
    h.advance();
    assert.equal((await h.request(OTHER)).status, 200);
    assert.deepEqual(h.sent.filter((tx) => tx.to === OTHER).map((tx) => tx.purpose), ["gas", "usd"], "receipt reconciliation never repeats either transfer");
    assert.equal((await h.request(OTHER)).status, 200);
    assert.equal(h.sent.length, 4, "both accounts end with exactly one gas grant and one USD mint");
  });
}


test("HTTP, network and malformed funding failures remain visible and stop whenFunded", async () => {
  const responses = [
    async () => ({ ok: false, json: async () => ({ error: "Sponsor not configured" }) }),
    async () => { throw new Error("Network unavailable"); },
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ cooldown: true }) }),
  ];
  for (const response of responses) {
    const render = providerHarness(response);
    const account = render();
    assert.ok(await account.authorize(), "a funding error must not discard the created account");
    await assert.rejects(account.whenFunded(ADDRESS));
    assert.ok(render().error);
    assert.equal(render().funding, false);
  }
});

test("explicit retry clears a funding failure after a verified response", async () => {
  let available = false;
  const render = providerHarness(async () => ({
    ok: available,
    json: async () => available ? { funded: { gas: true, usd: true } } : { error: "Sponsor unavailable" },
  }), { getBalance: async () => available ? parseEther("0.3") : 0n });
  const account = render();
  await account.authorize();
  await assert.rejects(account.whenFunded(ADDRESS), /Sponsor unavailable/);
  available = true;
  await account.requestFunds();
  await account.whenFunded(ADDRESS);
  assert.equal(render().error, null);
});

test("the next primary-action click retries failed funding without an automatic retry loop", async () => {
  let attempts = 0;
  let available = false;
  const render = providerHarness(async () => {
    attempts++;
    return {
      ok: available,
      json: async () => available ? { funded: { gas: true, usd: true } } : { error: "Sponsor temporarily unavailable" },
    };
  }, { getBalance: async () => available ? parseEther("0.3") : 0n });
  const account = render();
  await account.authorize();
  await assert.rejects(account.whenFunded(ADDRESS), /temporarily unavailable/);
  assert.equal(attempts, 1, "failure does not retry itself");

  assert.ok(await account.authorize(), "a new primary-action click keeps the unlocked account");
  await assert.rejects(account.whenFunded(ADDRESS), /temporarily unavailable/);
  assert.equal(attempts, 2, "one new click makes exactly one new attempt");

  available = true;
  assert.ok(await account.authorize());
  await account.whenFunded(ADDRESS);
  assert.equal(attempts, 3);
  assert.equal(render().error, null);

  await account.authorize();
  await account.whenFunded(ADDRESS);
  assert.equal(attempts, 3, "successful funding does not repeat on every primary action");
});

test("a funded action does not wait for a stalled optional sponsor request", { timeout: 1000 }, async () => {
  const render = providerHarness(() => new Promise(() => {}), {
    getBalance: async () => parseEther("0.06"),
    balanceOf: async () => parseUnits("10", 6),
  });
  const account = render();
  await account.authorize();
  await account.whenFunded(ADDRESS, parseUnits("10", 6));
  assert.equal(render().funding, true, "the optional request is still in flight");
});

for (const requiresTokens of [false, true]) {
  test(`partial gas funding ${requiresTokens ? "does not authorize a token spend" : "permits a token-free action"}`, async () => {
    let finish;
    let gas = 0n;
    const response = new Promise((resolve) => { finish = resolve; });
    const render = providerHarness(() => response, { getBalance: async () => gas });
    const account = render();
    await account.authorize();
    let ready = false;
    const waiting = account.whenFunded(ADDRESS, requiresTokens ? parseUnits("10", 6) : 0n).then(() => { ready = true; });
    const checked = requiresTokens ? assert.rejects(waiting, /USD mint failed/) : waiting;
    await new Promise(setImmediate);
    assert.equal(ready, false, "zero native balance waits for funding");
    gas = parseEther("0.3");
    finish({ ok: false, json: async () => ({ error: "USD mint failed after gas funding" }) });
    await checked;
    assert.equal(ready, !requiresTokens);
    assert.match(render().error, /USD mint failed/, "the partial funding error remains visible");
  });
}

test("successful sponsorship does not bypass missing on-chain balances", async () => {
  const render = providerHarness(async () => ({ ok: true, json: async () => ({ funded: { gas: true, usd: true } }) }));
  const account = render();
  await account.authorize();
  await assert.rejects(account.whenFunded(ADDRESS), /needs more gas money/);
});

test("an unlocked account below the gas floor requests funding on its next action", async () => {
  let gas = 0n;
  let attempts = 0;
  const render = providerHarness(async () => {
    attempts++;
    gas = parseEther("0.3");
    return { ok: true, json: async () => ({ funded: { gas: true, usd: false } }) };
  }, { getBalance: async () => gas });
  const account = render();
  await account.authorize();
  await account.whenFunded(ADDRESS);
  for (const lowBalance of [0n, parseEther("0.01"), parseEther("0.059")]) {
    gas = lowBalance;
    await account.authorize();
    await account.whenFunded(ADDRESS);
    assert.equal(gas, parseEther("0.3"), "positive dust must request a top-up before continuing");
  }
  assert.equal(attempts, 4);
});

test("a positive balance below the gas floor does not continue after an ineffective grant", async () => {
  const render = providerHarness(async () => ({ ok: true, json: async () => ({ funded: { gas: true, usd: true } }) }), {
    getBalance: async () => parseEther("0.01"),
    balanceOf: async () => parseUnits("1000", 6),
  });
  const account = render();
  await account.authorize();
  await assert.rejects(account.whenFunded(ADDRESS, parseUnits("10", 6)), /needs more gas money/);
});

test("locking while balances are read prevents the old action from continuing", async () => {
  let finish;
  const gas = new Promise((resolve) => { finish = resolve; });
  const render = providerHarness(async () => ({ ok: false, json: async () => ({ error: "Sponsor unavailable" }) }), {
    getBalance: () => gas,
  });
  const account = render();
  await account.authorize();
  const waiting = account.whenFunded(ADDRESS);
  account.lock();
  finish(parseEther("0.3"));
  await assert.rejects(waiting, /changed or locked/);
});

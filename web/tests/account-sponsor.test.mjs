import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as viem from "viem";
import * as mera from "@category-labs/mera";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
const { verifyMessage } = viem;
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);
const root = new URL("../src/", import.meta.url);
function load(file, stubs = {}, globals = {}) {
  const source = readFileSync(new URL(file, root), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const runtimeModule = { exports: {} };
  runInNewContext(output, { exports: runtimeModule.exports, module: runtimeModule, require: (name) => name in stubs ? stubs[name] : require(name), ...globals }, { filename: file });
  return runtimeModule.exports;
}
const lifecycle = load("lib/account-lifecycle.ts");
const proof = load("lib/sponsor-proof.ts");
const { SponsorCoordinator } = load("lib/sponsor-coordinator.ts");
const transactions = load("lib/transactions.ts");
const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";
const metadata = (address = ADDRESS_A) => ({ address, credential: { credentialId: address === ADDRESS_A ? "passkey_a" : "passkey_b" } });
function account(address = ADDRESS_A) {
  return { ...metadata(address), session: { ended: false, end() { this.ended = true; } } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Executes the production provider against deterministic hooks and fake WebAuthn/network.
// It tests authority transitions; it does not claim to replay physical browser ceremonies.
function providerHarness({ create = async () => account(), unlock = async () => account(), reveal = async () => "synthetic phrase", cached = null, blockedStorage = false, fundingError = false, gasBalance = async () => 0n } = {}) {
  let cursor = 0;
  const hooks = [];
  let pendingEffects = [];
  const listeners = new Map();
  const sent = [];
  let stored = cached ? JSON.stringify(cached) : null;
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!hooks[index] || !depsEqual(hooks[index].deps, deps)) hooks[index] = { value: factory(), deps };
    return hooks[index].value;
  };
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useContext: () => { throw new Error("Not used by this provider harness"); },
    useState: (initial) => {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (next) => { hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next; }];
    },
    useRef: (initial) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect: (effect, deps) => {
      const index = cursor++;
      if (!hooks[index] || !depsEqual(hooks[index].deps, deps)) {
        const previous = hooks[index];
        hooks[index] = { deps };
        pendingEffects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = effect(); });
      }
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const { AccountProvider } = load("components/account.tsx", {
    react,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    viem: { createWalletClient: ({ account }) => ({ account }), http: () => ({}) },
    "@category-labs/mera/viem": { toViemAccount: (session) => ({ address: session.address ?? ADDRESS_A, signMessage: async () => "0x" + "11".repeat(65) }) },
    "@/lib/chain": { chain: { id: 10143 }, POLLING_MS: 4000, publicClient: { getBalance: gasBalance } },
    "@/lib/mera": { createAccount: create, unlockAccount: unlock, revealRecoveryPhrase: reveal, describeAccountError: (error) => error.message },
    "@/lib/account-lifecycle": lifecycle,
    "@/lib/sponsor-proof": proof,
  }, {
    localStorage: {
      getItem: () => { if (blockedStorage) throw new Error("Blocked storage"); return stored; },
      setItem: (_key, value) => { if (blockedStorage) throw new Error("Blocked storage"); stored = value; },
      removeItem: () => { stored = null; },
    },
    window: { addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: (type) => listeners.delete(type) },
    location: { origin: "https://kleos.example" },
    crypto: { randomUUID }, AbortController,
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return { ok: !fundingError, json: async () => fundingError ? { error: "Sponsor is unavailable" } : { funded: { gas: true, usd: true } } };
    },
  });
  const render = () => {
    cursor = 0;
    const node = AccountProvider({ children: null });
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
    return node.props.value;
  };
  return { render, sent, dispatchStorage: (value) => listeners.get("storage")?.({ key: "kleos.account.v1", newValue: value }) };
}

test("blocked storage preserves the same account for a fresh prompt", async () => {
  let creations = 0;
  const unlockedCredentials = [];
  const harness = providerHarness({ blockedStorage: true, create: async () => { creations++; return account(); }, unlock: async (credential) => { unlockedCredentials.push(credential.credentialId); return account(); } });
  let context = harness.render();
  assert.ok(await context.authorize());
  context = harness.render();
  await context.whenFunded(ADDRESS_A);
  assert.equal(context.credential.credentialId, "passkey_a");
  assert.ok(await context.authorize({ fresh: true }));
  context = harness.render();
  await context.whenFunded(ADDRESS_A);
  assert.equal(creations, 1);
  assert.deepEqual(unlockedCredentials, ["passkey_a"]);
  assert.equal(context.address, ADDRESS_A);
});

test("overlapping prompts are blocked synchronously and lock rejects a late result", async () => {
  const prompt = deferred();
  const created = account();
  let prompts = 0;
  const harness = providerHarness({ create: () => { prompts++; return prompt.promise; } });
  let context = harness.render();
  const waiting = context.authorize();
  assert.equal(prompts, 1, "WebAuthn starts before the handler yields");
  assert.equal(await context.authorize(), null);
  assert.equal(prompts, 1);
  context.lock();
  prompt.resolve(created);
  assert.equal(await waiting, null);
  assert.equal(created.session.ended, true);
  context = harness.render();
  assert.equal(context.status, "none");
  assert.equal(harness.sent.length, 0);
});

test("a pinned passkey cannot replace the expected signer", async () => {
  const wrong = account(ADDRESS_B);
  const harness = providerHarness({ cached: metadata(), unlock: async () => wrong });
  let context = harness.render();
  assert.equal(await context.authorize({ fresh: true }), null);
  context = harness.render();
  assert.equal(context.address, ADDRESS_A);
  assert.equal(context.status, "locked");
  assert.match(context.error, /selected account/);
  assert.equal(wrong.session.ended, true);
  assert.equal(harness.sent.length, 0);
});

test("sign-out during phrase authentication cannot reveal its late result", async () => {
  const prompt = deferred();
  const harness = providerHarness({ reveal: () => prompt.promise });
  let context = harness.render();
  await context.authorize();
  context = harness.render();
  await context.whenFunded(ADDRESS_A);
  const waiting = context.revealPhrase();
  context.signOut();
  prompt.resolve("synthetic phrase");
  assert.equal(await waiting, null);
  assert.equal(harness.render().status, "none");
});

test("funding rejects HTTP failures and does not switch its requesting address", async () => {
  const harness = providerHarness({ fundingError: true });
  let context = harness.render();
  await context.authorize();
  context = harness.render();
  await assert.rejects(context.whenFunded(ADDRESS_A), /Sponsor is unavailable/);
  await assert.rejects(context.requestFunds(ADDRESS_B), /changed or locked/);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].address, ADDRESS_A);
  assert.equal(typeof harness.sent[0].signature, "string");
});

test("gas-only actions survive a faucet USD failure only with real gas for the selected signer", async () => {
  const checked = [];
  const harness = providerHarness({ fundingError: true, gasBalance: async ({ address }) => { checked.push(address); return 1_000_000n; } });
  let context = harness.render();
  await context.authorize();
  context = harness.render();
  await context.whenFunded(ADDRESS_A);
  assert.deepEqual(checked, [ADDRESS_A]);
  assert.match(harness.render().error, /Sponsor is unavailable/, "the faucet failure is still shown");
  await assert.rejects(context.requestFunds(ADDRESS_A), /Sponsor is unavailable/, "explicit USD top-ups still reject failures");
});

test("locking during the fallback gas read revokes permission to continue", async () => {
  const balance = deferred();
  const entered = deferred();
  const harness = providerHarness({ fundingError: true, gasBalance: () => { entered.resolve(); return balance.promise; } });
  let context = harness.render();
  await context.authorize();
  context = harness.render();
  const waiting = context.whenFunded(ADDRESS_A);
  await entered.promise;
  context.lock();
  balance.resolve(1_000_000n);
  await assert.rejects(waiting, /changed or locked/);
});

test("another tab's account replacement locks the old signing session", async () => {
  const old = account();
  const harness = providerHarness({ create: async () => old });
  let context = harness.render();
  await context.authorize();
  context = harness.render();
  await context.whenFunded(ADDRESS_A);
  harness.dispatchStorage(JSON.stringify(metadata(ADDRESS_B)));
  context = harness.render();
  assert.equal(old.session.ended, true);
  assert.equal(context.status, "locked");
  assert.equal(context.address, ADDRESS_B);
  await assert.rejects(context.whenFunded(ADDRESS_A), /changed or locked/);
});

test("corrupt metadata is rejected and extra persisted fields are discarded", () => {
  assert.equal(lifecycle.parsePublicAccount('{"address":"not-an-address"}'), null);
  assert.equal(lifecycle.parsePublicAccount(JSON.stringify({ ...metadata(), credential: { credentialId: "../bad" } })), null);
  const parsed = lifecycle.parsePublicAccount(JSON.stringify({ ...metadata(), secret: "never keep", credential: { credentialId: "passkey_a", session: "never keep" } }));
  assert.equal(Object.keys(parsed).sort().join(","), "address,credential");
  assert.equal(Object.keys(parsed.credential).join(","), "credentialId");
});

test("funding proof expires and binds origin, chain and requesting account", async () => {
  // This key is generated only in memory for offline signature verification.
  const signer = privateKeyToAccount(generatePrivateKey());
  const now = Date.now();
  const request = { address: signer.address, issuedAt: now, requestId: randomUUID() };
  const message = proof.sponsorshipMessage("https://kleos.example", 10143, request);
  const signature = await signer.signMessage({ message });
  assert.ok(proof.parseSponsorProof({ ...request, signature }, now));
  assert.equal(proof.parseSponsorProof({ ...request, signature }, now + proof.SPONSOR_PROOF_TTL_MS + 1), null);
  assert.equal(proof.parseSponsorProof({ ...request, signature, issuedAt: now + 15_001 }, now), null);
  assert.equal(await verifyMessage({ address: signer.address, signature, message }), true);
  assert.equal(await verifyMessage({ address: ADDRESS_B, signature, message }), false);
  assert.equal(await verifyMessage({ address: signer.address, signature, message: proof.sponsorshipMessage("https://elsewhere.example", 10143, request) }), false);
  assert.equal(await verifyMessage({ address: signer.address, signature, message: proof.sponsorshipMessage("https://kleos.example", 1, request) }), false);
});

test("the signer queue coalesces an address and serializes different addresses", async () => {
  const coordinator = new SponsorCoordinator();
  const first = deferred();
  const order = [];
  const runA = coordinator.run(ADDRESS_A, async () => { order.push("A start"); await first.promise; order.push("A end"); return "A"; });
  const duplicate = coordinator.run(ADDRESS_A.toUpperCase(), async () => { throw new Error("Duplicate must not run"); });
  const runB = coordinator.run(ADDRESS_B, async () => { order.push("B"); return "B"; });
  assert.equal(duplicate, runA);
  await Promise.resolve();
  assert.deepEqual(order, ["A start"]);
  first.resolve();
  assert.equal(await runA, "A");
  assert.equal(await runB, "B");
  assert.deepEqual(order, ["A start", "A end", "B"]);
  await assert.rejects(coordinator.run(ADDRESS_A, async () => { throw new Error("Failed transaction"); }), /Failed transaction/);
  assert.equal(await coordinator.run(ADDRESS_B, async () => "next"), "next", "a failed job does not poison later requests");
});

test("owned-node cleanup preserves the established recovery derivation and wipes PRF bytes", async () => {
  const entropy = new Uint8Array(32).fill(0x42); // Synthetic offline vector, never a user's credential.
  const seed = mnemonicToSeedSync(entropyToMnemonic(entropy, wordlist));
  const expected = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  const expectedSession = mera.createSecp256k1SigningSession({ privateKey: expected.privateKey });
  const expectedAddress = mera.getEvmAddress(expectedSession.publicKey);
  expectedSession.end(); expected.wipePrivateData(); seed.fill(0);
  const { createAccount } = load("lib/mera.ts", { "@category-labs/mera": { ...mera, createPasskeyWithPrfOutput: async () => ({ credentialId: "synthetic_passkey", prfOutput: entropy }) } }, { location: { hostname: "kleos.example" } });
  const rebuilt = await createAccount();
  assert.equal(rebuilt.address, expectedAddress);
  assert.equal(entropy.every((byte) => byte === 0), true);
  const signature = await rebuilt.session.signDigest(new Uint8Array(32).fill(1));
  assert.equal(signature.compact.length, 64);
  rebuilt.session.end();
  await assert.rejects(rebuilt.session.signDigest(new Uint8Array(32)), /ended/i);
});

function sponsorHarness({ failSend = false, failConfirmation = false, failUsdConfirmation = false, uncertainUsdConfirmation = false, budgets = {}, gasBalance = 0n, usdBalance = 0n } = {}) {
  let sends = 0;
  let timestamp = Date.now();
  class ClockDate extends Date { static now() { return timestamp; } }
  const confirmations = [];
  const { POST } = load("app/api/sponsor/route.ts", {
    viem: { ...viem, verifyMessage: async () => true, createWalletClient: () => ({
      account: { address: ADDRESS_B },
      sendTransaction: async () => { sends++; if (failSend) throw new Error("Synthetic send failure"); return "0x" + "11".repeat(32); },
      writeContract: async () => { sends++; return "0x" + "22".repeat(32); },
    }) },
    "viem/accounts": { privateKeyToAccount: () => ({ address: ADDRESS_B }) },
    "@/lib/chain": { chain: { id: 10143 }, USD_ADDRESS: ADDRESS_B, publicClient: { getBalance: async () => gasBalance, readContract: async () => usdBalance } },
    "@/lib/abi": { kleosUsdAbi: [{ type: "function", name: "sponsorMint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] },
    "@/lib/sponsor-proof": proof,
    "@/lib/sponsor-coordinator": { SponsorCoordinator },
    "@/lib/transactions": { ...transactions, confirmTransaction: async (_client, hash, intent) => {
      confirmations.push(intent);
      if (failConfirmation || (failUsdConfirmation && intent.data !== "0x")) throw new transactions.TransactionRejectedError("Synthetic reverted confirmation", hash);
      if (uncertainUsdConfirmation && intent.data !== "0x") throw new transactions.TransactionUncertainError(hash, intent);
      return { status: "success", transactionHash: hash };
    } },
  }, { Request, Response, URL, Date: ClockDate, TextDecoder, process: { env: { SPONSOR_PRIVATE_KEY: "synthetic-stub-not-a-key", ...budgets } } });
  const body = { address: ADDRESS_A, issuedAt: timestamp, requestId: randomUUID(), signature: "0x" + "11".repeat(65) };
  const request = (payload = body, headers = {}) => new Request("https://kleos.example/api/sponsor", { method: "POST", headers: { "content-type": "application/json", origin: "https://kleos.example", ...headers }, body: JSON.stringify(payload) });
  const next = (number, headers = {}) => request({ ...body, address: `0x${number.toString(16).padStart(40, "0")}`, requestId: randomUUID(), issuedAt: timestamp }, headers);
  return { POST, request, next, body, confirmations, advance: (ms) => { timestamp += ms; }, get sends() { return sends; } };
}

test("a hashless sponsor broadcast locks every recipient until operator reconciliation", async () => {
  const harness = sponsorHarness({ failSend: true });
  const failed = await harness.POST(harness.request());
  assert.equal(failed.status, 503);
  for (const request of [harness.request({ ...harness.body, requestId: randomUUID() }), harness.next(3)]) {
    const next = await harness.POST(request);
    assert.equal(next.status, 503);
    assert.match((await next.json()).error, /operator must reconcile/i);
  }
  assert.equal(harness.sends, 1);
});

test("a definitively reverted transfer still reserves cooldown for a zero-USD account", async () => {
  const harness = sponsorHarness({ failConfirmation: true });
  assert.equal((await harness.POST(harness.request())).status, 503);
  const next = await harness.POST(harness.request({ ...harness.body, requestId: randomUUID() }));
  assert.equal((await next.json()).cooldown, true);
  assert.equal(harness.sends, 1);
});

test("successful sponsor requests replay idempotently and confirm both intended transfers", async () => {
  const harness = sponsorHarness();
  const first = await harness.POST(harness.request());
  assert.equal(first.status, 200);
  const initial = await first.json();
  const again = await harness.POST(harness.request());
  assert.deepEqual(await again.json(), initial);
  assert.equal(harness.sends, 2);
  assert.equal(harness.confirmations[0].to, ADDRESS_A);
  assert.equal(harness.confirmations[0].value, viem.parseEther("0.3"));
  assert.equal(harness.confirmations[1].to, ADDRESS_B);
  assert.notEqual(harness.confirmations[1].data, "0x");
});

test("a failed sponsor confirmation cannot produce a success response", async () => {
  const harness = sponsorHarness({ failConfirmation: true });
  assert.equal((await harness.POST(harness.request())).status, 503);
  assert.equal(harness.sends, 1, "mint is not sent after gas confirmation fails");
});

test("a confirmed gas transfer survives a later reverted USD mint and its replay", async () => {
  const harness = sponsorHarness({ failUsdConfirmation: true });
  const response = await harness.POST(harness.request());
  assert.equal(response.status, 503);
  const partial = await response.json();
  assert.deepEqual(partial.funded, { gas: true, usd: false });
  assert.deepEqual(partial.hashes, ["0x" + "11".repeat(32)]);
  assert.equal(partial.pending, undefined, "a definitive reverted mint is not left pending");
  assert.match(partial.error, /Gas funding is confirmed/);
  const replay = await harness.POST(harness.request());
  assert.equal(replay.status, 503);
  assert.deepEqual(await replay.json(), partial);
  assert.equal(harness.sends, 2, "replaying a partial result never resends either transfer");
});

test("an uncertain mint retains its public hash and blocks a new transfer until checked", async () => {
  const harness = sponsorHarness({ uncertainUsdConfirmation: true });
  const first = await harness.POST(harness.request());
  const partial = await first.json();
  assert.equal(first.status, 503);
  assert.deepEqual(partial.funded, { gas: true, usd: false });
  assert.deepEqual(partial.pending, { purpose: "usd", hash: "0x" + "22".repeat(32) });
  const again = await harness.POST(harness.request({ ...harness.body, requestId: randomUUID() }));
  assert.equal(again.status, 503);
  assert.deepEqual((await again.json()).pending, partial.pending);
  assert.equal(harness.sends, 2, "a new proof checks the pending mint without issuing another one");
  const otherRecipient = await harness.POST(harness.next(3));
  assert.equal(otherRecipient.status, 503);
  assert.deepEqual((await otherRecipient.json()).pending, partial.pending);
  assert.equal(harness.sends, 2, "another recipient cannot bypass an unresolved sponsor nonce");
});

test("an oversized funding body is rejected even without a content-length header", async () => {
  const harness = sponsorHarness();
  const response = await harness.POST(harness.request({ ...harness.body, ignored: "x".repeat(5000) }));
  assert.equal(response.status, 413);
  assert.equal(harness.sends, 0);
});

test("sponsor budgets count failed attempts, fresh wallets cannot bypass the daily ceiling", async () => {
  const harness = sponsorHarness({ failConfirmation: true, budgets: { SPONSOR_PER_DAY: "1" } });
  assert.equal((await harness.POST(harness.next(3))).status, 503);
  const blocked = await harness.POST(harness.next(4));
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /budget is used up/);
  assert.equal(harness.sends, 1);
  harness.advance(24 * 60 * 60_000);
  assert.equal((await harness.POST(harness.next(4))).status, 503, "expired daily attempts release the next reservation");
  assert.equal(harness.sends, 2);
});

test("per-IP and per-minute limits are checked inside the shared signer queue", async () => {
  const ip = sponsorHarness({ budgets: { SPONSOR_PER_IP_PER_HOUR: "1", SPONSOR_PER_MINUTE: "100" } });
  assert.equal((await ip.POST(ip.next(3, { "x-forwarded-for": "192.0.2.1" }))).status, 200);
  assert.equal((await ip.POST(ip.next(4, { "x-forwarded-for": "192.0.2.1" }))).status, 429);
  assert.equal((await ip.POST(ip.next(4, { "x-forwarded-for": "192.0.2.2" }))).status, 200);
  const minute = sponsorHarness({ budgets: { SPONSOR_PER_IP_PER_HOUR: "100", SPONSOR_PER_MINUTE: "1" } });
  const [first, second] = await Promise.all([minute.POST(minute.next(3)), minute.POST(minute.next(4))]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(minute.sends, 2, "only one gas-plus-USD attempt was sent");
  minute.advance(60_000);
  assert.equal((await minute.POST(minute.next(4))).status, 200);
});

test("invalid budgets fail closed and a zero quota disables funding", async () => {
  for (const value of ["NaN", "-1", "1.5", "Infinity", "9007199254740992"]) {
    const harness = sponsorHarness({ budgets: { SPONSOR_PER_DAY: value } });
    assert.equal((await harness.POST(harness.request())).status, 503);
    assert.equal(harness.sends, 0);
  }
  const disabled = sponsorHarness({ budgets: { SPONSOR_PER_DAY: "0" } });
  assert.equal((await disabled.POST(disabled.request())).status, 429);
  assert.equal(disabled.sends, 0);
});

test("funding requires the exact browser origin even with a signed account proof", async () => {
  const harness = sponsorHarness();
  for (const origin of ["", "https://elsewhere.example", "http://kleos.example"]) {
    assert.equal((await harness.POST(harness.request(harness.body, { origin }))).status, 403);
  }
  assert.equal(harness.sends, 0);
});

test("the merged gas floor tops up low gas and leaves funded accounts unchanged", async () => {
  const low = sponsorHarness({ gasBalance: viem.parseEther("0.05"), usdBalance: viem.parseUnits("100", 6) });
  assert.equal((await low.POST(low.request())).status, 200);
  assert.equal(low.sends, 1);
  assert.equal(low.confirmations[0].value, viem.parseEther("0.3"));
  const funded = sponsorHarness({ gasBalance: viem.parseEther("0.06"), usdBalance: viem.parseUnits("50", 6), budgets: { SPONSOR_PER_DAY: "0" } });
  assert.deepEqual((await (await funded.POST(funded.request())).json()).funded, { gas: false, usd: false });
  assert.equal(funded.sends, 0, "a balance check does not consume a funding reservation");
});

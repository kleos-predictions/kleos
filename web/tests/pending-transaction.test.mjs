import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../src/", import.meta.url);
function load(file, stubs = {}, globals = {}) {
  const source = readFileSync(new URL(file, root), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const runtimeModule = { exports: {} };
  runInNewContext(output, { exports: runtimeModule.exports, module: runtimeModule, require: (name) => name in stubs ? stubs[name] : require(name), ...globals }, { filename: file });
  return runtimeModule.exports;
}
const transactions = load("lib/transactions.ts");
const pendingRecords = load("lib/pending-transactions.ts");
const hash = "0x" + "11".repeat(32);
const newHash = "0x" + "22".repeat(32);
const intent = { sender: "0x" + "a".repeat(40), to: "0x" + "b".repeat(40), data: "0x1234" };

/** Executes the production hook with inert React hooks, storage and receipt reads. No signer exists. */
function harness(storage, client, blockedStorage = false) {
  let cursor = 0;
  const hooks = [];
  const memo = (factory, deps) => {
    const index = cursor++;
    const previous = hooks[index];
    if (!previous || previous.deps.length !== deps.length || !deps.every((value, i) => Object.is(value, previous.deps[i]))) hooks[index] = { value: factory(), deps };
    return hooks[index].value;
  };
  const react = {
    useCallback: (callback, deps) => memo(() => callback, deps),
    useMemo: memo,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: (initial) => {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: initial };
      return [hooks[index].value, (next) => { hooks[index].value = next; }];
    },
  };
  const { usePendingTransaction } = load("components/pending-transaction.tsx", {
    react, "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "@/lib/chain": { chain: { id: 10143 }, publicClient: client, txUrl: (value) => value },
    "@/lib/transactions": transactions,
    "@/lib/pending-transactions": pendingRecords,
  }, {
    localStorage: {
      getItem: (key) => { if (blockedStorage) throw new Error("Storage blocked"); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (blockedStorage) throw new Error("Storage blocked"); storage.set(key, value); },
      removeItem: (key) => { if (blockedStorage) throw new Error("Storage blocked"); storage.delete(key); },
    },
    window: { addEventListener() {}, removeEventListener() {} },
  });
  function useHarnessRender(scope = "test") { cursor = 0; return usePendingTransaction(scope); }
  return { render: useHarnessRender };
}

test("an uncertain action survives reload and must reconcile its original hash before completion", async () => {
  const storage = new Map();
  let waiting = 0;
  let available = false;
  const client = {
    waitForTransactionReceipt: async () => { waiting++; if (!available) throw new Error("RPC timeout"); return { status: "success", transactionHash: hash, logs: [] }; },
    getTransaction: async () => ({ from: intent.sender, to: intent.to, input: intent.data, value: 0n }),
  };
  const first = harness(storage, client);
  await assert.rejects(first.render().confirm(hash, intent), /could not be confirmed/);
  assert.equal(first.render().pending.hash, hash);
  const reloaded = harness(storage, client);
  assert.equal(reloaded.render().hasPending(), true);
  await assert.rejects(reloaded.render().confirm(newHash, intent), /Check the pending/);
  assert.equal(waiting, 1, "blocked resubmission does not even start another receipt wait");
  available = true;
  const result = await reloaded.render().check();
  assert.equal(result.receipt.transactionHash, hash);
  assert.equal(result.intent.sender, intent.sender);
  assert.equal(reloaded.render().hasPending(), true, "the caller still validates its event before completing");
  reloaded.render().complete();
  assert.equal(reloaded.render().pending, null);
  assert.equal(storage.size, 0);
});

test("definitive reverted receipts clear the lock while RPC read failures preserve it", async () => {
  const storage = new Map();
  let status = "success";
  let unavailable = true;
  const client = {
    waitForTransactionReceipt: async () => ({ status, transactionHash: hash, logs: [] }),
    getTransaction: async () => { if (unavailable) throw new Error("RPC read failed"); return { from: intent.sender, to: intent.to, input: intent.data, value: 0n }; },
  };
  const instance = harness(storage, client);
  await assert.rejects(instance.render().confirm(hash, intent), /could not be confirmed/);
  assert.equal(instance.render().hasPending(), true);
  status = "reverted";
  await assert.rejects(instance.render().check(), /reverted/);
  assert.equal(instance.render().hasPending(), false);
  unavailable = false;
  status = "success";
  await instance.render().confirm(newHash, intent);
  assert.equal(instance.render().hasPending(), true);
});

test("blocked persistence retains a pending hash in the current page's memory", async () => {
  const instance = harness(new Map(), { waitForTransactionReceipt: async () => { throw new Error("Timeout"); }, getTransaction: async () => { throw new Error("Unused"); } }, true);
  await assert.rejects(instance.render().confirm(hash, intent), /could not be confirmed/);
  assert.equal(instance.render().pending.hash, hash);
  assert.equal(instance.render().hasPending(), true);
});

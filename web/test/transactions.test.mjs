import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { confirmTransaction, receiptEvent, settlementBatches, TransactionUncertainError, TransactionRejectedError } from "../src/lib/transactions.ts";
import { parsePendingTransaction, serializePendingTransaction } from "../src/lib/pending-transactions.ts";
import { kleosAbi } from "../src/lib/abi.ts";

const sender = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222";
const wrong = "0x3333333333333333333333333333333333333333";
const hash = `0x${"a".repeat(64)}`;
const repricedHash = `0x${"b".repeat(64)}`;
const intent = { sender, to: contract, data: "0x1234" };
const transaction = { from: sender, to: contract, input: "0x1234", value: 0n };
function mock({ status = "success", replacement, tx = transaction } = {}) {
  return {
    async waitForTransactionReceipt({ onReplaced }) {
      if (replacement) onReplaced({ reason: replacement });
      return { status, transactionHash: replacement ? repricedHash : hash, logs: [] };
    },
    async getTransaction() { return tx; },
  };
}

test("a mined revert is rejected before it can become a success receipt", async () => {
  await assert.rejects(confirmTransaction(mock({ status: "reverted" }), hash, intent), /reverted/);
});
test("repricing preserves the intent and returns the final transaction hash", async () => {
  assert.equal((await confirmTransaction(mock({ replacement: "repriced" }), hash, intent)).transactionHash, repricedHash);
});
test("cancellation and a different replacement never confirm the old action", async () => {
  for (const replacement of ["cancelled", "replaced"]) await assert.rejects(confirmTransaction(mock({ replacement }), hash, intent), /cancelled|replaced/);
});
test("successful execution still must match sender, destination, calldata and value", async () => {
  for (const tx of [{ ...transaction, from: wrong }, { ...transaction, to: wrong }, { ...transaction, input: "0xbeef" }, { ...transaction, value: 1n }]) {
    await assert.rejects(confirmTransaction(mock({ tx }), hash, intent), /does not match/);
  }
  await confirmTransaction(mock({ tx: { ...transaction, value: 10n } }), hash, { ...intent, value: 10n });
});

test("a timeout retains the submitted hash and intent for explicit reconciliation", async () => {
  const client = { ...mock(), waitForTransactionReceipt: async () => { throw new Error("Timeout"); } };
  await assert.rejects(confirmTransaction(client, hash, intent), (error) => error instanceof TransactionUncertainError && error.hash === hash && error.intent === intent);
});
test("a confirmed receipt with unavailable transaction data remains uncertain", async () => {
  const client = { ...mock({ replacement: "repriced" }), getTransaction: async () => { throw new Error("RPC unavailable"); } };
  await assert.rejects(confirmTransaction(client, hash, intent), (error) => error instanceof TransactionUncertainError && error.hash === repricedHash);
  await assert.rejects(confirmTransaction(mock({ status: "reverted" }), hash, intent), (error) => error instanceof TransactionRejectedError);
});
test("public pending records preserve exact values and reject malformed persistence", () => {
  const pending = { hash, intent: { ...intent, value: 123_456_789_123_456_789n } };
  assert.deepEqual(parsePendingTransaction(serializePendingTransaction(pending)), pending);
  for (const raw of ["not JSON", JSON.stringify({ hash, intent: { ...intent, value: "-1" } }), JSON.stringify({ hash: "0x1234", intent: { ...intent, value: "0" } })]) assert.equal(parsePendingTransaction(raw), null);
  assert.equal(serializePendingTransaction(pending).includes("privateKey"), false);
});

function log(eventName, indexed, values, address = contract) {
  const event = kleosAbi.find((entry) => entry.type === "event" && entry.name === eventName);
  return { address, topics: encodeEventTopics({ abi: kleosAbi, eventName, args: indexed }), data: encodeAbiParameters(event.inputs.filter((i) => !i.indexed), values) };
}
test("MarketCreated ID comes from the creator's exact event, not a global counter", () => {
  const logs = [log("MarketCreated", { marketId: 7n, creator: sender }, ["Will it happen?", 1, "Official source", "YES if observed", 1_800_000_000n])];
  assert.equal(receiptEvent({ logs }, contract, kleosAbi, "MarketCreated", (a) => a.creator.toLowerCase() === sender).marketId, 7n);
  assert.throws(() => receiptEvent({ logs }, wrong, kleosAbi, "MarketCreated", () => true), /could not be verified/);
});
test("BetPlaced uses applied weight and checks the intended market, sender, side and amount", () => {
  const bet = log("BetPlaced", { marketId: 1n, user: sender }, [true, 50_000_000n, 50_000_000n, 5_000_000_000_000_000_000n, 500_000_000_000_000_000n, 550_000_000_000_000_000n, 510_000_000_000_000_000n]);
  const matches = (a) => a.marketId === 1n && a.user.toLowerCase() === sender && a.side === true && a.amount === 50_000_000n;
  assert.equal(receiptEvent({ logs: [bet] }, contract, kleosAbi, "BetPlaced", matches).effective, 50_000_000n);
  assert.throws(() => receiptEvent({ logs: [bet, bet] }, contract, kleosAbi, "BetPlaced", matches), /could not be verified/);
  assert.throws(() => receiptEvent({ logs: [bet] }, contract, kleosAbi, "BetPlaced", (a) => matches(a) && a.marketId === 2n), /could not be verified/);
});
test("settlement still executes once for a zero-bettor market", () => {
  assert.deepEqual(settlementBatches([]), [[]]);
  assert.deepEqual(settlementBatches(Array.from({ length: 201 }, (_, i) => i)).map((b) => b.length), [100, 100, 1]);
});
test("failed settlement batches stop later submissions", async () => {
  const submitted = [];
  await assert.rejects((async () => {
    for (const batch of settlementBatches([1, 2, 3], 1)) {
      submitted.push(batch[0]);
      await confirmTransaction(mock({ status: batch[0] === 2 ? "reverted" : "success" }), hash, intent);
    }
  })(), /reverted/);
  assert.deepEqual(submitted, [1, 2]);
});

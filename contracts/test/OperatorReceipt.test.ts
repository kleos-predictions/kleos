import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Address, Hex, Transaction, TransactionReceipt, WaitForTransactionReceiptParameters } from "viem";
import { atomicEnvValue, configureOperatorSponsor, confirmOperatorTransaction, OperatorRejectedError, OperatorUncertainError, sendAndConfirmOperatorTransaction, type OperatorIntent, type OperatorReceiptClient } from "../scripts/operator-receipt.ts";

const OWNER = `0x${"1".repeat(40)}` as Address;
const TOKEN = `0x${"2".repeat(40)}` as Address;
const SPONSOR = `0x${"3".repeat(40)}` as Address;
const OTHER = `0x${"4".repeat(40)}` as Address;
const HASH = `0x${"1".repeat(64)}` as Hex;
const REPLACEMENT = `0x${"2".repeat(64)}` as Hex;
const DATA = "0x1234" as Hex;
const intent: OperatorIntent = { sender: OWNER, to: TOKEN, data: DATA, value: 7n };
const original = { hash: HASH, from: OWNER, to: TOKEN, input: DATA, value: 7n, nonce: 10 };
const receipt = (hash = HASH, status: "success" | "reverted" = "success") => ({ transactionHash: hash, status, blockNumber: 12n }) as TransactionReceipt;

function replacementEvent(reason: "cancelled" | "replaced" | "repriced", tx: Awaited<ReturnType<OperatorReceiptClient["getTransaction"]>> = { ...original, hash: REPLACEMENT }) {
  return { reason, replacedTransaction: original as Transaction, transaction: tx as Transaction, transactionReceipt: receipt(REPLACEMENT) };
}

function temporaryTest(run: (directory: string) => void | Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "kleos-operator-test-"));
    try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
  };
}

describe("operator receipt intent", () => {
  it("checks original and final transactions before accepting a successful receipt", async () => {
    const reads: Hex[] = [];
    const client: OperatorReceiptClient = {
      getTransaction: async ({ hash }) => { reads.push(hash); return original; },
      waitForTransactionReceipt: async (args) => { assert.equal(args.checkReplacement, true); assert.equal(args.timeout, 120_000); return receipt(); },
    };
    assert.equal((await confirmOperatorTransaction(client, HASH, intent)).status, "success");
    assert.deepEqual(reads, [HASH, HASH]);
  });

  it("rejects a mined revert", async () => {
    await assert.rejects(confirmOperatorTransaction({ getTransaction: async () => original, waitForTransactionReceipt: async () => receipt(HASH, "reverted") }, HASH, intent), (error) => error instanceof OperatorRejectedError && /reverted/.test(error.message));
  });

  it("rejects cancellations and different replacements even if their receipt succeeds", async () => {
    for (const reason of ["cancelled", "replaced"] as const) {
      const client: OperatorReceiptClient = {
        getTransaction: async () => original,
        waitForTransactionReceipt: async (args) => { args.onReplaced?.(replacementEvent(reason)); return receipt(REPLACEMENT); },
      };
      await assert.rejects(confirmOperatorTransaction(client, HASH, intent), (error) => error instanceof OperatorRejectedError && error.message.includes(reason));
    }
  });

  it("accepts a repricing only when the same sender, nonce, destination, data and value survive", async () => {
    const client: OperatorReceiptClient = {
      getTransaction: async ({ hash }) => ({ ...original, hash }),
      waitForTransactionReceipt: async (args) => { args.onReplaced?.(replacementEvent("repriced")); return receipt(REPLACEMENT); },
    };
    assert.equal((await confirmOperatorTransaction(client, HASH, intent)).transactionHash, REPLACEMENT);
  });

  it("rejects every changed original intent field before waiting for a receipt", async () => {
    for (const changed of [{ hash: REPLACEMENT }, { from: OTHER }, { to: OTHER }, { to: null }, { input: "0xabcd" as Hex }, { value: 8n }]) {
      let waits = 0;
      await assert.rejects(confirmOperatorTransaction({ getTransaction: async () => ({ ...original, ...changed }), waitForTransactionReceipt: async () => { waits++; return receipt(); } }, HASH, intent), OperatorRejectedError);
      assert.equal(waits, 0);
    }
  });

  it("rejects every changed final intent field, including a purported repricing with a new nonce", async () => {
    for (const changed of [{ hash: HASH }, { from: OTHER }, { to: OTHER }, { to: null }, { input: "0xabcd" as Hex }, { value: 8n }, { nonce: 11 }]) {
      const final = { ...original, hash: REPLACEMENT, ...changed };
      const client: OperatorReceiptClient = {
        getTransaction: async ({ hash }) => hash === HASH ? original : final,
        waitForTransactionReceipt: async (args) => { args.onReplaced?.(replacementEvent("repriced", final)); return receipt(REPLACEMENT); },
      };
      await assert.rejects(confirmOperatorTransaction(client, HASH, intent), OperatorRejectedError);
    }
  });

  it("keeps cancellation rejection when a later callback reports repricing", async () => {
    const client: OperatorReceiptClient = {
      getTransaction: async ({ hash }) => ({ ...original, hash }),
      waitForTransactionReceipt: async (args) => { args.onReplaced?.(replacementEvent("cancelled")); args.onReplaced?.(replacementEvent("repriced")); return receipt(REPLACEMENT); },
    };
    await assert.rejects(confirmOperatorTransaction(client, HASH, intent), /cancelled/);
  });

  it("preserves the submitted public hash and intent on receipt timeout", async () => {
    await assert.rejects(confirmOperatorTransaction({ getTransaction: async () => original, waitForTransactionReceipt: async () => { throw new Error("timeout"); } }, HASH, intent), (error) => {
      assert.ok(error instanceof OperatorUncertainError);
      assert.deepEqual(error.hashes, [HASH]);
      assert.deepEqual(error.intent, intent);
      return true;
    });
  });

  it("preserves both hashes if repricing is known but final readback fails", async () => {
    const client: OperatorReceiptClient = {
      getTransaction: async ({ hash }) => { if (hash === REPLACEMENT) throw new Error("RPC lost"); return original; },
      waitForTransactionReceipt: async (args) => { args.onReplaced?.(replacementEvent("repriced")); return receipt(REPLACEMENT); },
    };
    await assert.rejects(confirmOperatorTransaction(client, HASH, intent), (error) => error instanceof OperatorUncertainError && error.hashes.length === 2 && error.hashes[1] === REPLACEMENT);
  });

  it("treats missing original readback as uncertain and never broadcasts a retry", async () => {
    let sends = 0;
    await assert.rejects(sendAndConfirmOperatorTransaction({ getTransaction: async () => { throw new Error("not found yet"); }, waitForTransactionReceipt: async () => receipt() }, async () => { sends++; return HASH; }, intent), OperatorUncertainError);
    assert.equal(sends, 1);
  });

  it("preserves an unknown broadcast result without retrying or waiting on a guessed hash", async () => {
    let sends = 0;
    let reads = 0;
    await assert.rejects(sendAndConfirmOperatorTransaction({ getTransaction: async () => { reads++; return original; }, waitForTransactionReceipt: async () => receipt() }, async () => { sends++; throw new Error("lost send response"); }, intent), (error) => error instanceof OperatorUncertainError && error.hashes.length === 0 && error.intent === intent);
    assert.equal(sends, 1);
    assert.equal(reads, 0);
  });
});

describe("private atomic operator env update", () => {
  it("replaces duplicate assignments, preserves other lines and fixes existing public permissions", temporaryTest((directory) => {
    const path = join(directory, "synthetic.env");
    writeFileSync(path, "# Synthetic fixture only\nOTHER=value  \nSPONSOR_PRIVATE_KEY=old\nSPONSOR_PRIVATE_KEY=duplicate\n", { mode: 0o644 });
    atomicEnvValue(path, "SPONSOR_PRIVATE_KEY", "FAKE_KEY_NOT_VALID_FOR_SIGNING");
    assert.equal(readFileSync(path, "utf8"), "# Synthetic fixture only\nOTHER=value  \nSPONSOR_PRIVATE_KEY=FAKE_KEY_NOT_VALID_FOR_SIGNING\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(directory), ["synthetic.env"]);
  }));

  it("refuses symlink destinations without changing their target", temporaryTest((directory) => {
    const target = join(directory, "target.txt");
    const link = join(directory, "synthetic.env");
    writeFileSync(target, "unchanged");
    symlinkSync(target, link);
    assert.throws(() => atomicEnvValue(link, "SPONSOR_PRIVATE_KEY", "FAKE_KEY"), /symbolic-link/);
    assert.equal(readFileSync(target, "utf8"), "unchanged");
    rmSync(target);
    assert.throws(() => atomicEnvValue(link, "SPONSOR_PRIVATE_KEY", "FAKE_KEY"), /symbolic-link/);
    assert.equal(existsSync(target), false);
  }));

  it("rejects env injection before modifying an existing file", temporaryTest((directory) => {
    const path = join(directory, "synthetic.env");
    writeFileSync(path, "unchanged");
    assert.throws(() => atomicEnvValue(path, "SPONSOR_PRIVATE_KEY", "fake\nSECOND=value"), /Invalid/);
    assert.throws(() => atomicEnvValue(path, "BAD=NAME", "fake"), /Invalid/);
    assert.equal(readFileSync(path, "utf8"), "unchanged");
    assert.deepEqual(readdirSync(directory), ["synthetic.env"]);
  }));
});

function sponsorHarness(directory: string, failure?: "set-reverted" | "fund-reverted" | "fund-timeout" | "fund-broadcast" | "wrong-sponsor" | "low-balance") {
  const custody = join(directory, "custody.fixture");
  const web = join(directory, "web.fixture");
  const events: string[] = [];
  let current = OTHER;
  let balance = 0n;
  const client = {
    getBalance: async () => { events.push("balance"); return failure === "low-balance" && balance > 0n ? 19n : balance; },
    getTransaction: async ({ hash }: { hash: Hex }) => hash === HASH
      ? { ...original, value: 0n }
      : { ...original, hash: REPLACEMENT, to: SPONSOR, input: "0x" as Hex, value: 20n, nonce: 11 },
    waitForTransactionReceipt: async ({ hash }: WaitForTransactionReceiptParameters) => {
      events.push(`confirm:${hash === HASH ? "set" : "fund"}`);
      if (hash === HASH && failure === "set-reverted") return receipt(hash, "reverted");
      if (hash === REPLACEMENT && failure === "fund-reverted") return receipt(hash, "reverted");
      if (hash === REPLACEMENT && failure === "fund-timeout") throw new Error("timeout");
      if (hash === HASH) current = failure === "wrong-sponsor" ? OTHER : SPONSOR;
      else balance = 20n;
      return receipt(hash);
    },
  };
  const options = {
    owner: OWNER, token: TOKEN, sponsor: SPONSOR, funding: 20n, setSponsorData: DATA,
    readSponsor: async () => { events.push("read-sponsor"); return current; },
    setSponsor: async () => { events.push("send:set"); assert.ok(existsSync(custody)); return HASH; },
    fund: async (value: bigint) => { events.push("send:fund"); assert.equal(value, 20n); if (failure === "fund-broadcast") throw new Error("lost send response"); return REPLACEMENT; },
    persistCustody: () => { events.push("custody"); atomicEnvValue(custody, "SPONSOR_PRIVATE_KEY", "FAKE_KEY_NOT_VALID_FOR_SIGNING"); },
    publish: () => { events.push("publish"); atomicEnvValue(web, "SPONSOR_PRIVATE_KEY", "FAKE_KEY_NOT_VALID_FOR_SIGNING"); },
  };
  return { client, options, custody, web, events };
}

describe("sponsor custody and publication order", () => {
  it("keeps private custody before broadcasts and publishes only after confirmations and current-state verification", temporaryTest(async (directory) => {
    const harness = sponsorHarness(directory);
    assert.equal(await configureOperatorSponsor(harness.client, harness.options), 20n);
    assert.deepEqual(harness.events, ["custody", "read-sponsor", "send:set", "confirm:set", "balance", "send:fund", "confirm:fund", "read-sponsor", "balance", "publish"]);
    assert.equal(statSync(harness.custody).mode & 0o777, 0o600);
    assert.equal(statSync(harness.web).mode & 0o777, 0o600);
  }));

  it("retains custody but never publishes on a revert, timeout, lost broadcast response or differing final state", temporaryTest(async (directory) => {
    for (const failure of ["set-reverted", "fund-reverted", "fund-timeout", "fund-broadcast", "wrong-sponsor", "low-balance"] as const) {
      const harness = sponsorHarness(directory, failure);
      await assert.rejects(configureOperatorSponsor(harness.client, harness.options));
      assert.equal(readFileSync(harness.custody, "utf8"), "SPONSOR_PRIVATE_KEY=FAKE_KEY_NOT_VALID_FOR_SIGNING\n");
      assert.equal(statSync(harness.custody).mode & 0o777, 0o600);
      assert.equal(existsSync(harness.web), false);
      assert.equal(harness.events.includes("publish"), false);
    }
  }));

  it("uses existing correct sponsor and sufficient balance without sending another transaction", temporaryTest(async (directory) => {
    const harness = sponsorHarness(directory);
    let sends = 0;
    harness.options.readSponsor = async () => SPONSOR;
    harness.client.getBalance = async () => 20n;
    harness.options.setSponsor = async () => { sends++; return HASH; };
    harness.options.fund = async () => { sends++; return REPLACEMENT; };
    await configureOperatorSponsor(harness.client, harness.options);
    assert.equal(sends, 0);
    assert.ok(existsSync(harness.web));
  }));

  it("stops before onchain work if private custody cannot be saved", temporaryTest(async (directory) => {
    const harness = sponsorHarness(directory);
    harness.options.persistCustody = () => { throw new Error("custody unavailable"); };
    await assert.rejects(configureOperatorSponsor(harness.client, harness.options), /custody unavailable/);
    assert.deepEqual(harness.events, []);
    assert.equal(existsSync(harness.web), false);
  }));
});

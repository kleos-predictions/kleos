import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { type PublicClient } from "viem";
import { DemoJournal, acquireJournalLock, boundedInteger, contextId, selectDemoJurors, type Receipt } from "../scripts/demo-journal.ts";
import { demoCloseTimes } from "../scripts/demo-markets.ts";
import { demoDeployment } from "../scripts/demo-deployment.ts";
import { resumeDemoResolution, type DemoResolutionMarket } from "../scripts/demo-lifecycle.ts";

const HASH = `0x${"1".repeat(64)}` as const;
const BLOCK = `0x${"2".repeat(64)}`;
const receipt = (status = "success"): Receipt => ({ status, transactionHash: HASH, blockHash: BLOCK, blockNumber: 12n });
const context = { chainId: 31337, address: "0xdemo", deploymentBlock: BLOCK };

function temporaryTest(run: (path: string) => void | Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "kleos-demo-journal-"));
    try { await run(join(directory, "operations.json")); } finally { rmSync(directory, { recursive: true, force: true }); }
  };
}

describe("demo operation journal", () => {
  it("replays a confirmed receipt without sending a second mint or bet", temporaryTest(async (path) => {
    let sends = 0;
    const send = async () => { sends++; return HASH; };
    await new DemoJournal(path, context).run("mint", send, async () => receipt());
    await new DemoJournal(path, context).run("mint", send, async () => receipt());
    assert.equal(sends, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }));
  it("resumes a broadcast transaction after the receipt waiter times out", temporaryTest(async (path) => {
    let sends = 0;
    const send = async () => { sends++; return HASH; };
    await assert.rejects(new DemoJournal(path, context).run("bet", send, async () => { throw new Error("timeout"); }), /timeout/);
    await new DemoJournal(path, context).run("bet", send, async () => receipt());
    assert.equal(sends, 1);
  }));
  it("does not record a reverted close as successful and retries it", temporaryTest(async (path) => {
    let sends = 0;
    const send = async () => { sends++; return HASH; };
    await assert.rejects(new DemoJournal(path, context).run("close", send, async () => receipt("reverted")), /reverted/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).operations.close.phase, "reverted");
    await new DemoJournal(path, context).run("close", send, async () => receipt());
    assert.equal(sends, 2);
  }));
  it("fails closed when a crash or sender error leaves the broadcast result unknown", temporaryTest(async (path) => {
    await assert.rejects(new DemoJournal(path, context).run("create", async () => { throw new Error("connection lost"); }, async () => receipt()), /connection lost/);
    let sends = 0;
    await assert.rejects(new DemoJournal(path, context).run("create", async () => { sends++; return HASH; }, async () => receipt()), /unknown broadcast/);
    assert.equal(sends, 0);
  }));
  it("rejects a replacement receipt before reporting the original operation successful", temporaryTest(async (path) => {
    await assert.rejects(new DemoJournal(path, context).run("mint", async () => HASH, async () => ({ ...receipt(), transactionHash: `0x${"3".repeat(64)}` })), /replaced/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).operations.mint.phase, "pending");
  }));
  it("rejects a changed deployment and a confirmed transaction moved by a reorg", temporaryTest(async (path) => {
    await new DemoJournal(path, context).run("mint", async () => HASH, async () => receipt());
    assert.throws(() => new DemoJournal(path, { ...context, deploymentBlock: "different" }), /different deployment/);
    await assert.rejects(new DemoJournal(path, context).run("mint", async () => HASH, async () => ({ ...receipt(), blockHash: "different" })), /reorg/);
  }));
  it("persists the original vote and salt across restarts, independent of a changed vote mode", temporaryTest(async (path) => {
    const saved = { vote: 2, salt: `0x${"4".repeat(64)}`, commitment: HASH };
    new DemoJournal(path, context).setValue("7:1:juror", saved);
    assert.deepEqual(new DemoJournal(path, context).value("7:1:juror"), saved);
  }));
  it("prevents two live operators from sharing a journal", temporaryTest((path) => {
    const release = acquireJournalLock(path);
    assert.throws(() => acquireJournalLock(path), /Another process/);
    release();
    acquireJournalLock(path)();
  }));
  it("rejects overlapping execution of one operation", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    let resolveSend!: (hash: typeof HASH) => void;
    const send = new Promise<typeof HASH>((resolve) => { resolveSend = resolve; });
    const first = journal.run("mint", () => send, async () => receipt());
    await assert.rejects(journal.run("mint", async () => HASH, async () => receipt()), /already running/);
    resolveSend(HASH);
    await first;
  }));
  it("recovers a known hash after an actual operator process exits before its receipt arrives", temporaryTest(async (path) => {
    const helper = new URL("../scripts/demo-journal.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DemoJournal } from ${JSON.stringify(helper)};
      const journal = new DemoJournal(${JSON.stringify(path)}, ${JSON.stringify(context)});
      await journal.run("mint", async () => ${JSON.stringify(HASH)}, async () => process.exit(23));
    `]);
    assert.equal(child.status, 23, child.stderr.toString());
    let sends = 0;
    await new DemoJournal(path, context).run("mint", async () => { sends++; return HASH; }, async () => receipt());
    assert.equal(sends, 0, "the restarted operator must wait for the existing hash");
  }));
  it("preserves uncertain intent after an actual process exits inside the broadcast call", temporaryTest(async (path) => {
    const helper = new URL("../scripts/demo-journal.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DemoJournal } from ${JSON.stringify(helper)};
      await new DemoJournal(${JSON.stringify(path)}, ${JSON.stringify(context)}).run("bet", async () => process.exit(24), async () => process.exit(25));
    `]);
    assert.equal(child.status, 24, child.stderr.toString());
    await assert.rejects(new DemoJournal(path, context).run("bet", async () => HASH, async () => receipt()), /unknown broadcast/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).operations.bet.phase, "started");
  }));
  it("does not remove a lock whose ownership changed", temporaryTest((path) => {
    const release = acquireJournalLock(path);
    writeFileSync(`${path}.lock`, "different owner");
    release();
    assert.equal(readFileSync(`${path}.lock`, "utf8"), "different owner");
  }));
  it("blocks a different operation on the uncertain sender while allowing unrelated court senders", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("juror-A:commit", async () => { throw new Error("lost response"); }, async () => receipt(), "0xA"), /lost response/);
    let sends = 0;
    const send = async () => { sends++; return HASH; };
    await assert.rejects(journal.run("juror-A:other-market", send, async () => receipt(), "0xa"), /unknown broadcast/);
    assert.equal(sends, 0);
    await journal.run("juror-B:commit", send, async () => receipt(), "0xB");
    assert.equal(sends, 1);
  }));
  it("reconciles a pending sender hash before a later operation can broadcast", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("first", async () => HASH, async () => { throw new Error("timeout"); }, "0xA"), /timeout/);
    let sends = 0;
    await assert.rejects(journal.run("second", async () => { sends++; return HASH; }, async () => { throw new Error("still pending"); }, "0xA"), /still pending/);
    assert.equal(sends, 0);
    await journal.run("second", async () => {
      assert.equal(JSON.parse(readFileSync(path, "utf8")).operations.first.phase, "confirmed");
      sends++;
      return HASH;
    }, async () => receipt(), "0xA");
    assert.equal(sends, 1);
  }));
  it("blocks later sender work when reconciliation returns a replacement receipt", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("first", async () => HASH, async () => { throw new Error("timeout"); }, "0xA"));
    let sends = 0;
    await assert.rejects(journal.run("second", async () => { sends++; return HASH; }, async () => ({ ...receipt(), transactionHash: `0x${"3".repeat(64)}` }), "0xA"), /replaced/);
    assert.equal(sends, 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).operations.first.phase, "pending");
  }));
  it("conservatively blocks all new senders for an unresolved legacy operation without sender metadata", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("legacy", async () => { throw new Error("lost response"); }, async () => receipt()));
    let sends = 0;
    await assert.rejects(journal.run("new-sender", async () => { sends++; return HASH; }, async () => receipt(), "0xB"), /unknown broadcast/);
    assert.equal(sends, 0);
  }));
  it("rejects concurrent different operations from one sender and a changed replay sender", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    let resolveSend!: (hash: typeof HASH) => void;
    const pending = new Promise<typeof HASH>((resolve) => { resolveSend = resolve; });
    const first = journal.run("first", () => pending, async () => receipt(), "0xA");
    await assert.rejects(journal.run("second", async () => HASH, async () => receipt(), "0xa"), /Sender.*already/);
    resolveSend(HASH);
    await first;
    await assert.rejects(journal.run("first", async () => HASH, async () => receipt(), "0xB"), /another sender/);
  }));
});

describe("demo resolution orchestration", () => {
  const expected = { proposer: "0xA", outcome: true, evidenceHash: HASH, evidenceURI: "https://demo.invalid" };
  const fixture = (state = 0): DemoResolutionMarket => ({ state, closeTime: 100n, proposedAt: 100n, proposer: expected.proposer,
    proposedOutcome: true, evidenceHash: HASH, evidenceURI: expected.evidenceURI, outcome: state === 3, voided: false });
  function actions(journal: DemoJournal, initial: DemoResolutionMarket) {
    let market = initial;
    let sends = 0;
    const wait = async () => receipt();
    return {
      sends: () => sends,
      change: (next: DemoResolutionMarket) => { market = next; },
      callbacks: {
        wait,
        readMarket: async () => market,
        waitUntil: async () => {},
        disputeWindow: async () => 120n,
        propose: () => journal.run("resolved-demo:propose", async () => { sends++; market = fixture(1); return HASH; }, wait, "0xA"),
        finalize: () => journal.run("resolved-demo:finalize", async () => { sends++; market = fixture(3); return HASH; }, wait, "0xOwner"),
      },
    };
  }
  it("executes and replays the actual seed resolution orchestration without another proposal or finalization", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    const operator = actions(journal, fixture());
    await resumeDemoResolution(journal, "resolved-demo", expected, operator.callbacks);
    assert.equal(operator.sends(), 2);
    await resumeDemoResolution(new DemoJournal(path, context), "resolved-demo", expected, operator.callbacks);
    assert.equal(operator.sends(), 2);
  }));
  it("does not finalize an advanced market when the original proposal response was lost", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("resolved-demo:propose", async () => { throw new Error("lost response after proposal lands"); }, async () => receipt(), "0xA"));
    const restarted = new DemoJournal(path, context);
    const operator = actions(restarted, fixture(1));
    await assert.rejects(resumeDemoResolution(restarted, "resolved-demo", expected, operator.callbacks), /unknown broadcast/);
    assert.equal(operator.sends(), 0);
  }));
  it("reconciles the pending proposal hash before finalizing an already proposed market", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("resolved-demo:propose", async () => HASH, async () => { throw new Error("timeout"); }, "0xA"));
    const restarted = new DemoJournal(path, context);
    const operator = actions(restarted, fixture(1));
    await resumeDemoResolution(restarted, "resolved-demo", expected, operator.callbacks);
    assert.equal(operator.sends(), 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).operations["resolved-demo:propose"].phase, "confirmed");
  }));
  it("reconciles a pending finalize even when the market is already resolved", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("resolved-demo:finalize", async () => HASH, async () => { throw new Error("timeout"); }, "0xOwner"));
    const restarted = new DemoJournal(path, context);
    const operator = actions(restarted, fixture(3));
    await resumeDemoResolution(restarted, "resolved-demo", expected, operator.callbacks);
    assert.equal(operator.sends(), 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).operations["resolved-demo:finalize"].phase, "confirmed");
  }));
  it("requires reconciliation of an unknown finalize response even after the market resolves", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    await assert.rejects(journal.run("resolved-demo:finalize", async () => { throw new Error("lost response after finalization lands"); }, async () => receipt(), "0xOwner"));
    const restarted = new DemoJournal(path, context);
    const operator = actions(restarted, fixture(3));
    await assert.rejects(resumeDemoResolution(restarted, "resolved-demo", expected, operator.callbacks), /unknown broadcast/);
    assert.equal(operator.sends(), 0);
  }));
  it("rejects a foreign proposer, changed outcome or changed evidence before finalizing", temporaryTest(async (path) => {
    for (const changed of [{ proposer: "0xB" }, { proposedOutcome: false }, { evidenceHash: `0x${"3".repeat(64)}` }, { evidenceURI: "https://changed.invalid" }]) {
      const journal = new DemoJournal(path, context);
      const operator = actions(journal, { ...fixture(1), ...changed });
      await assert.rejects(resumeDemoResolution(journal, "resolved-demo", expected, operator.callbacks), /proposal differs/);
      assert.equal(operator.sends(), 0);
    }
  }));
  it("rechecks a dispute that arrives while waiting for the finalize deadline", temporaryTest(async (path) => {
    const journal = new DemoJournal(path, context);
    const operator = actions(journal, fixture(1));
    operator.callbacks.waitUntil = async () => { operator.change(fixture(2)); };
    await assert.rejects(resumeDemoResolution(journal, "resolved-demo", expected, operator.callbacks), /was disputed/);
    assert.equal(operator.sends(), 0);
  }));
  it("rejects a voided or differing terminal outcome instead of declaring the resolved fixture successful", temporaryTest(async (path) => {
    for (const changed of [{ outcome: false }, { voided: true }]) {
      const journal = new DemoJournal(path, context);
      const operator = actions(journal, { ...fixture(3), ...changed });
      await assert.rejects(resumeDemoResolution(journal, "resolved-demo", expected, operator.callbacks), /outcome differs/);
      assert.equal(operator.sends(), 0);
    }
  }));
});

describe("demo scheduling and jury selection", () => {
  it("keeps demo deadlines future-dated even after the old fixed dates", () => {
    const base = BigInt(Date.UTC(2030, 0, 1) / 1000);
    assert.ok(demoCloseTimes(base).every((timestamp) => timestamp > base));
    assert.deepEqual(demoCloseTimes(base), demoCloseTimes(base));
    assert.throws(() => demoCloseTimes(0n), /positive/);
  });
  it("keeps all three demo jurors on a three-seat jury", () => {
    const jury = ["0xA", "0xB", "0xC"] as const;
    assert.deepEqual(selectDemoJurors(jury, new Set(["0xa", "0xb", "0xc"])), jury);
    assert.deepEqual(selectDemoJurors(["0xA", "0xOutside"], new Set(["0xa"])), ["0xA"]);
  });
  it("bounds operator budgets instead of accepting NaN, zero or unbounded values", () => {
    assert.equal(boundedInteger(undefined, 25, 100, "limit"), 25);
    for (const value of ["NaN", "0", "101", "1.5", "-1"]) assert.throws(() => boundedInteger(value, 25, 100, "limit"));
    assert.notEqual(contextId({ deploymentBlock: "A" }), contextId({ deploymentBlock: "B" }));
  });
});

describe("demo deployment identity", () => {
  function deploymentFixture(path: string, overrides: { code?: string; status?: string; blockHash?: string } = {}) {
    const folder = dirname(path);
    const names = ["Kleos", "KleosUSD", "KleosSocial"];
    const deployed = Object.fromEntries(names.map((name, i) => [`KleosModule#${name}`, `0x${String(i + 1).repeat(40)}`]));
    const records = names.map((name, i) => ({ type: "TRANSACTION_CONFIRM", futureId: `KleosModule#${name}`, hash: `0x${String(i + 1).repeat(64)}`, receipt: { blockHash: BLOCK } }));
    writeFileSync(join(folder, "deployed_addresses.json"), JSON.stringify(deployed));
    writeFileSync(join(folder, "journal.jsonl"), records.map((record) => JSON.stringify(record)).join("\n"));
    const client = {
      getBytecode: async () => overrides.code ?? "0x1234",
      getTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: overrides.status ?? "success", blockHash: overrides.blockHash ?? BLOCK, contractAddress: deployed[`KleosModule#${names[Number(hash[2]) - 1]}`] }),
    } as unknown as PublicClient;
    return { folder, client };
  }
  it("binds the journal to all three contract addresses, code hashes and deployment receipts", temporaryTest(async (path) => {
    const { client, folder } = deploymentFixture(path);
    const result = await demoDeployment(client, 31337, folder);
    assert.equal(Object.keys(result.context.contracts).length, 3);
    assert.equal(result.context.chainId, 31337);
    assert.equal(result.context.contracts.Kleos.blockHash, BLOCK);
    assert.match(result.context.contracts.Kleos.codeHash, /^0x[0-9a-f]{64}$/);
  }));
  it("rejects absent runtime code and reverted deployment receipts", temporaryTest(async (path) => {
    for (const overrides of [{ code: "0x" }, { status: "reverted" }]) {
      const { client, folder } = deploymentFixture(path, overrides);
      await assert.rejects(demoDeployment(client, 31337, folder), /does not match this chain/);
    }
  }));
  it("rejects a deployment whose recorded block no longer matches the chain", temporaryTest(async (path) => {
    const { client, folder } = deploymentFixture(path, { blockHash: "different" });
    await assert.rejects(demoDeployment(client, 31337, folder), /does not match this chain/);
  }));
});

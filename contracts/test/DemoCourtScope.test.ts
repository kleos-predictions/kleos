import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { encodeAbiParameters, keccak256, zeroHash, type Address, type Hex } from "viem";
import { DemoJournal, acquireJournalLock, boundedInteger, contextId, selectDemoJurors } from "../scripts/demo-journal.ts";

// Run the actual script and journal with inert RPC/wallet boundaries. Never import Hardhat
// configuration or demo-wallets, which could load operator custody from the environment.
const source = stripTypeScriptTypes(readFileSync(new URL("../scripts/court-bot.ts", import.meta.url), "utf8"))
  .replace(/^import\s[^;]+;\n/gm, "");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
type Action = "commitVote" | "revealVote" | "closeCourt";
type Write = { action: Action; args: unknown[]; account: Address; hash: Hex };

async function withBot(run: (bot: ReturnType<typeof botHarness>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "kleos-court-scope-"));
  try { await run(botHarness(directory)); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function botHarness(directory: string) {
  const writes: Write[] = [];
  const commitments = new Map<string, Hex>();
  const votes = new Map<string, number>();
  const key = (id: unknown, juror: Address) => `${id}:${juror.toLowerCase()}`;
  const salt = `0x${"07".repeat(32)}` as Hex;
  return {
    writes, salt,
    async run({ chainId = 10143, market, mode = "uphold", fail, cycles = 3, startTick = 0 }: {
      chainId?: number; market?: string; mode?: string; fail?: Action; cycles?: number; startTick?: number;
    } = {}) {
      const loaded: string[] = [], logs: string[] = [], errors: string[] = [];
      const marketReads: bigint[] = [];
      const wallets = Array.from({ length: 19 }, (_, i) => ({ account: { address: address(i + 100) } }));
      const jury = wallets.slice(6, 9).map((wallet) => wallet.account.address);
      let tick = startTick;
      const signals = new Map<string, () => void>();
      const write = (action: Action) => async (args: unknown[], options: { account: { address: Address } }) => {
        const hash = `0x${(writes.length + 1).toString(16).padStart(64, "0")}` as Hex;
        writes.push({ action, args, account: options.account.address, hash });
        return hash;
      };
      const kleos = {
        read: {
          marketCount: async () => 3n,
          getMarket: async ([id]: [bigint]) => { marketReads.push(id); return { state: 2, proposedOutcome: true }; },
          getCourt: async () => ({ round: 2, commitEnd: 10n, revealEnd: 20n }),
          getJury: async () => jury,
          commitments: async ([id, , juror]: [bigint, number, Address]) => commitments.get(key(id, juror)) ?? zeroHash,
          votes: async ([id, , juror]: [bigint, number, Address]) => votes.get(key(id, juror)) ?? 0,
          voteCommitment: async () => { throw new Error("Hidden vote and salt were sent to RPC"); },
        },
        write: { commitVote: write("commitVote"), revealVote: write("revealVote"), closeCourt: write("closeCourt") },
      };
      const publicClient = {
        getChainId: async () => chainId,
        getBlock: async () => ({ timestamp: BigInt(tick * 11) }),
        request: async ({ method }: { method: string }) => { assert.equal(chainId, 31337); assert.equal(method, "evm_mine"); },
        waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          const sent = writes.find((w) => w.hash === hash);
          assert.ok(sent);
          const success = sent.action !== fail;
          if (success && sent.action === "commitVote") commitments.set(key(sent.args[0], sent.account), sent.args[1] as Hex);
          if (success && sent.action === "revealVote") votes.set(key(sent.args[0], sent.account), sent.args[1] as number);
          return { status: success ? "success" : "reverted", transactionHash: hash, blockNumber: 1n, blockHash: zeroHash };
        },
      };
      const viem = {
        getPublicClient: async () => publicClient,
        getContractAt: async () => kleos,
        getWalletClients: async () => { loaded.push("operator"); return [{ account: { address: address(1) } }]; },
      };
      let error: unknown;
      try {
        await runInNewContext(`(async () => {\n${source}\n})()`, {
          network: { getOrCreate: async () => ({ viem }) },
          process: { env: { KLEOS_MARKET: market, KLEOS_BOT_VOTE: mode }, once: (signal: string, callback: () => void) => signals.set(signal, callback) },
          DemoJournal: class extends DemoJournal { constructor(path: string, context: unknown) { super(join(directory, basename(path)), context); } },
          acquireJournalLock: (path: string) => acquireJournalLock(join(directory, basename(path))),
          boundedInteger, contextId, selectDemoJurors,
          demoDeployment: async () => ({ deployed: { "KleosModule#Kleos": address(2) }, context: { chainId, address: address(2) } }),
          randomBytes: (size: number) => Buffer.alloc(size, 7),
          encodeAbiParameters, keccak256, zeroHash, Error,
          LOCAL_CHAIN_ID: 31337, ROLES: { jurors: [6, 14] },
          getDemoWallets: async () => { loaded.push("demo"); return wallets; },
          console: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) },
          setTimeout: (resolve: () => void) => { if (++tick >= startTick + cycles) signals.get("SIGTERM")!(); resolve(); },
        });
      } catch (caught) { error = caught; }
      return { loaded, marketReads, logs, errors, error };
    },
  };
}

describe("court bot scope and hidden votes", () => {
  for (const market of [undefined, "", "0", "-1", "1.5", "1e2", "0x2", " 2", "2 ", (2n ** 256n).toString()]) {
    it(`rejects ${market === undefined ? "a missing market" : JSON.stringify(market)} before loading wallets`, () => withBot(async (bot) => {
      const result = await bot.run({ market });
      assert.match(String(result.error), /KLEOS_MARKET/);
      assert.deepEqual(result.loaded, []);
      assert.equal(bot.writes.length, 0);
    }));
  }
  it("rejects a nonexistent target before loading wallets", () => withBot(async (bot) => {
    const result = await bot.run({ market: "4" });
    assert.match(String(result.error), /does not exist/);
    assert.deepEqual(result.loaded, []);
    assert.equal(bot.writes.length, 0);
  }));
  it("only commits, reveals and closes the selected market, retaining all three jurors", () => withBot(async (bot) => {
    const result = await bot.run({ market: "2" });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.marketReads, [2n, 2n, 2n]);
    assert.equal(bot.writes.filter((w) => w.action === "commitVote").length, 3);
    assert.equal(bot.writes.filter((w) => w.action === "revealVote").length, 3);
    assert.equal(bot.writes.filter((w) => w.action === "closeCourt").length, 1);
    assert.ok(bot.writes.every((w) => w.args[0] === 2n));
  }));
  it("keeps watch-all available on the local chain", () => withBot(async (bot) => {
    const result = await bot.run({ chainId: 31337, cycles: 1 });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.marketReads, [1n, 2n, 3n]);
    assert.deepEqual([...new Set(bot.writes.map((w) => w.args[0]))], [1n, 2n, 3n]);
  }));
  for (const [mode, vote] of [["uphold", 1], ["overturn", 2], ["ambiguous", 3]] as const) {
    it(`keeps ${mode} votes off RPC and matches Solidity abi.encode commitments`, () => withBot(async (bot) => {
      const result = await bot.run({ market: "2", mode });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.errors, []);
      for (const commit of bot.writes.filter((w) => w.action === "commitVote")) {
        const word = (n: number) => n.toString(16).padStart(64, "0");
        const encoded = `0x${word(2)}${word(2)}${commit.account.slice(2).padStart(64, "0")}${word(vote)}${bot.salt.slice(2)}` as Hex;
        assert.equal(commit.args[1], keccak256(encoded));
        const reveal = bot.writes.find((w) => w.action === "revealVote" && w.account === commit.account);
        assert.ok(reveal);
        assert.deepEqual(Array.from(reveal.args), [2n, vote, bot.salt]);
      }
    }));
  }
  it("reveals the journaled vote after a restart with a changed mode", () => withBot(async (bot) => {
    assert.deepEqual((await bot.run({ market: "2", cycles: 1 })).errors, []);
    const resumed = await bot.run({ market: "2", mode: "overturn", startTick: 1, cycles: 2 });
    assert.equal(resumed.error, undefined);
    assert.deepEqual(resumed.errors, []);
    assert.equal(bot.writes.filter((w) => w.action === "commitVote").length, 3);
    const reveals = bot.writes.filter((w) => w.action === "revealVote");
    assert.equal(reveals.length, 3);
    assert.ok(reveals.every((w) => w.args[1] === 1));
  }));
  for (const [fail, successText] of [["commitVote", "committed."], ["revealVote", "revealed."], ["closeCourt", "close confirmed."]] as const) {
    it(`does not report a reverted ${fail} as successful`, () => withBot(async (bot) => {
      const result = await bot.run({ market: "2", fail });
      assert.equal(result.error, undefined);
      assert.ok(result.errors.some((line) => line.includes("reverted")));
      assert.ok(!result.logs.some((line) => line.includes(successText)));
    }));
  }
});

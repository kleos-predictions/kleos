import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";

// Exercise the actual operator script with every external dependency supplied by this harness.
// In particular, never import Hardhat's env-loading config or the real demo-wallet helper.
const source = stripTypeScriptTypes(readFileSync(new URL("../scripts/court-bot.ts", import.meta.url), "utf8"))
  .replace(/^import\s[^;]+;\n/gm, "");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
type Action = "commitVote" | "revealVote" | "closeCourt";
type Write = { action: Action; args: unknown[]; account: Address; hash: Hex };

async function runBot({
  chainId = 10143,
  market,
  mode = "uphold",
  fail,
  cycles = 3,
}: { chainId?: number; market?: string; mode?: string; fail?: Action; cycles?: number } = {}) {
  const loaded: string[] = [];
  const marketReads: bigint[] = [];
  const writes: Write[] = [];
  const logs: string[] = [];
  const wallets = Array.from({ length: 19 }, (_, i) => ({ account: { address: address(i + 100) } }));
  const jury = wallets.slice(6, 11).map((w) => w.account.address);
  const salt = toHex(new Uint8Array(32).fill(7));
  const halt = new Error("Harness finished its polling cycles");
  let tick = 0;
  const owner = { account: { address: address(1) }, sendTransaction: async () => "0x01" };
  const write = (action: Action) => async (args: unknown[], options: { account: { address: Address } }) => {
    const hash = `0x${(writes.length + 1).toString(16).padStart(64, "0")}` as Hex;
    writes.push({ action, args, account: options.account.address, hash });
    return hash;
  };
  const kleos = {
    read: {
      marketCount: async () => 3n,
      getMarket: async ([id]: [bigint]) => {
        marketReads.push(id);
        return { state: 2, proposedOutcome: true };
      },
      getCourt: async () => ({ round: 2, commitEnd: 10, revealEnd: 20 }),
      getJury: async () => jury,
      votes: async () => 0,
      voteCommitment: async () => { throw new Error("Hidden vote and salt were sent to RPC"); },
    },
    write: { commitVote: write("commitVote"), revealVote: write("revealVote"), closeCourt: write("closeCourt") },
  };
  const publicClient = {
    getChainId: async () => chainId,
    getBlock: async () => ({ timestamp: BigInt(tick * 11) }),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const sent = writes.find((w) => w.hash === hash);
      assert.ok(sent);
      return { status: sent.action === fail ? "reverted" : "success" };
    },
  };
  const viem = {
    getPublicClient: async () => publicClient,
    getContractAt: async () => kleos,
    getWalletClients: async () => { loaded.push("owner"); return [owner]; },
  };
  let error: unknown;
  try {
    await runInNewContext(`(async () => {\n${source}\n})()`, {
      network: { getOrCreate: async () => ({ viem }) },
      process: { env: { KLEOS_MARKET: market, KLEOS_BOT_VOTE: mode } },
      readFileSync: (file: string) => {
        assert.equal(file, `ignition/deployments/chain-${chainId}/deployed_addresses.json`);
        return JSON.stringify({ "KleosModule#Kleos": address(2) });
      },
      randomBytes: (size: number) => new Uint8Array(size).fill(7),
      encodeAbiParameters, keccak256, toHex,
      LOCAL_CHAIN_ID: 31337,
      ROLES: { jurors: [6, 14] },
      getDemoWallets: async () => { loaded.push("demo"); return wallets; },
      console: { log: (message: string) => logs.push(message) },
      setTimeout: (resolve: () => void) => {
        if (++tick >= cycles) throw halt;
        resolve();
      },
    });
  } catch (caught) {
    if (caught !== halt) error = caught;
  }
  return { loaded, marketReads, writes, logs, error, salt };
}

describe("court bot testnet scope", () => {
  for (const market of [undefined, "", "0", "-1", "1.5", "1e2", "0x2", " 2", "2 ", (2n ** 256n).toString()]) {
    it(`rejects ${market === undefined ? "a missing market" : JSON.stringify(market)} before loading wallets`, async () => {
      const result = await runBot({ market });
      assert.match(String(result.error), /KLEOS_MARKET/);
      assert.deepEqual(result.loaded, []);
      assert.equal(result.writes.length, 0);
    });
  }

  it("rejects a nonexistent target before loading wallets", async () => {
    const result = await runBot({ market: "4" });
    assert.match(String(result.error), /does not exist/);
    assert.deepEqual(result.loaded, []);
    assert.equal(result.writes.length, 0);
  });

  it("only commits, reveals and closes the selected market when others are disputed", async () => {
    const result = await runBot({ market: "2" });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.marketReads, [2n, 2n, 2n]);
    assert.equal(result.writes.filter((w) => w.action === "commitVote").length, 4);
    assert.equal(result.writes.filter((w) => w.action === "revealVote").length, 4);
    assert.equal(result.writes.filter((w) => w.action === "closeCourt").length, 1);
    assert.ok(result.writes.every((w) => w.args[0] === 2n));
  });

  it("keeps watch-all available on the local chain", async () => {
    const result = await runBot({ chainId: 31337, cycles: 1 });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.marketReads, [1n, 2n, 3n]);
    assert.deepEqual([...new Set(result.writes.map((w) => w.args[0]))], [1n, 2n, 3n]);
  });

  for (const [mode, vote] of [["uphold", 1], ["overturn", 2], ["ambiguous", 3]] as const) {
    it(`keeps ${mode} votes off RPC and matches Solidity abi.encode commitments`, async () => {
      const result = await runBot({ market: "2", mode });
      assert.equal(result.error, undefined);
      for (const commit of result.writes.filter((w) => w.action === "commitVote")) {
        // Solidity ABI words, assembled independently of encodeAbiParameters.
        const word = (n: number) => n.toString(16).padStart(64, "0");
        const encoded = `0x${word(2)}${word(2)}${commit.account.slice(2).padStart(64, "0")}${word(vote)}${result.salt.slice(2)}` as Hex;
        assert.equal(commit.args[1], keccak256(encoded));
        const reveal = result.writes.find((w) => w.action === "revealVote" && w.account === commit.account);
        assert.ok(reveal);
        assert.deepEqual(Array.from(reveal.args), [2n, vote, result.salt]);
      }
    });
  }

  for (const [fail, successText] of [["commitVote", "committed a hidden vote"], ["revealVote", "revealed"], ["closeCourt", "court closed"]] as const) {
    it(`stops on a reverted ${fail} without reporting success`, async () => {
      const result = await runBot({ market: "2", fail });
      assert.match(String(result.error), /did not succeed/);
      assert.equal(result.writes.filter((w) => w.action === fail).length, 1);
      assert.ok(!result.logs.some((line) => line.includes(successText)));
      assert.equal(result.writes.at(-1)?.action, fail);
    });
  }
});

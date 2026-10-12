// Demo jurors for the Kleos Court. Watches for disputed markets, and for every demo juror drawn
// it commits a hidden vote, reveals it when the reveal phase opens, then closes the court.
//
//   KLEOS_BOT_VOTE=uphold npx hardhat run scripts/court-bot.ts --network localhost
//   KLEOS_MARKET=9 KLEOS_BOT_VOTE=uphold npm run court-bot:monad
//
// Non-local chains require one explicit KLEOS_MARKET. Locally, omitting it watches every market.
// KLEOS_BOT_VOTE: "uphold" (vote the proposed outcome, default), "overturn", "yes", "no" or
// "ambiguous". One demo juror always sits out, to show that 3 of 5 is enough.
// Vote salts live only in memory: keep this process running through reveal. A restart cannot
// recover its earlier commitments. Stop and inspect a failed transaction before attempting recovery.
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { LOCAL_CHAIN_ID, ROLES, getDemoWallets } from "./demo-wallets.ts";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const requestedMarket = process.env.KLEOS_MARKET;
if (requestedMarket !== undefined && !/^[1-9]\d*$/.test(requestedMarket)) {
  throw new Error("KLEOS_MARKET must be an explicit positive decimal market ID.");
}
const marketId = requestedMarket === undefined ? undefined : BigInt(requestedMarket);
if (marketId !== undefined && marketId >= 2n ** 256n) {
  throw new Error("KLEOS_MARKET is outside the contract's uint256 range.");
}
if (chainId !== LOCAL_CHAIN_ID && marketId === undefined) {
  throw new Error("Set KLEOS_MARKET to the one approved market before running the court bot on a non-local chain.");
}
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${chainId}/deployed_addresses.json`, "utf8"));
const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"] as Address);
if (marketId !== undefined && marketId > await kleos.read.marketCount()) {
  throw new Error(`KLEOS_MARKET ${marketId} does not exist on chain ${chainId}.`);
}

const [owner] = await viem.getWalletClients();
const wallets = await getDemoWallets(viem, chainId);
const jurors = new Map(wallets.slice(...ROLES.jurors).map((w) => [w.account.address.toLowerCase(), w]));
const mode = (process.env.KLEOS_BOT_VOTE ?? "uphold").toLowerCase();
const DISPUTED = 2;

const salts = new Map<string, Hex>(); // `${market}:${round}:${juror}` → salt
const done = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = async () => Number((await publicClient.getBlock()).timestamp);

async function confirmed(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Court transaction ${hash} did not succeed. Inspect its receipt before restarting the bot.`);
  }
}

// Matches Kleos.voteCommitment without sending the hidden vote or salt to an RPC provider.
function voteCommitment(id: bigint, round: number, juror: Address, vote: number, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "uint8" }, { type: "bytes32" }],
    [id, round, juror, vote, salt],
  ));
}

function voteFor(proposed: boolean): number {
  if (mode === "yes") return 1;
  if (mode === "no") return 2;
  if (mode === "ambiguous") return 3;
  const upheld = mode !== "overturn";
  return (upheld ? proposed : !proposed) ? 1 : 2;
}

console.log(`Court bot watching ${marketId === undefined ? "all local markets" : `market ${marketId}`} with ${jurors.size} demo jurors (vote: ${mode}). Ctrl+C to stop.`);
for (;;) {
  // Keep blocks coming so timestamps move on an idle local node (testnet produces them anyway).
  if (chainId === LOCAL_CHAIN_ID) await owner.sendTransaction({ to: owner.account.address, value: 0n });
  const lastMarket = marketId ?? await kleos.read.marketCount();
  for (let id = marketId ?? 1n; id <= lastMarket; id++) {
    const m = await kleos.read.getMarket([id]);
    if (m.state !== DISPUTED) continue;
    const court = await kleos.read.getCourt([id]);
    const key = `${id}:${court.round}`;
    if (done.has(key)) continue;
    const jury = await kleos.read.getJury([id, court.round]);
    const mine = jury.filter((j) => jurors.has(j.toLowerCase())).slice(0, -1); // one demo juror sits out
    const t = await now();

    if (t < court.commitEnd) {
      for (const j of mine) {
        const k = `${key}:${j.toLowerCase()}`;
        if (salts.has(k)) continue;
        const salt = toHex(randomBytes(32));
        const vote = voteFor(m.proposedOutcome);
        const commitment = voteCommitment(id, court.round, j, vote, salt);
        await confirmed(await kleos.write.commitVote([id, commitment], { account: jurors.get(j.toLowerCase())!.account }));
        salts.set(k, salt);
        console.log(`market ${id} round ${court.round}: ${j} committed a hidden vote`);
      }
    } else if (t < court.revealEnd) {
      for (const j of mine) {
        const k = `${key}:${j.toLowerCase()}`;
        const salt = salts.get(k);
        if (!salt || (await kleos.read.votes([id, court.round, j])) !== 0) continue;
        await confirmed(await kleos.write.revealVote([id, voteFor(m.proposedOutcome), salt], { account: jurors.get(j.toLowerCase())!.account }));
        console.log(`market ${id} round ${court.round}: ${j} revealed`);
      }
    } else {
      await confirmed(await kleos.write.closeCourt([id], { account: owner.account }));
      done.add(key);
      console.log(`market ${id} round ${court.round}: court closed`);
    }
  }
  await sleep(3000);
}

// Demo jurors for the Kleos Court. Watches for disputed markets, and for every demo juror drawn
// it commits a hidden vote, reveals it when the reveal phase opens, then closes the court.
//
//   KLEOS_BOT_VOTE=uphold npx hardhat run scripts/court-bot.ts --network localhost   (or --network monadTestnet)
//
// KLEOS_BOT_VOTE: "uphold" (vote the proposed outcome, default), "overturn", "yes", "no" or
// "ambiguous". One demo juror always sits out, to show that 3 of 5 is enough.
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { LOCAL_CHAIN_ID, ROLES, getDemoWallets } from "./demo-wallets.ts";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${chainId}/deployed_addresses.json`, "utf8"));
const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"] as Address);

const [owner] = await viem.getWalletClients();
const wallets = await getDemoWallets(viem, chainId);
const jurors = new Map(wallets.slice(...ROLES.jurors).map((w) => [w.account.address.toLowerCase(), w]));
const mode = (process.env.KLEOS_BOT_VOTE ?? "uphold").toLowerCase();
const DISPUTED = 2;

const salts = new Map<string, Hex>(); // `${market}:${round}:${juror}` → salt
const done = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = async () => Number((await publicClient.getBlock()).timestamp);

function voteFor(proposed: boolean): number {
  if (mode === "yes") return 1;
  if (mode === "no") return 2;
  if (mode === "ambiguous") return 3;
  const upheld = mode !== "overturn";
  return (upheld ? proposed : !proposed) ? 1 : 2;
}

console.log(`Court bot watching ${jurors.size} demo jurors (vote: ${mode}). Ctrl+C to stop.`);
for (;;) {
  // Keep blocks coming so timestamps move on an idle local node (testnet produces them anyway).
  if (chainId === LOCAL_CHAIN_ID) await owner.sendTransaction({ to: owner.account.address, value: 0n });
  const count = Number(await kleos.read.marketCount());
  for (let id = 1n; id <= BigInt(count); id++) {
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
        const salt = keccak256(toHex(`${k}:${Math.random()}`));
        const vote = voteFor(m.proposedOutcome);
        const commitment = await kleos.read.voteCommitment([id, court.round, j, vote, salt]);
        await publicClient.waitForTransactionReceipt({ hash: await kleos.write.commitVote([id, commitment], { account: jurors.get(j.toLowerCase())!.account }) });
        salts.set(k, salt);
        console.log(`market ${id} round ${court.round}: ${j} committed a hidden vote`);
      }
    } else if (t < court.revealEnd) {
      for (const j of mine) {
        const k = `${key}:${j.toLowerCase()}`;
        const salt = salts.get(k);
        if (!salt || (await kleos.read.votes([id, court.round, j])) !== 0) continue;
        await publicClient.waitForTransactionReceipt({ hash: await kleos.write.revealVote([id, voteFor(m.proposedOutcome), salt], { account: jurors.get(j.toLowerCase())!.account }) });
        console.log(`market ${id} round ${court.round}: ${j} revealed`);
      }
    } else {
      await publicClient.waitForTransactionReceipt({ hash: await kleos.write.closeCourt([id], { account: owner.account }) });
      done.add(key);
      console.log(`market ${id} round ${court.round}: court closed`);
    }
  }
  await sleep(3000);
}

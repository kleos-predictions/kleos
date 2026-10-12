// Opens a short market for recording the Kleos Court: it closes a few minutes after this runs,
// with bets from the six demo personas (run seed-demo first).
//
//   npx hardhat run scripts/demo-market.ts --network monadTestnet
//   KLEOS_CLOSE_MIN=8 npx hardhat run scripts/demo-market.ts --network monadTestnet
//
// Then: propose an outcome on the market page once it closes, `npm run dispute:monad` sends it to
// the court, and `npm run court-bot:monad` has the demo jurors vote and reveal.
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { parseUnits, type Address } from "viem";
import { ROLES, getDemoWallets } from "./demo-wallets.ts";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${chainId}/deployed_addresses.json`, "utf8"));
const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"] as Address);
const [owner] = await viem.getWalletClients();
const personas = (await getDemoWallets(viem, chainId)).slice(...ROLES.personas);

const minutes = Number(process.env.KLEOS_CLOSE_MIN ?? 5);
const closeTime = (await publicClient.getBlock()).timestamp + BigInt(Math.round(minutes * 60));
await publicClient.waitForTransactionReceipt({
  hash: await kleos.write.createMarket(
    [
      "Kleos demo: will the Kleos Court back the proposed outcome?",
      4,
      "The Kleos Court verdict",
      "YES if the outcome first proposed for this market stands after any dispute.",
      closeTime,
    ],
    { account: owner.account },
  ),
});
const id = await kleos.read.marketCount();

// Personas bet in turn, each waiting for its receipt (Monad can reject a reused nonce).
const BETS: [boolean, number][] = [[true, 40], [true, 30], [false, 35], [true, 25], [false, 20], [false, 45]];
for (const [i, [side, amount]] of BETS.entries()) {
  await publicClient.waitForTransactionReceipt({
    hash: await kleos.write.bet([id, side, parseUnits(String(amount), 6)], { account: personas[i].account }),
  });
}

console.log(`Market ${id} is open with ${BETS.length} bets and closes in ~${minutes} min.`);
console.log(`Then: propose on /market/${id}, run KLEOS_MARKET=${id} npm run dispute:monad, then npm run court-bot:monad.`);

// Creates a dedicated sponsor wallet for the web app (it funds new passkey accounts), makes it
// KleosUSD's sponsor, and gives it some MON. The deployer's key never goes near the web server.
//
//   npx hardhat run scripts/setup-sponsor.ts --network monadTestnet
//
// Run it after seed-demo (which mints from the deployer while it is still the sponsor). The key
// is written to contracts/.env.demo and web/.env.local (both git-ignored) and never printed.
import { network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { demoSecret, writeDemoEnv } from "./demo-wallets.ts";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${chainId}/deployed_addresses.json`, "utf8"));
const usd = await viem.getContractAt("KleosUSD", deployed["KleosModule#KleosUSD"] as Address);
const [owner] = await viem.getWalletClients();

const FUNDING = parseEther(process.env.KLEOS_SPONSOR_MON ?? "0.5");

let key = demoSecret("SPONSOR_PRIVATE_KEY") as Hex | undefined;
if (!key) {
  key = generatePrivateKey();
  writeDemoEnv("SPONSOR_PRIVATE_KEY", key);
}
const sponsor = privateKeyToAccount(key).address;

if ((await usd.read.sponsor()).toLowerCase() !== sponsor.toLowerCase()) {
  await publicClient.waitForTransactionReceipt({ hash: await usd.write.setSponsor([sponsor], { account: owner.account }) });
}
const balance = await publicClient.getBalance({ address: sponsor });
if (balance < FUNDING) {
  await publicClient.waitForTransactionReceipt({ hash: await owner.sendTransaction({ to: sponsor, value: FUNDING - balance }) });
}

// The web server reads it from web/.env.local locally; copy it into Vercel's env settings by hand.
const envPath = "../web/.env.local";
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
env = /^SPONSOR_PRIVATE_KEY=.*$/m.test(env) ? env.replace(/^SPONSOR_PRIVATE_KEY=.*$/m, `SPONSOR_PRIVATE_KEY=${key}`) : `${env.trimEnd()}\nSPONSOR_PRIVATE_KEY=${key}\n`;
writeFileSync(envPath, env);

console.log(`Sponsor ${sponsor} is KleosUSD's sponsor and holds ${Number(await publicClient.getBalance({ address: sponsor })) / 1e18} MON.`);
console.log("Its key is in contracts/.env.demo and web/.env.local (git-ignored).");

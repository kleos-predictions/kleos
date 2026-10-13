// Creates a dedicated sponsor wallet for the web app (it funds new passkey accounts), makes it
// KleosUSD's sponsor, and gives it some MON. The deployer's key never goes near the web server.
//
//   npx hardhat run scripts/setup-sponsor.ts --network monadTestnet
//
// Seed uses the deployer or this dedicated sponsor as appropriate. The key
// is written to contracts/.env.demo and web/.env.local (both git-ignored) and never printed.
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { encodeFunctionData, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEMO_ENV, demoSecret } from "./demo-wallets.ts";
import { atomicEnvValue, configureOperatorSponsor } from "./operator-receipt.ts";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${chainId}/deployed_addresses.json`, "utf8"));
const usd = await viem.getContractAt("KleosUSD", deployed["KleosModule#KleosUSD"] as Address);
const [owner] = await viem.getWalletClients();

// Each funding attempt may send 0.3 MON (web/src/app/api/sponsor/route.ts).
// 2 MON is a configurable demo reserve, not a guaranteed account or transaction count.
const FUNDING = parseEther(process.env.KLEOS_SPONSOR_MON ?? "2");

const key = (demoSecret("SPONSOR_PRIVATE_KEY") as Hex | undefined) ?? generatePrivateKey();
const sponsor = privateKeyToAccount(key).address;

// The web server reads it from web/.env.local locally; copy it into Vercel's env settings by hand.
const balance = await configureOperatorSponsor(publicClient, {
  owner: owner.account.address,
  token: usd.address,
  sponsor,
  funding: FUNDING,
  setSponsorData: encodeFunctionData({ abi: usd.abi, functionName: "setSponsor", args: [sponsor] }),
  readSponsor: () => usd.read.sponsor(),
  setSponsor: () => usd.write.setSponsor([sponsor], { account: owner.account }),
  fund: (value) => owner.sendTransaction({ to: sponsor, value }),
  persistCustody: () => atomicEnvValue(DEMO_ENV, "SPONSOR_PRIVATE_KEY", key),
  publish: () => atomicEnvValue("../web/.env.local", "SPONSOR_PRIVATE_KEY", key),
});

console.log(`Sponsor ${sponsor} is KleosUSD's sponsor and holds ${Number(balance) / 1e18} MON.`);
console.log("Its key is in contracts/.env.demo and web/.env.local (git-ignored).");

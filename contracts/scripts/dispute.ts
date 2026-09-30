// Disputes a proposed outcome from a demo account, to trigger the Kleos Court during a demo.
//   KLEOS_MARKET=8 npx hardhat run scripts/dispute.ts --network localhost
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import type { Address } from "viem";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${await publicClient.getChainId()}/deployed_addresses.json`, "utf8"));
const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"] as Address);
const [, ...wallets] = await viem.getWalletClients();
const disputer = wallets[4]; // @pollster: disputing needs only the $15 bond

const id = BigInt(process.env.KLEOS_MARKET ?? (await kleos.read.marketCount()));
const hash = await kleos.write.dispute([id], { account: disputer.account });
await publicClient.waitForTransactionReceipt({ hash });
const court = await kleos.read.getCourt([id]);
console.log(`Market ${id} disputed by @pollster. Jury drawn:`, await kleos.read.getJury([id, court.round]));

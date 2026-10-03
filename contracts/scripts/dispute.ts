// Disputes a proposed outcome from a demo account, to trigger the Kleos Court during a demo.
//   KLEOS_MARKET=8 npx hardhat run scripts/dispute.ts --network localhost
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { encodeFunctionData, type Address } from "viem";
import { getDemoWallets } from "./demo-wallets.ts";
import { sendAndConfirmOperatorTransaction } from "./operator-receipt.ts";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${await publicClient.getChainId()}/deployed_addresses.json`, "utf8"));
const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"] as Address);
const wallets = await getDemoWallets(viem, await publicClient.getChainId());
const disputer = wallets[4]; // @pollster: disputing needs only the $15 bond

const id = BigInt(process.env.KLEOS_MARKET ?? (await kleos.read.marketCount()));
await sendAndConfirmOperatorTransaction(publicClient, () => kleos.write.dispute([id], { account: disputer.account }), {
  sender: disputer.account.address,
  to: kleos.address,
  data: encodeFunctionData({ abi: kleos.abi, functionName: "dispute", args: [id] }),
});
const court = await kleos.read.getCourt([id]);
console.log(`Market ${id} disputed by @pollster. Jury drawn:`, await kleos.read.getJury([id, court.round]));

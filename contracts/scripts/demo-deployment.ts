import { readFileSync } from "node:fs";
import { keccak256, type Address, type PublicClient } from "viem";

export async function demoDeployment(publicClient: PublicClient, chainId: number, folder = `ignition/deployments/chain-${chainId}`) {
  const deployed = JSON.parse(readFileSync(`${folder}/deployed_addresses.json`, "utf8")) as Record<string, Address>;
  const records = readFileSync(`${folder}/journal.jsonl`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const context: { chainId: number; contracts: Record<string, { address: Address; codeHash: string; deploymentHash: string; blockHash: string }> } = { chainId, contracts: {} };
  for (const name of ["Kleos", "KleosUSD", "KleosSocial"]) {
    const futureId = `KleosModule#${name}`;
    const address = deployed[futureId];
    const confirmed = records.find((record) => record.type === "TRANSACTION_CONFIRM" && record.futureId === futureId);
    if (!address || !confirmed || typeof confirmed.hash !== "string") throw new Error(`Missing confirmed ${name} deployment in the Ignition journal.`);
    const receipt = await publicClient.getTransactionReceipt({ hash: confirmed.hash as `0x${string}` });
    const code = await publicClient.getBytecode({ address });
    const recordedReceipt = confirmed.receipt as { blockHash?: string };
    if (receipt.status !== "success" || receipt.contractAddress?.toLowerCase() !== address.toLowerCase() || receipt.blockHash !== recordedReceipt.blockHash || !code || code === "0x") {
      throw new Error(`${name} deployment does not match this chain. Redeploy a fresh local chain before seeding.`);
    }
    context.contracts[name] = { address, codeHash: keccak256(code), deploymentHash: confirmed.hash, blockHash: receipt.blockHash };
  }
  return { deployed, context };
}

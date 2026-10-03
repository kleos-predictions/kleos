import { encodeFunctionData, type WalletClient } from "viem";
import { kleosUsdAbi } from "./abi";
import { KLEOS_ADDRESS, USD_ADDRESS, chain, publicClient } from "./chain";
import { confirmTransaction } from "./transactions";

/** Check the real signer balance and approve only this spend if kUSD does not trust this market. */
export async function ensureUsdAllowance(client: WalletClient, amount: bigint) {
  const me = client.account;
  if (!me) throw new Error("No signing account is available.");
  const token = { address: USD_ADDRESS!, abi: kleosUsdAbi } as const;
  const [balance, allowance, trusted] = await Promise.all([
    publicClient.readContract({ ...token, functionName: "balanceOf", args: [me.address] }),
    publicClient.readContract({ ...token, functionName: "allowance", args: [me.address, KLEOS_ADDRESS!] }),
    publicClient.readContract({ ...token, functionName: "market" }),
  ]);
  if (balance < amount) throw new Error("Not enough test USD for this action.");
  if (trusted.toLowerCase() === KLEOS_ADDRESS!.toLowerCase() || allowance >= amount) return;
  const args = [KLEOS_ADDRESS!, amount] as const;
  const hash = await client.writeContract({ account: me, chain, ...token, functionName: "approve", args });
  await confirmTransaction(publicClient, hash, { sender: me.address, to: USD_ADDRESS!, data: encodeFunctionData({ abi: kleosUsdAbi, functionName: "approve", args }) });
}

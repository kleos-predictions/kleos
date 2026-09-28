// Gas and test-money sponsorship for new passkey accounts. A Mera account starts empty, so the
// first bet would otherwise need a faucet trip. The sponsor only ever sends funds: it never
// holds or sees user keys. Testnet only.

import { createWalletClient, http, isAddress, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient, USD_ADDRESS } from "@/lib/chain";
import { kleosUsdAbi } from "@/lib/abi";

const GAS_FLOOR = parseEther("0.03");
const GAS_TOP_UP = parseEther("0.1"); // ~5 bets at testnet gas prices
const USD_FLOOR = parseUnits("50", 6);
const USD_TOP_UP = parseUnits("1000", 6);
const COOLDOWN_MS = 30 * 1000;

// Best-effort, per server instance. On-chain balance floors are the real limit.
const lastFunded = new Map<string, number>();

export async function POST(request: Request) {
  const key = process.env.SPONSOR_PRIVATE_KEY as Hex | undefined;
  if (!key || !USD_ADDRESS) return Response.json({ error: "Sponsorship is not configured" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { address?: string } | null;
  const address = body?.address;
  if (!address || !isAddress(address)) return Response.json({ error: "Invalid address" }, { status: 400 });

  const id = address.toLowerCase();
  const sponsor = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http() });
  const [gas, usd] = await Promise.all([
    publicClient.getBalance({ address: address as Address }),
    publicClient.readContract({ address: USD_ADDRESS, abi: kleosUsdAbi, functionName: "balanceOf", args: [address as Address] }),
  ]);

  const needsGas = gas < GAS_FLOOR;
  const needsUsd = usd < USD_FLOOR;
  if (!needsGas && !needsUsd) return Response.json({ funded: { gas: false, usd: false } });
  // Cooldown only bites for repeat requests; balance floors are the real limit.
  if (Date.now() - (lastFunded.get(id) ?? 0) < COOLDOWN_MS && !(needsUsd && usd === 0n)) {
    return Response.json({ funded: { gas: false, usd: false }, cooldown: true });
  }

  const hashes: Hex[] = [];
  if (gas < GAS_FLOOR) hashes.push(await sponsor.sendTransaction({ to: address as Address, value: GAS_TOP_UP }));
  if (usd < USD_FLOOR) {
    hashes.push(
      await sponsor.writeContract({ address: USD_ADDRESS, abi: kleosUsdAbi, functionName: "sponsorMint", args: [address as Address, USD_TOP_UP] }),
    );
  }
  await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })));
  lastFunded.set(id, Date.now());

  return Response.json({ funded: { gas: gas < GAS_FLOOR, usd: usd < USD_FLOOR }, hashes });
}

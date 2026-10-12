// Gas and test-money sponsorship for new passkey accounts. A Mera account starts empty, so the
// first bet would otherwise need a faucet trip. The sponsor only ever sends funds: it never
// holds or sees user keys. Testnet only.
//
// Anyone can generate fresh addresses, so the limits below are what protect the sponsor wallet:
// same-site requests only, one funding at a time, a cooldown per address, and budgets per IP,
// per minute and per day. They're kept in memory, per server instance: enough for one demo
// server. A deployment that runs several instances needs a shared store for them.

import { createWalletClient, http, isAddress, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient, USD_ADDRESS } from "@/lib/chain";
import { kleosUsdAbi } from "@/lib/abi";

const GAS_FLOOR = parseEther("0.06"); // about two bets: below it, an account can't dispute or settle
const GAS_TOP_UP = parseEther("0.3"); // ~10 bets, or settling a market of 11, at ~100 gwei (Monad charges the gas limit)
const USD_FLOOR = parseUnits("50", 6);
const USD_TOP_UP = parseUnits("1000", 6);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COOLDOWN_MS = 30_000; // per address
const PER_IP_PER_HOUR = Number(process.env.SPONSOR_PER_IP_PER_HOUR ?? 5);
const PER_MINUTE = Number(process.env.SPONSOR_PER_MINUTE ?? 10);
const PER_DAY = Number(process.env.SPONSOR_PER_DAY ?? 300);

const lastFunded = new Map<string, number>(); // address → when funding started
const byIp = new Map<string, number[]>(); // ip → funding times in the last hour
let recent: number[] = []; // all funding times in the last day
let queue: Promise<unknown> = Promise.resolve(); // one funding at a time: no nonce races, no double pays
type PendingFunding = { hash: Hex; purpose: "gas" | "usd" };
let pendingFunding: PendingFunding | undefined;

const deny = (status: number, error: string) => Response.json({ error }, { status });

/** Same-site only: browsers always send Origin on a POST, and it must match this host. */
function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/** Whether one more funding fits the IP, per-minute and per-day budgets. Doesn't record it. */
function withinBudget(ip: string, now: number): string | null {
  recent = recent.filter((t) => now - t < DAY);
  const ipTimes = (byIp.get(ip) ?? []).filter((t) => now - t < HOUR);
  byIp.set(ip, ipTimes);
  if (ipTimes.length >= PER_IP_PER_HOUR) return "Too many new accounts from this network. Try again in an hour.";
  if (recent.filter((t) => now - t < MINUTE).length >= PER_MINUTE) return "Sponsorship is busy. Try again in a minute.";
  if (recent.length >= PER_DAY) return "Today's sponsorship budget is used up. Use the Monad faucet, or try again tomorrow.";
  return null;
}

export async function POST(request: Request) {
  // A cross-site form or no-cors fetch can't set this content type without a preflight.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return deny(415, "Send JSON");
  if (!sameSite(request)) return deny(403, "Sponsorship is only available from the Kleos app");

  const key = process.env.SPONSOR_PRIVATE_KEY as Hex | undefined;
  if (!key || !USD_ADDRESS) return deny(503, "Sponsorship is not configured");

  const body = (await request.json().catch(() => null)) as { address?: string } | null;
  const address = body?.address;
  if (!address || !isAddress(address)) return deny(400, "Invalid address");

  const id = address.toLowerCase();
  const ip = clientIp(request);
  const run = queue.then(() => fund(key, address as Address, id, ip));
  queue = run.catch(() => undefined);
  try {
    return await run;
  } catch {
    return deny(502, "Sponsorship failed. Try again in a moment.");
  }
}

async function fund(key: Hex, address: Address, id: string, ip: string): Promise<Response> {
  const readBalances = () => Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "balanceOf", args: [address] }),
  ]);
  let [gas, usd] = await readBalances();
  // An account that needs no funds must not depend on another recipient's pending transfer.
  if (gas >= GAS_FLOOR && usd >= USD_FLOOR) return Response.json({ funded: { gas: false, usd: false } });

  // A timed-out receipt is not a failed transfer. Reconcile it before using this signer's
  // nonce again, including when the next request is for a different recipient.
  if (pendingFunding) {
    try {
      await confirmFunding();
    } catch {
      return Response.json({
        funded: { gas: false, usd: false },
        ...(pendingFunding ? { pending: pendingFunding } : {}),
        error: "The previous funding transaction could not be confirmed. Check its status before requesting funds again.",
      }, { status: 503 });
    }
    // The confirmed transfer may have funded this recipient. Refresh before deciding to send.
    [gas, usd] = await readBalances();
  }

  const needsGas = gas < GAS_FLOOR;
  const needsUsd = usd < USD_FLOOR;
  const now = Date.now();
  if (!needsGas && !needsUsd) return Response.json({ funded: { gas: false, usd: false } });
  if (now - (lastFunded.get(id) ?? 0) < COOLDOWN_MS) {
    return Response.json({ funded: { gas: false, usd: false }, cooldown: true, error: "Test funding is on cooldown. Try again in 30 seconds." }, { status: 429 });
  }

  const over = withinBudget(ip, now);
  if (over) return deny(429, over);

  // Recorded before sending, so a parallel request for the same address waits out the cooldown.
  lastFunded.set(id, now);
  recent.push(now);
  byIp.get(ip)!.push(now);

  const sponsor = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http() });
  const hashes: Hex[] = [];
  const funded = { gas: false, usd: false };
  try {
    if (needsGas) {
      const hash = await sponsor.sendTransaction({ to: address, value: GAS_TOP_UP });
      hashes.push(hash);
      pendingFunding = { hash, purpose: "gas" };
      await confirmFunding();
      funded.gas = true;
    }
    if (needsUsd) {
      const hash = await sponsor.writeContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "sponsorMint", args: [address, USD_TOP_UP] });
      hashes.push(hash);
      pendingFunding = { hash, purpose: "usd" };
      await confirmFunding();
      funded.usd = true;
    }
    return Response.json({ funded, hashes });
  } catch {
    // Keep the cooldown and any pending hash: a retry must not repeat an unverified transfer.
    return Response.json({
      funded,
      hashes,
      ...(pendingFunding ? { pending: pendingFunding } : {}),
      error: funded.gas
        ? "Gas funding is confirmed, but test USD funding could not be confirmed. Check the submitted transaction before trying again."
        : "Test funding could not be confirmed. Check any submitted transaction before trying again.",
    }, { status: 503 });
  }
}

async function confirmFunding() {
  const pending = pendingFunding!;
  let replaced = false;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: pending.hash,
    timeout: 15_000,
    onReplaced: ({ reason, transactionReceipt }) => {
      replaced = reason !== "repriced";
      if (pendingFunding) pendingFunding.hash = transactionReceipt.transactionHash;
    },
  });
  pendingFunding = undefined;
  if (replaced || receipt.status !== "success") throw new Error("Funding transaction did not succeed.");
}

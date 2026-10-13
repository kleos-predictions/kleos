// Testnet funding requires a short-lived signature from the receiving account. The local
// queue, request budgets and cooldown prevent overlap within one process only. A shared
// durable budget and signer queue are required across replicas or with valuable funds.

import { createWalletClient, encodeFunctionData, http, isAddress, parseEther, parseUnits, verifyMessage, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient, USD_ADDRESS } from "@/lib/chain";
import { kleosUsdAbi } from "@/lib/abi";
import { parseSponsorProof, sponsorshipMessage, SPONSOR_PROOF_TTL_MS } from "@/lib/sponsor-proof";
import { SponsorCoordinator } from "@/lib/sponsor-coordinator";
import { confirmTransaction, TransactionRejectedError, TransactionUncertainError, type TransactionIntent } from "@/lib/transactions";

import { FUNDING_GAS_FLOOR } from "@/lib/funding";
const GAS_TOP_UP = parseEther("0.3");
const USD_FLOOR = parseUnits("50", 6);
const USD_TOP_UP = parseUnits("1000", 6);
const COOLDOWN_MS = 30 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
function budget(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
const PER_IP_PER_HOUR = budget(process.env.SPONSOR_PER_IP_PER_HOUR, 5);
const PER_MINUTE = budget(process.env.SPONSOR_PER_MINUTE, 10);
const PER_DAY = budget(process.env.SPONSOR_PER_DAY, 300);
const byIp = new Map<string, number[]>();
let recent: number[] = [];

type SponsorResult = { funded: { gas: boolean; usd: boolean }; status?: number; hashes?: Hex[]; cooldown?: boolean; error?: string; pending?: { purpose: "gas" | "usd"; hash: Hex } };
const coordinator = new SponsorCoordinator();
const lastReserved = new Map<string, number>();
const recentProofs = new Map<string, { expiresAt: number; promise: Promise<SponsorResult> }>();
type PendingFunding = { purpose: "gas" | "usd"; hash: Hex; intent: TransactionIntent; recipient: Address; nonce: number };
const unconfirmedFunding = new Map<string, PendingFunding>();
let unknownBroadcast: { purpose: "gas" | "usd"; intent: TransactionIntent } | undefined;

// Proxy IP headers are a deployment-provided hint, not identity. The global budgets still
// apply when a client rotates addresses or when the hosting proxy cannot establish an IP.
function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

function withinBudget(ip: string, now: number): string | null {
  recent = recent.filter((time) => now - time < DAY);
  for (const [id, times] of byIp) {
    const active = times.filter((time) => now - time < HOUR);
    if (active.length) byIp.set(id, active); else byIp.delete(id);
  }
  if ((byIp.get(ip)?.length ?? 0) >= PER_IP_PER_HOUR!) return "Too many funding attempts from this network. Try again in an hour.";
  if (recent.filter((time) => now - time < MINUTE).length >= PER_MINUTE!) return "Sponsorship is busy. Try again in a minute.";
  if (recent.length >= PER_DAY!) return "Today's sponsorship budget is used up. Use the Monad faucet, or try again tomorrow.";
  return null;
}

function fundingResponse(result: SponsorResult) {
  const { status, ...body } = result;
  return Response.json(body, { status: status ?? (result.error ? 503 : 200) });
}

async function readProofBody(request: Request): Promise<{ value: unknown; tooLarge: boolean }> {
  if (!request.body) return { value: null, tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) { await reader.cancel(); return { value: null, tooLarge: true }; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder().decode(bytes)), tooLarge: false };
  } catch { return { value: null, tooLarge: false }; }
  finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  const browserOrigin = request.headers.get("origin");
  if (browserOrigin !== origin) return Response.json({ error: "Funding requests must come from this site." }, { status: 403 });
  const key = process.env.SPONSOR_PRIVATE_KEY as Hex | undefined;
  const usdAddress = USD_ADDRESS;
  if (!key || !usdAddress) return Response.json({ error: "Sponsorship is not configured." }, { status: 503 });
  if (PER_IP_PER_HOUR === null || PER_MINUTE === null || PER_DAY === null) return Response.json({ error: "Sponsorship budgets must be nonnegative safe integers." }, { status: 503 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "Send a JSON funding proof." }, { status: 415 });
  if (Number(request.headers.get("content-length") ?? 0) > 4096) return Response.json({ error: "Funding proof is too large." }, { status: 413 });
  const now = Date.now();
  const body = await readProofBody(request);
  if (body.tooLarge) return Response.json({ error: "Funding proof is too large." }, { status: 413 });
  const proof = parseSponsorProof(body.value, now);
  if (!proof || !isAddress(proof.address)) return Response.json({ error: "A valid, recent account signature is required." }, { status: 400 });

  try {
    const valid = await verifyMessage({ address: proof.address, signature: proof.signature, message: sponsorshipMessage(origin, chain.id, proof) });
    if (!valid) return Response.json({ error: "The funding signature does not match this account." }, { status: 403 });
    for (const [id, entry] of recentProofs) if (entry.expiresAt < now) recentProofs.delete(id);
    for (const [id, timestamp] of lastReserved) if (now - timestamp >= COOLDOWN_MS) lastReserved.delete(id);
    const id = proof.address.toLowerCase();
    const ip = clientIp(request);
    const proofId = id + "/" + proof.requestId;
    const existing = recentProofs.get(proofId);
    if (existing) return fundingResponse(await existing.promise);
    if (recentProofs.size >= 2000) return Response.json({ error: "Funding is busy. Try again in a moment." }, { status: 429 });

    const run = coordinator.run(id, async (): Promise<SponsorResult> => {
      if (Date.now() - proof.issuedAt > SPONSOR_PROOF_TTL_MS) throw new Error("The queued funding proof expired.");
      // Balance checks stay inside the signer queue. An already-funded account does not
      // depend on another recipient's pending transfer or an optional faucet grant.
      const readBalances = () => Promise.all([
        publicClient.getBalance({ address: proof.address }),
        publicClient.readContract({ address: usdAddress, abi: kleosUsdAbi, functionName: "balanceOf", args: [proof.address] }),
      ]);
      let [gas, usd] = await readBalances();
      if (gas >= FUNDING_GAS_FLOOR && usd >= USD_FLOOR) return { funded: { gas: false, usd: false } };
      if (unknownBroadcast) return { funded: { gas: false, usd: false }, error: `The ${unknownBroadcast.purpose} funding broadcast to ${unknownBroadcast.intent.to} has an unknown result. The operator must reconcile the sponsor nonce before further funding.` };
      const sponsor = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http() });
      // Pin retries to the original nonce: a delayed original and its retry cannot both pay.
      const sendGrant = (purpose: PendingFunding["purpose"], recipient: Address, nonce: number): Promise<Hex> => purpose === "gas"
        ? sponsor.sendTransaction({ to: recipient, value: GAS_TOP_UP, nonce })
        : sponsor.writeContract({ address: usdAddress, abi: kleosUsdAbi, functionName: "sponsorMint", args: [recipient, USD_TOP_UP], nonce });
      for (const [recipient, previous] of unconfirmedFunding) {
        try {
          await reconcileFunding(previous, sponsor.account.address, sendGrant);
          unconfirmedFunding.delete(recipient);
        } catch (failure) {
          if (failure instanceof TransactionRejectedError) unconfirmedFunding.delete(recipient);
          else {
            if (failure instanceof TransactionUncertainError) previous.hash = failure.hash;
            return { funded: { gas: false, usd: false }, pending: { purpose: previous.purpose, hash: previous.hash }, error: "A previously submitted funding transaction is still unverified. Check its status before requesting another transfer." };
          }
        }
      }
      // A confirmed/replaced nonce may have funded this recipient; never reuse stale balances.
      [gas, usd] = await readBalances();
      const needsGas = gas < FUNDING_GAS_FLOOR;
      const needsUsd = usd < USD_FLOOR;
      if (!needsGas && !needsUsd) return { funded: { gas: false, usd: false } };
      if (Date.now() - (lastReserved.get(id) ?? 0) < COOLDOWN_MS) return { funded: { gas: false, usd: false }, cooldown: true, status: 429, error: "Test funding is on cooldown. Try again in 30 seconds." };
      const over = withinBudget(ip, Date.now());
      if (over) return { funded: { gas: false, usd: false }, error: over, status: 429 };
      // Reserve before any send, including attempts that fail. Zero USD does not bypass it.
      const reservedAt = Date.now();
      lastReserved.set(id, reservedAt);
      recent.push(reservedAt);
      byIp.set(ip, [...(byIp.get(ip) ?? []), reservedAt]);
      const hashes: Hex[] = [];
      const funded = { gas: false, usd: false };
      try {
        for (const purpose of ["gas", "usd"] as const) {
          if (!(purpose === "gas" ? needsGas : needsUsd)) continue;
          const nonce = await publicClient.getTransactionCount({ address: sponsor.account.address, blockTag: "pending" });
          const intent: TransactionIntent = purpose === "gas"
            ? { sender: sponsor.account.address, to: proof.address, data: "0x", value: GAS_TOP_UP }
            : { sender: sponsor.account.address, to: usdAddress, data: encodeFunctionData({ abi: kleosUsdAbi, functionName: "sponsorMint", args: [proof.address, USD_TOP_UP] }) };
          // An initial hashless broadcast remains fail-closed. A known dropped grant instead
          // retains its original nonce and intent throughout reconciliation and retry.
          unknownBroadcast = { purpose, intent };
          const hash = await sendGrant(purpose, proof.address, nonce);
          unconfirmedFunding.set(id, { purpose, hash, intent, recipient: proof.address, nonce });
          unknownBroadcast = undefined;
          const receipt = await confirmTransaction(publicClient, hash, intent, 15_000);
          hashes.push(receipt.transactionHash);
          funded[purpose] = true;
          unconfirmedFunding.delete(id);
        }
      } catch (failure) {
        const pending = unconfirmedFunding.get(id);
        if (failure instanceof TransactionRejectedError) unconfirmedFunding.delete(id);
        else if (failure instanceof TransactionUncertainError && pending) pending.hash = failure.hash;
        const uncertain = unconfirmedFunding.get(id);
        return { funded, hashes, ...(uncertain ? { pending: { purpose: uncertain.purpose, hash: uncertain.hash } } : {}), error: unknownBroadcast
          ? `The ${unknownBroadcast.purpose} funding broadcast to ${unknownBroadcast.intent.to} has an unknown result. The operator must reconcile the sponsor nonce before further funding.` : funded.gas
          ? "Gas funding is confirmed, but test USD funding could not be confirmed. Check any submitted transaction before requesting test USD again."
          : "Test funding could not be confirmed. Check any submitted transaction before requesting funds again." };
      }
      return { funded, hashes };
    });
    recentProofs.set(proofId, { expiresAt: now + SPONSOR_PROOF_TTL_MS, promise: run });
    return fundingResponse(await run);
  } catch {
    return Response.json({ error: "Test funding failed. Wait 30 seconds, then request funds again." }, { status: 503 });
  }
}


async function reconcileFunding(
  pending: PendingFunding,
  sponsor: Address,
  resend: (purpose: PendingFunding["purpose"], recipient: Address, nonce: number) => Promise<Hex>,
) {
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.hash }).catch((error: unknown) => {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  });
  if (receipt) {
    // Keep the audit's intent verification, including replacements and changed calldata.
    await confirmTransaction(publicClient, pending.hash, pending.intent, 15_000);
    return;
  }
  const transaction = await publicClient.getTransaction({ hash: pending.hash }).catch((error: unknown) => {
    if (error instanceof TransactionNotFoundError) return null;
    throw error;
  });
  const [confirmedNonce, pendingNonce] = await Promise.all([
    publicClient.getTransactionCount({ address: pending.intent.sender, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: pending.intent.sender, blockTag: "pending" }),
  ]);
  // A consumed nonce cannot execute again. The caller refreshes balances rather than
  // declaring the old grant successful when its final hash/intent was never verified.
  if (confirmedNonce > pending.nonce) return;
  if (!transaction) {
    if (confirmedNonce !== pending.nonce || pendingNonce !== pending.nonce || sponsor !== pending.intent.sender) {
      throw new Error("Funding transaction is still unresolved.");
    }
    pending.hash = await resend(pending.purpose, pending.recipient, pending.nonce);
  }
  await confirmTransaction(publicClient, pending.hash, pending.intent, 15_000);
}

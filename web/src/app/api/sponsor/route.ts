// Testnet funding requires a short-lived signature from the receiving account. The local
// queue/cooldown prevent overlap within one process only. A shared durable budget and signer
// queue are still required before operating this service across replicas or with valuable funds.

import { createWalletClient, encodeFunctionData, http, isAddress, parseEther, parseUnits, verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient, USD_ADDRESS } from "@/lib/chain";
import { kleosUsdAbi } from "@/lib/abi";
import { parseSponsorProof, sponsorshipMessage, SPONSOR_PROOF_TTL_MS } from "@/lib/sponsor-proof";
import { SponsorCoordinator } from "@/lib/sponsor-coordinator";
import { confirmTransaction, TransactionRejectedError, TransactionUncertainError, type TransactionIntent } from "@/lib/transactions";

const GAS_FLOOR = parseEther("0.03");
const GAS_TOP_UP = parseEther("0.1");
const USD_FLOOR = parseUnits("50", 6);
const USD_TOP_UP = parseUnits("1000", 6);
const COOLDOWN_MS = 30 * 1000;

type SponsorResult = { funded: { gas: boolean; usd: boolean }; hashes?: Hex[]; cooldown?: boolean; error?: string; pending?: { purpose: "gas" | "usd"; hash: Hex } };
const coordinator = new SponsorCoordinator();
const lastReserved = new Map<string, number>();
const recentProofs = new Map<string, { expiresAt: number; promise: Promise<SponsorResult> }>();
const unconfirmedFunding = new Map<string, { purpose: "gas" | "usd"; hash: Hex; intent: TransactionIntent }>();

function fundingResponse(result: SponsorResult) {
  return Response.json(result, { status: result.error ? 503 : 200 });
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
  if (browserOrigin && browserOrigin !== origin) return Response.json({ error: "Funding requests must come from this site." }, { status: 403 });
  const key = process.env.SPONSOR_PRIVATE_KEY as Hex | undefined;
  const usdAddress = USD_ADDRESS;
  if (!key || !usdAddress) return Response.json({ error: "Sponsorship is not configured." }, { status: 503 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Send a JSON funding proof." }, { status: 415 });
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
    const proofId = id + "/" + proof.requestId;
    const existing = recentProofs.get(proofId);
    if (existing) return fundingResponse(await existing.promise);
    if (recentProofs.size >= 2000) return Response.json({ error: "Funding is busy. Try again in a moment." }, { status: 429 });

    const run = coordinator.run(id, async (): Promise<SponsorResult> => {
      if (Date.now() - proof.issuedAt > SPONSOR_PROOF_TTL_MS) throw new Error("The queued funding proof expired.");
      const previous = unconfirmedFunding.get(id);
      if (previous) {
        try { await confirmTransaction(publicClient, previous.hash, previous.intent, 15_000); unconfirmedFunding.delete(id); }
        catch (failure) {
          if (failure instanceof TransactionRejectedError) unconfirmedFunding.delete(id);
          else {
            if (failure instanceof TransactionUncertainError) previous.hash = failure.hash;
            return { funded: { gas: false, usd: false }, pending: { purpose: previous.purpose, hash: previous.hash }, error: "A previously submitted funding transaction is still unverified. Check its status before requesting another transfer." };
          }
        }
      }
      // Read inside the signer queue: earlier funding may have changed these balances.
      const [gas, usd] = await Promise.all([
        publicClient.getBalance({ address: proof.address }),
        publicClient.readContract({ address: usdAddress, abi: kleosUsdAbi, functionName: "balanceOf", args: [proof.address] }),
      ]);
      const needsGas = gas < GAS_FLOOR;
      const needsUsd = usd < USD_FLOOR;
      if (!needsGas && !needsUsd) return { funded: { gas: false, usd: false } };
      if (Date.now() - (lastReserved.get(id) ?? 0) < COOLDOWN_MS) return { funded: { gas: false, usd: false }, cooldown: true };
      // Reserve before any send, including attempts that fail. Zero USD does not bypass it.
      lastReserved.set(id, Date.now());
      const sponsor = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http() });
      const hashes: Hex[] = [];
      const funded = { gas: false, usd: false };
      try {
        if (needsGas) {
          const hash = await sponsor.sendTransaction({ to: proof.address, value: GAS_TOP_UP });
          const intent: TransactionIntent = { sender: sponsor.account.address, to: proof.address, data: "0x", value: GAS_TOP_UP };
          unconfirmedFunding.set(id, { purpose: "gas", hash, intent });
          const receipt = await confirmTransaction(publicClient, hash, intent);
          hashes.push(receipt.transactionHash);
          funded.gas = true;
          unconfirmedFunding.delete(id);
        }
        if (needsUsd) {
          const hash = await sponsor.writeContract({ address: usdAddress, abi: kleosUsdAbi, functionName: "sponsorMint", args: [proof.address, USD_TOP_UP] });
          const data = encodeFunctionData({ abi: kleosUsdAbi, functionName: "sponsorMint", args: [proof.address, USD_TOP_UP] });
          const intent = { sender: sponsor.account.address, to: usdAddress, data };
          unconfirmedFunding.set(id, { purpose: "usd", hash, intent });
          const receipt = await confirmTransaction(publicClient, hash, intent);
          hashes.push(receipt.transactionHash);
          funded.usd = true;
          unconfirmedFunding.delete(id);
        }
      } catch (failure) {
        const pending = unconfirmedFunding.get(id);
        if (failure instanceof TransactionRejectedError) unconfirmedFunding.delete(id);
        else if (failure instanceof TransactionUncertainError && pending) pending.hash = failure.hash;
        const uncertain = unconfirmedFunding.get(id);
        return { funded, hashes, ...(uncertain ? { pending: { purpose: uncertain.purpose, hash: uncertain.hash } } : {}), error: funded.gas
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

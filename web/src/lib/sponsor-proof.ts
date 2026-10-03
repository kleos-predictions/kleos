// The proof only authorizes this testnet faucet request. It cannot authorize transactions.
export const SPONSOR_PROOF_TTL_MS = 2 * 60 * 1000;
const FUTURE_SKEW_MS = 15 * 1000;

export type SponsorProof = { address: `0x${string}`; issuedAt: number; requestId: string; signature: `0x${string}` };

export function sponsorshipMessage(origin: string, chainId: number, proof: Pick<SponsorProof, "address" | "issuedAt" | "requestId">) {
  return [
    "Kleos testnet funding request",
    `Origin: ${origin}`,
    `Chain ID: ${chainId}`,
    `Address: ${proof.address.toLowerCase()}`,
    `Issued at: ${proof.issuedAt}`,
    `Request ID: ${proof.requestId}`,
    "This signature requests testnet gas and kUSD only.",
  ].join("\n");
}

export function parseSponsorProof(value: unknown, now: number): SponsorProof | null {
  if (!value || typeof value !== "object") return null;
  const { address, issuedAt, requestId, signature } = value as Partial<SponsorProof>;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt > now + FUTURE_SKEW_MS || now - issuedAt > SPONSOR_PROOF_TTL_MS) return null;
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return null;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  return { address, issuedAt, requestId, signature };
}

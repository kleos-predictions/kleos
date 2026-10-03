// Omitted event fields can be recovered from top-level calldata only when its destination,
// function and arguments match the emitting contract and event. Never decode a wrapper's
// payload as if it were the inner Kleos call.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Hex } from "viem";

const calls = parseAbi([
  "function seedReputation(address user, uint256 r, uint32 resolvedBets)",
  "function commitVote(uint256 id, bytes32 commitment)",
]);
const constructorArgs = parseAbiParameters("address usd, uint256 disputeWindow, uint256 vestPeriod, uint256 nMin, uint256 courtPeriod");

type TransactionEvent = {
  srcAddress: string;
  transaction: { to: string | undefined; input: string };
};

function directCall(event: TransactionEvent) {
  if (event.transaction.to?.toLowerCase() !== event.srcAddress.toLowerCase()) return undefined;
  try {
    const decoded = decodeFunctionData({ abi: calls, data: event.transaction.input as Hex });
    // Strict canonical calldata keeps malformed, truncated or appended wrapper data unknown.
    const canonical = encodeFunctionData({ abi: calls, ...decoded });
    return canonical.toLowerCase() === event.transaction.input.toLowerCase() ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function seedHistory(event: TransactionEvent & { params: { user: string; marketId: bigint; newR: bigint; entryPrice: bigint; side: boolean; outcome: boolean } }): bigint | undefined {
  const call = directCall(event);
  if (call?.functionName !== "seedReputation") return undefined;
  const [user, r, count] = call.args;
  const p = event.params;
  if (p.marketId !== 0n || user.toLowerCase() !== p.user.toLowerCase() || r !== p.newR || p.entryPrice !== 0n || p.side || p.outcome) return undefined;
  return BigInt(count);
}

export function voteCommitment(event: TransactionEvent & { transaction: { from: string | undefined }; params: { marketId: bigint; juror: string } }): Hex | undefined {
  const call = directCall(event);
  if (call?.functionName !== "commitVote") return undefined;
  const [id, commitment] = call.args;
  if (id !== event.params.marketId || event.transaction.from?.toLowerCase() !== event.params.juror.toLowerCase()) return undefined;
  return commitment;
}

export function creationConfiguration(event: TransactionEvent & { transaction: { contractAddress: string | undefined } }) {
  // Factory creation, even in a transaction that also creates another contract, is unknown.
  if (event.transaction.to !== undefined || event.transaction.contractAddress?.toLowerCase() !== event.srcAddress.toLowerCase()) return undefined;
  const input = event.transaction.input;
  if (!/^0x[0-9a-f]+$/i.test(input) || input.length <= 2 + 5 * 64) return undefined;
  try {
    const data = `0x${input.slice(-5 * 64)}` as Hex;
    const args = decodeAbiParameters(constructorArgs, data);
    if (encodeAbiParameters(constructorArgs, args).toLowerCase() !== data.toLowerCase()) return undefined;
    const [, disputeWindow, vestPeriod, nMin, courtPeriod] = args;
    return { disputeWindow, vestPeriod, nMin, courtPeriod };
  } catch {
    return undefined;
  }
}

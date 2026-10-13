import { toFunctionSelector, type Address } from "viem";
import { kleosAbi } from "./abi";
import { KLEOS_ADDRESS, chain, publicClient } from "./chain";

const LEGACY_LIMIT = 1_000;
let supportsPagination: Promise<boolean> | undefined;

/** Kleos is a direct deployment. Unknown selectors stay on the explicitly bounded legacy path. */
async function paginationAvailable(blockNumber: bigint): Promise<boolean> {
  const detect = async () => {
    const code = await publicClient.getBytecode({ address: KLEOS_ADDRESS!, blockNumber });
    if (!code) throw new Error("The market contract is unavailable at this block.");
    const count = toFunctionSelector("bettorCount(uint256)").slice(2);
    const page = toFunctionSelector("getBettorsPage(uint256,uint256,uint256)").slice(2);
    return code.includes(count) && code.includes(page);
  };
  if (chain.id === 31337) return detect(); // local resets may replace the bytecode at the same address
  supportsPagination ??= detect().catch((e) => { supportsPagination = undefined; throw e; });
  return supportsPagination;
}

export type BettorDiscovery = { count: bigint; legacy: boolean; page: (offset: bigint) => Promise<readonly Address[]> };

/** Count and pages share a pinned block. Legacy arrays are limited to 1,000 after the full getter read. */
export async function readBettorDiscovery(id: bigint, blockNumber: bigint): Promise<BettorDiscovery> {
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  if (await paginationAvailable(blockNumber)) {
    const count = await publicClient.readContract({ ...k, functionName: "bettorCount", args: [id] });
    return { count, legacy: false, page: (offset) => publicClient.readContract({ ...k, functionName: "getBettorsPage", args: [id, offset, 100n] }) };
  }
  const bettors = await publicClient.readContract({ ...k, functionName: "getBettors", args: [id] });
  if (bettors.length > LEGACY_LIMIT) throw new Error("This legacy deployment needs paginated discovery for markets above 1,000 bettors.");
  return { count: BigInt(bettors.length), legacy: true, page: async (offset) => bettors.slice(Number(offset), Number(offset) + 100) };
}

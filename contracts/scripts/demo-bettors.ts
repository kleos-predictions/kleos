import { toFunctionSelector, type Address, type Hex } from "viem";

type Snapshot = { blockNumber: bigint };
type BettorContract = {
  address: Address;
  read: {
    bettorCount: (args: readonly [bigint], options: Snapshot) => Promise<bigint>;
    getBettorsPage: (args: readonly [bigint, bigint, bigint], options: Snapshot) => Promise<readonly Address[]>;
    getBettors: (args: readonly [bigint], options: Snapshot) => Promise<readonly Address[]>;
  };
};
type BettorClient = {
  getBlockNumber: () => Promise<bigint>;
  getBytecode: (options: Snapshot & { address: Address }) => Promise<Hex | undefined>;
};
const LIMIT = 100n;
const TOO_MANY = "The demo market has over 100 bettors; use the bounded settlement UI/keeper instead of this seed script.";

/** These are direct deployments. Detect selectors before reading; an RPC failure is never
 * evidence of a legacy ABI. Pin discovery to one block. The legacy getter materializes its
 * full array, so reject oversized results instead of silently settling only its first page. */
export async function readDemoBettors(client: BettorClient, contract: BettorContract, id: bigint): Promise<readonly Address[]> {
  const snapshot = { blockNumber: await client.getBlockNumber() };
  const code = await client.getBytecode({ address: contract.address, ...snapshot });
  if (!code || code === "0x") throw new Error("The market contract is unavailable at this block.");
  const paginated = ["bettorCount(uint256)", "getBettorsPage(uint256,uint256,uint256)"]
    .every((signature) => code.includes(toFunctionSelector(signature).slice(2)));
  if (!paginated) {
    const bettors = await contract.read.getBettors([id], snapshot);
    if (bettors.length > Number(LIMIT)) throw new Error(TOO_MANY);
    return bettors;
  }
  const count = await contract.read.bettorCount([id], snapshot);
  if (count > LIMIT) throw new Error(TOO_MANY);
  const bettors = await contract.read.getBettorsPage([id, 0n, LIMIT], snapshot);
  if (BigInt(bettors.length) !== count) throw new Error("Bettor discovery did not match its pinned count. Stop before settlement.");
  return bettors;
}

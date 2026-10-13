// Event reads through Envio HyperSync: one query scans from the deploy block to the chain head in
// milliseconds and returns block timestamps alongside the logs. Server-only (ENVIO_API_TOKEN).
// Used on Monad testnet, where the public RPC serves eth_getLogs 100 blocks at a time.
import "server-only";
import { decodeEventLog, encodeEventTopics, type Abi, type Address, type ContractEventName, type Hex } from "viem";

const TOKEN = process.env.ENVIO_API_TOKEN;
const URL = process.env.HYPERSYNC_URL ?? "https://10143.hypersync.xyz";

export const HAS_HYPERSYNC = Boolean(TOKEN) && process.env.NEXT_PUBLIC_CHAIN !== "local";

type RawLog = {
  block_number: number;
  log_index: number;
  transaction_hash: Hex;
  data: Hex;
  topic0?: Hex | null;
  topic1?: Hex | null;
  topic2?: Hex | null;
  topic3?: Hex | null;
};
type RawBlock = { number: number; timestamp: number | string };
type Page = { data: { logs?: RawLog[]; blocks?: RawBlock[] }[] | { logs?: RawLog[]; blocks?: RawBlock[] }; next_block: number; archive_height: number };

export type SyncedLog<TArgs> = { args: TArgs; blockNumber: bigint; logIndex: number; transactionHash: Hex; timestamp: number };

/** Every log of one event from `address`, optionally filtered by indexed args, oldest first. */
export async function hypersyncEvents<const TAbi extends Abi, TName extends ContractEventName<TAbi>, TArgs = Record<string, unknown>>(opts: {
  address: Address;
  abi: TAbi;
  eventName: TName;
  args?: Record<string, unknown>;
  fromBlock: bigint;
  toBlock?: bigint;
}): Promise<SyncedLog<TArgs>[]> {
  const topics = encodeEventTopics({ abi: opts.abi, eventName: opts.eventName, args: opts.args } as never) as (Hex | Hex[] | null)[];
  const filter = topics.map((t) => (t === null ? [] : Array.isArray(t) ? t : [t]));
  const out: SyncedLog<TArgs>[] = [];
  let from = Number(opts.fromBlock);
  const to = opts.toBlock === undefined ? undefined : Number(opts.toBlock + 1n); // API upper bound is exclusive.
  const deadline = Date.now() + 20_000;
  let pages = 0;
  if (!Number.isSafeInteger(from) || (to !== undefined && !Number.isSafeInteger(to))) throw new Error("Unsupported history block range.");

  for (;;) {
    if (++pages > 100 || Date.now() >= deadline) throw new Error("HyperSync history exceeded its read budget.");
    const res = await fetch(`${URL}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        from_block: from,
        ...(to === undefined ? {} : { to_block: to }),
        logs: [{ address: [opts.address], topics: filter }],
        field_selection: {
          log: ["block_number", "log_index", "transaction_hash", "data", "topic0", "topic1", "topic2", "topic3"],
          block: ["number", "timestamp"],
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!res.ok) throw new Error(`HyperSync ${res.status}`);
    const page = (await res.json()) as Page;
    const batches = Array.isArray(page.data) ? page.data : [page.data];
    const times = new Map<number, number>();
    for (const b of batches) for (const blk of b.blocks ?? []) times.set(Number(blk.number), Number(blk.timestamp));
    for (const b of batches) {
      for (const log of b.logs ?? []) {
        const logTopics = [log.topic0, log.topic1, log.topic2, log.topic3].filter(Boolean) as [Hex, ...Hex[]];
        const decoded = decodeEventLog({ abi: opts.abi, data: log.data, topics: logTopics });
        if (to !== undefined && log.block_number >= to) continue;
        const timestamp = times.get(Number(log.block_number));
        if (timestamp === undefined || timestamp <= 0) throw new Error("HyperSync returned a log without its block timestamp.");
        out.push({
          args: decoded.args as TArgs,
          blockNumber: BigInt(log.block_number),
          logIndex: log.log_index,
          transactionHash: log.transaction_hash,
          timestamp,
        });
      }
    }
    if (out.length > 10_000) throw new Error("HyperSync history exceeded its row budget.");
    if (!Number.isSafeInteger(page.next_block) || page.next_block <= from) throw new Error("HyperSync pagination did not advance.");
    if (to !== undefined && page.next_block >= to) break;
    if (page.next_block >= page.archive_height) {
      if (to !== undefined && page.next_block < to) throw new Error("HyperSync has not indexed the requested snapshot block yet.");
      break;
    }
    from = page.next_block;
  }
  return out;
}

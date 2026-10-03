import { decodeEventLog, type Abi, type Address, type Hex, type TransactionReceipt, type WaitForTransactionReceiptParameters } from "viem";

/** The submitted intent must still be the transaction that succeeded, including after repricing. */
export type TransactionIntent = { sender: Address; to: Address; data: Hex; value?: bigint };

/** A public submitted hash exists, but its final outcome or intent is still unverified. */
export class TransactionUncertainError extends Error {
  readonly hash: Hex;
  readonly intent: TransactionIntent;
  constructor(hash: Hex, intent: TransactionIntent, cause?: unknown, message = "This transaction could not be confirmed. Check its status before submitting this action again.") {
    super(message, { cause });
    this.name = "TransactionUncertainError";
    this.hash = hash;
    this.intent = intent;
  }
}

/** These outcomes conclusively prevent the originally submitted intent from succeeding. */
export class TransactionRejectedError extends Error {
  readonly hash: Hex;
  constructor(message: string, hash: Hex) { super(message); this.name = "TransactionRejectedError"; this.hash = hash; }
}
type ReceiptReader = {
  waitForTransactionReceipt: (args: WaitForTransactionReceiptParameters) => Promise<TransactionReceipt>;
  getTransaction: (args: { hash: Hex }) => Promise<{ from: Address; to: Address | null; input: Hex; value: bigint }>;
};

export async function confirmTransaction(client: ReceiptReader, hash: Hex, intent: TransactionIntent, timeout = 120_000): Promise<TransactionReceipt> {
  let replacement: "cancelled" | "replaced" | "repriced" | undefined;
  let finalHash = hash;
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash, checkReplacement: true, timeout,
      onReplaced: ({ reason, transactionReceipt }) => { replacement = reason; finalHash = transactionReceipt?.transactionHash ?? hash; },
    });
  } catch (cause) { throw new TransactionUncertainError(finalHash, intent, cause); }
  if (replacement === "cancelled") throw new TransactionRejectedError("The transaction was cancelled. Nothing was confirmed.", receipt.transactionHash);
  if (replacement === "replaced") throw new TransactionRejectedError("A different transaction replaced this action. Check its receipt before trying again.", receipt.transactionHash);
  if (receipt.status !== "success") throw new TransactionRejectedError("The transaction reverted. This action did not complete.", receipt.transactionHash);
  let tx: Awaited<ReturnType<ReceiptReader["getTransaction"]>>;
  try { tx = await client.getTransaction({ hash: receipt.transactionHash }); }
  catch (cause) { throw new TransactionUncertainError(receipt.transactionHash, intent, cause); }
  if (tx.from.toLowerCase() !== intent.sender.toLowerCase() || tx.to?.toLowerCase() !== intent.to.toLowerCase() || tx.input.toLowerCase() !== intent.data.toLowerCase() || tx.value !== (intent.value ?? 0n)) {
    throw new TransactionUncertainError(receipt.transactionHash, intent, undefined, "The confirmed transaction does not match this action. Check its status before submitting again.");
  }
  return receipt;
}

/** Require exactly one matching event from the intended contract, not another log emitter. */
export function receiptEvent<T>(receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string, matches: (args: T) => boolean): T {
  const events: T[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === eventName && matches(decoded.args as T)) events.push(decoded.args as T);
    } catch { /* Other contract events are expected in the same receipt. */ }
  }
  if (events.length !== 1) throw new Error(`The transaction succeeded, but its ${eventName} receipt could not be verified. Check the transaction before retrying.`);
  return events[0];
}

/** Even an empty market needs one settle call to open its bonus rollover. */
export function settlementBatches<T>(users: readonly T[], size = 100): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("Invalid settlement batch size.");
  if (users.length === 0) return [[]];
  return Array.from({ length: Math.ceil(users.length / size) }, (_, i) => users.slice(i * size, (i + 1) * size));
}

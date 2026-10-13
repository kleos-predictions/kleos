import type { Hex } from "viem";
import type { TransactionIntent } from "./transactions";

/** Public transaction information only; never a credential, signature key or session. */
export type PendingTransaction = { hash: Hex; intent: TransactionIntent };

export function serializePendingTransaction(transaction: PendingTransaction) {
  return JSON.stringify({ hash: transaction.hash, intent: { ...transaction.intent, value: (transaction.intent.value ?? 0n).toString() } });
}

export function parsePendingTransaction(raw: string | null): PendingTransaction | null {
  try {
    const parsed = JSON.parse(raw ?? "null");
    const { hash, intent } = parsed ?? {};
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || !intent || !/^0x[0-9a-fA-F]{40}$/.test(intent.sender) || !/^0x[0-9a-fA-F]{40}$/.test(intent.to) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(intent.data) || !/^(0|[1-9][0-9]*)$/.test(intent.value)) return null;
    return { hash, intent: { sender: intent.sender, to: intent.to, data: intent.data, value: BigInt(intent.value) } };
  } catch { return null; }
}

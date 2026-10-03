"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { chain, publicClient, txUrl } from "@/lib/chain";
import { confirmTransaction, TransactionRejectedError, TransactionUncertainError, type TransactionIntent } from "@/lib/transactions";
import { parsePendingTransaction, serializePendingTransaction, type PendingTransaction } from "@/lib/pending-transactions";

const memory = new Map<string, string | null>();
const listeners = new Set<() => void>();

function read(key: string) {
  if (memory.has(key)) return memory.get(key)!;
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, pending: PendingTransaction | null) {
  const raw = pending ? serializePendingTransaction(pending) : null;
  memory.set(key, raw);
  try { if (raw) localStorage.setItem(key, raw); else localStorage.removeItem(key); } catch { /* Keep the public pending intent in memory if storage is blocked. */ }
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null) memory.clear();
    else if (event.key.startsWith("kleos.pending.v1.")) memory.set(event.key, event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/** Keep an uncertain submitted intent across renders/reloads. Rechecking never signs or sends. */
export function usePendingTransaction(scope: string) {
  const key = `kleos.pending.v1.${chain.id}.${scope}`;
  const snapshot = useCallback(() => read(key), [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  const pending = useMemo(() => parsePendingTransaction(raw), [raw]);
  const [checking, setChecking] = useState(false);
  const hasPending = () => Boolean(parsePendingTransaction(read(key)));
  const confirm = async (hash: Hex, intent: TransactionIntent, recheck = false) => {
    if (!recheck && hasPending()) throw new Error("Check the pending transaction before submitting this action again.");
    write(key, { hash, intent });
    setChecking(true);
    try {
      const receipt = await confirmTransaction(publicClient, hash, intent, recheck ? 15_000 : 120_000);
      write(key, { hash: receipt.transactionHash, intent });
      return receipt;
    } catch (error) {
      if (error instanceof TransactionRejectedError) write(key, null);
      else if (error instanceof TransactionUncertainError) write(key, { hash: error.hash, intent: error.intent });
      throw error;
    } finally { setChecking(false); }
  };
  const check = async () => {
    const current = parsePendingTransaction(read(key));
    if (!current) throw new Error("No pending transaction remains.");
    setChecking(true);
    try { return { receipt: await confirm(current.hash, current.intent, true), intent: current.intent }; }
    finally { setChecking(false); }
  };
  return { pending, checking, hasPending, confirm, check, complete: () => write(key, null) };
}

export function PendingTransactionNotice({ transaction, onCheck }: { transaction: ReturnType<typeof usePendingTransaction>; onCheck: () => void }) {
  if (!transaction.pending) return null;
  return <div role="status" className="rounded-[12px] border border-line-strong bg-card-alt p-4 text-sm">
    <p>A submitted transaction still needs verification. Check its status before starting this action again.</p>
    <a className="mt-2 block break-all font-mono text-xs underline" href={txUrl(transaction.pending.hash)} target="_blank" rel="noreferrer">{transaction.pending.hash}</a>
    <button className="btn btn-no mt-3" disabled={transaction.checking} onClick={onCheck}>{transaction.checking ? "Checking…" : "Check transaction status"}</button>
  </div>;
}

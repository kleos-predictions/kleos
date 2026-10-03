import type { DemoJournal, Receipt } from "./demo-journal.ts";

/** A sponsor handoff changes the next mint's signer, never the sender of an existing hash.
 * Confirmed/pending operations reconcile with their recorded receipt. Unknown broadcasts or
 * reverted operations with a changed sender remain closed for operator reconciliation. */
export async function mintDemoTokens<R extends Receipt>(journal: DemoJournal, key: string, sender: string,
  send: () => Promise<`0x${string}`>, wait: (hash: `0x${string}`) => Promise<R>): Promise<R> {
  const existing = await journal.reconcile(key, wait);
  if (existing) return existing;
  return journal.run(key, send, wait, sender);
}

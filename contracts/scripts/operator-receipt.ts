import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Address, Hex, TransactionReceipt, WaitForTransactionReceiptParameters } from "viem";

export type OperatorIntent = { sender: Address; to: Address; data: Hex; value?: bigint };
type OperatorTransaction = { hash: Hex; from: Address; to: Address | null; input: Hex; value: bigint; nonce: number };
export type OperatorReceiptClient = {
  getTransaction: (args: { hash: Hex }) => Promise<OperatorTransaction>;
  waitForTransactionReceipt: (args: WaitForTransactionReceiptParameters) => Promise<TransactionReceipt>;
};

export class OperatorUncertainError extends Error {
  readonly hashes: readonly Hex[];
  readonly intent: OperatorIntent;
  constructor(hashes: readonly Hex[], intent: OperatorIntent, cause?: unknown) {
    super(`Operator transaction outcome is uncertain${hashes.length ? ` (${hashes.join(", ")})` : " (broadcast response missing)"}. Stop and reconcile this intent before sending again.`, { cause });
    this.name = "OperatorUncertainError";
    this.hashes = hashes;
    this.intent = intent;
  }
}

export class OperatorRejectedError extends Error {
  readonly hash: Hex;
  constructor(message: string, hash: Hex) { super(`${message} (${hash}). Stop and inspect the transaction.`); this.name = "OperatorRejectedError"; this.hash = hash; }
}

function matchesIntent(tx: OperatorTransaction, intent: OperatorIntent): boolean {
  return tx.from.toLowerCase() === intent.sender.toLowerCase()
    && tx.to?.toLowerCase() === intent.to.toLowerCase()
    && tx.input.toLowerCase() === intent.data.toLowerCase()
    && tx.value === (intent.value ?? 0n);
}

/** Verifies the original broadcast and its successful final transaction. Gas repricing may
 * change its hash, but cannot change the sender, nonce, destination, calldata or value. */
export async function confirmOperatorTransaction(client: OperatorReceiptClient, hash: Hex, intent: OperatorIntent, timeout = 120_000): Promise<TransactionReceipt> {
  const hashes: Hex[] = [hash];
  let original: OperatorTransaction;
  try { original = await client.getTransaction({ hash }); }
  catch (cause) { throw new OperatorUncertainError(hashes, intent, cause); }
  if (original.hash.toLowerCase() !== hash.toLowerCase() || !matchesIntent(original, intent)) {
    throw new OperatorRejectedError("The original transaction does not match the requested operation", hash);
  }
  let invalidReplacement: "cancelled" | "replaced" | undefined;
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash, checkReplacement: true, timeout,
      onReplaced: ({ reason, transactionReceipt }) => {
        if (reason !== "repriced") invalidReplacement = reason;
        const replacementHash = transactionReceipt.transactionHash;
        if (!hashes.includes(replacementHash)) hashes.push(replacementHash);
      },
    });
  } catch (cause) { throw new OperatorUncertainError(hashes, intent, cause); }
  if (invalidReplacement) throw new OperatorRejectedError(`The operation was ${invalidReplacement}`, receipt.transactionHash);
  if (receipt.status !== "success") throw new OperatorRejectedError("The operation reverted", receipt.transactionHash);
  if (!hashes.includes(receipt.transactionHash)) hashes.push(receipt.transactionHash);
  let final: OperatorTransaction;
  try { final = await client.getTransaction({ hash: receipt.transactionHash }); }
  catch (cause) { throw new OperatorUncertainError(hashes, intent, cause); }
  if (final.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() || !matchesIntent(final, intent) || final.nonce !== original.nonce) {
    throw new OperatorRejectedError("The confirmed transaction does not match the original operation", receipt.transactionHash);
  }
  return receipt;
}

/** A failed broadcast response may still have sent the transaction. Never retry it here. */
export async function sendAndConfirmOperatorTransaction(client: OperatorReceiptClient, send: () => Promise<Hex>, intent: OperatorIntent): Promise<TransactionReceipt> {
  let hash: Hex;
  try { hash = await send(); }
  catch (cause) { throw new OperatorUncertainError([], intent, cause); }
  return confirmOperatorTransaction(client, hash, intent);
}

/** Replace one env assignment atomically. Temporary and final files are owner-readable only.
 * The caller chooses when custody and publication happen; this never logs its value. */
export function atomicEnvValue(path: string, name: string, value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(value)) throw new Error("Invalid env assignment.");
  let present = false;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Refusing a symbolic-link env file.");
    present = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const before = present ? readFileSync(path, "utf8") : "";
  const lines = before.split("\n").filter((line) => !new RegExp(`^${name}=`).test(line));
  const prefix = lines.join("\n");
  const body = `${prefix}${prefix && !prefix.endsWith("\n") ? "\n" : ""}${name}=${value}\n`;
  const temporary = join(dirname(path), `.operator-env-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

type SponsorSetupOptions = {
  owner: Address; token: Address; sponsor: Address; funding: bigint; setSponsorData: Hex;
  readSponsor: () => Promise<Address>;
  setSponsor: () => Promise<Hex>;
  fund: (amount: bigint) => Promise<Hex>;
  persistCustody: () => void | Promise<void>;
  publish: () => void | Promise<void>;
};

/** Preserve private key custody before any broadcast; publish the web env only after all
 * intended writes are confirmed and current sponsor/balance reads agree with the plan. */
export async function configureOperatorSponsor(client: OperatorReceiptClient & { getBalance: (args: { address: Address }) => Promise<bigint> }, options: SponsorSetupOptions): Promise<bigint> {
  if (options.funding < 0n) throw new Error("Sponsor funding must be nonnegative.");
  await options.persistCustody();
  if ((await options.readSponsor()).toLowerCase() !== options.sponsor.toLowerCase()) {
    await sendAndConfirmOperatorTransaction(client, options.setSponsor, { sender: options.owner, to: options.token, data: options.setSponsorData });
  }
  const before = await client.getBalance({ address: options.sponsor });
  if (before < options.funding) {
    const amount = options.funding - before;
    await sendAndConfirmOperatorTransaction(client, () => options.fund(amount), { sender: options.owner, to: options.sponsor, data: "0x", value: amount });
  }
  if ((await options.readSponsor()).toLowerCase() !== options.sponsor.toLowerCase()) throw new Error("The current token sponsor differs from the intended sponsor. Web publication stopped.");
  const balance = await client.getBalance({ address: options.sponsor });
  if (balance < options.funding) throw new Error("The intended sponsor funding is not present. Web publication stopped.");
  await options.publish();
  return balance;
}

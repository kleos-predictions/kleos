// Local operational state, never a wallet/key store. Seed operations fail closed if a send's
// hash was lost; the bot stores commit/reveal salts here so a restart can reveal the same vote.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

export type Receipt = { status: string; blockHash: string; blockNumber: bigint; transactionHash: `0x${string}` };
type Operation = { phase: "started" | "pending" | "confirmed" | "reverted"; sender?: string; hash?: `0x${string}`; blockHash?: string; blockNumber?: string };
type JournalData = { version: 1; context: string; operations: Record<string, Operation>; values: Record<string, unknown> };

export const contextId = (context: unknown) => createHash("sha256").update(JSON.stringify(context)).digest("hex");

function atomicWrite(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Exclusive process lock. Stale locks need explicit operator cleanup after checking the PID.
 * Never auto-unlink one: two simultaneous recoveries can otherwise delete a new live lock. */
export function acquireJournalLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const lock = `${path}.lock`;
  if (existsSync(lock)) {
    const previous = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; host: string };
    let alive = true;
    if (previous.host === hostname() && Number.isSafeInteger(previous.pid) && previous.pid > 0) {
      try { process.kill(previous.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
    }
    if (alive) throw new Error(`Another process owns ${lock}. Do not run two demo operators together.`);
    throw new Error(`Stale lock ${lock} belongs to stopped process ${previous.pid}. Confirm that no operator is running, then remove only the lock file; preserve the journal.`);
  }
  const fd = openSync(lock, "wx", 0o600);
  const ownership = JSON.stringify({ pid: process.pid, host: hostname(), token: randomBytes(16).toString("hex") });
  try { writeFileSync(fd, ownership); fsyncSync(fd); } finally { closeSync(fd); }
  return () => { if (existsSync(lock) && readFileSync(lock, "utf8") === ownership) unlinkSync(lock); };
}

export class DemoJournal {
  readonly path: string;
  readonly existed: boolean;
  private readonly data: JournalData;
  private readonly busy = new Set<string>();
  private readonly busySenders = new Set<string>();
  constructor(path: string, context: unknown) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.existed = existsSync(path);
    this.data = this.existed ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, context: contextId(context), operations: {}, values: {} };
    if (this.data.version !== 1 || this.data.context !== contextId(context)) throw new Error("Demo journal belongs to a different deployment. Preserve it and use a fresh deployment journal.");
    if (!this.existed) this.save();
  }
  private save() { atomicWrite(this.path, this.data); }
  value<T>(key: string): T | undefined { return this.data.values[key] as T | undefined; }
  setValue(key: string, value: unknown) { this.data.values[key] = value; this.save(); }
  hasOperation(key: string) { return this.data.operations[key] !== undefined; }
  /** Read-only reconciliation also runs before state-based skips. Observing an advanced
   * market state is not a receipt for the transaction this operator intended to send. */
  async reconcile<R extends Receipt>(key: string, wait: (hash: `0x${string}`) => Promise<R>): Promise<R | undefined> {
    const operation = this.data.operations[key];
    if (!operation || operation.phase === "reverted") return undefined;
    if (operation.phase === "started") throw new Error(`Operation ${key} has an unknown broadcast result. Reconcile its sender nonce and receipt before changing this journal; automatic replay is disabled.`);
    if (!operation.hash) throw new Error(`Operation ${key} is missing its transaction hash.`);
    const receipt = await wait(operation.hash);
    if (receipt.transactionHash.toLowerCase() !== operation.hash.toLowerCase()) throw new Error(`Operation ${key} was replaced; verify its actual calldata and receipt before proceeding.`);
    if (receipt.status !== "success") {
      operation.phase = "reverted";
      this.save();
      throw new Error(`Operation ${key} reverted: ${operation.hash}`);
    }
    if (operation.phase === "confirmed" && operation.blockHash !== receipt.blockHash) throw new Error(`Operation ${key} changed block after a reorg; stop and reconcile the deployment.`);
    operation.phase = "confirmed";
    operation.blockHash = receipt.blockHash;
    operation.blockNumber = receipt.blockNumber.toString();
    this.save();
    return receipt;
  }
  /** A lost or pending response blocks subsequent sends from the same account. Historical
   * journals without sender metadata are conservative: unresolved entries block any sender.
   * Read failures for another fully known sender do not stop unrelated court duties. */
  private async reconcileSender<R extends Receipt>(key: string, sender: string | undefined, wait: (hash: `0x${string}`) => Promise<R>) {
    for (const [otherKey, operation] of Object.entries(this.data.operations)) {
      if (otherKey === key || (operation.phase !== "started" && operation.phase !== "pending")) continue;
      if (sender && operation.sender && operation.sender !== sender) continue;
      await this.reconcile(otherKey, wait);
    }
  }
  /** Persist intent before sending. A crash between broadcast and hash persistence is ambiguous:
   * stop for manual receipt reconciliation instead of duplicating a mint or a bet. */
  async run<R extends Receipt>(key: string, send: () => Promise<`0x${string}`>, wait: (hash: `0x${string}`) => Promise<R>, sender?: string): Promise<R> {
    if (this.busy.has(key)) throw new Error(`Operation ${key} is already running.`);
    const normalizedSender = sender?.toLowerCase();
    const senderKey = normalizedSender ?? "*";
    if (this.busySenders.has("*") || this.busySenders.has(senderKey) || (!normalizedSender && this.busySenders.size > 0)) {
      throw new Error(`Sender for operation ${key} already has an operation running.`);
    }
    this.busy.add(key);
    this.busySenders.add(senderKey);
    try {
      let operation = this.data.operations[key];
      if (operation?.sender && operation.sender !== normalizedSender) throw new Error(`Operation ${key} belongs to another sender. Restore its original account before resuming.`);
      if (operation?.phase === "started") throw new Error(`Operation ${key} has an unknown broadcast result. Reconcile its sender nonce and receipt before changing this journal; automatic replay is disabled.`);
      if (!operation || operation.phase === "reverted") {
        await this.reconcileSender(key, normalizedSender, wait);
        operation = this.data.operations[key] = { phase: "started", sender: normalizedSender };
        this.save();
        operation.hash = await send();
        operation.phase = "pending";
        this.save();
      }
      return (await this.reconcile(key, wait))!;
    } finally { this.busy.delete(key); this.busySenders.delete(senderKey); }
  }
}

export function boundedInteger(value: string | undefined, fallback: number, maximum: number, label: string): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  return number;
}

/** No automatic sit-out: a three-juror jury must retain all three possible reveals. */
export function selectDemoJurors<T extends string>(jury: readonly T[], demoAddresses: Set<string>): T[] {
  return jury.filter((address) => demoAddresses.has(address.toLowerCase()));
}

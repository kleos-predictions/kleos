"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createWalletClient, http, type Address, type Hex, type WalletClient } from "viem";
import { toViemAccount } from "@category-labs/mera/viem";
import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import { chain, POLLING_MS, publicClient, USD_ADDRESS } from "@/lib/chain";
import { createAccount, describeAccountError, revealRecoveryPhrase, unlockAccount, type UnlockedAccount } from "@/lib/mera";
import { AccountPromptGate, parsePublicAccount, sameAddress, type PublicAccountMetadata } from "@/lib/account-lifecycle";
import { sponsorshipMessage } from "@/lib/sponsor-proof";
import { kleosUsdAbi } from "@/lib/abi";
import { FUNDING_GAS_FLOOR } from "@/lib/funding";

// This is a full signing session kept only in memory. The per-bet prompt threshold is a UI
// policy, not a cumulative allowance or cryptographic restriction on the software wallet.
export const PROMPT_FREE_LIMIT = 100;
const IDLE_LOCK_MS = 15 * 60 * 1000;
const CACHE_KEY = "kleos.account.v1";

export type AccountStatus = "none" | "locked" | "unlocked";

type AccountContext = {
  status: AccountStatus;
  address?: Address;
  credential?: PasskeyCredentialMetadata;
  epoch: number;
  prompting: boolean;
  funding: boolean;
  fundingTransactions: Hex[];
  error: string | null;
  /** Must be the first await in a click handler; WebAuthn starts before any other await. */
  authorize: (opts?: { fresh?: boolean; signIn?: boolean }) => Promise<WalletClient | null>;
  /** Fresh passkey prompt; never returns a phrase from a locked/replaced account. */
  revealPhrase: () => Promise<string | null>;
  /** Ensures this signer has gas and the action's kUSD amount; sponsorship is optional. */
  whenFunded: (expectedAddress: Address, usd?: bigint) => Promise<void>;
  requestFunds: (expectedAddress?: Address) => Promise<void>;
  lock: () => void;
  signOut: () => void;
  clearError: () => void;
};

const Ctx = createContext<AccountContext | null>(null);
const cacheListeners = new Set<() => void>();
// Public metadata remains available even when persistence is blocked. No secret enters it.
let memoryCacheRaw: string | null | undefined;

function readCacheRaw(): string | null {
  if (memoryCacheRaw !== undefined) return memoryCacheRaw;
  try { return localStorage.getItem(CACHE_KEY); } catch { return null; }
}

function writeCache(value: PublicAccountMetadata | null) {
  memoryCacheRaw = value ? JSON.stringify(value) : null;
  try {
    if (memoryCacheRaw) localStorage.setItem(CACHE_KEY, memoryCacheRaw);
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* The public memory copy still allows fresh authorization of this account. */ }
  cacheListeners.forEach((listener) => listener());
}

function subscribeCache(listener: () => void) {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

type FundingJob = { address: Address; epoch: number; promise: Promise<void>; controller: AbortController; pending: boolean; failed: boolean };

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const cacheRaw = useSyncExternalStore(subscribeCache, readCacheRaw, () => null);
  const cached = useMemo(() => parsePublicAccount(cacheRaw), [cacheRaw]);
  const [unlockedAddress, setUnlockedAddress] = useState<Address | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [prompting, setPrompting] = useState(false);
  const [funding, setFunding] = useState(false);
  const [fundingTransactions, setFundingTransactions] = useState<Hex[]>([]);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<UnlockedAccount | null>(null);
  const gate = useRef(new AccountPromptGate());
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fundingJob = useRef<FundingJob | null>(null);
  const status: AccountStatus = unlockedAddress ? "unlocked" : cached ? "locked" : "none";

  const lock = useCallback(() => {
    setEpoch(gate.current.invalidate());
    live.current?.session.end();
    live.current = null;
    fundingJob.current?.controller.abort();
    fundingJob.current = null;
    setFunding(false);
    setFundingTransactions([]);
    if (idle.current) clearTimeout(idle.current);
    setUnlockedAddress(null);
  }, []);

  const touch = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(lock, IDLE_LOCK_MS);
  }, [lock]);

  useEffect(() => {
    const promptGate = gate.current;
    // Another tab's sign-out or account replacement revokes this tab's in-memory authority.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CACHE_KEY && event.key !== null) return;
      memoryCacheRaw = event.key === null ? null : event.newValue;
      lock();
      cacheListeners.forEach((listener) => listener());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      promptGate.invalidate();
      live.current?.session.end();
      fundingJob.current?.controller.abort();
      if (idle.current) clearTimeout(idle.current);
    };
  }, [lock]);

  const requestFunds = useCallback((expectedAddress?: Address): Promise<void> => {
    const account = live.current;
    if (!account || (expectedAddress && !sameAddress(account.address, expectedAddress))) {
      const failure = new Error("Your account changed or locked. Unlock it before requesting funds.");
      setError(failure.message);
      return Promise.reject(failure);
    }
    const target = account.address;
    const startedAt = gate.current.epoch;
    const previous = fundingJob.current;
    if (previous?.pending && previous.epoch === startedAt && sameAddress(previous.address, target)) return previous.promise;
    const controller = new AbortController();
    setFunding(true);
    setError(null);
    const proof = { address: target, issuedAt: Date.now(), requestId: crypto.randomUUID() };
    const run = (async () => {
      const signature = await toViemAccount(account.session).signMessage({ message: sponsorshipMessage(location.origin, chain.id, proof) });
      if (!gate.current.current(startedAt) || live.current !== account) throw new Error("Your account changed or locked before funding.");
      const response = await fetch("/api/sponsor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...proof, signature }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null) as { error?: string; cooldown?: boolean; funded?: { gas?: boolean; usd?: boolean }; hashes?: string[]; pending?: { hash?: string } } | null;
      if (gate.current.current(startedAt) && live.current === account) {
        const hashes = [...(result?.hashes ?? []), ...(result?.pending?.hash ? [result.pending.hash] : [])].filter((hash): hash is Hex => /^0x[0-9a-fA-F]{64}$/.test(hash));
        if (hashes.length) setFundingTransactions((previous) => [...new Set([...previous, ...hashes])].slice(-4));
      }
      if (!response.ok || result?.error) throw new Error(result?.error ?? "Funding failed. Request test funds again.");
      if (result?.cooldown) throw new Error("Test funding is on cooldown. Try again in 30 seconds.");
      if (typeof result?.funded?.gas !== "boolean" || typeof result?.funded?.usd !== "boolean") throw new Error("The funding response could not be verified. Request funds again.");
      if (!gate.current.current(startedAt) || live.current !== account) throw new Error("Your account changed or locked during funding.");
    })().catch((failure: unknown) => {
      if (fundingJob.current?.promise === run && gate.current.current(startedAt) && live.current === account) {
        fundingJob.current.failed = true;
        setError(describeAccountError(failure));
      }
      throw failure;
    }).finally(() => {
      if (fundingJob.current?.promise === run) {
        fundingJob.current.pending = false;
        setFunding(false);
      }
    });
    fundingJob.current = { address: target, epoch: startedAt, promise: run, controller, pending: true, failed: false };
    // Background starts remain handled; callers still receive the rejecting promise.
    void run.catch(() => undefined);
    return run;
  }, []);

  const adopt = useCallback((account: UnlockedAccount) => {
    if (!live.current || !sameAddress(live.current.address, account.address)) setFundingTransactions([]);
    live.current?.session.end();
    fundingJob.current?.controller.abort();
    fundingJob.current = null;
    live.current = account;
    writeCache({ credential: account.credential, address: account.address });
    setUnlockedAddress(account.address);
    setEpoch(gate.current.invalidate());
    touch();
    return createWalletClient({ account: toViemAccount(account.session), chain, transport: http(), pollingInterval: POLLING_MS });
  }, [touch]);

  const authorize = useCallback(async ({ fresh = false, signIn = false }: { fresh?: boolean; signIn?: boolean } = {}) => {
    setError(null);
    // Take the guard synchronously, including prompt-free calls while another prompt is live.
    const token = gate.current.begin();
    if (!token) {
      setError("Finish the current passkey prompt before continuing.");
      return null;
    }
    try {
      if (live.current && !fresh) {
        touch();
        const job = fundingJob.current;
        if (job?.failed && gate.current.current(job.epoch) && sameAddress(job.address, live.current.address)) {
          void requestFunds(live.current.address).catch(() => undefined);
        }
        return createWalletClient({ account: toViemAccount(live.current.session), chain, transport: http(), pollingInterval: POLLING_MS });
      }
      setPrompting(true);
      const expected = live.current ?? cached;
      // No await may precede these calls: Safari needs the original click gesture.
      const account = expected ? await unlockAccount(expected.credential) : signIn ? await unlockAccount() : await createAccount();
      if (!gate.current.current(token.epoch)) {
        account.session.end();
        return null;
      }
      if (expected && !sameAddress(expected.address, account.address)) {
        account.session.end();
        throw new Error("That passkey does not belong to the selected account. Sign out to choose another.");
      }
      const client = adopt(account);
      // Retain the rejecting promise for whenFunded; this catch only handles the background start.
      void requestFunds(account.address).catch(() => undefined);
      return client;
    } catch (failure) {
      if (gate.current.current(token.epoch)) setError(describeAccountError(failure));
      return null;
    } finally {
      gate.current.finish(token);
      setPrompting(false);
    }
  }, [adopt, cached, requestFunds, touch]);

  const revealPhrase = useCallback(async () => {
    const account = live.current;
    if (!account) { setError("Unlock your account before showing its recovery phrase."); return null; }
    const token = gate.current.begin();
    if (!token) { setError("Finish the current passkey prompt before continuing."); return null; }
    setError(null);
    setPrompting(true);
    try {
      const phrase = await revealRecoveryPhrase(account.credential, account.address); // first await: WebAuthn
      if (!gate.current.current(token.epoch) || live.current !== account) return null;
      touch();
      return phrase;
    } catch (failure) {
      if (gate.current.current(token.epoch)) setError(describeAccountError(failure));
      return null;
    } finally {
      gate.current.finish(token);
      setPrompting(false);
    }
  }, [touch]);

  const signOut = useCallback(() => { lock(); writeCache(null); }, [lock]);
  const whenFunded = useCallback(async (expectedAddress: Address, usd = 0n): Promise<void> => {
    const account = live.current;
    const startedAt = gate.current.epoch;
    const assertCurrent = () => {
      if (!account || live.current !== account || !gate.current.current(startedAt) || !sameAddress(expectedAddress, account.address)) {
        throw new Error("Your account changed or locked. Authorize this action again.");
      }
    };
    assertCurrent();
    const readFunds = async () => {
      if (usd > 0n && !USD_ADDRESS) throw new Error("Test USD is not configured.");
      const [gas, tokens] = await Promise.all([
        publicClient.getBalance({ address: expectedAddress }),
        usd > 0n
          ? publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "balanceOf", args: [expectedAddress] })
          : Promise.resolve(0n),
      ]);
      assertCurrent();
      return { gas, tokens };
    };
    // A positive dust balance cannot pay for a typical action. The token requirement stays
    // specific to this action, so gas-only actions remain independent of the kUSD faucet.
    const sufficient = (funds: { gas: bigint; tokens: bigint }) => funds.gas >= FUNDING_GAS_FLOOR && funds.tokens >= usd;
    if (sufficient(await readFunds())) return;

    let fundingError: unknown;
    try {
      const job = fundingJob.current;
      const currentJob = job && job.epoch === startedAt && sameAddress(job.address, expectedAddress);
      // Reuse the current failure until a new click explicitly retries through authorize().
      await (currentJob && (job.pending || job.failed) ? job.promise : requestFunds(expectedAddress));
    } catch (failure) {
      fundingError = failure;
    }
    const funds = await readFunds();
    if (sufficient(funds)) return;
    if (fundingError) throw fundingError;
    throw new Error(funds.gas < FUNDING_GAS_FLOOR
      ? "Your account needs more gas money. Request test funds or fund it with MON."
      : "Not enough test USD for this action. Try a smaller amount or request funds.");
  }, [requestFunds]);

  return <Ctx.Provider value={{
    status, address: unlockedAddress ?? cached?.address, credential: cached?.credential,
    epoch, prompting, funding, fundingTransactions, error, authorize, revealPhrase, whenFunded, requestFunds, lock, signOut,
    clearError: () => setError(null),
  }}>{children}</Ctx.Provider>;
}

export function useKleosAccount() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKleosAccount must be used inside AccountProvider");
  return ctx;
}

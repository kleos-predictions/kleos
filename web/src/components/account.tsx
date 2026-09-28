"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createWalletClient, http, type WalletClient } from "viem";
import { toViemAccount } from "@category-labs/mera/viem";
import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import { chain, POLLING_MS } from "@/lib/chain";
import { createAccount, describeAccountError, unlockAccount, type UnlockedAccount } from "@/lib/mera";

// Session design:
// - The signing session lives in memory only. A reload or 15 idle minutes locks the account.
// - Prompt-free while unlocked: bets up to PROMPT_FREE_LIMIT, approvals, settling, claiming, vesting.
// - A fresh passkey prompt: bigger bets, anything that posts a bond (propose, dispute), jury votes,
//   and revealing the recovery phrase.
// - Stored: the credential id and the public address. Never the PRF output, seed, key or session.

export const PROMPT_FREE_LIMIT = 100;
const IDLE_LOCK_MS = 15 * 60 * 1000;
const CACHE_KEY = "kleos.account.v1";

type Cached = { credential: PasskeyCredentialMetadata; address: `0x${string}` };
export type AccountStatus = "none" | "locked" | "unlocked";

type AccountContext = {
  status: AccountStatus;
  address?: `0x${string}`;
  credential?: PasskeyCredentialMetadata;
  funding: boolean;
  error: string | null;
  /**
   * Must be the first `await` in a click handler. Creates, unlocks or re-prompts as needed.
   * `signIn` uses an existing passkey on a device with nothing cached (the stateless path).
   */
  authorize: (opts?: { fresh?: boolean; signIn?: boolean }) => Promise<WalletClient | null>;
  /** Waits until a new account has gas and test money. */
  whenFunded: () => Promise<void>;
  requestFunds: () => Promise<void>;
  lock: () => void;
  signOut: () => void;
  clearError: () => void;
};

const Ctx = createContext<AccountContext | null>(null);

// The public cache (credential id + address) as an external store, so the server render and
// the first client render agree (both see nothing) and later changes re-render subscribers.
const cacheListeners = new Set<() => void>();

function readCacheRaw(): string | null {
  try {
    return localStorage.getItem(CACHE_KEY);
  } catch {
    return null;
  }
}

function writeCache(value: Cached | null) {
  try {
    if (value) localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage can be blocked; the passkey still rebuilds the account.
  }
  cacheListeners.forEach((l) => l());
}

function subscribeCache(listener: () => void) {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

function parseCache(raw: string | null): Cached | null {
  try {
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const cacheRaw = useSyncExternalStore(subscribeCache, readCacheRaw, () => null);
  const cached = useMemo(() => parseCache(cacheRaw), [cacheRaw]);
  const [unlockedAddress, setUnlockedAddress] = useState<`0x${string}` | null>(null);
  const status: AccountStatus = unlockedAddress ? "unlocked" : cached ? "locked" : "none";
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<UnlockedAccount | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fundingPromise = useRef<Promise<void>>(Promise.resolve());

  const lock = useCallback(() => {
    live.current?.session.end();
    live.current = null;
    if (idle.current) clearTimeout(idle.current);
    setUnlockedAddress(null);
  }, []);

  const touch = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(lock, IDLE_LOCK_MS);
  }, [lock]);

  useEffect(() => () => live.current?.session.end(), []);

  const requestFunds = useCallback(async (address?: string) => {
    const target = address ?? live.current?.address ?? cached?.address;
    if (!target) return;
    setFunding(true);
    const run = fetch("/api/sponsor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: target }) })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => setFunding(false));
    fundingPromise.current = run;
    return run;
  }, [cached?.address]);

  const adopt = useCallback(
    (account: UnlockedAccount) => {
      live.current?.session.end();
      live.current = account;
      writeCache({ credential: account.credential, address: account.address });
      setUnlockedAddress(account.address);
      touch();
      return createWalletClient({ account: toViemAccount(account.session), chain, transport: http(), pollingInterval: POLLING_MS });
    },
    [touch],
  );

  const authorize = useCallback(
    async ({ fresh = false, signIn = false }: { fresh?: boolean; signIn?: boolean } = {}) => {
      setError(null);
      try {
        if (live.current && !fresh) {
          touch();
          return createWalletClient({ account: toViemAccount(live.current.session), chain, transport: http(), pollingInterval: POLLING_MS });
        }
        if (!cached && signIn) {
          const unlocked = await unlockAccount();
          const client = adopt(unlocked);
          void requestFunds(unlocked.address);
          return client;
        }
        if (!cached) {
          const account = await createAccount();
          const client = adopt(account);
          void requestFunds(account.address); // runs while the user reads the next screen
          return client;
        }
        const unlocked = await unlockAccount(cached.credential);
        const client = adopt(unlocked);
        void requestFunds(unlocked.address); // tops up only if the balance ran low
        return client;
      } catch (e) {
        setError(describeAccountError(e));
        return null;
      }
    },
    [adopt, cached, requestFunds, touch],
  );

  const signOut = useCallback(() => {
    lock();
    writeCache(null);
  }, [lock]);

  const whenFunded = useCallback(() => fundingPromise.current, []);

  const value: AccountContext = {
    status,
    address: unlockedAddress ?? cached?.address,
    credential: cached?.credential,
    funding,
    error,
    authorize,
    whenFunded,
    requestFunds: () => requestFunds(),
    lock,
    signOut,
    clearError: () => setError(null),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKleosAccount() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKleosAccount must be used inside AccountProvider");
  return ctx;
}

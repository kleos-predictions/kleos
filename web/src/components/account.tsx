"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createWalletClient, http, type Address, type WalletClient } from "viem";
import { toViemAccount } from "@category-labs/mera/viem";
import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import { chain, POLLING_MS, publicClient, USD_ADDRESS } from "@/lib/chain";
import { kleosUsdAbi } from "@/lib/abi";
import { FUNDING_GAS_FLOOR } from "@/lib/funding";
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
  /** Ensures this signer has gas and the action's kUSD amount; sponsorship is optional. */
  whenFunded: (address: Address, usd?: bigint) => Promise<void>;
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
  const fundingFailed = useRef(false);
  const fundingPending = useRef(false);

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

  const requestFunds = useCallback((address?: string) => {
    const target = address ?? live.current?.address ?? cached?.address;
    if (!target) return Promise.resolve();
    setFunding(true);
    setError(null);
    fundingFailed.current = false;
    fundingPending.current = true;
    const run = fetch("/api/sponsor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: target }) })
      .then(async (response) => {
        const result = await response.json().catch(() => null) as { error?: string; cooldown?: boolean; funded?: { gas?: boolean; usd?: boolean } } | null;
        if (!response.ok || result?.error) throw new Error(result?.error ?? "Test funding is unavailable. Try again in a moment.");
        if (result?.cooldown) throw new Error("Test funding is on cooldown. Try again in 30 seconds.");
        if (typeof result?.funded?.gas !== "boolean" || typeof result?.funded?.usd !== "boolean") {
          throw new Error("The funding response could not be verified. Try again in a moment.");
        }
      })
      .catch((failure: unknown) => {
        if (fundingPromise.current === run) {
          fundingFailed.current = true;
          setError(describeAccountError(failure));
        }
        throw failure;
      })
      .finally(() => {
        if (fundingPromise.current === run) {
          fundingPending.current = false;
          setFunding(false);
        }
      });
    fundingPromise.current = run;
    // Keep the rejection for whenFunded/requestFunds, but also handle background callers.
    void run.catch(() => undefined);
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
          // A new click can retry failed funding; never leave the primary action waiting on
          // the same rejected promise forever. An in-flight request is left alone.
          if (fundingFailed.current) void requestFunds(live.current.address).catch(() => undefined);
          return createWalletClient({ account: toViemAccount(live.current.session), chain, transport: http(), pollingInterval: POLLING_MS });
        }
        if (!cached && signIn) {
          const unlocked = await unlockAccount();
          const client = adopt(unlocked);
          void requestFunds(unlocked.address).catch(() => undefined);
          return client;
        }
        if (!cached) {
          const account = await createAccount();
          const client = adopt(account);
          void requestFunds(account.address).catch(() => undefined); // runs while the user reads the next screen
          return client;
        }
        const unlocked = await unlockAccount(cached.credential);
        const client = adopt(unlocked);
        void requestFunds(unlocked.address).catch(() => undefined); // tops up only if the balance ran low
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

  const whenFunded = useCallback(async (address: Address, usd = 0n) => {
    const assertCurrent = () => {
      if (live.current?.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Your account changed or locked. Unlock it before continuing.");
      }
    };
    assertCurrent();
    const readFunds = async () => {
      if (usd > 0n && !USD_ADDRESS) throw new Error("Test USD is not configured.");
      const [gas, tokens] = await Promise.all([
        publicClient.getBalance({ address }),
        usd > 0n
          ? publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "balanceOf", args: [address] })
          : Promise.resolve(0n),
      ]);
      assertCurrent();
      return { gas, tokens };
    };
    // A positive dust balance cannot pay for a typical action. Use the sponsor's gas floor,
    // while token-free actions need no kUSD and small bets need only their stake.
    const sufficient = (funds: { gas: bigint; tokens: bigint }) => funds.gas >= FUNDING_GAS_FLOOR && funds.tokens >= usd;
    if (sufficient(await readFunds())) return;

    let fundingError: unknown;
    try {
      // Reuse the current attempt, including its failure. A later user click retries via
      // authorize(); an account that ran low after a successful grant gets one new attempt.
      await (fundingPending.current || fundingFailed.current ? fundingPromise.current : requestFunds(address));
    } catch (failure) {
      fundingError = failure;
    }
    const funds = await readFunds();
    if (sufficient(funds)) return; // A partial grant or manual deposit may be enough for this action.
    if (fundingError) throw fundingError;
    throw new Error(funds.gas < FUNDING_GAS_FLOOR
      ? "Your account needs more gas money. Request test funds or fund it with MON."
      : "Not enough test USD for this action. Try a smaller amount or request funds.");
  }, [requestFunds]);

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

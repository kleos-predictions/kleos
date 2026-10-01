"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { IS_LIVE, KLEOS_ADDRESS, USD_ADDRESS, shortAddress } from "@/lib/chain";
import { kleosAbi, kleosUsdAbi } from "@/lib/abi";
import { describeAccountError, revealRecoveryPhrase } from "@/lib/mera";
import { useKleosAccount } from "./account";
import { LaurelBadge } from "./laurel";

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onEvent = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onEvent);
    document.addEventListener("keydown", onEvent);
    return () => {
      document.removeEventListener("mousedown", onEvent);
      document.removeEventListener("keydown", onEvent);
    };
  }, [open, close]);
  return ref;
}

const noop = () => () => {};

export function AccountButton() {
  const account = useKleosAccount();
  // The account comes from localStorage, which the server can't see. Until this component has
  // hydrated, render what the server rendered (signed out), then switch to the real state.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const menuRef = useDismiss(menuOpen, () => setMenuOpen(false));
  const address = account.address;
  const status = hydrated ? account.status : "none";

  const { data: rep } = useReadContract({
    address: KLEOS_ADDRESS,
    abi: kleosAbi,
    functionName: "reputation",
    args: address ? [address] : undefined,
    query: { enabled: IS_LIVE && Boolean(address) },
  });
  const { data: balance } = useReadContract({
    address: USD_ADDRESS,
    abi: kleosUsdAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: IS_LIVE && Boolean(address), refetchInterval: 4000 },
  });
  const r = rep ? Number(rep.r) / 1e18 : 0;

  // The phrase leaves memory when the dialog closes or after two minutes, and is hidden as soon as the account locks.
  useEffect(() => {
    if (!phrase) return;
    const t = setTimeout(() => setPhrase(null), 2 * 60 * 1000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPhrase(null);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [phrase]);

  async function showPhrase() {
    if (!account.credential) return;
    try {
      setPhrase(await revealRecoveryPhrase(account.credential));
    } catch (e) {
      setPhrase(null);
      setPhraseError(describeAccountError(e));
    }
  }

  if (status === "none") {
    return (
      <div className="flex items-center gap-2">
        <button className="btn !min-h-11 btn-yes" onClick={() => account.authorize()}>
          Start with passkey
        </button>
        <button className="btn !min-h-11 btn-no hidden md:inline-flex" onClick={() => account.authorize({ signIn: true })}>
          I have one
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        className="btn !min-h-11 border-line bg-card normal-case"
        onClick={() => (status === "locked" ? account.authorize() : setMenuOpen((o) => !o))}
        aria-haspopup={status === "unlocked" ? "menu" : undefined}
        aria-expanded={status === "unlocked" ? menuOpen : undefined}
      >
        <LaurelBadge r={r} />
        {address && shortAddress(address)}
        {status === "locked" ? (
          <span className="lbl !text-accent">Unlock</span>
        ) : account.funding ? (
          <span className="lbl">Funding…</span>
        ) : (
          balance !== undefined && <span className="text-muted">${Number(formatUnits(balance, 6)).toLocaleString("en-US")}</span>
        )}
      </button>

      {menuOpen && status === "unlocked" && (
        <div role="menu" className="card absolute right-0 z-50 mt-2 flex w-60 flex-col p-2">
          <Link role="menuitem" href={`/profile/${address}`} className="lbl rounded-[10px] px-3 py-3 !text-ink hover:bg-card-alt" onClick={() => setMenuOpen(false)}>
            My profile
          </Link>
          <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt" onClick={() => { setMenuOpen(false); void account.requestFunds(); }}>
            Get test USD
          </button>
          <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt" onClick={() => { setMenuOpen(false); void showPhrase(); }}>
            Show recovery phrase
          </button>
          <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt" onClick={() => { setMenuOpen(false); account.lock(); }}>
            Lock
          </button>
          <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt" onClick={() => { setMenuOpen(false); account.signOut(); }}>
            Sign out of this device
          </button>
        </div>
      )}

      {phrase && status === "unlocked" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPhrase(null)}>
          <div role="dialog" aria-label="Recovery phrase" className="card flex w-full max-w-lg flex-col gap-5 p-6" onClick={(e) => e.stopPropagation()}>
            <span className="lbl">Recovery phrase</span>
            <p className="text-sm text-muted">
              Your passkey already backs up this account on every device it syncs to. This phrase is a second way in, for any standard
              wallet. Anyone who sees it controls the account.
            </p>
            <ol className="grid grid-cols-3 gap-2 font-mono text-sm">
              {phrase.split(" ").map((w, i) => (
                <li key={i} className="rounded-[8px] bg-card-alt px-2 py-1.5">
                  <span className="text-muted">{i + 1}.</span> {w}
                </li>
              ))}
            </ol>
            <button className="btn btn-no" onClick={() => setPhrase(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {(account.error || phraseError) && (
        <p
          role="alert"
          className="fixed right-4 bottom-4 z-50 max-w-sm rounded-[12px] border border-line-strong bg-card-alt px-4 py-3 text-sm text-ink"
          onClick={() => {
            account.clearError();
            setPhraseError(null);
          }}
        >
          {account.error ?? phraseError}
        </p>
      )}
    </div>
  );
}

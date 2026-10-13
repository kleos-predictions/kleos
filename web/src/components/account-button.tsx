"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { IS_LIVE, KLEOS_ADDRESS, USD_ADDRESS, shortAddress, txUrl } from "@/lib/chain";
import { kleosAbi, kleosUsdAbi } from "@/lib/abi";
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
  const [recovery, setRecovery] = useState<{ phrase: string; address: string; epoch: number } | null>(null);
  const phraseRequest = useRef(0);
  const menuRef = useDismiss(menuOpen, () => setMenuOpen(false));
  const address = account.address;
  const status = hydrated ? account.status : "none";
  const clearPhrase = useCallback(() => { phraseRequest.current++; setRecovery(null); }, []);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState !== "visible") clearPhrase(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") clearPhrase(); };
    // Native passkey choosers can blur the browser. Clear an already visible phrase on blur;
    // the visibility/focus checks below decide whether a newly returned phrase can be shown.
    const onBlur = () => { if (recovery) clearPhrase(); };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", clearPhrase);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", clearPhrase);
    };
  }, [clearPhrase, recovery]);

  useEffect(() => () => { phraseRequest.current++; }, []);

  useEffect(() => {
    if (!recovery) return;
    const timeout = setTimeout(clearPhrase, 60_000);
    return () => clearTimeout(timeout);
  }, [clearPhrase, recovery]);

  // Clear retained secret state as the identity changes, before any child can show it again.
  if (recovery && (status !== "unlocked" || account.epoch !== recovery.epoch || address?.toLowerCase() !== recovery.address.toLowerCase())) {
    setRecovery(null);
  }

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

  async function showPhrase() {
    const selectedAddress = account.address;
    if (!selectedAddress) return;
    setRecovery(null);
    const request = ++phraseRequest.current;
    const phrase = await account.revealPhrase(); // first await: starts the passkey ceremony
    if (!phrase || phraseRequest.current !== request || document.visibilityState !== "visible" || !document.hasFocus()) return;
    setRecovery({ phrase, address: selectedAddress, epoch: account.epoch });
  }

  const errorNotice = account.error && (
    <p role="alert" className="fixed right-4 bottom-4 z-50 max-w-sm rounded-[12px] border border-line-strong bg-card-alt px-4 py-3 text-sm text-ink" onClick={account.clearError}>
      {account.error}
      {account.fundingTransactions.map((hash) => <a key={hash} className="mt-1 block break-all font-mono text-xs underline" href={txUrl(hash)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{hash}</a>)}
    </p>
  );

  if (status === "none") {
    return (
      <div className="flex items-center gap-2">
        <button className="btn !min-h-11 btn-yes" aria-label="Create an account with a passkey" disabled={account.prompting} onClick={() => account.authorize()}>
          {account.prompting ? "Passkey…" : <><span className="hidden md:inline">Start with </span>passkey</>}
        </button>
        <button className="btn !min-h-11 btn-no" disabled={account.prompting} onClick={() => account.authorize({ signIn: true })}>
          I have one
        </button>
        {errorNotice}
      </div>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        className="btn !min-h-11 border-line bg-card normal-case"
        disabled={account.prompting}
        onClick={() => (status === "locked" ? account.authorize() : setMenuOpen((o) => !o))}
        aria-haspopup={status === "unlocked" ? "menu" : undefined}
        aria-expanded={status === "unlocked" ? menuOpen : undefined}
      >
        {rep ? <LaurelBadge r={r} rawR={rep.r.toString()} /> : IS_LIVE && <span className="lbl" title="Reputation is unavailable">R ?</span>}
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
          <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt" disabled={account.funding} onClick={() => { setMenuOpen(false); void account.requestFunds(address).catch(() => undefined); }}>
            Get test USD
          </button>
          <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt" disabled={account.prompting} onClick={() => { setMenuOpen(false); void showPhrase(); }}>
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

      {recovery && status === "unlocked" && recovery.epoch === account.epoch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={clearPhrase}>
          <div role="dialog" aria-modal="true" aria-label="Recovery phrase" className="card flex w-full max-w-lg flex-col gap-5 p-6" onClick={(e) => e.stopPropagation()}>
            <span className="lbl">Recovery phrase</span>
            <p className="text-sm text-muted">
              Your passkey already backs up this account on every device it syncs to. This phrase is a second way in, for any standard
              wallet. Anyone who sees it controls the account.
            </p>
            <ol className="grid grid-cols-3 gap-2 font-mono text-sm">
              {recovery.phrase.split(" ").map((w, i) => (
                <li key={i} className="rounded-[8px] bg-card-alt px-2 py-1.5">
                  <span className="text-muted">{i + 1}.</span> {w}
                </li>
              ))}
            </ol>
            <button className="btn btn-no" autoFocus onClick={clearPhrase}>
              Done
            </button>
          </div>
        </div>
      )}

      {errorNotice}
    </div>
  );
}

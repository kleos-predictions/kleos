"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { Wordmark, LaurelBadge } from "./laurel";
import { IS_LIVE, KLEOS_ADDRESS, USD_ADDRESS, shortAddress } from "@/lib/chain";
import { kleosAbi, kleosUsdAbi } from "@/lib/abi";
import { useEffect, useRef, useState } from "react";

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/compare", label: "Compare" },
  { href: "/how-it-works", label: "How it works" },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContract, isPending: faucetPending } = useWriteContract();
  const [note, setNote] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

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
  const r = rep ? Number(rep.r) / 1e18 : 0; // vested reputation

  function getTestUsd() {
    if (!IS_LIVE) return flash("Demo mode: deploy the contracts to mint test USD");
    if (!isConnected) return flash("Connect a wallet first");
    writeContract(
      { address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "faucet" },
      { onSuccess: () => flash("+1,000 test USD on the way"), onError: (e) => flash(e.message.split("\n")[0]) },
    );
  }
  function flash(msg: string) {
    setNote(msg);
    setTimeout(() => setNote(null), 3500);
  }

  return (
    <nav className="border-b border-line">
      <div className="mx-auto flex min-h-[76px] max-w-[1440px] flex-wrap items-center gap-x-10 gap-y-3 px-4 py-3 md:px-12">
        <Link href="/markets" aria-label="Kleos home">
          <Wordmark />
        </Link>

        <div className="order-3 flex gap-7 md:order-none">
          {LINKS.map((l) => {
            const active = pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`font-mono text-sm tracking-[0.06em] uppercase ${active ? "text-ink" : "text-muted"}`}
                aria-current={active ? "page" : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </div>

        <form
          role="search"
          className="order-4 flex h-11 w-full items-center gap-2.5 rounded-[12px] border border-line bg-card px-4 lg:order-none lg:w-auto lg:flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const q = new FormData(e.currentTarget).get("q") as string;
            router.push(`/markets${q ? `?q=${encodeURIComponent(q)}` : ""}`);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            name="q"
            aria-label="Search markets"
            placeholder="Search markets"
            defaultValue={params.get("q") ?? ""}
            className="flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-muted"
          />
        </form>

        <div className="ml-auto flex items-center gap-3 md:ml-0">
          <button className="btn btn-no !min-h-11 hidden sm:inline-flex" onClick={getTestUsd} disabled={faucetPending}>
            {faucetPending ? "Minting…" : "Get test USD"}
          </button>
          {isConnected && address ? (
            <div className="relative" ref={menuRef}>
              <button
                className="btn !min-h-11 border-line bg-card normal-case"
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <LaurelBadge r={r} />
                {shortAddress(address)}
                {balance !== undefined && <span className="text-muted">${Number(formatUnits(balance, 6)).toLocaleString("en-US")}</span>}
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
              </button>
              {menuOpen && (
                <div role="menu" className="card absolute right-0 z-50 mt-2 flex w-56 flex-col p-2">
                  <Link role="menuitem" href={`/profile/${address}`} className="lbl rounded-[10px] px-3 py-3 !text-ink hover:bg-card-alt" onClick={() => setMenuOpen(false)}>
                    My reputation
                  </Link>
                  <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt sm:hidden" onClick={() => { setMenuOpen(false); getTestUsd(); }}>
                    Get test USD
                  </button>
                  <button role="menuitem" className="lbl rounded-[10px] px-3 py-3 text-left hover:bg-card-alt" onClick={() => { setMenuOpen(false); disconnect(); }}>
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              className="btn !min-h-11 border-line bg-card"
              disabled={isPending}
              onClick={() => connectors[0] && connect({ connector: connectors[0] })}
            >
              <LaurelBadge r={0} label={false} />
              {isPending ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
      </div>
      {note && (
        <p role="status" className="lbl fixed right-4 bottom-4 z-50 rounded-[12px] border border-line-strong bg-card-alt px-4 py-3 !text-ink">
          {note}
        </p>
      )}
    </nav>
  );
}

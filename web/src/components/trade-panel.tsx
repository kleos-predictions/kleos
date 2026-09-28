"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { DEMO_R, pools, type Market } from "@/lib/data";
import { PARAMS, effectiveBet, multiplier, payout } from "@/lib/math";
import { IS_LIVE, KLEOS_ADDRESS, USD_ADDRESS, txUrl } from "@/lib/chain";
import { kleosAbi, kleosUsdAbi } from "@/lib/abi";
import { tierOf, TIER_NAMES, TIER_THRESHOLDS } from "@/lib/tiers";
import { BoostGauge } from "./boost-gauge";
import { LaurelBadge } from "./laurel";

const CHIPS = [10, 50, 100];
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function TradePanel({ market }: { market: Market }) {
  const params = useSearchParams();
  const [side, setSide] = useState<boolean>(params.get("side") !== "no");
  const [amount, setAmount] = useState(80);
  const [sheetOpen, setSheetOpen] = useState(params.has("side"));
  const [status, setStatus] = useState<{ msg: string; tx?: string } | null>(null);

  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const { data: rep } = useReadContract({
    address: KLEOS_ADDRESS,
    abi: kleosAbi,
    functionName: "reputation",
    args: address ? [address] : undefined,
    query: { enabled: IS_LIVE && Boolean(address) },
  });

  const r = IS_LIVE ? (rep ? Number(rep.r) / 1e18 : 0) : DEMO_R; // vested reputation
  const activated = IS_LIVE ? (rep?.resolvedBets ?? 0) >= PARAMS.nMin : true;
  const mult = activated ? multiplier(r) : 1;
  const p = pools(market);
  const eff = effectiveBet(amount, mult, p.yesEff + p.noEff);
  const winMoney = (side ? p.yesMoney : p.noMoney) + amount;
  const losingMoney = side ? p.noMoney : p.yesMoney;
  const ifRight = amount > 0 ? payout(amount, winMoney, losingMoney) : 0;
  const pays = amount > 0 ? ifRight / amount : 0;
  const tier = tierOf(r);
  const next = TIER_THRESHOLDS[tier];
  const open = market.status === "live" || market.status === "closing";

  async function placeBet() {
    if (!IS_LIVE) {
      setStatus({ msg: `Demo mode: ${money(amount)} on ${side ? "YES" : "NO"} would count as ${money(eff)}` });
      return;
    }
    if (!isConnected || !address) return setStatus({ msg: "Connect a wallet first" });
    try {
      const value = parseUnits(String(amount), 6);
      const allowance = await publicClient!.readContract({
        address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "allowance", args: [address, KLEOS_ADDRESS!],
      });
      if (allowance < value) {
        setStatus({ msg: "Approving test USD…" });
        const approveTx = await writeContractAsync({
          address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "approve", args: [KLEOS_ADDRESS!, value * 1000n],
        });
        await publicClient!.waitForTransactionReceipt({ hash: approveTx });
      }
      setStatus({ msg: "Placing bet…" });
      const tx = await writeContractAsync({
        address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "bet", args: [BigInt(market.id), side, value],
      });
      await publicClient!.waitForTransactionReceipt({ hash: tx });
      setStatus({ msg: "Bet placed", tx });
    } catch (e) {
      setStatus({ msg: (e as Error).message.split("\n")[0] });
    }
  }

  const panel = (
    <div className="flex flex-col gap-4">
      <section className="card flex flex-col gap-5 p-6">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
          {[true, false].map((s) => (
            <button
              key={String(s)}
              role="radio"
              aria-checked={side === s}
              onClick={() => setSide(s)}
              className={`btn ${side === s ? (s ? "btn-yes" : "border-ink bg-ink text-ground") : "btn-no text-muted"}`}
            >
              {s ? "Yes" : "No"} {Math.round((s ? market.repYes : 1 - market.repYes) * 100)}%
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-2">
          <span className="lbl">Amount</span>
          <span className="flex items-center gap-1 rounded-[12px] border border-line bg-ground px-4 py-2 focus-within:border-line-strong">
            <span className="font-dot text-[40px] font-black text-muted">$</span>
            <input
              inputMode="numeric"
              value={amount || ""}
              onChange={(e) => setAmount(Math.min(Number(e.target.value.replace(/\D/g, "")) || 0, 1_000_000))}
              placeholder="0"
              className="w-full bg-transparent font-dot text-[40px] font-black text-ink outline-none"
              aria-label="Amount in test USD"
            />
          </span>
        </label>
        <div className="flex gap-2">
          {CHIPS.map((c) => (
            <button key={c} className="btn btn-chip flex-1" aria-pressed={amount === c} onClick={() => setAmount(c)}>
              ${c}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-5 rounded-[12px] bg-card-alt p-4">
          <BoostGauge mult={mult} size={116} />
          <div className="flex flex-col gap-1">
            <span className="lbl">Your {money(amount)} counts as</span>
            <span className="font-dot text-[34px] leading-none font-black text-accent">{money(eff)}</span>
            <span className="lbl mt-2">
              If right: {money(ifRight)} · pays {pays.toFixed(2)}× + bonus
            </span>
          </div>
        </div>

        <button className="btn btn-yes w-full !min-h-14 !text-base" onClick={placeBet} disabled={!open || amount < 1 || isPending}>
          {!open ? "Market closed" : isPending ? "Confirm in wallet…" : `Place bet · ${side ? "Yes" : "No"}`}
        </button>
        {status && (
          <p role="status" className="lbl !text-ink">
            {status.msg}
            {status.tx && (
              <>
                {" · "}
                <a href={txUrl(status.tx)} target="_blank" rel="noreferrer" className="text-accent underline">
                  View tx
                </a>
              </>
            )}
          </p>
        )}
        {!IS_LIVE && <p className="lbl !text-[11px]">Demo mode · sample wallet with R = {DEMO_R}</p>}
      </section>

      <section className="card flex items-center gap-4 p-5">
        <LaurelBadge r={r} size={52} />
        <div className="flex flex-1 flex-col gap-1">
          <span className="lbl">Your tier</span>
          <span className="font-dot text-2xl font-black">{tier ? `TIER ${TIER_NAMES[tier]}` : "NO TIER YET"}</span>
          <span className="lbl !text-[11px]">
            R = {r.toFixed(1)}
            {next !== undefined && ` · ${(next - r).toFixed(1)} to tier ${TIER_NAMES[tier + 1]}`}
            {!activated && ` · boost unlocks after ${PARAMS.nMin} resolved bets`}
          </span>
        </div>
        {address && (
          <Link href={`/profile/${address}`} className="lbl !text-ink underline">
            History
          </Link>
        )}
      </section>
    </div>
  );

  return (
    <>
      {/* Desktop: sticky column. */}
      <aside className="hidden lg:sticky lg:top-6 lg:block">{panel}</aside>

      {/* Mobile: bottom bar that opens a sheet. */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex gap-3 border-t border-line bg-ground p-4 lg:hidden">
        <button className="btn btn-yes flex-1" onClick={() => { setSide(true); setSheetOpen(true); }}>Yes</button>
        <button className="btn btn-no flex-1" onClick={() => { setSide(false); setSheetOpen(true); }}>No</button>
      </div>
      {sheetOpen && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/60 lg:hidden" onClick={() => setSheetOpen(false)}>
          <div
            role="dialog"
            aria-label="Place a bet"
            className="max-h-[88dvh] overflow-y-auto rounded-t-[18px] border-t border-line-strong bg-ground p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex justify-between">
              <span className="lbl">Trade</span>
              <button className="lbl !text-ink" onClick={() => setSheetOpen(false)}>Close</button>
            </div>
            {panel}
          </div>
        </div>
      )}
    </>
  );
}

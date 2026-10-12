"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useReadContract } from "wagmi";
import { maxUint256, parseUnits } from "viem";
import { DEMO_R, pools, type Market } from "@/lib/data";
import { PARAMS, effectiveBet, multiplier, payout } from "@/lib/math";
import { IS_LIVE, IS_LOCAL_CHAIN, KLEOS_ADDRESS, USD_ADDRESS, chain, publicClient, txUrl } from "@/lib/chain";
import { describeAccountError } from "@/lib/mera";
import { PROMPT_FREE_LIMIT, useKleosAccount } from "./account";
import { kleosAbi, kleosUsdAbi } from "@/lib/abi";
import { tierOf, TIER_NAMES, TIER_THRESHOLDS } from "@/lib/tiers";
import { BoostGauge } from "./boost-gauge";
import { LaurelBadge } from "./laurel";

const CHIPS = [10, 50, 100];

type Step = "account" | "funds" | "bet";
const STEPS: [Step, string][] = [["account", "Account"], ["funds", "Funds"], ["bet", "Bet"]];
type Receipt = { side: boolean; amount: number; eff: number; call: string; secs: string; tx?: string; demo?: boolean };
const clock = () => performance.now();
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function TradePanel({ market }: { market: Market }) {
  const params = useSearchParams();
  const router = useRouter();
  const [side, setSide] = useState<boolean>(params.get("side") !== "no");
  const [amount, setAmount] = useState(80);
  const [call, setCall] = useState("");
  const [sheetOpen, setSheetOpen] = useState(params.has("side"));
  const [step, setStep] = useState<Step | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const account = useKleosAccount();
  const address = account.address;
  const [busy, setBusy] = useState(false);
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

  const needsPrompt = amount > PROMPT_FREE_LIMIT;
  const callBytes = new TextEncoder().encode(call.trim()).length;
  const cta = !open
    ? "Market closed"
    : busy
      ? "Placing bet…"
      : !IS_LIVE
        ? `Place bet · ${side ? "Yes" : "No"}`
        : account.status === "none"
          ? `Start with passkey · bet ${side ? "Yes" : "No"}`
          : account.status === "locked"
            ? `Unlock & bet ${side ? "Yes" : "No"}`
            : needsPrompt
              ? `Confirm with passkey · ${side ? "Yes" : "No"}`
              : `Place bet · ${side ? "Yes" : "No"}`;

  async function placeBet() {
    setError(null);
    const text = call.trim();
    if (!IS_LIVE) {
      setReceipt({ side, amount, eff, call: text, secs: "0.0", demo: true });
      return;
    }
    const started = clock();
    setStep("account");
    // The passkey prompt, when one is needed, has to be the first await in this click handler.
    const client = await account.authorize({ fresh: needsPrompt });
    if (!client?.account) {
      setStep(null);
      return;
    }
    setBusy(true);
    try {
      const me = client.account;
      setStep("funds");
      const value = parseUnits(String(amount), 6);
      await account.whenFunded(me.address, value);
      const [allowance, trustedMarket] = await Promise.all([
        publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "allowance", args: [me.address, KLEOS_ADDRESS!] }),
        publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "market" }),
      ]);
      // kUSD trusts the Kleos market, so the first bet is a single transaction.
      if (trustedMarket.toLowerCase() !== KLEOS_ADDRESS!.toLowerCase() && allowance < value) {
        const approveTx = await client.writeContract({
          account: me, chain, address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "approve", args: [KLEOS_ADDRESS!, maxUint256],
        });
        const approval = await publicClient.waitForTransactionReceipt({ hash: approveTx });
        if (approval.status !== "success") {
          throw new Error("Test USD approval reverted. No bet was placed.");
        }
      }
      setStep("bet");
      const tx = text
        ? await client.writeContract({
            account: me, chain, address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "betWithCall", args: [BigInt(market.id), side, value, text],
          })
        : await client.writeContract({
            account: me, chain, address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "bet", args: [BigInt(market.id), side, value],
          });
      const confirmed = await publicClient.waitForTransactionReceipt({ hash: tx });
      if (confirmed.status !== "success") {
        throw new Error("Your bet reverted on-chain. No bet was placed.");
      }
      setReceipt({ side, amount, eff, call: text, secs: ((clock() - started) / 1000).toFixed(1), tx });
      setCall("");
      router.refresh(); // server-rendered calls and prices pick up the new bet
    } catch (e) {
      setError(describeAccountError(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  const panel = (
    <div className="flex flex-col gap-4">
      {receipt ? (
        <BetReceipt receipt={receipt} address={address} onAgain={() => setReceipt(null)} />
      ) : (
      <section className="card flex flex-col gap-5 p-6">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
          {[true, false].map((s) => (
            <button
              key={String(s)}
              role="radio"
              aria-checked={side === s}
              onClick={() => setSide(s)}
              className={`btn ${side === s ? (s ? "btn-yes" : "btn-no-active") : "btn-no text-muted"}`}
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

        <label className="flex flex-col gap-2">
          <span className="flex justify-between">
            <span className="lbl">Your call · optional</span>
            <span className={`lbl ${callBytes > 140 ? "!text-accent" : ""}`}>{callBytes}/140</span>
          </span>
          <input
            value={call}
            onChange={(e) => setCall(e.target.value)}
            aria-label="Your call, optional"
            placeholder="Why? One line, public and permanent"
            className="rounded-[12px] border border-line bg-ground px-4 py-3 text-[15px] text-ink outline-none placeholder:text-muted focus:border-line-strong"
          />
        </label>

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

        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3">
          <span className="lbl !text-[11px]">Resolves by these rules · fixed on-chain</span>
          <p className="text-sm leading-snug text-ink">{market.criteria}</p>
          <span className="lbl !text-[11px]">Source: {market.oracle}</span>
        </div>

        <button className={`btn ${side ? "btn-yes" : "btn-no-active"} w-full !min-h-14 !text-base`} onClick={placeBet} disabled={!open || amount < 1 || busy || callBytes > 140}>
          {cta}
        </button>
        {IS_LIVE && account.status === "unlocked" && (
          <p className="lbl !text-[11px]">
            {needsPrompt ? `Bets over $${PROMPT_FREE_LIMIT} ask for your passkey` : `No prompt for bets up to $${PROMPT_FREE_LIMIT} while unlocked`}
          </p>
        )}
        {step && <BetProgress step={step} />}
        {error && (
          <p role="alert" className="rounded-[12px] border border-accent px-4 py-3 text-sm text-ink">
            {error}
          </p>
        )}
        {!IS_LIVE && <p className="lbl !text-[11px]">Demo mode · sample wallet with R = {DEMO_R}</p>}
      </section>
      )}

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

function BetProgress({ step }: { step: Step }) {
  const at = STEPS.findIndex(([s]) => s === step);
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Placing your bet" role="status" aria-live="polite">
      {STEPS.map(([s, label], i) => (
        <li key={s} className="flex flex-col items-center gap-2">
          <span
            className={`h-1.5 w-full rounded-full ${i < at ? "bg-accent" : i === at ? "animate-pulse bg-accent" : "bg-dot-off"}`}
          />
          <span className={`lbl !text-[11px] ${i <= at ? "!text-ink" : ""}`}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function BetReceipt({ receipt, address, onAgain }: { receipt: Receipt; address?: string; onAgain: () => void }) {
  const color = receipt.side ? "text-accent" : "text-lavender";
  return (
    <section className={`card flex flex-col gap-5 border-2 p-6 ${receipt.side ? "!border-accent" : "!border-lavender"}`} role="status" aria-live="polite">
      <div className="flex items-center justify-between">
        <span className="lbl">{receipt.demo ? "Demo · not on-chain" : `Confirmed on Monad in ${receipt.secs}s`}</span>
        <span className={`font-dot text-2xl font-black ${color}`}>✓</span>
      </div>
      <h3 className="font-dot text-[40px] leading-none font-black">BET PLACED</h3>
      <p className="text-lg leading-snug">
        {money(receipt.amount)} on <span className={`font-medium ${color}`}>{receipt.side ? "YES" : "NO"}</span>, counting as{" "}
        <span className="font-medium text-accent">{money(receipt.eff)}</span> in the reputation-weighted price.
      </p>
      {receipt.call && (
        <blockquote className="rounded-[12px] bg-card-alt px-4 py-3 text-[17px] leading-snug">
          “{receipt.call}”
          <span className="lbl mt-2 block !text-[11px]">Your call is public now and gets scored when the market resolves</span>
        </blockquote>
      )}
      <div className="grid grid-cols-2 gap-2">
        {receipt.call ? (
          <Link href="/feed" className="btn btn-no text-center whitespace-nowrap">
            View in feed
          </Link>
        ) : (
          address && (
            <Link href={`/profile/${address}`} className="btn btn-no text-center whitespace-nowrap">
              My profile
            </Link>
          )
        )}
        <button className="btn btn-no whitespace-nowrap" onClick={onAgain}>
          Bet again
        </button>
      </div>
      {receipt.tx && !IS_LOCAL_CHAIN && (
        <a href={txUrl(receipt.tx)} target="_blank" rel="noreferrer" className="lbl underline">
          View transaction ↗
        </a>
      )}
    </section>
  );
}

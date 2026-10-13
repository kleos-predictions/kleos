"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useReadContract } from "wagmi";
import { decodeFunctionData, encodeFunctionData, parseUnits, type Address, type TransactionReceipt } from "viem";
import { DEMO_R, pools, type Market } from "@/lib/data";
import { PARAMS, effectiveBet, multiplier, payout } from "@/lib/math";
import { IS_LIVE, IS_LOCAL_CHAIN, KLEOS_ADDRESS, USD_ADDRESS, chain, publicClient, txUrl } from "@/lib/chain";
import { describeAccountError } from "@/lib/mera";
import { PROMPT_FREE_LIMIT, useKleosAccount } from "./account";
import { kleosAbi, kleosUsdAbi } from "@/lib/abi";
import { confirmTransaction, receiptEvent, type TransactionIntent } from "@/lib/transactions";
import { PendingTransactionNotice, usePendingTransaction } from "./pending-transaction";
import { ReputationActions } from "./reputation-actions";
import { tierOf, tierOfWad, TIER_NAMES, TIER_THRESHOLDS } from "@/lib/tiers";
import { BoostGauge } from "./boost-gauge";
import { LaurelBadge } from "./laurel";

const CHIPS = [10, 50, 100];

type Step = "account" | "funds" | "bet";
const STEPS: [Step, string][] = [["account", "Account"], ["funds", "Funds"], ["bet", "Bet"]];
type Receipt = { side: boolean; amount: number; eff: number; call: string; secs: string; tx?: string; address?: string; demo?: boolean };
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
  const transaction = usePendingTransaction(`bet:${KLEOS_ADDRESS}:${market.id}`);

  const account = useKleosAccount();
  const address = account.address;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const { data: rep } = useReadContract({
    address: KLEOS_ADDRESS,
    abi: kleosAbi,
    functionName: "reputation",
    args: address ? [address] : undefined,
    query: { enabled: IS_LIVE && Boolean(address) },
  });

  const r = IS_LIVE ? (rep ? Number(rep.r) / 1e18 : 0) : DEMO_R; // vested reputation
  const [liveQuote, setLiveQuote] = useState<{ sender?: string; amount: number; eff: bigint; mult: bigint; nMin: bigint; state: number; closeTime: bigint; yesMoney: bigint; noMoney: bigint; block: bigint } | null>(null);
  const [quoteError, setQuoteError] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!IS_LIVE) return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!IS_LIVE || amount < 1) return;
    let stopped = false;
    let pending = false;
    async function read() {
      if (pending) return;
      pending = true;
      try {
        const blockNumber = await publicClient.getBlockNumber();
        const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
        const [m, q, nMin] = await Promise.all([
          publicClient.readContract({ ...k, functionName: "getMarket", args: [BigInt(market.id)] }),
          address ? publicClient.readContract({ ...k, functionName: "quote", args: [BigInt(market.id), address, parseUnits(String(amount), 6)] }) : Promise.resolve(null),
          publicClient.readContract({ ...k, functionName: "N_MIN" }),
        ]);
        if (!stopped) {
          setLiveQuote({ sender: address, amount, eff: q?.[0] ?? 0n, mult: q?.[1] ?? 0n, nMin, state: m.state, closeTime: m.closeTime, yesMoney: m.yesMoney, noMoney: m.noMoney, block: blockNumber });
          setQuoteError(false);
        }
      } catch { if (!stopped) setQuoteError(true); }
      finally { pending = false; }
    }
    void read();
    const timer = setInterval(read, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [market.id, address, amount]);
  const quote = liveQuote?.sender === address && liveQuote?.amount === amount && !quoteError ? liveQuote : null;
  const activated = IS_LIVE ? Boolean(rep && quote && BigInt(rep.resolvedBets) >= quote.nMin) : true;
  const mult = IS_LIVE ? (address && quote ? Number(quote.mult) / 1e18 : 1) : activated ? multiplier(r) : 1;
  const p = IS_LIVE && quote ? { yesMoney: Number(quote.yesMoney) / 1e6, noMoney: Number(quote.noMoney) / 1e6 } : pools(market);
  const eff = IS_LIVE ? (address && quote ? Number(quote.eff) / 1e6 : null) : effectiveBet(amount, mult, pools(market).yesEff + pools(market).noEff);
  const winMoney = (side ? p.yesMoney : p.noMoney) + amount;
  const losingMoney = side ? p.noMoney : p.yesMoney;
  const ifRight = amount > 0 ? payout(amount, winMoney, losingMoney) : 0;
  const pays = amount > 0 ? ifRight / amount : 0;
  const tier = IS_LIVE ? tierOfWad(rep?.r ?? 0n) : tierOf(r);
  const next = TIER_THRESHOLDS[tier];
  const open = IS_LIVE ? Boolean(quote && quote.state === 0 && quote.closeTime > BigInt(now)) : market.status === "live" || market.status === "closing";

  const needsPrompt = amount > PROMPT_FREE_LIMIT;
  const callBytes = new TextEncoder().encode(call.trim()).length;
  const cta = IS_LIVE && !quote
    ? quoteError ? "Live quote unavailable" : "Reading live market…"
    : !open
    ? "Market closed"
    : busy
      ? "Placing bet…"
      : !IS_LIVE
        ? `Place bet · ${side ? "Yes" : "No"}`
        : account.status === "none"
          ? "Connect & review quote"
          : account.status === "locked"
            ? `Unlock & bet ${side ? "Yes" : "No"}`
            : needsPrompt
              ? `Confirm with passkey · ${side ? "Yes" : "No"}`
              : `Place bet · ${side ? "Yes" : "No"}`;

  async function placeBet() {
    if (inFlight.current || transaction.hasPending()) return;
    setError(null);
    const text = call.trim();
    if (!IS_LIVE) {
      setReceipt({ side, amount, eff: eff ?? amount, call: text, secs: "0.0", demo: true });
      return;
    }
    const started = clock();
    inFlight.current = true;
    setBusy(true);
    setStep("account");
    try {
      // The passkey prompt, when one is needed, is the first await in this click handler.
      const client = await account.authorize({ fresh: needsPrompt });
      if (!client?.account) return;
      const me = client.account;
      if (!quote?.sender || quote.sender.toLowerCase() !== me.address.toLowerCase()) {
        setError("Account connected. Review its live quote and place the bet again.");
        return;
      }
      setStep("funds");
      const value = parseUnits(String(amount), 6);
      await account.whenFunded(me.address, value);
      const balanceOf = () =>
        publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "balanceOf", args: [me.address] });
      const balance = await balanceOf();
      if (balance < value) {
        throw new Error(`Not enough test USD: you have ${money(Number(balance) / 1e6)}. Try a smaller bet.`);
      }
      const [allowance, trustedMarket] = await Promise.all([
        publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "allowance", args: [me.address, KLEOS_ADDRESS!] }),
        publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "market" }),
      ]);
      // kUSD trusts the Kleos market, so the first bet is a single transaction.
      if (trustedMarket.toLowerCase() !== KLEOS_ADDRESS!.toLowerCase() && allowance < value) {
        const approveTx = await client.writeContract({
          account: me, chain, address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "approve", args: [KLEOS_ADDRESS!, value],
        });
        await confirmTransaction(publicClient, approveTx, { sender: me.address, to: USD_ADDRESS!, data: encodeFunctionData({ abi: kleosUsdAbi, functionName: "approve", args: [KLEOS_ADDRESS!, value] }) });
      }
      // Revalidate for the account that actually authorized, not a previous render's identity.
      const quoteBlock = await publicClient.getBlock();
      const [currentMarket, currentQuote] = await Promise.all([
        publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "getMarket", args: [BigInt(market.id)], blockNumber: quoteBlock.number }),
        publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "quote", args: [BigInt(market.id), me.address, value], blockNumber: quoteBlock.number }),
      ]);
      if (currentMarket.state !== 0 || currentMarket.closeTime <= quoteBlock.timestamp) throw new Error("This market is closed.");
      if (quote?.sender?.toLowerCase() === me.address.toLowerCase() && currentQuote[0] !== quote.eff) throw new Error("Your applied weight changed. Review the refreshed quote and place the bet again.");
      setStep("bet");
      const tx = text
        ? await client.writeContract({
            account: me, chain, address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "betWithCall", args: [BigInt(market.id), side, value, text],
          })
        : await client.writeContract({
            account: me, chain, address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "bet", args: [BigInt(market.id), side, value],
          });
      const data = text
        ? encodeFunctionData({ abi: kleosAbi, functionName: "betWithCall", args: [BigInt(market.id), side, value, text] })
        : encodeFunctionData({ abi: kleosAbi, functionName: "bet", args: [BigInt(market.id), side, value] });
      const intent = { sender: me.address, to: KLEOS_ADDRESS!, data };
      const confirmed = await transaction.confirm(tx, intent);
      showConfirmedBet(confirmed, intent, ((clock() - started) / 1000).toFixed(1));
    } catch (e) {
      setError(describeAccountError(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
      setStep(null);
    }
  }

  function showConfirmedBet(confirmed: TransactionReceipt, intent: TransactionIntent, seconds = "—") {
    const decoded = decodeFunctionData({ abi: kleosAbi, data: intent.data });
    if (decoded.functionName !== "bet" && decoded.functionName !== "betWithCall") throw new Error("The saved transaction is not this market's bet.");
    const [id, selectedSide, value] = decoded.args;
    if (id !== BigInt(market.id)) throw new Error("The saved transaction belongs to another market.");
    const text = decoded.functionName === "betWithCall" ? decoded.args[3] : "";
    const placed = receiptEvent<{ marketId: bigint; user: Address; side: boolean; amount: bigint; effective: bigint }>(confirmed, KLEOS_ADDRESS!, kleosAbi, "BetPlaced", (a) => a.marketId === id && a.user.toLowerCase() === intent.sender.toLowerCase() && a.side === selectedSide && a.amount === value);
    setReceipt({ side: placed.side, amount: Number(placed.amount) / 1e6, eff: Number(placed.effective) / 1e6, address: intent.sender, call: text, secs: seconds, tx: confirmed.transactionHash });
    transaction.complete();
    setCall("");
    router.refresh();
  }

  async function checkPending() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try { const result = await transaction.check(); showConfirmedBet(result.receipt, result.intent); }
    catch (failure) { setError(describeAccountError(failure)); }
    finally { inFlight.current = false; }
  }

  const panel = (
    <div className="flex flex-col gap-4">
      <PendingTransactionNotice transaction={transaction} onCheck={() => void checkPending()} />
      {receipt ? (
        <BetReceipt receipt={receipt} address={receipt.address ?? address} onAgain={() => setReceipt(null)} />
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
            <span className="font-dot text-[34px] leading-none font-black text-accent">{eff === null ? address ? "Quote unavailable" : "Connect to quote" : money(eff)}</span>
            <span className="lbl mt-2">
              {IS_LIVE && !quote ? "Payout estimate unavailable" : <>At these pools: {money(ifRight)} · {pays.toFixed(2)}× before bonus</>}
            </span>
          </div>
        </div>

        {IS_LIVE && <p className="text-xs text-muted">Later bets can change your payout. Bonus eligibility is determined at settlement.{quote && ` Quote block ${quote.block}.`}</p>}
        {quoteError && <p role="status" className="text-sm text-muted">The chain could not be read. Trading is paused until a fresh quote is available.</p>}
        <div className="flex flex-col gap-1 rounded-[12px] border border-line p-3">
          <span className="lbl !text-[11px]">Resolves by these rules · fixed on-chain</span>
          <p className="text-sm leading-snug text-ink">{market.criteria}</p>
          <span className="lbl !text-[11px]">Source: {market.oracle}</span>
        </div>

        <button className={`btn ${side ? "btn-yes" : "btn-no-active"} w-full !min-h-14 !text-base`} onClick={placeBet} disabled={!open || amount < 1 || busy || callBytes > 140 || Boolean(transaction.pending)}>
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
        {(!IS_LIVE || rep) && <LaurelBadge r={r} rawR={IS_LIVE ? rep?.r.toString() : undefined} size={52} />}
        <div className="flex flex-1 flex-col gap-1">
          <span className="lbl">Your tier</span>
          <span className="font-dot text-2xl font-black">{IS_LIVE && !rep ? address ? "Reputation unavailable" : "Connect to view your tier" : tier ? `TIER ${TIER_NAMES[tier]}` : "NO TIER YET"}</span>
          {(!IS_LIVE || rep) && <span className="lbl !text-[11px]">
            R = {r.toFixed(1)}
            {next !== undefined && ` · ${(next - r).toFixed(1)} to tier ${TIER_NAMES[tier + 1]}`}
            {!activated && ` · boost unlocks after ${IS_LIVE ? quote?.nMin ?? "the required number of" : PARAMS.nMin} resolved bets`}
          </span>}
        </div>
        {address && (
          <Link href={`/profile/${address}`} className="lbl !text-ink underline">
            History
          </Link>
        )}
      </section>
      {IS_LIVE && <ReputationActions />}
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
        <span className="lbl">{receipt.demo ? "Demo · not on-chain" : `Confirmed on ${IS_LOCAL_CHAIN ? "local chain" : "Monad testnet"} in ${receipt.secs}s`}</span>
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

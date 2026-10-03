"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { encodeFunctionData, parseUnits, type Address } from "viem";
import { IS_LIVE, KLEOS_ADDRESS, USD_ADDRESS, chain, publicClient } from "@/lib/chain";
import { kleosAbi, kleosUsdAbi } from "@/lib/abi";
import { describeAccountError } from "@/lib/mera";
import { CATEGORIES } from "@/lib/data";
import { useKleosAccount } from "./account";
import { ensureUsdAllowance } from "@/lib/usd-spend";
import { receiptEvent } from "@/lib/transactions";
import { PendingTransactionNotice, usePendingTransaction } from "./pending-transaction";

const COST = parseUnits("27", 6); // $25 bond + $2 fee
const field = "rounded-[12px] border border-line bg-ground px-4 py-3 text-ink outline-none placeholder:text-muted focus:border-line-strong";

/** Market creation for the team and tier-V traders. The bond comes back unless the court rules the question ambiguous. */
export function CreateMarketForm() {
  const account = useKleosAccount();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState(1);
  const [oracle, setOracle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [close, setClose] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const transaction = usePendingTransaction(`create-market:${KLEOS_ADDRESS}`);

  const { data: rep } = useReadContract({
    address: KLEOS_ADDRESS,
    abi: kleosAbi,
    functionName: "reputation",
    args: account.address ? [account.address] : undefined,
    query: { enabled: IS_LIVE && Boolean(account.address) },
  });
  const { data: owner } = useReadContract({ address: KLEOS_ADDRESS, abi: kleosAbi, functionName: "owner", query: { enabled: IS_LIVE } });

  const r = rep ? Number(rep.r) / 1e18 : 0;
  const isTeam = Boolean(owner && account.address && owner.toLowerCase() === account.address.toLowerCase());
  const { data: createThreshold } = useReadContract({ address: KLEOS_ADDRESS, abi: kleosAbi, functionName: "CREATOR_MIN_R", query: { enabled: IS_LIVE } });
  const eligible = isTeam || Boolean(rep && createThreshold !== undefined && rep.r >= createThreshold && !rep.flagged);
  const closeTs = close ? Math.floor(new Date(`${close}:00Z`).getTime() / 1000) : 0;
  const ready = question.trim().length >= 10 && oracle.trim() && criteria.trim().length >= 10 && closeTs > 0;

  async function submit() {
    if (inFlight.current || transaction.hasPending()) return;
    setError(null);
    if (closeTs <= Date.now() / 1000) return setError("The close time has to be in the future.");
    inFlight.current = true;
    setBusy(true);
    try {
      const client = await account.authorize({ fresh: true }); // first await: a bond always asks for the passkey
      if (!client?.account) return;
      await account.whenFunded(client.account.address);
      const actualOwner = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "owner" });
      const actualTeam = actualOwner.toLowerCase() === client.account.address.toLowerCase();
      if (!actualTeam) {
        const balance = await publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "balanceOf", args: [client.account.address] });
        if (balance < COST) await account.requestFunds(client.account.address);
        await ensureUsdAllowance(client, COST);
      }
      const hash = await client.writeContract({
        account: client.account,
        chain,
        address: KLEOS_ADDRESS!,
        abi: kleosAbi,
        functionName: "createMarket",
        args: [question.trim(), category, oracle.trim(), criteria.trim(), BigInt(closeTs)],
      });
      const confirmed = await transaction.confirm(hash, { sender: client.account.address, to: KLEOS_ADDRESS!, data: encodeFunctionData({ abi: kleosAbi, functionName: "createMarket", args: [question.trim(), category, oracle.trim(), criteria.trim(), BigInt(closeTs)] }) });
      const created = receiptEvent<{ marketId: bigint; creator: Address }>(confirmed, KLEOS_ADDRESS!, kleosAbi, "MarketCreated", (a) => a.creator.toLowerCase() === client.account!.address.toLowerCase());
      transaction.complete();
      router.push(`/market/${created.marketId}`);
    } catch (e) {
      setError(describeAccountError(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function checkPending() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const { receipt, intent } = await transaction.check();
      const created = receiptEvent<{ marketId: bigint; creator: Address }>(receipt, KLEOS_ADDRESS!, kleosAbi, "MarketCreated", (a) => a.creator.toLowerCase() === intent.sender.toLowerCase());
      transaction.complete();
      router.push(`/market/${created.marketId}`);
    } catch (failure) { setError(describeAccountError(failure)); }
    finally { inFlight.current = false; }
  }

  if (!IS_LIVE) return <p className="card lbl p-8 text-center">Market creation needs the live contracts. This is demo mode.</p>;

  if (!eligible && !transaction.pending) {
    return (
      <div className="card flex flex-col gap-3 p-8">
        <span className="font-dot text-[28px] font-black">TIER V ONLY</span>
        <p className="leading-relaxed text-muted">
          Market creation is available to the team and unflagged accounts at tier V (R ≥ 36). {account.address ? `Your R is ${r.toFixed(1)}.` : "Start with a passkey to see your tier."}
        </p>
        {account.status !== "unlocked" && <button className="btn btn-no" onClick={() => { void account.authorize().catch((e) => setError(describeAccountError(e))); }}>Connect account</button>}
        {error && <p role="alert" className="text-sm">{error}</p>}
      </div>
    );
  }

  return (
    <form
      className="card flex flex-col gap-5 p-6 md:p-8"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <PendingTransactionNotice transaction={transaction} onCheck={() => void checkPending()} />
      <label className="flex flex-col gap-2">
        <span className="lbl">Question</span>
        <input className={`${field} text-lg`} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={140} placeholder="Will … by …?" />
      </label>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="lbl">Category</span>
          <select className={field} value={category} onChange={(e) => setCategory(Number(e.target.value))}>
            {CATEGORIES.map((c, i) => (
              <option key={c} value={i + 1}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2">
          <span className="lbl">Closes (UTC)</span>
          <input className={field} type="datetime-local" value={close} onChange={(e) => setClose(e.target.value)} />
        </label>
      </div>

      <label className="flex flex-col gap-2">
        <span className="lbl">Source of truth</span>
        <input className={field} value={oracle} onChange={(e) => setOracle(e.target.value)} placeholder="e.g. Official league result, Chainlink BTC/USD" />
      </label>

      <label className="flex flex-col gap-2">
        <span className="lbl">Resolution criteria · written now, fixed forever</span>
        <textarea
          className={`${field} min-h-28`}
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          placeholder="YES if … according to … at … UTC. Say exactly what counts, so nobody has to interpret it later."
        />
      </label>

      <div className="flex flex-col gap-1 rounded-[12px] bg-card-alt p-4 text-sm">
        {isTeam ? (
          <span className="text-muted">Curated market: no bond or fee for the team.</span>
        ) : (
          <>
            <span>
              <span className="text-ink">$25 bond</span> <span className="text-muted">· back when the market resolves YES or NO</span>
            </span>
            <span>
              <span className="text-ink">$2 fee</span> <span className="text-muted">· protocol revenue</span>
            </span>
            <span className="mt-1 text-muted">If the Kleos Court rules the question ambiguous, everyone is refunded and the bond funds future bonuses.</span>
          </>
        )}
      </div>

      <button className="btn btn-yes !min-h-14 !text-base" disabled={!ready || busy || Boolean(transaction.pending)}>
        {busy ? "Creating…" : isTeam ? "Create market" : "Create market · $27"}
      </button>
      {error && (
        <p role="alert" className="rounded-[12px] border border-accent px-4 py-3 text-sm">
          {error}
        </p>
      )}
    </form>
  );
}

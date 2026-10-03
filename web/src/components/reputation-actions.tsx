"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFunctionData, isAddress } from "viem";
import { useRouter } from "next/navigation";
import { kleosAbi } from "@/lib/abi";
import { KLEOS_ADDRESS, chain, publicClient, shortAddress } from "@/lib/chain";
import { describeAccountError } from "@/lib/mera";
import { useKleosAccount } from "./account";
import { PendingTransactionNotice, usePendingTransaction } from "./pending-transaction";

async function readStatus(address: `0x${string}`) {
  const blockNumber = await publicClient.getBlockNumber();
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  const [rep, threshold, nMin] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "reputation", args: [address] }),
    publicClient.readContract({ ...k, functionName: "JUROR_MIN_R" }),
    publicClient.readContract({ ...k, functionName: "N_MIN" }),
  ]);
  return { address, rep, threshold, nMin };
}

/** Direct routes for pending reputation and court opt-in; availability uses exact contract values. */
export function ReputationActions() {
  const account = useKleosAccount();
  const router = useRouter();
  const transaction = usePendingTransaction(`reputation:${KLEOS_ADDRESS}`);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(timer); }, []);
  const [snap, setSnap] = useState<Awaited<ReturnType<typeof readStatus>> | null>(null);
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pruneAddress, setPruneAddress] = useState("");
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    if (!account.address) return;
    try {
      const next = await readStatus(account.address);
      if (seq === sequence.current) { setSnap(next); setReadError(false); }
    } catch { if (seq === sequence.current) setReadError(true); }
  }, [account.address]);
  const invalidateRead = useCallback(() => { sequence.current++; }, []);
  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    return () => { clearTimeout(timer); invalidateRead(); };
  }, [refresh, invalidateRead]);

  async function act(action: "vest" | "joinCourt" | "leaveCourt" | "pruneJuror") {
    if (inFlight.current || transaction.hasPending()) return;
    inFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const client = await account.authorize({ fresh: action === "joinCourt" }); // first await in the click handler
      if (!client?.account) return;
      await account.whenFunded(client.account.address);
      const args = action === "vest" ? [client.account.address] : action === "pruneJuror" ? [pruneAddress] : [];
      const data = encodeFunctionData({ abi: kleosAbi, functionName: action, args } as never);
      const hash = await client.writeContract({ account: client.account, chain, address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: action, args } as never);
      await transaction.confirm(hash, { sender: client.account.address, to: KLEOS_ADDRESS!, data });
      transaction.complete();
      setNotice(action === "vest" ? "Pending reputation vested." : action === "joinCourt" ? "Court membership confirmed. Check disputed markets for assignments." : action === "leaveCourt" ? "You left the draw pool. Existing jury assignments still need your vote." : "The ineligible juror was removed from the draw pool.");
      await refresh(); router.refresh();
    } catch (e) { setError(describeAccountError(e)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  if (!account.address && !transaction.pending) return null;
  const current = !readError && account.address && snap?.address.toLowerCase() === account.address.toLowerCase() ? snap : null;
  const eligible = Boolean(current && current.rep.r >= current.threshold && !current.rep.flagged && BigInt(current.rep.resolvedBets) >= current.nMin);
  return <section className="card flex flex-col gap-3 p-5">
    <span className="lbl">Your reputation and court{account.address && ` · ${shortAddress(account.address)}`}</span>
    {current ? <>
      <p className="text-sm text-muted">Pending R: {(Number(current.rep.pending) / 1e18).toFixed(2)}{current.rep.pending > 0n && ` · available from ${new Date(Number(current.rep.vestAt) * 1000).toLocaleString()}`}{current.rep.flagged && " · under review"}.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-no" disabled={busy || Boolean(transaction.pending) || current.rep.pending === 0n || current.rep.flagged || current.rep.vestAt > BigInt(now)} onClick={() => void act("vest")}>Vest pending R</button>
        <button className="btn btn-no" disabled={busy || Boolean(transaction.pending) || !eligible} onClick={() => void act("joinCourt")}>Join juror pool</button>
        <button className="btn btn-no" disabled={busy || Boolean(transaction.pending)} onClick={() => void act("leaveCourt")}>Leave juror pool</button>
      </div>
      <p className="text-xs text-muted">Joining needs R ≥ {Number(current.threshold) / 1e18}, {current.nMin.toString()} resolved bets and no flag. Leaving the pool does not cancel an assigned jury duty.</p>
    </> : <p role="status" className="text-sm text-muted">{readError ? "Reputation could not be read. Refresh to try again." : "Reading reputation…"}</p>}
    <button className="lbl w-fit underline" disabled={busy} onClick={() => void refresh()}>Refresh reputation</button>
    <details className="text-sm"><summary className="cursor-pointer text-muted">Remove an ineligible juror</summary><div className="mt-3 flex flex-col gap-2"><input value={pruneAddress} onChange={(e) => setPruneAddress(e.target.value)} placeholder="Juror address to prune" aria-label="Juror address to prune" className="rounded-[10px] border border-line p-2 font-mono" /><button className="btn btn-no" disabled={busy || Boolean(transaction.pending) || !isAddress(pruneAddress)} onClick={() => void act("pruneJuror")}>Prune juror</button><p className="text-xs text-muted">Anyone can remove a pool member who is flagged or below the juror R threshold.</p></div></details>
    <PendingTransactionNotice transaction={transaction} onCheck={() => { void transaction.check().then(async () => { transaction.complete(); setNotice("Submitted reputation or court transaction confirmed."); await refresh(); router.refresh(); }).catch(e => setError(describeAccountError(e))); }} />
    {notice && <p role="status" className="text-sm">{notice}</p>}{error && <p role="alert" className="text-sm">{error}</p>}
  </section>;
}

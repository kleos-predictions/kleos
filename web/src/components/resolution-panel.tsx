"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Address, type Hex, type TransactionReceipt, type WalletClient } from "viem";
import { KLEOS_ADDRESS, SOCIAL_ADDRESS, chain, publicClient, shortAddress } from "@/lib/chain";
import { kleosAbi, kleosSocialAbi } from "@/lib/abi";
import { describeAccountError } from "@/lib/mera";
import { RESOLUTION_STAGES } from "@/lib/data";
import { useKleosAccount } from "./account";
import { ResolutionTrack } from "./resolution-track";
import { PendingTransactionNotice, usePendingTransaction } from "./pending-transaction";
import { readBettorDiscovery } from "@/lib/bettors";
import { ensureUsdAllowance } from "@/lib/usd-spend";

const STATE = { Open: 0, Proposed: 1, Disputed: 2, Resolved: 3 } as const;
const VOTES = [
  { value: 1, label: "Yes" },
  { value: 2, label: "No" },
  { value: 3, label: "Ambiguous" },
] as const;
const BOND = 10_000_000n;
const DISPUTE_BOND = 15_000_000n;

type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;

let parameters: Promise<{ disputeWindow: bigint; courtPeriod: bigint; resolverMinR: bigint; expiryWindows: bigint }> | undefined;
function readParameters() {
  if (!parameters) {
    const k = { address: KLEOS_ADDRESS!, abi: kleosAbi } as const;
    parameters = Promise.all([
      publicClient.readContract({ ...k, functionName: "DISPUTE_WINDOW" }), publicClient.readContract({ ...k, functionName: "COURT_PERIOD" }),
      publicClient.readContract({ ...k, functionName: "RESOLVER_MIN_R" }), publicClient.readContract({ ...k, functionName: "EXPIRY_WINDOWS" }),
    ]).then(([disputeWindow, courtPeriod, resolverMinR, expiryWindows]) => ({ disputeWindow, courtPeriod, resolverMinR, expiryWindows })).catch((e) => { parameters = undefined; throw e; });
  }
  return parameters;
}

/**
 * Same as Kleos.voteCommitment: keccak256(abi.encode(id, round, juror, vote, salt)). Computed
 * here, never with an eth_call, so the hidden vote and its salt never leave the device before
 * the reveal.
 */
function voteCommitment(id: bigint, round: number, juror: Address, vote: number, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "uint8" }, { type: "bytes32" }],
      [id, round, juror, vote, salt],
    ),
  );
}

/** Evidence links are shown only when they're plain https URLs. Anything else is shown as text. */
const MAX_EVIDENCE = 300;
function safeEvidenceUrl(uri: string): string | null {
  if (uri.length > MAX_EVIDENCE) return null;
  try {
    return new URL(uri).protocol === "https:" ? uri : null;
  } catch {
    return null;
  }
}

function Evidence({ uri }: { uri: string }) {
  const href = safeEvidenceUrl(uri);
  const text = uri.length > 80 ? `${uri.slice(0, 80)}…` : uri;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className="truncate text-sm underline">
      Evidence: {text} ↗
    </a>
  ) : (
    <p className="truncate text-sm text-muted" title="Not an https link, so it isn't clickable">
      Evidence (not a link): {text}
    </p>
  );
}

async function readSnapshot(id: bigint, me: Address | undefined) {
  const blockNumber = await publicClient.getBlockNumber();
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi, blockNumber } as const;
  const [market, court, payout, owner, params] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "getMarket", args: [id] }),
    publicClient.readContract({ ...k, functionName: "getCourt", args: [id] }),
    publicClient.readContract({ ...k, functionName: "payouts", args: [id] }),
    publicClient.readContract({ ...k, functionName: "owner" }), readParameters(),
  ]);
  const jury = market.state === STATE.Disputed && court.round > 0 ? await publicClient.readContract({ ...k, functionName: "getJury", args: [id, court.round] }) : [];
  const [names, juryVotes, juryCommits] = await Promise.all([
    SOCIAL_ADDRESS && jury.length ? publicClient.readContract({ address: SOCIAL_ADDRESS, abi: kleosSocialAbi, functionName: "namesOf", args: [[...jury]], blockNumber }).catch(() => [] as readonly string[]) : Promise.resolve([] as readonly string[]),
    Promise.all(jury.map((j) => publicClient.readContract({ ...k, functionName: "votes", args: [id, court.round, j] }))),
    Promise.all(jury.map((j) => publicClient.readContract({ ...k, functionName: "commitments", args: [id, court.round, j] }))),
  ]);
  const [rep, hasBet, bonus, bonusClaimed] = me ? await Promise.all([
    publicClient.readContract({ ...k, functionName: "reputation", args: [me] }), publicClient.readContract({ ...k, functionName: "hasBet", args: [id, me] }),
    market.state === STATE.Resolved ? publicClient.readContract({ ...k, functionName: "bonusOf", args: [id, me] }) : Promise.resolve(0n),
    market.state === STATE.Resolved ? publicClient.readContract({ ...k, functionName: "bonusClaimed", args: [id, me] }) : Promise.resolve(false),
  ]) : [undefined, false, 0n, false] as const;
  return {
    market, court, blockNumber, accountAddress: me, marketId: id,
    disputeWindow: Number(params.disputeWindow), resolverMinR: params.resolverMinR, expiryWindows: Number(params.expiryWindows),
    isOwner: Boolean(me && owner.toLowerCase() === me.toLowerCase()), courtPeriod: Number(params.courtPeriod), bonusOpen: payout[3],
    jury: jury.map((address, i) => ({ address, name: names[i] || undefined, vote: juryVotes[i], committed: juryCommits[i] !== `0x${"0".repeat(64)}` })),
    me: { r: rep?.r ?? 0n, flagged: rep?.flagged ?? false, hasBet, bonus, bonusClaimed },
  };
}

/** The message a juror signs to derive their vote salt: deterministic, so any device with the passkey rebuilds it. */
const saltMessage = (id: bigint, round: number) =>
  `Kleos jury vote\nchain: ${chain.id}\ncontract: ${KLEOS_ADDRESS!.toLowerCase()}\nmarket: ${id}\nround: ${round}`;

async function deriveSalt(client: WalletClient, id: bigint, round: number): Promise<Hex> {
  return keccak256(await client.signMessage({ account: client.account!, message: saltMessage(id, round) }));
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const clockText = (seconds: number) => {
  const s = Math.max(0, seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Live resolution and Kleos Court for one market: shows only what each phase allows. */
export function ResolutionPanel({ marketId, oracle }: { marketId: number; oracle: string }) {
  const id = BigInt(marketId);
  const account = useKleosAccount();
  const router = useRouter();
  const now = useNow();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const transaction = usePendingTransaction(`resolution:${KLEOS_ADDRESS}:${marketId}`);
  const [evidence, setEvidence] = useState("");
  const [readError, setReadError] = useState(false);
  const [readAt, setReadAt] = useState(0);
  const reading = useRef(false);
  const sequence = useRef(0);
  const acting = useRef(false);

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const request = ++sequence.current;
    try {
      const next = await readSnapshot(id, account.address);
      if (request === sequence.current) { setSnap(next); setReadError(false); setReadAt(Math.floor(Date.now() / 1000)); }
    } catch { if (request === sequence.current) setReadError(true); }
    finally { reading.current = false; }
  }, [id, account.address]);

  const invalidateRead = useCallback(() => { sequence.current++; }, []);
  // A previous account or market's terminal snapshot must not stop retries after a skipped read.
  const final = Boolean(snap && !readError && snap.marketId === id &&
    snap.accountAddress?.toLowerCase() === account.address?.toLowerCase() &&
    snap.market.state === STATE.Resolved && snap.bonusOpen && (snap.me.bonus === 0n || snap.me.bonusClaimed));
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = final ? undefined : setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      if (t !== undefined) clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      invalidateRead();
    };
  }, [refresh, invalidateRead, final]);

  /** Runs one on-chain action. `fresh` asks for the passkey again (bonds and jury votes). */
  async function act(label: string, fresh: boolean, run: (client: WalletClient) => Promise<TransactionReceipt | void>, bond?: bigint) {
    if (acting.current || transaction.hasPending()) return;
    acting.current = true;
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      const client = await account.authorize({ fresh }); // first await: may show the passkey prompt
      if (!client?.account) return;
      await account.whenFunded(client.account.address, bond ?? 0n);
      if (bond) {
        await ensureUsdAllowance(client, bond);
      }
      await run(client);
      await refresh();
      router.refresh();
    } catch (e) {
      setError(describeAccountError(e));
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  const write = async (client: WalletClient, functionName: string, args: readonly unknown[]) => {
    const data = encodeFunctionData({ abi: kleosAbi, functionName, args } as never);
    const hash = await client.writeContract({ account: client.account!, chain, address: KLEOS_ADDRESS!, abi: kleosAbi, functionName, args } as never);
    const receipt = await transaction.confirm(hash, { sender: client.account!.address, to: KLEOS_ADDRESS!, data });
    transaction.complete();
    return receipt;
  };

  async function checkPending() {
    if (acting.current) return;
    acting.current = true;
    setError(null); setNotice(null);
    try {
      await transaction.check();
      transaction.complete();
      setNotice("The submitted transaction is confirmed. Review the refreshed market state before the next action.");
      await refresh(); router.refresh();
    } catch (failure) { setError(describeAccountError(failure)); }
    finally { acting.current = false; }
  }

  if (!snap || snap.marketId !== id || snap.accountAddress?.toLowerCase() !== account.address?.toLowerCase()) return <div><PendingTransactionNotice transaction={transaction} onCheck={() => void checkPending()} /><p className="lbl py-6 text-center" role="status">{readError ? "Live resolution state could not be read. Retrying…" : "Reading the market from the chain…"}</p>{error && <p role="alert" className="text-sm">{error}</p>}</div>;
  const stale = readError || now - readAt > 30 || Boolean(transaction.pending);

  const { market: m, court } = snap;
  const me = account.address?.toLowerCase();
  const closed = now >= Number(m.closeTime);
  const windowEnds = Number(m.proposedAt) + snap.disputeWindow;
  const iAmJuror = snap.jury.find((j) => j.address.toLowerCase() === me);
  // Mirrors Kleos._requireResolver: the team can always propose; traders need tier II, no position,
  // no flag, and can't resolve a market they created.
  const isCreator = m.creator.toLowerCase() === me;
  const canResolve = !snap.me.hasBet && (snap.isOwner || (snap.me.r >= snap.resolverMinR && !snap.me.flagged && !isCreator));
  const expiresAt = Number(m.closeTime) + snap.expiryWindows * snap.disputeWindow;
  const isProposer = m.proposer.toLowerCase() === me;

  const stage =
    m.state === STATE.Resolved ? 4 : m.state === STATE.Disputed ? 3 : m.state === STATE.Proposed ? (now < windowEnds ? 3 : 2) : closed ? 1 : 0;
  const stageLabels: string[] = [...RESOLUTION_STAGES];
  if (m.state === STATE.Disputed) stageLabels[3] = "Kleos Court";

  const outcomeText = (yes: boolean) => (yes ? "YES" : "NO");


  return (
    <div className="flex flex-col gap-5">
      <PendingTransactionNotice transaction={transaction} onCheck={() => void checkPending()} />
      <ResolutionTrack stage={stage} labels={stageLabels} />
      <p role="status" className="text-xs text-muted">{stale ? "This resolution snapshot is stale. Actions are paused until the chain can be read." : `Snapshot block ${snap.blockNumber} · refreshed ${Math.max(0, now - readAt)}s ago`}</p>

      {/* Open, not closed yet */}
      {m.state === STATE.Open && !closed && (
        <p className="text-sm text-muted">
          Closes{" "}
          <span className="font-mono text-ink">
            {Number(m.closeTime) - now < 3600
              ? `in ${clockText(Number(m.closeTime) - now)}`
              : new Date(Number(m.closeTime) * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"}
          </span>
          . After that, a trader with earned reputation and no position proposes the outcome from <span className="text-ink">{oracle}</span>.
        </p>
      )}

      {/* Closed, waiting for a proposal */}
      {m.state === STATE.Open && closed && (
        <div className="flex flex-col gap-3 rounded-[12px] bg-card-alt p-4">
          <span className="lbl !text-ink">Propose the outcome · $10 bond</span>
          {canResolve ? (
            <>
              <input
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="https:// link to the evidence (official result, feed, article)"
                aria-label="Evidence link"
                maxLength={MAX_EVIDENCE}
                className="rounded-[10px] border border-line bg-ground px-3 py-2.5 text-sm text-ink outline-none placeholder:text-muted focus:border-line-strong"
              />
              <div className="grid grid-cols-2 gap-2">
                {[true, false].map((yes) => (
                  <span key={String(yes)} className="contents">
                    {<ActionButton label={`Propose ${outcomeText(yes)}`} onClick={() =>
                        act(`Propose ${outcomeText(yes)}`, true, (c) => write(c, "propose", [id, yes, keccak256(toHex(evidence.trim())), evidence.trim()]), BOND)} variant={yes ? "btn-yes" : "btn-no-active"} disabled={!safeEvidenceUrl(evidence.trim())} busy={Boolean(busy)} stale={stale} />}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">
              {snap.me.hasBet
                ? "You have a position in this market, so you can't resolve it."
                : isCreator
                  ? "You created this market, so someone else resolves it."
                  : "Proposing needs tier II (R ≥ 4) and no position here."}
            </p>
          )}
          {now >= expiresAt &&
            <ActionButton label={"Void: nobody proposed"} onClick={() => act("Void: nobody proposed", false, (c) => write(c, "expire", [id]))} variant={"btn-no"} busy={Boolean(busy)} stale={stale} />}
        </div>
      )}

      {/* Proposed: dispute window */}
      {m.state === STATE.Proposed && (
        <div className="flex flex-col gap-3 rounded-[12px] bg-card-alt p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="lbl !text-ink">
              Proposed <span className={m.proposedOutcome ? "text-accent" : "text-lavender"}>{outcomeText(m.proposedOutcome)}</span>
            </span>
            <span className="lbl">{now < windowEnds ? `Final in ${clockText(windowEnds - now)}` : "Dispute window over"}</span>
          </div>
          {m.evidenceURI && <Evidence uri={m.evidenceURI} />}
          {now < windowEnds
            ? !isProposer && <ActionButton label={"Dispute · $15 bond"} onClick={() => act("Dispute · $15 bond", true, (c) => write(c, "dispute", [id]), DISPUTE_BOND)} variant={"btn-no"} busy={Boolean(busy)} stale={stale} />
            : <ActionButton label={"Finalize"} onClick={() => act("Finalize", false, (c) => write(c, "finalize", [id]))} busy={Boolean(busy)} stale={stale} />}
          <p className="text-xs text-muted">A dispute sends this to the Kleos Court. If the jury upholds the proposal, the $15 goes to the jurors.</p>
        </div>
      )}

      {/* Disputed: Kleos Court */}
      {m.state === STATE.Disputed && (
        <div className="flex flex-col gap-4 rounded-[12px] bg-card-alt p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="lbl !text-ink">Kleos Court · round {court.round}</span>
            <span className="lbl">
              {now < Number(court.commitEnd)
                ? `Hidden votes · ${clockText(Number(court.commitEnd) - now)}`
                : now < Number(court.revealEnd)
                  ? `Reveals · ${clockText(Number(court.revealEnd) - now)}`
                  : "Ready to close"}
            </span>
          </div>
          <p className="text-sm text-muted">
            Proposed <span className="text-ink">{outcomeText(m.proposedOutcome)}</span>, disputed. {snap.jury.length} tier-V jurors with no position vote in secret;
            3 matching votes decide.
          </p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            {snap.jury.map((j) => (
              <li key={j.address} className="flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2">
                <span className="truncate text-sm">{j.name ? `@${j.name}` : <span className="font-mono">{shortAddress(j.address)}</span>}</span>
                <span className="lbl !text-[10px]">
                  {j.vote ? VOTES[j.vote - 1].label : j.committed ? "Voted · hidden" : "Waiting"}
                </span>
              </li>
            ))}
          </ul>
          {court.revealed > 0 && (
            <p className="lbl">
              Tally · Yes {court.tally[1]} · No {court.tally[2]} · Ambiguous {court.tally[3]}
            </p>
          )}

          {iAmJuror && now < Number(court.commitEnd) && (
            <div className="flex flex-col gap-2">
              <span className="lbl !text-accent">You were drawn as a juror</span>
              <div className="grid grid-cols-3 gap-2">
                {VOTES.map((v) => (
                  <span key={v.value} className="contents">
                    {<ActionButton label={v.label} onClick={() =>
                      act(v.label, true, async (c) => {
                        const salt = await deriveSalt(c, id, court.round);
                        const commitment = voteCommitment(id, court.round, c.account!.address, v.value, salt);
                        const hash = await write(c, "commitVote", [id, commitment]);
                        setNotice(`Hidden vote confirmed. You'll reveal it after ${clockText(Number(court.commitEnd) - now)}; nothing was saved on this device.`);
                        return hash;
                      })} variant={iAmJuror.committed ? "btn-no" : v.value === 1 ? "btn-yes" : v.value === 2 ? "btn-no-active" : "btn-no"} busy={Boolean(busy)} stale={stale} />}
                  </span>
                ))}
              </div>
              {iAmJuror.committed && <p className="text-xs text-muted">Your hidden vote is in. Voting again replaces it.</p>}
            </div>
          )}

          {iAmJuror && iAmJuror.committed && !iAmJuror.vote && now >= Number(court.commitEnd) && now < Number(court.revealEnd) &&
            <ActionButton label={"Reveal my vote"} onClick={() =>
              act("Reveal my vote", false, async (c) => {
                // Rebuild the salt from the passkey and find which vote matches the hidden commitment.
                const salt = await deriveSalt(c, id, court.round);
                const committed = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "commitments", args: [id, court.round, c.account!.address] });
                for (const v of VOTES) {
                  if (voteCommitment(id, court.round, c.account!.address, v.value, salt) === committed) return write(c, "revealVote", [id, v.value, salt]);
                }
                throw new Error("This passkey didn't cast the hidden vote for this round.");
              })} busy={Boolean(busy)} stale={stale} />}

          {(now >= Number(court.revealEnd) || (court.revealed > 0 && court.revealed === snap.jury.length)) &&
            <ActionButton label={"Close the court"} onClick={() => act("Close the court", false, (c) => write(c, "closeCourt", [id]))} busy={Boolean(busy)} stale={stale} />}
        </div>
      )}

      {/* Resolved */}
      {m.state === STATE.Resolved && (
        <div className="flex flex-col gap-3 rounded-[12px] bg-card-alt p-4">
          <span className="font-dot text-[28px] leading-none font-black">
            {m.voided ? "AMBIGUOUS · REFUNDED" : <>RESOLVED <span className={m.outcome ? "text-accent" : "text-lavender"}>{outcomeText(m.outcome)}</span></>}
          </span>
          {m.evidenceURI && <Evidence uri={m.evidenceURI} />}
          <div className="flex flex-wrap gap-2">
            {!snap.bonusOpen &&
              <ActionButton label={"Settle everyone"} onClick={() =>
                act("Settle everyone", false, async (c) => {
                  const blockNumber = await publicClient.getBlockNumber();
                  const discovery = await readBettorDiscovery(id, blockNumber);
                  if (discovery.legacy) setNotice("Using the legacy full-list getter for this deployment (at most 1,000 bettors).");
                  if (discovery.count === 0n) await write(c, "settle", [id, []]);
                  try {
                    for (let offset = 0n; offset < discovery.count; offset += 100n) {
                      const batch = await discovery.page(offset);
                      if (batch.length === 0 || batch.length > 100) throw new Error("Settlement discovery returned an invalid page.");
                      await write(c, "settle", [id, batch]);
                      setNotice(`Settled through bettor ${offset + BigInt(batch.length)} of ${discovery.count}.`);
                    }
                  } catch (failure) {
                    throw new Error(`${describeAccountError(failure)} Already confirmed batches remain settled. Check the pending transaction before retrying.`);
                  }
                })} busy={Boolean(busy)} stale={stale} />}
            {snap.bonusOpen && snap.me.bonus > 0n && !snap.me.bonusClaimed &&
              <ActionButton label={`Claim bonus · $${(Number(snap.me.bonus) / 1e6).toFixed(2)}`} onClick={() =>
                act(`Claim bonus · $${(Number(snap.me.bonus) / 1e6).toFixed(2)}`, false, (c) => write(c, "claimBonus", [id, c.account!.address]))} busy={Boolean(busy)} stale={stale} />}
          </div>
          <p className="text-xs text-muted">Settling pays everyone and updates reputation. Anyone can trigger it, for everyone.</p>
        </div>
      )}

      {notice && <p role="status" aria-live="polite" className="rounded-[12px] border border-line-strong px-4 py-3 text-sm">{notice}</p>}
      {error && (
        <p role="alert" className="rounded-[12px] border border-accent px-4 py-3 text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

function ActionButton({ label, onClick, variant = "btn-yes", disabled = false, busy, stale }: { label: string; onClick: () => void; variant?: string; disabled?: boolean; busy: boolean; stale: boolean }) {
  return <button className={`btn ${variant} !min-h-11`} onClick={onClick} disabled={busy || stale || disabled}>{busy ? "…" : label}</button>;
}

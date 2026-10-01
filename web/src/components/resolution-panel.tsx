"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { encodeAbiParameters, keccak256, toHex, zeroAddress, type Address, type Hex, type WalletClient } from "viem";
import { KLEOS_ADDRESS, SOCIAL_ADDRESS, USD_ADDRESS, chain, publicClient, shortAddress } from "@/lib/chain";
import { kleosAbi, kleosSocialAbi, kleosUsdAbi } from "@/lib/abi";
import { describeAccountError } from "@/lib/mera";
import { RESOLUTION_STAGES } from "@/lib/data";
import { useKleosAccount } from "./account";
import { ResolutionTrack } from "./resolution-track";

const STATE = { Open: 0, Proposed: 1, Disputed: 2, Resolved: 3 } as const;
const VOTES = [
  { value: 1, label: "Yes" },
  { value: 2, label: "No" },
  { value: 3, label: "Ambiguous" },
] as const;
const BOND = 10_000_000n;
const DISPUTE_BOND = 15_000_000n;

type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;

/** Values that never change after deployment, read once per page load. */
let constants: Promise<{ disputeWindow: bigint; courtPeriod: bigint; owner: Address }> | undefined;
function readConstants() {
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi } as const;
  constants ??= Promise.all([
    publicClient.readContract({ ...k, functionName: "DISPUTE_WINDOW" }),
    publicClient.readContract({ ...k, functionName: "COURT_PERIOD" }),
    publicClient.readContract({ ...k, functionName: "owner" }),
  ])
    .then(([disputeWindow, courtPeriod, owner]) => ({ disputeWindow, courtPeriod, owner }))
    .catch((err) => {
      constants = undefined; // retry on the next poll
      throw err;
    });
  return constants;
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
  const k = { address: KLEOS_ADDRESS!, abi: kleosAbi } as const;
  const [market, court, payout, { disputeWindow, courtPeriod, owner }] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "getMarket", args: [id] }),
    publicClient.readContract({ ...k, functionName: "getCourt", args: [id] }),
    publicClient.readContract({ ...k, functionName: "payouts", args: [id] }),
    readConstants(),
  ]);
  const jury = court.round > 0 ? await publicClient.readContract({ ...k, functionName: "getJury", args: [id, court.round] }) : [];
  const [names, juryVotes, juryCommits] = await Promise.all([
    SOCIAL_ADDRESS && jury.length
      ? publicClient.readContract({ address: SOCIAL_ADDRESS, abi: kleosSocialAbi, functionName: "namesOf", args: [[...jury]] })
      : Promise.resolve([] as readonly string[]),
    Promise.all(jury.map((j) => publicClient.readContract({ ...k, functionName: "votes", args: [id, court.round, j] }))),
    Promise.all(jury.map((j) => publicClient.readContract({ ...k, functionName: "commitments", args: [id, court.round, j] }))),
  ]);
  const who = me ?? zeroAddress;
  const [rep, hasBet, settled, bonus, bonusClaimed] = await Promise.all([
    publicClient.readContract({ ...k, functionName: "reputation", args: [who] }),
    publicClient.readContract({ ...k, functionName: "hasBet", args: [id, who] }),
    publicClient.readContract({ ...k, functionName: "settled", args: [id, who] }),
    publicClient.readContract({ ...k, functionName: "bonusOf", args: [id, who] }),
    publicClient.readContract({ ...k, functionName: "bonusClaimed", args: [id, who] }),
  ]);
  return {
    market,
    court,
    disputeWindow: Number(disputeWindow),
    isOwner: Boolean(me && owner.toLowerCase() === me.toLowerCase()),
    courtPeriod: Number(courtPeriod),
    bonusOpen: payout[3],
    jury: jury.map((address, i) => ({ address, name: names[i] || undefined, vote: juryVotes[i], committed: juryCommits[i] !== `0x${"0".repeat(64)}` })),
    me: { r: Number(rep.r) / 1e18, flagged: rep.flagged, hasBet, settled, bonus, bonusClaimed },
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
  const [evidence, setEvidence] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSnap(await readSnapshot(id, account.address));
    } catch {
      // Chain unreachable for a moment; keep the last snapshot.
    }
  }, [id, account.address]);

  // Poll the chain: phases change on their own as windows open and close. Paused while the tab is
  // hidden, and stopped once the market is final (resolved, bonus open, nothing left to claim here).
  const final = Boolean(snap && snap.market.state === STATE.Resolved && snap.bonusOpen && (snap.me.bonus === 0n || snap.me.bonusClaimed));
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    if (final) return () => clearTimeout(first);
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2500);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, final]);

  /** Runs one on-chain action. `fresh` asks for the passkey again (bonds and jury votes). */
  async function act(label: string, fresh: boolean, run: (client: WalletClient) => Promise<Hex | void>, bond?: bigint) {
    setError(null);
    setNotice(null);
    const client = await account.authorize({ fresh }); // first await: may show the passkey prompt
    if (!client?.account) return;
    setBusy(label);
    try {
      await account.whenFunded();
      if (bond) {
        const balance = await publicClient.readContract({ address: USD_ADDRESS!, abi: kleosUsdAbi, functionName: "balanceOf", args: [client.account.address] });
        if (balance < bond) await account.requestFunds();
      }
      const hash = await run(client);
      if (hash) await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
      router.refresh();
    } catch (e) {
      setError(describeAccountError(e));
    } finally {
      setBusy(null);
    }
  }

  const write = (client: WalletClient, functionName: string, args: readonly unknown[]) =>
    client.writeContract({ account: client.account!, chain, address: KLEOS_ADDRESS!, abi: kleosAbi, functionName, args } as never) as Promise<Hex>;

  if (!snap) return <p className="lbl py-6 text-center">Reading the market from the chain…</p>;

  const { market: m, court } = snap;
  const me = account.address?.toLowerCase();
  const closed = now >= Number(m.closeTime);
  const windowEnds = Number(m.proposedAt) + snap.disputeWindow;
  const iAmJuror = snap.jury.find((j) => j.address.toLowerCase() === me);
  // Mirrors Kleos._requireResolver: the team can always propose; traders need tier II, no position,
  // no flag, and can't resolve a market they created.
  const isCreator = m.creator.toLowerCase() === me;
  const canResolve = !snap.me.hasBet && (snap.isOwner || (snap.me.r >= 4 && !snap.me.flagged && !isCreator));
  const expiresAt = Number(m.closeTime) + 20 * snap.disputeWindow; // EXPIRY_WINDOWS
  const isProposer = m.proposer.toLowerCase() === me;

  const stage =
    m.state === STATE.Resolved ? 4 : m.state === STATE.Disputed ? 3 : m.state === STATE.Proposed ? (now < windowEnds ? 3 : 2) : closed ? 1 : 0;
  const stageLabels: string[] = [...RESOLUTION_STAGES];
  if (m.state === STATE.Disputed) stageLabels[3] = "Kleos Court";

  const outcomeText = (yes: boolean) => (yes ? "YES" : "NO");
  const btn = (label: string, onClick: () => void, variant = "btn-yes", disabled = false) => (
    <button className={`btn ${variant} !min-h-11`} onClick={onClick} disabled={Boolean(busy) || disabled}>
      {busy === label ? "…" : label}
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <ResolutionTrack stage={stage} labels={stageLabels} />

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
                    {btn(
                      `Propose ${outcomeText(yes)}`,
                      () =>
                        act(`Propose ${outcomeText(yes)}`, true, (c) => write(c, "propose", [id, yes, keccak256(toHex(evidence.trim())), evidence.trim()]), BOND),
                      yes ? "btn-yes" : "btn-no-active",
                      !safeEvidenceUrl(evidence.trim()),
                    )}
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
            btn("Void: nobody proposed", () => act("Void: nobody proposed", false, (c) => write(c, "expire", [id])), "btn-no")}
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
            ? !isProposer && btn("Dispute · $15 bond", () => act("Dispute · $15 bond", true, (c) => write(c, "dispute", [id]), DISPUTE_BOND), "btn-no")
            : btn("Finalize", () => act("Finalize", false, (c) => write(c, "finalize", [id])))}
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
                    {btn(v.label, () =>
                      act(v.label, true, async (c) => {
                        const salt = await deriveSalt(c, id, court.round);
                        const commitment = voteCommitment(id, court.round, c.account!.address, v.value, salt);
                        const hash = await write(c, "commitVote", [id, commitment]);
                        setNotice(`Hidden vote sent. You'll reveal it after ${clockText(Number(court.commitEnd) - now)}; nothing was saved on this device.`);
                        return hash;
                      }),
                      iAmJuror.committed ? "btn-no" : v.value === 1 ? "btn-yes" : v.value === 2 ? "btn-no-active" : "btn-no",
                    )}
                  </span>
                ))}
              </div>
              {iAmJuror.committed && <p className="text-xs text-muted">Your hidden vote is in. Voting again replaces it.</p>}
            </div>
          )}

          {iAmJuror && iAmJuror.committed && !iAmJuror.vote && now >= Number(court.commitEnd) && now < Number(court.revealEnd) &&
            btn("Reveal my vote", () =>
              act("Reveal my vote", false, async (c) => {
                // Rebuild the salt from the passkey and find which vote matches the hidden commitment.
                const salt = await deriveSalt(c, id, court.round);
                const committed = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "commitments", args: [id, court.round, c.account!.address] });
                for (const v of VOTES) {
                  if (voteCommitment(id, court.round, c.account!.address, v.value, salt) === committed) return write(c, "revealVote", [id, v.value, salt]);
                }
                throw new Error("This passkey didn't cast the hidden vote for this round.");
              }),
            )}

          {(now >= Number(court.revealEnd) || (court.revealed > 0 && court.revealed === snap.jury.length)) &&
            btn("Close the court", () => act("Close the court", false, (c) => write(c, "closeCourt", [id])))}
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
              btn("Settle everyone", () =>
                act("Settle everyone", false, async (c) => {
                  // Batches of 100 keep each transaction well under the block gas limit.
                  const bettors = await publicClient.readContract({ address: KLEOS_ADDRESS!, abi: kleosAbi, functionName: "getBettors", args: [id] });
                  for (let i = 0; i < bettors.length; i += 100) {
                    const hash = await write(c, "settle", [id, bettors.slice(i, i + 100)]);
                    await publicClient.waitForTransactionReceipt({ hash });
                  }
                }),
              )}
            {snap.bonusOpen && snap.me.bonus > 0n && !snap.me.bonusClaimed &&
              btn(`Claim bonus · $${(Number(snap.me.bonus) / 1e6).toFixed(2)}`, () =>
                act(`Claim bonus · $${(Number(snap.me.bonus) / 1e6).toFixed(2)}`, false, (c) => write(c, "claimBonus", [id, c.account!.address])),
              )}
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

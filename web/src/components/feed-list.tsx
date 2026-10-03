"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import { decodeFunctionData, encodeFunctionData, zeroAddress } from "viem";
import type { FeedItem } from "@/lib/data";
import { SHARP_R } from "@/lib/data";
import { SOCIAL_ADDRESS, chain, publicClient, shortAddress } from "@/lib/chain";
import { kleosSocialAbi } from "@/lib/abi";
import { tierOf, tierOfWad, TIER_NAMES } from "@/lib/tiers";
import { useKleosAccount } from "./account";
import { LaurelBadge } from "./laurel";
import { PendingTransactionNotice, usePendingTransaction } from "./pending-transaction";
import { describeAccountError } from "@/lib/mera";

type Tab = "all" | "sharps" | "following";

const RESULT = {
  right: { label: "Correct side", cls: "border-accent text-accent" },
  wrong: { label: "Incorrect side", cls: "border-line-strong text-muted" },
  refunded: { label: "Refunded", cls: "border-line-strong text-muted" },
} as const;

export function FeedList({ items, tabs = true, queryLive = false }: { items: FeedItem[]; tabs?: boolean; queryLive?: boolean }) {
  const [tab, setTab] = useState<Tab>("all");
  const [voteError, setVoteError] = useState<string | null>(null);
  const account = useKleosAccount();
  const transaction = usePendingTransaction(`votes:${SOCIAL_ADDRESS}`);
  const voting = useRef(false);
  const [filtered, setFiltered] = useState<{ key: string; items: FeedItem[]; error?: string } | null>(null);
  const filterKey = `${tab}:${account.address ?? ""}`;
  const remoteFilter = queryLive && tab !== "all" && (tab !== "following" || Boolean(account.address));
  useEffect(() => {
    if (!queryLive || tab === "all" || (tab === "following" && !account.address)) return;
    const controller = new AbortController();
    const key = `${tab}:${account.address ?? ""}`;
    const query = new URLSearchParams({ tab, ...(account.address ? { address: account.address } : {}) });
    void fetch(`/api/feed?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Feed unavailable.");
        if (!controller.signal.aborted) setFiltered({ key, items: result.items });
      }).catch(error => {
        if (!controller.signal.aborted) setFiltered({ key, items: [], error: error instanceof Error ? error.message : "Feed unavailable." });
      });
    return () => controller.abort();
  }, [queryLive, tab, account.address]);
  const currentFilter = filtered?.key === filterKey ? filtered : null;
  const sourceItems = queryLive && tab !== "all" ? currentFilter?.items ?? [] : items;
  const { data: following } = useReadContract({
    address: SOCIAL_ADDRESS,
    abi: kleosSocialAbi,
    functionName: "following",
    args: account.address ? [account.address] : undefined,
    query: { enabled: Boolean(SOCIAL_ADDRESS && account.address) },
  });
  const followed = new Set((following ?? []).map((a) => a.toLowerCase()));

  // Ups and downs: engagement only. Read in one batch; changes apply optimistically.
  const ids = sourceItems.map((i) => BigInt(i.id));
  const { data: tally, refetch: refetchTally } = useReadContract({
    address: SOCIAL_ADDRESS,
    abi: kleosSocialAbi,
    functionName: "tallies",
    args: [ids, account.address ?? zeroAddress],
    query: { enabled: Boolean(SOCIAL_ADDRESS) && ids.length > 0 },
  });
  const [mineOverride, setMineOverride] = useState<Record<string, number>>({});
  async function refreshVoteCounts(key: string) {
    const result = await refetchTally();
    if (result.isError) throw new Error("Vote confirmed, but counts could not be refreshed. Refresh the page to read current counts.");
    setMineOverride(m => { const next = { ...m }; delete next[key]; return next; });
  }
  const counts = (idx: number, id: number) => {
    const baseMine = tally ? Number(tally[2][idx]) : 0;
    const mine = mineOverride[`${account.address?.toLowerCase() ?? "demo"}:${id}`] ?? baseMine;
    let up = tally ? Number(tally[0][idx]) : 0;
    let down = tally ? Number(tally[1][idx]) : 0;
    // Move the server counts from the recorded vote to the optimistic one.
    if (baseMine === 1) up--;
    if (baseMine === -1) down--;
    if (mine === 1) up++;
    if (mine === -1) down++;
    return { up, down, mine };
  };

  async function vote(id: number, current: number, value: 1 | -1) {
    if (voting.current || transaction.hasPending()) return;
    let next = current === value ? 0 : value; // tapping your vote again clears it
    if (!SOCIAL_ADDRESS) {
      setMineOverride((m) => ({ ...m, [`demo:${id}`]: next })); // demo mode: local only
      return;
    }
    voting.current = true;
    let key: string | undefined;
    let confirmed = false;
    try {
      setVoteError(null);
      const client = await account.authorize(); // first await: may show the passkey prompt
      if (!client?.account) return;
      key = `${client.account.address.toLowerCase()}:${id}`;
      const recorded = await publicClient.readContract({ address: SOCIAL_ADDRESS, abi: kleosSocialAbi, functionName: "voteOf", args: [BigInt(id), client.account.address] });
      next = Number(recorded) === value ? 0 : value;
      const voteKey = key;
      setMineOverride((m) => ({ ...m, [voteKey]: next }));
      await account.whenFunded(client.account.address);
      const hash = await client.writeContract({ account: client.account, chain, address: SOCIAL_ADDRESS, abi: kleosSocialAbi, functionName: "vote", args: [BigInt(id), next] });
      await transaction.confirm(hash, { sender: client.account.address, to: SOCIAL_ADDRESS, data: encodeFunctionData({ abi: kleosSocialAbi, functionName: "vote", args: [BigInt(id), next] }) });
      confirmed = true;
      transaction.complete();
      await refreshVoteCounts(key);
    } catch (error) {
      if (!confirmed && key) { const voteKey = key; setMineOverride(m => { const next = { ...m }; delete next[voteKey]; return next; }); }
      setVoteError(confirmed ? "Vote confirmed, but counts could not be refreshed. Refresh the page to read current counts." : describeAccountError(error));
    } finally { voting.current = false; }
  }

  const shown = sourceItems.filter((i) =>
    queryLive && tab !== "all" ? true : tab === "sharps" ? i.rawR ? BigInt(i.rawR) >= BigInt(SHARP_R) * 10n ** 18n : i.r >= SHARP_R : tab === "following" ? followed.has(i.address.toLowerCase()) : true,
  );

  return (
    <div className="flex flex-col gap-6">
      {tabs && (
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Feed">
        {(
          [
            ["all", "All"],
            ["sharps", `Sharps · R ≥ ${SHARP_R}`],
            ["following", "Following"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className="btn btn-chip" onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      )}
      {voteError && <p role="alert" className="text-sm text-accent">{voteError}</p>}
      <PendingTransactionNotice transaction={transaction} onCheck={() => { void transaction.check().then(async ({ intent }) => { const decoded = decodeFunctionData({ abi: kleosSocialAbi, data: intent.data }); if (decoded.functionName !== "vote") throw new Error("Pending intent is not a vote."); const [id, next] = decoded.args; const key = `${intent.sender.toLowerCase()}:${id}`; setMineOverride(m => ({ ...m, [key]: Number(next) })); transaction.complete(); await refreshVoteCounts(key).catch(e => setVoteError(e.message)); }).catch(e => setVoteError(describeAccountError(e))); }} />
      {remoteFilter && !currentFilter && <p role="status" className="card p-6 text-muted">Reading matching calls…</p>}
      {currentFilter?.error && <p role="alert" className="card p-6 text-muted">{currentFilter.error}</p>}

      {shown.length === 0 && !(remoteFilter && (!currentFilter || currentFilter.error)) ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <p className="text-muted">
            {tab === "following"
              ? account.status === "none"
                ? "Start with a passkey, then follow traders from their profiles."
                : "No matching calls in the loaded window. Older calls may be outside it."
              : "No matching calls in the loaded window."}
          </p>
          <Link href="/leaderboard" className="btn btn-no !min-h-10">
            Find traders
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {shown.map((i) => {
            const tier = i.rawR ? tierOfWad(BigInt(i.rawR)) : tierOf(i.r);
            const v = counts(sourceItems.indexOf(i), i.id);
            const sharp = tier >= 4;
            return (
              // Calls from sharps stand out a little: they carry the most signal.
              // Tinted by the side of the bet: coral for YES, lavender for NO.
              <li
                key={i.id}
                className={`card flex flex-col gap-4 p-6 ${
                  !sharp
                    ? ""
                    : i.side
                      ? "!border-accent/25 bg-[color-mix(in_oklab,var(--color-accent)_2.5%,var(--color-card))]"
                      : "!border-lavender/25 bg-[color-mix(in_oklab,var(--color-lavender)_2.5%,var(--color-card))]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <LaurelBadge r={i.r} rawR={i.rawR} size={28} />
                  <Link href={`/profile/${i.address}`} className="font-medium text-ink">
                    {i.name ? `@${i.name}` : <span className="font-mono">{shortAddress(i.address)}</span>}
                  </Link>
                  {tier > 0 && <span className="lbl">{`Tier ${TIER_NAMES[tier]} · current R ${i.r.toFixed(1)}`}</span>}
                  {sharp && (
                    <span className={`lbl rounded-full border px-2 py-0.5 ${i.side ? "border-accent/60 !text-accent" : "border-lavender/60 !text-lavender"}`}>
                      Sharp
                    </span>
                  )}
                  <span className="lbl ml-auto">{i.ago}</span>
                </div>

                <p className="text-[22px] leading-snug font-medium">“{i.text}”</p>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-card-alt px-4 py-3">
                  <span className={`font-mono text-sm font-medium ${i.side ? "text-accent" : "text-lavender"}`}>{i.side ? "YES" : "NO"}</span>
                  <span className="font-mono text-sm text-muted">
                    ${i.amount.toLocaleString("en-US")} at {Math.round(i.entryPrice * 100)}%
                  </span>
                  <Link href={`/market/${i.marketId}`} className="min-w-0 flex-1 truncate text-[15px]">
                    {i.question}
                  </Link>
                  {i.result ? (
                    <span className={`lbl rounded-full border px-2 py-0.5 ${RESULT[i.result].cls}`}>{RESULT[i.result].label}</span>
                  ) : (
                    <span className="lbl">Open</span>
                  )}
                </div>

                <div className="flex items-center gap-2" aria-label="Votes">
                  <button
                    className={`btn !min-h-9 !gap-2 !px-3 ${v.mine === 1 ? "btn-yes" : "btn-no text-muted"}`}
                    aria-pressed={v.mine === 1}
                    aria-label={`Upvote, ${v.up} ups`}
                    disabled={Boolean(transaction.pending)}
                    onClick={() => vote(i.id, v.mine, 1)}
                  >
                    ▲ <span>{v.up}</span>
                  </button>
                  <button
                    className={`btn !min-h-9 !gap-2 !px-3 ${v.mine === -1 ? "btn-no-active" : "btn-no text-muted"}`}
                    aria-pressed={v.mine === -1}
                    aria-label={`Downvote, ${v.down} downs`}
                    disabled={Boolean(transaction.pending)}
                    onClick={() => vote(i.id, v.mine, -1)}
                  >
                    ▼ <span>{v.down}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

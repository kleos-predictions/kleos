"use client";

import Link from "next/link";
import { useState } from "react";
import { useReadContract } from "wagmi";
import { zeroAddress } from "viem";
import type { FeedItem } from "@/lib/data";
import { SHARP_R } from "@/lib/data";
import { SOCIAL_ADDRESS, chain, publicClient, shortAddress } from "@/lib/chain";
import { kleosSocialAbi } from "@/lib/abi";
import { tierOf, TIER_NAMES } from "@/lib/tiers";
import { useKleosAccount } from "./account";
import { LaurelBadge } from "./laurel";

type Tab = "all" | "sharps" | "following";

const RESULT = {
  right: { label: "Called it", cls: "border-accent text-accent" },
  wrong: { label: "Missed", cls: "border-line-strong text-muted" },
  refunded: { label: "Refunded", cls: "border-line-strong text-muted" },
} as const;

export function FeedList({ items, tabs = true }: { items: FeedItem[]; tabs?: boolean }) {
  const [tab, setTab] = useState<Tab>("all");
  const account = useKleosAccount();
  const { data: following } = useReadContract({
    address: SOCIAL_ADDRESS,
    abi: kleosSocialAbi,
    functionName: "following",
    args: account.address ? [account.address] : undefined,
    query: { enabled: Boolean(SOCIAL_ADDRESS && account.address) },
  });
  const followed = new Set((following ?? []).map((a) => a.toLowerCase()));

  // Ups and downs: engagement only. Read in one batch; changes apply optimistically.
  const ids = items.map((i) => i.id);
  const { data: tally, refetch: refetchTally } = useReadContract({
    address: SOCIAL_ADDRESS,
    abi: kleosSocialAbi,
    functionName: "tallies",
    args: [ids, account.address ?? zeroAddress],
    query: { enabled: Boolean(SOCIAL_ADDRESS) && ids.length > 0 },
  });
  const [mineOverride, setMineOverride] = useState<Record<string, number>>({});
  const counts = (idx: number, id: string) => {
    const baseMine = tally ? Number(tally[2][idx]) : 0;
    const mine = mineOverride[id] ?? baseMine;
    let up = tally ? Number(tally[0][idx]) : 0;
    let down = tally ? Number(tally[1][idx]) : 0;
    // Move the server counts from the recorded vote to the optimistic one.
    if (baseMine === 1) up--;
    if (baseMine === -1) down--;
    if (mine === 1) up++;
    if (mine === -1) down++;
    return { up, down, mine };
  };

  async function vote(id: `0x${string}`, current: number, value: 1 | -1) {
    const next = current === value ? 0 : value; // tapping your vote again clears it
    if (!SOCIAL_ADDRESS) {
      setMineOverride((m) => ({ ...m, [id]: next })); // demo mode: local only
      return;
    }
    const client = await account.authorize(); // first await: may show the passkey prompt
    if (!client?.account) return;
    setMineOverride((m) => ({ ...m, [id]: next }));
    try {
      await account.whenFunded();
      const hash = await client.writeContract({ account: client.account, chain, address: SOCIAL_ADDRESS, abi: kleosSocialAbi, functionName: "vote", args: [id, next] });
      await publicClient.waitForTransactionReceipt({ hash });
      await refetchTally();
      setMineOverride((m) => {
        const rest = { ...m };
        delete rest[id];
        return rest;
      });
    } catch {
      setMineOverride((m) => ({ ...m, [id]: current })); // roll back
    }
  }

  const shown = items.filter((i) =>
    tab === "sharps" ? i.r >= SHARP_R : tab === "following" ? followed.has(i.address.toLowerCase()) : true,
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
          <button key={id} role="tab" aria-selected={tab === id} aria-pressed={tab === id} className="btn btn-chip" onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      )}

      {shown.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <p className="text-muted">
            {tab === "following"
              ? account.status === "none"
                ? "Start with a passkey, then follow traders from their profiles."
                : "Nobody you follow has posted a call yet. Follow traders from their profiles."
              : "No calls yet. Add one when you place a bet."}
          </p>
          <Link href="/leaderboard" className="btn btn-no !min-h-10">
            Find traders
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {shown.map((i, k) => {
            const tier = tierOf(i.r);
            const v = counts(items.indexOf(i), i.id);
            const sharp = i.r >= SHARP_R;
            return (
              // Calls from sharps stand out a little: they carry the most signal.
              // Tinted by the side of the bet: coral for YES, lavender for NO.
              <li
                key={k}
                className={`card flex flex-col gap-4 p-6 ${
                  !sharp
                    ? ""
                    : i.side
                      ? "!border-accent/25 bg-[color-mix(in_oklab,var(--color-accent)_2.5%,var(--color-card))]"
                      : "!border-lavender/25 bg-[color-mix(in_oklab,var(--color-lavender)_2.5%,var(--color-card))]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <LaurelBadge r={i.r} size={28} />
                  <Link href={`/profile/${i.address}`} className="font-medium text-ink">
                    {i.name ? `@${i.name}` : <span className="font-mono">{shortAddress(i.address)}</span>}
                  </Link>
                  {tier > 0 && <span className="lbl">{`Tier ${TIER_NAMES[tier]} · R ${i.r.toFixed(1)}`}</span>}
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
                    onClick={() => vote(i.id, v.mine, 1)}
                  >
                    ▲ <span>{v.up}</span>
                  </button>
                  <button
                    className={`btn !min-h-9 !gap-2 !px-3 ${v.mine === -1 ? "btn-no-active" : "btn-no text-muted"}`}
                    aria-pressed={v.mine === -1}
                    aria-label={`Downvote, ${v.down} downs`}
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

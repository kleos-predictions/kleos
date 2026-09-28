import Link from "next/link";
import { isAddress, type Address } from "viem";
import { notFound } from "next/navigation";
import { getTrader, reputationHistory, sampleFeed, type FeedItem, type RepChange } from "@/lib/data";
import { explainChange, multiplier, PARAMS } from "@/lib/math";
import { tierOf, TIER_NAMES } from "@/lib/tiers";
import { IS_LIVE, IS_LOCAL_CHAIN, addressUrl, shortAddress, txUrl } from "@/lib/chain";
import { readFeed, readProfile } from "@/lib/onchain";
import { FeedList } from "@/components/feed-list";
import { LaurelBadge } from "@/components/laurel";
import { DotNumber } from "@/components/dot-number";
import { ReputationChart } from "@/components/reputation-chart";
import { FollowButton } from "@/components/follow-button";

type View = {
  name?: string;
  r: number;
  pending: number;
  resolvedBets: number;
  flagged: boolean;
  wins: number;
  losses: number;
  history: RepChange[];
  historyError: boolean;
};

const EMPTY: View = { r: 0, pending: 0, resolvedBets: 0, flagged: false, wins: 0, losses: 0, history: [], historyError: true };

async function load(address: Address): Promise<View> {
  if (IS_LIVE) {
    try {
      return await readProfile(address);
    } catch {
      return EMPTY; // chain unreachable: show an honest empty state instead of crashing
    }
  }
  const trader = getTrader(address);
  return { ...trader, pending: 0, resolvedBets: trader.wins + trader.losses, flagged: false, history: reputationHistory(trader), historyError: false };
}

export default async function ProfilePage(props: PageProps<"/profile/[address]">) {
  const { address } = await props.params;
  if (!isAddress(address)) notFound();

  const v = await load(address);
  const calls: FeedItem[] = IS_LIVE ? await readFeed(50, address).catch(() => []) : sampleFeed(address);
  const tier = tierOf(v.r);
  const activated = v.resolvedBets >= PARAMS.nMin;
  const mult = activated ? multiplier(v.r) : 1;
  const points = [...v.history].reverse().map((h) => ({ t: h.timestamp, r: h.newR }));

  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-6 px-4 pt-8 pb-16 md:px-0">
      <section className="card flex flex-col gap-5 p-6">
        <div className="flex items-start gap-5">
          <LaurelBadge r={v.r} size={72} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="truncate text-[28px] leading-tight font-medium">
              {v.name ? `@${v.name}` : <span className="font-mono">{shortAddress(address)}</span>}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {/* Without a username the address is already the title; don't repeat it. */}
              {!v.name ? null : IS_LOCAL_CHAIN ? (
                <span className="font-mono text-sm text-muted" title={address}>
                  {shortAddress(address)}
                </span>
              ) : (
                <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="font-mono text-sm text-muted" title={address}>
                  {shortAddress(address)} ↗
                </a>
              )}
              <span className="lbl !text-ink">{tier ? `Tier ${TIER_NAMES[tier]}` : "No tier yet"}</span>
              {v.flagged && <span className="lbl rounded-full border border-accent px-2 py-0.5 !text-accent">Under review</span>}
            </div>
            {!activated && (
              <span className="lbl !text-[11px]">
                Boost unlocks after {PARAMS.nMin} resolved bets · {v.resolvedBets}/{PARAMS.nMin}
              </span>
            )}
          </div>
          <FollowButton who={address} name={v.name} />
        </div>

        <dl className="flex flex-wrap gap-x-10 gap-y-3 border-t border-line pt-4">
          <Stat label="Reputation" value={v.r.toFixed(1)} accent note={v.pending > 0 ? `+${v.pending.toFixed(2)} vesting` : undefined} />
          <Stat label="Boost" value={`${mult.toFixed(1)}×`} />
          <Stat label="Right" value={String(v.wins)} />
          <Stat label="Wrong" value={String(v.losses)} />
        </dl>

        {points.length >= 2 && <ReputationChart points={points} height={150} />}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="font-dot text-[24px] font-black">CALLS</h2>
          <span className="lbl">{calls.length} public · scored when markets resolve</span>
        </div>
        {calls.length === 0 ? (
          <p className="card lbl p-8 text-center">No calls yet.</p>
        ) : (
          <FeedList items={calls} tabs={false} />
        )}
      </section>

      <details className="card group/history p-6">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
          <span className="lbl !text-ink">
            Reputation history · {v.history.length} {v.history.length === 1 ? "change" : "changes"}
            <span className="ml-2 inline-block transition-transform group-open/history:rotate-90">›</span>
          </span>
          <span className="lbl">Rebuilt from on-chain events · hover a change to check the math</span>
        </summary>
        {v.historyError && <p className="lbl mt-4 !text-accent">Couldn&apos;t load the full history from the RPC. The indexer will serve it.</p>}
        {v.history.length === 0 ? (
          <p className="lbl py-10 text-center">Nothing yet. Every change will show up here with its transaction.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] font-mono text-sm">
              <thead>
                <tr className="lbl text-left">
                  <th className="py-2 font-normal">Date</th>
                  <th className="py-2 font-normal">Market</th>
                  <th className="py-2 font-normal">Side</th>
                  <th className="py-2 text-right font-normal">Entry p</th>
                  <th className="py-2 text-right font-normal">ΔR</th>
                  <th className="py-2 text-right font-normal">New R</th>
                  <th className="py-2 text-right font-normal">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {v.history.map((h) => {
                  const bet = h.isBet !== false && h.marketId > 0;
                  const formula = explainChange(h);
                  return (
                    <tr key={`${h.tx}-${h.delta}`}>
                      <td className="py-3 text-muted">{h.date}</td>
                      <td className="max-w-[320px] truncate py-3 pr-4 font-sans">
                        {h.marketId > 0 ? <Link href={`/market/${h.marketId}`}>{h.question}</Link> : h.question}
                      </td>
                      <td className={`py-3 ${bet && h.side ? "text-accent" : ""}`}>{bet ? (h.side ? "YES" : "NO") : "—"}</td>
                      <td className="py-3 text-right">{bet ? `${Math.round(h.entryPrice * 100)}%` : "—"}</td>
                      <td className="py-3 text-right">
                        <span
                          tabIndex={0}
                          title={formula}
                          className={`group relative cursor-help underline decoration-dotted underline-offset-4 ${h.delta > 0 ? "text-accent" : "text-ink"}`}
                        >
                          {h.delta > 0 ? "+" : ""}
                          {h.delta.toFixed(2)}
                          <span className="pointer-events-none absolute right-0 bottom-full z-10 mb-2 hidden rounded-[12px] border border-line-strong bg-card-alt px-3 py-2 text-xs whitespace-nowrap text-ink group-hover:block group-focus:block">
                            {formula}
                          </span>
                        </span>
                      </td>
                      <td className="py-3 text-right">{h.newR.toFixed(2)}</td>
                      <td className="py-3 text-right">
                        {IS_LOCAL_CHAIN ? (
                          <span className="text-muted">{shortAddress(h.tx)}</span>
                        ) : (
                          <a href={txUrl(h.tx)} target="_blank" rel="noreferrer" className="text-muted">
                            {shortAddress(h.tx)} ↗
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </main>
  );
}

function Stat({ label, value, accent = false, note }: { label: string; value: string; accent?: boolean; note?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="lbl">{label}</dt>
      <dd className={`text-[26px] leading-none ${accent ? "text-accent" : ""}`}>
        <DotNumber value={value} />
      </dd>
      {note && <dd className="lbl !text-[11px]">{note}</dd>}
    </div>
  );
}

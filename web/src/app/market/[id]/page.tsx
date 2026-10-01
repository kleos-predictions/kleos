import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getMarket, recentBets, sampleCalls, type Bet, type Call, type Market } from "@/lib/data";
import { IS_LIVE, shortAddress } from "@/lib/chain";
import { readCalls, readLiveMarket } from "@/lib/onchain";
import * as indexer from "@/lib/indexer";
import { CallsList } from "@/components/calls-list";
import { ResolutionPanel } from "@/components/resolution-panel";
import { OddsDisplay } from "@/components/odds-display";
import { DottedLineChart } from "@/components/dotted-line-chart";
import { ResolutionTrack } from "@/components/resolution-track";
import { StatusTag } from "@/components/status-tag";
import { TradePanel } from "@/components/trade-panel";
import { LaurelBadge } from "@/components/laurel";
import { SharpSignal } from "@/components/sharp-signal";

export default async function MarketPage(props: PageProps<"/market/[id]">) {
  const { id } = await props.params;
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) notFound();
  const { market, bets, calls } = IS_LIVE ? await loadLive(n) : { market: getMarket(n), bets: recentBets(n), calls: sampleCalls(n) };
  if (!market) notFound();

  return (
    <main className="mx-auto grid w-full max-w-[1440px] flex-1 gap-8 px-4 pt-8 pb-32 md:px-12 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:pb-12">
      <div className="flex min-w-0 flex-col gap-8">
        <Link href="/markets" className="lbl w-fit hover:!text-ink">
          ← All markets
        </Link>

        <header className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="lbl">
              <span className="text-ink">{String(market.id).padStart(2, "0")}</span>
              {"  "}
              {market.category} · {market.type} · Oracle: {market.oracle}
            </span>
            <StatusTag status={market.status} />
          </div>
          <h1 className="max-w-[860px] text-[32px] leading-[1.15] font-medium text-balance md:text-[44px]">{market.question}</h1>
          {market.creator && (
            <p className="lbl flex items-center gap-2">
              Created by
              <Link href={`/profile/${market.creator.address}`} className="!text-ink normal-case">
                {market.creator.name ? `@${market.creator.name}` : shortAddress(market.creator.address)}
              </Link>
              · $25 bond at stake if the court rules the question ambiguous
            </p>
          )}
        </header>

        <OddsDisplay repYes={market.repYes} moneyYes={market.moneyYes} />

        <section className="card flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="lbl">Yes price · last 48h</span>
            <div className="flex gap-5">
              <span className="lbl flex items-center gap-2"><span className="size-2 rounded-full bg-accent" />Reputation</span>
              <span className="lbl flex items-center gap-2"><span className="size-2 rounded-full bg-lavender" />Money</span>
            </div>
          </div>
          <DottedLineChart points={market.history} />
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-4">
            <span className="lbl">Volume <span className="text-ink">${market.volume.toLocaleString("en-US")}</span></span>
            <span className="lbl">Bettors <span className="text-ink">{market.bettors}</span></span>
            <span className="lbl">Closes <span className="text-ink">{market.closesAt}</span></span>
          </div>
        </section>

        <SharpSignal {...market.sharps} />

        <CallsList calls={calls} />

        <section className="card flex flex-col gap-6 p-6">
          <div className="flex items-center justify-between">
            <span className="lbl">Resolution</span>
            {!IS_LIVE && market.proposed && (
              <span className="lbl !text-ink">
                Proposed {market.proposed.outcome ? "YES" : "NO"} · final in {market.proposed.finalIn}
              </span>
            )}
          </div>
          {IS_LIVE ? <ResolutionPanel marketId={market.id} oracle={market.oracle} /> : <ResolutionTrack stage={market.stage} />}
          <div className="flex flex-col gap-1 rounded-[12px] border border-line p-4">
            <span className="lbl">Resolution criteria · written before the first bet</span>
            <p className="leading-relaxed">{market.criteria}</p>
          </div>
          <p className="text-sm leading-relaxed text-muted">
            After close, a trader with earned reputation and no position proposes the outcome from{" "}
            <span className="text-ink">{market.oracle}</span> with a $10 bond. During the dispute window anyone can challenge it with a
            $15 bond. Undisputed proposals finalize automatically. Disputes go to the Kleos Court: 5 tier-V jurors with no stake vote
            in secret, and 3 matching votes decide YES, NO or AMBIGUOUS, which refunds everyone.
          </p>
        </section>

        <section className="card p-6">
          <span className="lbl">Recent bets</span>
          {bets.length === 0 && <p className="lbl mt-4">No bets yet.</p>}
          <ul className="mt-4 divide-y divide-line">
            {bets.map((b, i) => (
              <li key={i} className="flex items-center gap-3 py-3 font-mono text-sm">
                <LaurelBadge r={b.r} size={22} />
                <Link href={`/profile/${b.address}`} className="w-28 text-ink">{shortAddress(b.address)}</Link>
                <span className={`w-10 ${b.side ? "text-accent" : "text-ink"}`}>{b.side ? "YES" : "NO"}</span>
                <span className="w-20 text-right">${b.amount.toLocaleString("en-US")}</span>
                <span className="flex-1 text-muted">
                  × {b.mult.toFixed(1)} = <span className="text-ink">${Math.round(b.amount * b.mult).toLocaleString("en-US")}</span>
                </span>
                <span className="text-muted">{b.ago}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <Suspense>
        <TradePanel market={market} />
      </Suspense>
    </main>
  );
}

/**
 * One indexer query for the market, its bets and its calls. On the chain path, bets aren't
 * available (the contract keeps positions, not a bet list), and a market the indexer hasn't seen
 * yet is read from the chain.
 */
async function loadLive(n: number): Promise<{ market: Market | null; bets: Bet[]; calls: Call[] }> {
  const fromChain = async () => {
    const [market, calls] = await Promise.all([readLiveMarket(n).catch(() => null), readCalls(n).catch(() => [])]);
    return { market, bets: [] as Bet[], calls };
  };
  const fromIndexer = async () => {
    const page = await indexer.readMarketPage(n);
    return page.market ? page : { ...page, market: await readLiveMarket(n).catch(() => null) };
  };
  return indexer.preferIndexer(fromIndexer, fromChain);
}

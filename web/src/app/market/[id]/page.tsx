import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getMarket, recentBets, sampleCalls, type Bet, type Call, type Market } from "@/lib/data";
import { IS_LIVE, shortAddress } from "@/lib/chain";
import { readCalls, readLiveMarket, readRecentBets } from "@/lib/onchain";
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
  let page;
  try { page = IS_LIVE ? await loadLive(n) : { market: getMarket(n), bets: recentBets(n), calls: sampleCalls(n), betsError: false, callsError: false }; }
  catch {
    return <main className="mx-auto w-full max-w-3xl flex-1 p-8"><div className="card flex flex-col gap-4 p-6" role="alert"><h1 className="text-2xl">Live market unavailable</h1><p>The chain could not be read. Trading is unavailable until this market can be verified.</p><Link href={`/market/${id}`} className="btn btn-no">Try again</Link></div></main>;
  }
  const { market, bets, calls, betsError, callsError } = page;
  if (!market) notFound();

  return (
    <main className="mx-auto grid w-full max-w-[1440px] flex-1 gap-8 px-4 pt-8 pb-32 md:px-12 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:pb-12">
      <div className="flex min-w-0 flex-col gap-8">
        <Link href="/markets" className="lbl w-fit hover:!text-ink">
          ← All markets
        </Link>

        <header className="flex flex-col gap-5">
          {!IS_LIVE && <p className="lbl !text-accent">Sample market · demo mode</p>}
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
              {market.live?.creatorBond && BigInt(market.live.creatorBond) > 0n ? ` · $${Number(market.live.creatorBond) / 1e6} creator bond held; forfeited if the court rules the question ambiguous` : !IS_LIVE ? " · $25 bond at stake if the court rules the question ambiguous" : ""}
            </p>
          )}
        </header>

        <OddsDisplay repYes={market.repYes} moneyYes={market.moneyYes} />

        <section className="card flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="lbl">{IS_LIVE ? "Live prices" : "Yes price · last 48h"}</span>
            <div className="flex gap-5">
              <span className="lbl flex items-center gap-2"><span className="size-2 rounded-full bg-accent" />Reputation</span>
              <span className="lbl flex items-center gap-2"><span className="size-2 rounded-full bg-lavender" />Money</span>
            </div>
          </div>
          {market.history.length > 1 ? <DottedLineChart points={market.history} /> : <p className="text-sm text-muted">Historical prices are unavailable. The odds above are a chain snapshot.</p>}
          {market.historyCoverage && <p className="text-xs text-muted">{market.historyCoverage}</p>}
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-4">
            <span className="lbl">Volume <span className="text-ink">${market.volume.toLocaleString("en-US")}</span></span>
            <span className="lbl">Bettors <span className="text-ink">{market.bettors}</span></span>
            <span className="lbl">Closes <span className="text-ink">{market.closesAt}</span></span>
          </div>
        </section>

        {(!IS_LIVE || market.live?.sharpsAvailable) && <SharpSignal {...market.sharps} />}
        {market.live && <p className="lbl !text-[11px]">Chain {market.live.chainId} · block {market.live.block} · current snapshot</p>}

        {callsError ? <p role="status" className="card p-6 text-sm text-muted">Live calls could not be loaded.</p> : <CallsList calls={calls} />}

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
            After close, an eligible address with R ≥ 4 and no position can propose the outcome from{" "}
            <span className="text-ink">{market.oracle}</span> with a $10 bond. During the dispute window anyone can challenge it with a
            $15 bond, except the proposer. The owner has a proposal exception for its own unbet market.
            After the dispute window, anyone can finalize an undisputed proposal. Disputes draw up to five eligible court addresses with no same-address position.
            Three matching votes decide YES, NO or AMBIGUOUS. An ambiguous outcome refunds stakes; address checks cannot detect common control.
          </p>
        </section>

        <section className="card p-6">
          <span className="lbl">Recent bets</span>
          {betsError && <p role="status" className="mt-4 text-sm text-muted">Recent live bets could not be loaded.</p>}
          {!betsError && bets.length === 0 && <p className="mt-4 text-sm text-muted">No bets in the available history.</p>}
          <ul className="mt-4 divide-y divide-line">
            {bets.map((b, i) => (
              <li key={i} className="flex items-center gap-3 py-3 font-mono text-sm">
                {b.r !== undefined && <LaurelBadge r={b.r} rawR={b.rawR} size={22} />}
                <Link href={`/profile/${b.address}`} className="w-28 text-ink">{shortAddress(b.address)}</Link>
                <span className={`w-10 ${b.side ? "text-accent" : "text-ink"}`}>{b.side ? "YES" : "NO"}</span>
                <span className="w-20 text-right">${b.amount.toLocaleString("en-US")}</span>
                <span className="flex-1 text-muted">
                  × {b.mult.toFixed(1)} = <span className="text-ink">${Math.round(b.effective ?? b.amount * b.mult).toLocaleString("en-US")}</span>
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

async function loadLive(id: number): Promise<{ market: Market | null; bets: Bet[]; calls: Call[]; betsError: boolean; callsError: boolean }> {
  const fromChain = async () => {
    const market = await readLiveMarket(id);
    const [bets, calls] = await Promise.allSettled([readRecentBets(id), readCalls(id)]);
    return { market, bets: bets.status === "fulfilled" ? bets.value : [], calls: calls.status === "fulfilled" ? calls.value : [],
      betsError: bets.status === "rejected", callsError: calls.status === "rejected" };
  };
  return indexer.preferIndexer(async () => {
    const page = await indexer.readMarketPage(id);
    return page.market ? { ...page, betsError: false, callsError: false } : fromChain();
  }, fromChain);
}

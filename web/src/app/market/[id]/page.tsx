import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getMarket, recentBets, sampleCalls, MARKETS, type Call } from "@/lib/data";
import { IS_LIVE, shortAddress } from "@/lib/chain";
import { readCalls, readLiveMarket } from "@/lib/onchain";
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
  const market = getMarket(Number(id)) ?? (IS_LIVE ? await readLiveMarket(Number(id)).catch(() => null) : null);
  if (!market) notFound();
  const bets = recentBets(market.id);
  let calls: Call[] = sampleCalls(market.id);
  if (IS_LIVE) calls = await readCalls(market.id).catch(() => []);
  const index = MARKETS.indexOf(market);

  return (
    <main className="mx-auto grid w-full max-w-[1440px] flex-1 gap-8 px-4 pt-8 pb-32 md:px-12 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:pb-12">
      <div className="flex min-w-0 flex-col gap-8">
        <Link href="/markets" className="lbl w-fit hover:!text-ink">
          ← All markets
        </Link>

        <header className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="lbl">
              <span className="text-ink">{String(index + 1).padStart(2, "0")}</span>
              {"  "}
              {market.category} · {market.type} · Oracle: {market.oracle}
            </span>
            <StatusTag status={market.status} />
          </div>
          <h1 className="max-w-[860px] text-[32px] leading-[1.15] font-medium text-balance md:text-[44px]">{market.question}</h1>
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

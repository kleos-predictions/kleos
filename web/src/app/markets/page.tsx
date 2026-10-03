import { MARKETS } from "@/lib/data";
import { IS_LIVE } from "@/lib/chain";
import { readExtraMarkets } from "@/lib/onchain";
import { MarketGrid } from "@/components/market-grid";

export default async function MarketsPage(props: PageProps<"/markets">) {
  const { q } = await props.searchParams;
  let markets = MARKETS;
  let unavailable = false;
  if (IS_LIVE) {
    try { markets = await readExtraMarkets(1); }
    catch { markets = []; unavailable = true; }
  }
  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-7 px-4 pt-10 pb-12 md:px-12">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1 className="max-w-[980px] font-dot text-[30px] leading-[1.08] font-black tracking-[0.02em] md:text-[46px]">
          PUBLIC CALLS. TRACEABLE OUTCOMES.
          <span className="cursor-blink text-accent">_</span>
        </h1>
        <div className="lbl flex items-center gap-2 pb-2">
          {IS_LIVE ? unavailable ? "Chain data unavailable" : "Latest chain snapshot · test tokens" : "Sample markets · demo mode"}
        </div>
      </div>
      {unavailable ? <p role="alert" className="card p-6 text-muted">Markets could not be read. Reload to try again.</p> : <MarketGrid markets={markets} query={typeof q === "string" ? q : ""} />}
      {IS_LIVE && !unavailable && markets.length >= 50 && <p className="lbl">Showing the latest 50 markets.</p>}
    </main>
  );
}

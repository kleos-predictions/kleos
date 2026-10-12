import { MARKETS } from "@/lib/data";
import { IS_LIVE } from "@/lib/chain";
import { readExtraMarkets } from "@/lib/onchain";
import * as indexer from "@/lib/indexer";
import { MarketGrid } from "@/components/market-grid";

export default async function MarketsPage(props: PageProps<"/markets">) {
  const { q } = await props.searchParams;
  // Live: every on-chain market, newest first. Sample markets only in demo mode.
  const markets = IS_LIVE
    ? await indexer.preferIndexer(indexer.readMarkets, async () => (await readExtraMarkets(1)).reverse()).catch(() => [])
    : MARKETS;
  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-7 px-4 pt-10 pb-12 md:px-12">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1 className="max-w-[980px] font-dot text-[30px] leading-[1.08] font-black tracking-[0.02em] md:text-[46px]">
          YOUR TRACK RECORD IS WORTH MORE THAN THEIR BANKROLL
          <span className="cursor-blink text-accent">_</span>
        </h1>
        <div className="lbl flex items-center gap-2 pb-2">
          <span className="size-2 rounded-full bg-accent" />
          {IS_LIVE ? "Monad testnet" : "Demo mode · sample data"}
        </div>
      </div>
      <MarketGrid markets={markets} query={typeof q === "string" ? q : ""} />
    </main>
  );
}

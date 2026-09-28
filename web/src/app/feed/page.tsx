import type { Metadata } from "next";
import { sampleFeed, type FeedItem } from "@/lib/data";
import { IS_LIVE } from "@/lib/chain";
import { readFeed } from "@/lib/onchain";
import { FeedList } from "@/components/feed-list";

export const metadata: Metadata = {
  title: "Feed · Kleos",
  description: "Calls from traders, each tied to a real bet and scored when the market resolves.",
};

export default async function FeedPage() {
  let items: FeedItem[] = sampleFeed();
  if (IS_LIVE) items = await readFeed().catch(() => []);

  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-7 px-4 pt-10 pb-16 md:px-12">
      <header className="flex flex-col gap-3">
        <h1 className="font-dot text-[30px] leading-[1.08] font-black md:text-[46px]">
          CALLS<span className="cursor-blink text-accent">_</span>
        </h1>
        <p className="text-lg leading-relaxed text-muted">
          Opinions with receipts. Every call is tied to a real bet, written before the outcome, and scored when the market resolves.
        </p>
      </header>
      <FeedList items={items} />
    </main>
  );
}

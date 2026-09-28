import Link from "next/link";
import type { Market } from "@/lib/data";
import { StatusTag } from "./status-tag";
import { Sparkline } from "./sparkline";
import { SharpSignal } from "./sharp-signal";

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function MarketCard({ market, index }: { market: Market; index: number }) {
  const href = `/market/${market.id}`;
  const inDispute = market.status === "dispute" && market.proposed;

  return (
    <article className="card flex min-h-[340px] flex-col justify-between gap-6 p-6">
      <div className="flex items-center justify-between">
        <span className="lbl">
          <span className="text-ink">{String(index + 1).padStart(2, "0")}</span>
          {"  "}
          {market.category}
        </span>
        <StatusTag status={market.status} />
      </div>

      <div className="flex flex-col gap-3">
        <Link href={href} className="text-[21px] leading-[1.3] font-medium text-balance">
          {market.question}
        </Link>
        <SharpSignal {...market.sharps} compact />
      </div>

      <div className="flex items-end justify-between gap-4">
        {inDispute ? (
          <div className="flex flex-col gap-1">
            <span className="font-dot text-[64px] leading-none font-black">{market.proposed!.outcome ? "YES" : "NO"}</span>
            <span className="lbl">Proposed · final in {market.proposed!.finalIn}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="font-dot text-[64px] leading-none font-black text-accent">{pct(market.repYes)}</span>
            <span className="lbl">Yes · reputation</span>
          </div>
        )}
        <Sparkline points={market.history} muted={Boolean(inDispute)} />
      </div>

      {inDispute ? (
        <Link href={href} className="btn btn-no w-full">
          View resolution
        </Link>
      ) : (
        <div className="flex gap-3">
          <Link href={`${href}?side=yes`} className="btn btn-yes flex-1 hover:!text-ground">
            Yes
          </Link>
          <Link href={`${href}?side=no`} className="btn btn-no flex-1">
            No
          </Link>
        </div>
      )}
    </article>
  );
}

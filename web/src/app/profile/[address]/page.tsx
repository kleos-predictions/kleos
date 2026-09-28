import Link from "next/link";
import { isAddress } from "viem";
import { notFound } from "next/navigation";
import { getTrader, reputationHistory } from "@/lib/data";
import { multiplier, reputationFormula } from "@/lib/math";
import { tierOf, TIER_NAMES, TIER_THRESHOLDS } from "@/lib/tiers";
import { addressUrl, shortAddress, txUrl } from "@/lib/chain";
import { LaurelBadge } from "@/components/laurel";
import { smoothPath } from "@/lib/path";

export default async function ProfilePage(props: PageProps<"/profile/[address]">) {
  const { address } = await props.params;
  if (!isAddress(address)) notFound();

  const trader = getTrader(address);
  const history = reputationHistory(trader);
  const tier = tierOf(trader.r);
  const mult = multiplier(trader.r);

  // R over time, oldest → newest.
  const series = [...history].reverse().map((h) => h.newR);
  const max = Math.max(...series, 1);
  const W = 600, H = 120;
  const path = smoothPath(series.map((v, i) => [6 + (i / Math.max(series.length - 1, 1)) * (W - 12), 8 + (1 - v / max) * (H - 16)]));

  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-8 px-4 pt-10 pb-12 md:px-12">
      <section className="card flex flex-wrap items-center gap-8 p-6 md:p-8">
        <LaurelBadge r={trader.r} size={120} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="lbl">Trader</span>
          <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="truncate font-mono text-lg">
            {address} ↗
          </a>
          <span className="font-dot text-[44px] leading-none font-black">
            {tier ? `TIER ${TIER_NAMES[tier]}` : "NO TIER YET"}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-4">
          {[
            ["Reputation R", trader.r.toFixed(1), "text-accent"],
            ["Boost", `${mult.toFixed(1)}×`, ""],
            ["Right", String(trader.wins), ""],
            ["Wrong", String(trader.losses), ""],
          ].map(([k, v, c]) => (
            <div key={k} className="flex flex-col gap-1">
              <dt className="lbl">{k}</dt>
              <dd className={`font-dot text-[36px] leading-none font-black ${c}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="lbl">Reputation over time</span>
          <span className="lbl">Tiers at R = {TIER_THRESHOLDS.join(" · ")}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" aria-hidden="true">
          <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={5} strokeLinecap="round" strokeDasharray="0 10" />
        </svg>
      </section>

      <section className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="lbl">Reputation history</span>
          <span className="lbl">Rebuilt from ReputationChanged events · hover a change to check the math</span>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] font-mono text-sm">
            <thead>
              <tr className="lbl text-left">
                <th className="py-2 font-normal">Date</th>
                <th className="py-2 font-normal">Market</th>
                <th className="py-2 font-normal">Side</th>
                <th className="py-2 text-right font-normal">Entry p</th>
                <th className="py-2 text-right font-normal">Result</th>
                <th className="py-2 text-right font-normal">ΔR</th>
                <th className="py-2 text-right font-normal">New R</th>
                <th className="py-2 text-right font-normal">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {history.map((h) => {
                const won = h.side === h.outcome;
                const formula = reputationFormula(won, h.entryPrice, h.amount);
                return (
                  <tr key={h.tx}>
                    <td className="py-3 text-muted">{h.date}</td>
                    <td className="max-w-[320px] truncate py-3 pr-4 font-sans">
                      <Link href={`/market/${h.marketId}`}>{h.question}</Link>
                    </td>
                    <td className={`py-3 ${h.side ? "text-accent" : ""}`}>{h.side ? "YES" : "NO"}</td>
                    <td className="py-3 text-right">{Math.round(h.entryPrice * 100)}%</td>
                    <td className="py-3 text-right text-muted">{won ? "Right" : "Wrong"}</td>
                    <td className="py-3 text-right">
                      <span
                        tabIndex={0}
                        title={formula}
                        className={`group relative cursor-help underline decoration-dotted underline-offset-4 ${won ? "text-accent" : "text-ink"}`}
                      >
                        {h.delta > 0 ? "+" : ""}
                        {h.delta.toFixed(2)}
                        <span className="pointer-events-none absolute right-0 bottom-full z-10 mb-2 hidden whitespace-nowrap rounded-[12px] border border-line-strong bg-card-alt px-3 py-2 text-xs text-ink group-hover:block group-focus:block">
                          {formula}
                        </span>
                      </span>
                    </td>
                    <td className="py-3 text-right">{h.newR.toFixed(2)}</td>
                    <td className="py-3 text-right">
                      <a href={txUrl(h.tx)} target="_blank" rel="noreferrer" className="text-muted">
                        {shortAddress(h.tx)} ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

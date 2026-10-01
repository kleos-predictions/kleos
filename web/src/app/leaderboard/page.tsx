import Link from "next/link";
import { connection } from "next/server";
import { TRADERS, type Trader } from "@/lib/data";
import { multiplier } from "@/lib/math";
import { tierOf, TIER_NAMES } from "@/lib/tiers";
import { IS_LIVE, shortAddress } from "@/lib/chain";
import * as indexer from "@/lib/indexer";
import { LaurelBadge } from "@/components/laurel";
import { DotNumber } from "@/components/dot-number";

export default async function LeaderboardPage() {
  // Live traders come only from the indexer: ranking them needs every trader, which the chain can't list.
  // Rendered per request when live, so INDEXER_URL can be set at runtime, not only at build time.
  if (IS_LIVE) await connection();
  let traders: Trader[] = TRADERS;
  if (indexer.HAS_INDEXER) traders = await indexer.readLeaderboard().catch(() => TRADERS);
  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-7 px-4 pt-10 pb-12 md:px-12">
      <h1 className="font-dot text-[30px] leading-[1.08] font-black md:text-[46px]">
        LEADERBOARD<span className="cursor-blink text-accent">_</span>
      </h1>
      <section className="card overflow-x-auto p-2 md:p-4">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="lbl text-left">
              <th className="px-4 py-3 font-normal">#</th>
              <th className="px-4 py-3 font-normal">Trader</th>
              <th className="px-4 py-3 font-normal">Tier</th>
              <th className="px-4 py-3 text-right font-normal">R</th>
              <th className="px-4 py-3 text-right font-normal">Boost</th>
              <th className="px-4 py-3 text-right font-normal">Right / Wrong</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {traders.map((t, i) => (
              <tr key={t.address}>
                <td className="px-4 py-4 font-dot text-2xl font-black text-muted">{String(i + 1).padStart(2, "0")}</td>
                <td className="px-4 py-4">
                  <Link href={`/profile/${t.address}`} className="flex items-center gap-3 font-mono">
                    <LaurelBadge r={t.r} size={32} />
                    {t.name ? <span className="font-sans font-medium">@{t.name}</span> : shortAddress(t.address)}
                  </Link>
                </td>
                <td className="px-4 py-4 font-mono text-sm">{TIER_NAMES[tierOf(t.r)]}</td>
                <td className="px-4 py-4 text-right text-2xl text-accent">
                  <DotNumber value={t.r.toFixed(1)} />
                </td>
                <td className="px-4 py-4 text-right font-mono">{multiplier(t.r).toFixed(1)}×</td>
                <td className="px-4 py-4 text-right font-mono text-muted">
                  {t.wins} / {t.losses}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

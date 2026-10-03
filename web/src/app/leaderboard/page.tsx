import Link from "next/link";
import { TRADERS, type Trader } from "@/lib/data";
import { multiplier } from "@/lib/math";
import { tierOf, tierOfWad, TIER_NAMES } from "@/lib/tiers";
import { IS_LIVE, shortAddress } from "@/lib/chain";
import { readLeaderboard } from "@/lib/onchain";
import { LaurelBadge } from "@/components/laurel";
import { DotNumber } from "@/components/dot-number";

export default async function LeaderboardPage() {
  let traders: (Trader & { multiplier?: number; rawR?: string; flagged?: boolean })[] = TRADERS;
  let coverage = "Sample traders · demo mode";
  let unavailable = false;
  if (IS_LIVE) {
    try {
      const snapshot = await readLeaderboard();
      traders = snapshot.traders;
      coverage = `Block ${snapshot.asOfBlock}. ${snapshot.coverage}`;
    } catch { traders = []; unavailable = true; coverage = "Leaderboard data unavailable."; }
  }
  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-7 px-4 pt-10 pb-12 md:px-12">
      <h1 className="font-dot text-[30px] leading-[1.08] font-black md:text-[46px]">
        LEADERBOARD<span className="cursor-blink text-accent">_</span>
      </h1>
      <p className="text-sm text-muted">{coverage}</p>
      {unavailable && <p role="alert" className="card p-6 text-muted">Participants could not be read. Reload to try again.</p>}
      <section className="card overflow-x-auto p-2 md:p-4">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="lbl text-left">
              <th className="px-4 py-3 font-normal">#</th>
              <th className="px-4 py-3 font-normal">Trader</th>
              <th className="px-4 py-3 font-normal">Tier</th>
              <th className="px-4 py-3 text-right font-normal">R</th>
              <th className="px-4 py-3 text-right font-normal">Boost</th>
              <th className="px-4 py-3 text-right font-normal">Settled side results</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {traders.map((t, i) => (
              <tr key={t.address}>
                <td className="px-4 py-4 font-dot text-2xl font-black text-muted">{String(i + 1).padStart(2, "0")}</td>
                <td className="px-4 py-4">
                  <Link href={`/profile/${t.address}`} className="flex items-center gap-3 font-mono">
                    <LaurelBadge r={t.r} rawR={t.rawR} size={32} />
                    {t.name ? <span className="font-sans font-medium">@{t.name}</span> : shortAddress(t.address)}
                  </Link>
                </td>
                <td className="px-4 py-4 font-mono text-sm">{TIER_NAMES[t.rawR ? tierOfWad(BigInt(t.rawR)) : tierOf(t.r)]}{t.flagged && " · review"}</td>
                <td className="px-4 py-4 text-right text-2xl text-accent">
                  <DotNumber value={t.r.toFixed(1)} />
                </td>
                <td className="px-4 py-4 text-right font-mono">{(t.multiplier ?? multiplier(t.r)).toFixed(1)}×</td>
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

import type { Metadata } from "next";
import { FEATURED_CASES, MATRIX } from "@/lib/cases";
import { BrandMark } from "@/components/brand-mark";
import { CaseCard } from "@/components/case-card";
import { LaurelLogo } from "@/components/laurel";

export const metadata: Metadata = {
  title: "Compare · Kleos",
  description: "Traditional prediction markets vs Kleos, replayed on real controversies.",
};

export default function ComparePage() {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-14 px-4 pt-10 pb-20 md:px-12">
      <header className="flex flex-col gap-5">
        <span className="lbl">Compare</span>
        <h1 className="font-dot text-[40px] leading-[1.02] font-black md:text-[64px]">
          SAME EVENT. TWO SYSTEMS<span className="cursor-blink text-accent">_</span>
        </h1>
        <p className="max-w-[720px] text-xl leading-relaxed text-muted">
          The biggest prediction market controversies weren&apos;t bad luck. They came from how the markets are built. Here is each one, replayed.
        </p>
      </header>

      <section aria-labelledby="matrix" className="flex flex-col gap-6">
        <h2 id="matrix" className="sr-only">Side by side</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-line">
                <th className="w-[28%] p-5 text-left" />
                <th className="p-5 text-left">
                  <span className="flex flex-wrap items-center gap-5">
                    <BrandMark name="Polymarket" size={22} />
                    <BrandMark name="Kalshi" size={22} />
                  </span>
                </th>
                <th className="p-5 text-left">
                  <span className="flex items-center gap-2">
                    <LaurelLogo size={22} />
                    <span className="font-dot text-xl font-black tracking-[0.14em]">KLEOS</span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {MATRIX.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="lbl p-5 text-left align-top font-normal">
                    {row.label}
                  </th>
                  <td className="p-5 align-top text-muted">{row.traditional}</td>
                  <td className="p-5 align-top">{row.kleos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="cases" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 id="cases" className="font-dot text-[28px] font-black md:text-[36px]">THE CASES</h2>
          <p className="text-muted">Flip each case to see what changes on Kleos, and what doesn&apos;t.</p>
        </div>
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-y-5">
          {FEATURED_CASES.map((c, i) => (
            <CaseCard key={c.id} c={c} index={i} brand={<BrandMark name={c.platform} size={20} />} />
          ))}
        </div>
      </section>
    </main>
  );
}

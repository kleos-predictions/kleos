"use client";

import { useState } from "react";
import Link from "next/link";
import { CATEGORIES, type Category, type Market } from "@/lib/data";
import { MarketCard } from "./market-card";

export function MarketGrid({ markets, query = "" }: { markets: Market[]; query?: string }) {
  const [category, setCategory] = useState<Category | "All">("All");
  const q = query.trim().toLowerCase();
  const shown = markets.filter(
    (m) => (category === "All" || m.category === category) && (!q || m.question.toLowerCase().includes(q)),
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          {(["All", ...CATEGORIES] as const).map((c) => (
            <button key={c} className="btn btn-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <span className="lbl">Sort · trending</span>
          <Link href="/create" className="btn btn-no !min-h-10">
            + Create market
          </Link>
        </div>
      </div>

      {shown.length ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((m) => (
            <MarketCard key={m.id} market={m} index={markets.indexOf(m)} />
          ))}
        </div>
      ) : (
        <p className="lbl py-16 text-center">No markets match{q ? ` “${query}”` : ""}</p>
      )}
    </>
  );
}

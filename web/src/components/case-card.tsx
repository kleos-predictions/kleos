"use client";

import { useState } from "react";
import type { Case } from "@/lib/cases";

/** One real case, replayed under both systems, with Kleos's limit stated plainly. */
export function CaseCard({ c, index, brand }: { c: Case; index: number; brand: React.ReactNode }) {
  const [view, setView] = useState<"traditional" | "kleos">("traditional");
  const kleos = view === "kleos";

  return (
    // On desktop the card is a subgrid of 6 rows, so every row (buttons, panel, sources)
    // lines up with the card next to it no matter how long each text is.
    <article className="card flex flex-col gap-5 p-6 md:p-8 lg:row-span-6 lg:grid lg:grid-rows-subgrid">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="lbl">
          <span className="text-ink">{String(index + 1).padStart(2, "0")}</span>
          {"  "}
          {c.date}
          {c.volume && ` · ${c.volume}`}
        </span>
        {brand}
      </div>

      <h3 className="text-[24px] leading-tight font-medium">{c.title}</h3>
      <p className="leading-relaxed text-muted">{c.happened}</p>

      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Replay under">
        {(["traditional", "kleos"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`btn !min-h-11 ${view === v ? (v === "kleos" ? "btn-yes" : "border-ink bg-ink text-ground") : "btn-no text-muted"}`}
          >
            {v === "kleos" ? "On Kleos" : `On ${c.platform}`}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="flex flex-col gap-4">
        <div className={`flex flex-col gap-4 rounded-[12px] p-5 ${kleos ? "bg-card-alt" : "border border-line"}`}>
        <span className="lbl">{kleos ? "With Kleos" : "How it was decided"}</span>
        <p className="leading-relaxed">{kleos ? c.kleos : c.decided}</p>
        {kleos && (
          <ul className="flex flex-wrap gap-2">
            {c.mechanisms.map((m) => (
              <li key={m} className="rounded-full border border-accent px-3 py-1 font-mono text-xs text-accent">
                {m}
              </li>
            ))}
          </ul>
        )}
        </div>
        {kleos && (
          <div className="flex flex-col gap-2 border-l-2 border-line-strong pl-4">
            <span className="lbl">Kleos limit</span>
            <p className="text-sm leading-relaxed text-muted">{c.limit}</p>
          </div>
        )}
      </div>

      <p className="lbl flex flex-wrap items-end gap-x-4 gap-y-1">
        Sources
        {c.sources.map((s) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="!text-ink underline">
            {s.label} ↗
          </a>
        ))}
      </p>
    </article>
  );
}

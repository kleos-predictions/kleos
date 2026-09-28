import Link from "next/link";
import type { Call } from "@/lib/data";
import { shortAddress } from "@/lib/chain";
import { LaurelBadge } from "./laurel";

/** Public one-line reasons behind bets. Written before the outcome, so they become receipts. */
export function CallsList({ calls }: { calls: Call[] }) {
  return (
    <section className="card flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="lbl">Calls</span>
        <span className="lbl">Public · permanent · written before the outcome</span>
      </div>
      {calls.length === 0 ? (
        <p className="lbl py-6 text-center">No calls yet. Add one when you bet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {calls.map((c, i) => (
            <li key={i} className="flex flex-col gap-2 py-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm">
                <LaurelBadge r={c.r} size={20} />
                <Link href={`/profile/${c.address}`} className="text-ink">
                  {shortAddress(c.address)}
                </Link>
                <span className={c.side ? "text-accent" : "text-lavender"}>{c.side ? "YES" : "NO"}</span>
                <span className="text-muted">
                  ${c.amount.toLocaleString("en-US")} at {Math.round(c.entryPrice * 100)}%
                </span>
                <span className="ml-auto text-muted">{c.ago}</span>
              </div>
              <p className="text-[17px] leading-snug">“{c.text}”</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

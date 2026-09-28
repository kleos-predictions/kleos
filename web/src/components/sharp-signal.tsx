import { SHARP_R } from "@/lib/data";
import { LaurelBadge } from "./laurel";

type Props = { yes: number; no: number; compact?: boolean };

/** "X of Y traders with R ≥ 16 bet YES". Filled dot = YES, hollow dot = NO. */
export function SharpSignal({ yes, no, compact = false }: Props) {
  const total = yes + no;
  const text = (
    <>
      <span className="text-ink">
        {yes} of {total}
      </span>{" "}
      traders with R ≥ {SHARP_R} bet YES
    </>
  );

  if (compact) {
    return (
      <p className="lbl flex items-center gap-2 !text-[11px]">
        <LaurelBadge r={SHARP_R} size={16} label={false} />
        <span>{text}</span>
      </p>
    );
  }

  return (
    <section className="card flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="lbl flex items-center gap-2">
          <LaurelBadge r={SHARP_R} size={18} label={false} />
          Sharp signal
        </span>
        <span className="lbl">Tier IV and above</span>
      </div>
      <p className="font-dot text-[28px] leading-tight font-black md:text-[34px]">
        {yes} OF {total} SHARPS SAY <span className="text-accent">YES</span>
      </p>
      <div className="flex flex-wrap gap-2" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`size-4 rounded-full ${i < yes ? "bg-accent" : "border-2 border-line-strong"}`}
          />
        ))}
      </div>
      <div className="flex gap-6">
        <span className="lbl flex items-center gap-2"><span className="size-2.5 rounded-full bg-accent" />Yes {yes}</span>
        <span className="lbl flex items-center gap-2"><span className="size-2.5 rounded-full border-2 border-line-strong" />No {no}</span>
      </div>
    </section>
  );
}

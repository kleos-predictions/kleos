const pct = (n: number) => `${Math.round(n * 100)}%`;

export function OddsDisplay({ repYes, moneyYes }: { repYes: number; moneyYes: number }) {
  return (
    <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
      <div className="flex flex-col gap-2">
        <span className="font-dot text-[88px] leading-[0.9] font-black text-accent md:text-[120px]">{pct(repYes)}</span>
        <span className="lbl">Yes · reputation-weighted</span>
      </div>
      <div className="flex flex-col gap-2 pb-1">
        <span className="font-dot text-[44px] leading-none font-black text-lavender md:text-[56px]">{pct(moneyYes)}</span>
        <span className="lbl">Yes · money only</span>
      </div>
    </div>
  );
}

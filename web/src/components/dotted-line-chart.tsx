"use client";

import { useRef, useState } from "react";
import type { PricePoint } from "@/lib/data";
import { smoothPath } from "@/lib/path";

const W = 800;
const H = 280;
const PAD = { l: 8, r: 48, t: 16, b: 16 };

export function DottedLineChart({ points }: { points: PricePoint[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const x = (i: number) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v) * (H - PAD.t - PAD.b);
  const line = (key: "rep" | "money") => smoothPath(points.map((p, i) => [x(i), y(p[key])]));

  function onMove(e: React.PointerEvent) {
    const box = ref.current!.getBoundingClientRect();
    const rel = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((rel - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  }

  const h = hover !== null ? points[hover] : null;
  const hoursAgo = hover !== null ? points.length - 1 - hover : 0;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Price history. Now: ${Math.round(points.at(-1)!.rep * 100)}% reputation-weighted, ${Math.round(points.at(-1)!.money * 100)}% money only.`}
      >
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={W - PAD.r + 10} y={y(v) + 4} fill="var(--color-muted)" fontSize={12} fontFamily="var(--font-mono)">
              {v * 100}%
            </text>
          </g>
        ))}
        <path d={line("money")} fill="none" stroke="var(--color-lavender)" strokeWidth={5} strokeLinecap="round" strokeDasharray="0 11" />
        <path d={line("rep")} fill="none" stroke="var(--color-accent)" strokeWidth={6} strokeLinecap="round" strokeDasharray="0 11" />
        {h && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-muted)" strokeDasharray="3 5" />
            <circle cx={x(hover)} cy={y(h.rep)} r={6} fill="var(--color-accent)" />
            <circle cx={x(hover)} cy={y(h.money)} r={5} fill="var(--color-lavender)" />
          </g>
        )}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-2 flex flex-col gap-1 rounded-[12px] border border-line-strong bg-card-alt px-3 py-2 font-mono text-xs"
          style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% - 70px), calc(100% - 150px))` }}
        >
          <span className="text-muted">{hoursAgo ? `${hoursAgo}h ago` : "Now"}</span>
          <span className="text-accent">REP {Math.round(h.rep * 100)}%</span>
          <span className="text-lavender">MONEY {Math.round(h.money * 100)}%</span>
        </div>
      )}
    </div>
  );
}

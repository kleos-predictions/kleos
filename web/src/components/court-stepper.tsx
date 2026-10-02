"use client";

import { useEffect, useState } from "react";

// A step-through of one disputed market, from open to verdict. Illustrative: the numbers are the
// contract's bonds, jury size, quorum and juror reward/penalty.

const STAGES = ["Open", "Closed", "Proposed", "Disputed", "Court", "Resolved"];
const POOL = Array.from({ length: 12 }, (_, i) => ({ x: 70 + (i % 6) * 34, y: 130 + Math.floor(i / 6) * 34, holds: [1, 4, 8, 10].includes(i) }));
const VOTES: ("YES" | "NO" | null)[] = ["YES", "YES", "NO", "YES", null]; // the last juror never reveals

const STEPS = [
  { stage: 0, text: "Bets are open." },
  { stage: 1, text: "Betting closes at the set time." },
  { stage: 2, text: "A tier II trader with no position proposes YES, with a $10 bond." },
  { stage: 3, text: "Someone disputes it with a $15 bond." },
  { stage: 4, text: "Five tier-V jurors with no position are drawn." },
  { stage: 4, text: "They vote in secret: only a hash goes on-chain." },
  { stage: 4, text: "Then they reveal. One juror doesn't." },
  { stage: 5, text: "3 matching votes: YES. The disputer's bond pays the jury." },
];

export function CourtStepper() {
  const last = STEPS.length - 1;
  const [at, setAt] = useState(last); // at rest, the finished story is visible
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setAt((i) => {
        if (i >= last) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 1500);
    return () => clearInterval(t);
  }, [playing, last]);

  const step = STEPS[at];
  const drawn = at >= 4, hidden = at === 5, revealed = at >= 6, done = at === last;
  const sx = (i: number) => 40 + i * 112;

  return (
    <div className="flex flex-col gap-4">
      <svg viewBox="0 0 640 290" className="h-auto w-full" role="img" aria-label={`Kleos Court, step ${at + 1} of ${STEPS.length}: ${step.text}`}>
        <line x1={sx(0)} x2={sx(5)} y1={36} y2={36} stroke="var(--color-line-strong)" strokeWidth={2} strokeDasharray="2 6" />
        {STAGES.map((name, i) => (
          <g key={name}>
            <circle
              cx={sx(i)}
              cy={36}
              r={7}
              fill={i < step.stage ? "var(--color-accent)" : i === step.stage ? "var(--color-ink)" : "var(--color-dot-off)"}
            />
            <text x={sx(i)} y={62} textAnchor="middle" fontSize={10} fill="var(--color-faint)" className="font-mono uppercase" letterSpacing="0.08em">
              {name}
            </text>
          </g>
        ))}

        <text x={70} y={104} fontSize={10} fill="var(--color-faint)" className="font-mono uppercase" letterSpacing="0.08em">Juror pool · tier V</text>
        {POOL.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={9} fill="var(--color-card-alt)" stroke="var(--color-line-strong)" />
            {p.holds && <line x1={p.x - 6} y1={p.y - 6} x2={p.x + 6} y2={p.y + 6} stroke="var(--color-faint)" strokeWidth={2} />}
          </g>
        ))}
        {drawn && (
          <text x={70} y={222} fontSize={10} fill="var(--color-faint)" className="font-mono uppercase" letterSpacing="0.08em">✕ holds a position · can&apos;t sit</text>
        )}

        {at >= 2 && (
          <text x={380} y={104} fontSize={11} fill="var(--color-muted)" className="font-mono uppercase" letterSpacing="0.06em">
            {at >= 3 ? "Proposed YES · disputed · $15 bond" : "Proposed YES · $10 bond"}
          </text>
        )}
        {drawn &&
          VOTES.map((v, i) => {
            const x = 380 + i * 48;
            const fill = revealed ? (v === "YES" ? "var(--color-accent)" : v === "NO" ? "var(--color-lavender)" : "var(--color-card-alt)") : hidden || done ? "var(--color-line-strong)" : "var(--color-card-alt)";
            const label = revealed ? (v ?? "—") : hidden ? "•••" : "";
            return (
              <g key={i}>
                <circle cx={x} cy={160} r={17} fill={fill} stroke="var(--color-line-strong)" strokeWidth={2} />
                <text x={x} y={164} textAnchor="middle" fontSize={11} fill={revealed && v ? "var(--color-ground)" : "var(--color-ink)"} className="font-mono">
                  {label}
                </text>
              </g>
            );
          })}
        {done && (
          <>
            <text x={476} y={236} textAnchor="middle" fontSize={26} fontWeight={900} fill="var(--color-accent)" className="font-dot">YES</text>
            <text x={476} y={260} textAnchor="middle" fontSize={10} fill="var(--color-muted)" className="font-mono uppercase" letterSpacing="0.06em">
              with verdict +0.3 R · against or silent −0.3 R
            </text>
          </>
        )}
      </svg>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-yes !px-4 !py-2 text-sm"
          onClick={() => {
            setPlaying(false);
            setAt((i) => (i >= last ? 0 : i + 1));
          }}
        >
          {at >= last ? "Start over" : "Next step"}
        </button>
        <button
          type="button"
          className="btn btn-no !px-4 !py-2 text-sm"
          onClick={() => {
            if (playing) return setPlaying(false);
            if (at >= last) setAt(0);
            setPlaying(true);
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span className="lbl" aria-live="polite">
          {at + 1}/{STEPS.length} · {step.text}
        </span>
      </div>
    </div>
  );
}

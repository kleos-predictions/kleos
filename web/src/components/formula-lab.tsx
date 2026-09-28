"use client";

import { useState } from "react";
import { PARAMS, effectiveBet, fee, multiplier, payout, reputationDelta, stakeFactor } from "@/lib/math";
import { smoothPath } from "@/lib/path";
import { BoostGauge } from "./boost-gauge";
import { DotNumber } from "./dot-number";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const f2 = (n: number) => n.toFixed(2);

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="flex justify-between">
        <span className="lbl">{props.label}</span>
        <span className="font-mono text-sm text-ink">{props.display}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}

function Step({ n, title, formula, children }: { n: string; title: string; formula: string; children: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-col gap-3">
        <span className="lbl">
          <span className="text-ink">{n}</span>
          {"  "}
          {title}
        </span>
        <code className="w-fit rounded-[10px] bg-card-alt px-3 py-2 font-mono text-[15px] text-ink">{formula}</code>
      </div>
      {children}
    </section>
  );
}

/** Horizontal dotted meter for a 0–1 value. */
function DotMeter({ value, color, label }: { value: number; color: string; label: string }) {
  const n = 40;
  const lit = Math.round(value * n);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="lbl">{label}</span>
        <span className="font-dot text-4xl font-black" style={{ color }}>{pct(value)}</span>
      </div>
      <div className="flex gap-[3px]" role="img" aria-label={`${label}: ${pct(value)} YES`}>
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className="h-2.5 flex-1 rounded-full" style={{ background: i < lit ? color : "var(--color-dot-off)" }} />
        ))}
      </div>
    </div>
  );
}

// ─── 01 Multiplier ────────────────────────────────────────────────────────────
function MultiplierStep() {
  const [r, setR] = useState(16);
  const m = multiplier(r);
  const W = 520, H = 180, RMAX = 100;
  const x = (v: number) => 10 + (v / RMAX) * (W - 20);
  // Top padding leaves room for the "CAP 5×" label above the ceiling line.
  const y = (v: number) => 28 + (1 - (v - 1) / (PARAMS.mMax - 1)) * (H - 38);
  const curve = smoothPath(Array.from({ length: 41 }, (_, i) => [x((i / 40) * RMAX), y(multiplier((i / 40) * RMAX))]));
  return (
    <Step n="01" title="Reputation becomes a multiplier" formula="M = min(1 + α·√R, 5)   α = 0.5">
      <div className="grid gap-8 md:grid-cols-[auto_1fr] md:items-center">
        <BoostGauge mult={m} size={168} />
        <div className="flex flex-col gap-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" aria-hidden="true">
            <line x1={10} x2={W - 10} y1={y(5)} y2={y(5)} stroke="var(--color-line)" strokeDasharray="2 6" />
            <text x={W - 10} y={y(5) - 6} textAnchor="end" fontSize={11} fill="var(--color-muted)" fontFamily="var(--font-mono)">CAP 5×</text>
            <path d={curve} fill="none" stroke="var(--color-accent)" strokeWidth={5} strokeLinecap="round" strokeDasharray="0 10" />
            <circle cx={x(Math.min(r, RMAX))} cy={y(m)} r={8} fill="var(--color-ink)" />
          </svg>
          <Slider label="Your reputation R" value={r} min={0} max={100} display={String(r)} onChange={setR} />
          <p className="text-sm leading-relaxed text-muted">
            1 + 0.5·√{r} = <span className="text-ink">{f2(1 + 0.5 * Math.sqrt(r))}</span>
            {m === PARAMS.mMax && " → capped at 5×"}. The square root means diminishing returns: 1× → 3× takes R = 16, but 5× takes R = 64.
            Nobody becomes king of the market.
          </p>
        </div>
      </div>
    </Step>
  );
}

// ─── 02–04 Whale vs sharps ───────────────────────────────────────────────────
function WhaleStep() {
  const [whale, setWhale] = useState(2000);
  const [sharps, setSharps] = useState(20);
  const [bet, setBet] = useState(80);
  const [r, setR] = useState(16);

  const m = multiplier(r);
  const eff = effectiveBet(bet, m);
  const yesMoney = sharps * bet;
  const yesEff = sharps * eff;
  const pMoney = yesMoney / (yesMoney + whale);
  const pRep = yesEff / (yesEff + whale);
  const principal = payout(bet, yesMoney, whale);
  const bonusPool = fee(whale);
  // Identical sharps have identical ΔR · M, so they split the bonus evenly.
  const each = principal + bonusPool / sharps;

  return (
    <Step n="02" title="One whale vs a crowd of sharps" formula="E = m · M      P_money = YES$ / total$      P_rep = YES_E / total_E">
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Slider label="Whale bets NO (R = 0)" value={whale} min={100} max={10000} step={100} display={money(whale)} onChange={setWhale} />
          <Slider label="Number of sharps on YES" value={sharps} min={1} max={50} display={String(sharps)} onChange={setSharps} />
          <Slider label="Each sharp bets" value={bet} min={10} max={500} step={10} display={money(bet)} onChange={setBet} />
          <Slider label="Sharps' reputation R" value={r} min={0} max={64} display={`${r} → ${f2(m)}×`} onChange={setR} />
        </div>
        <div className="flex flex-col gap-6">
          <DotMeter value={pMoney} color="var(--color-lavender)" label="Money only says" />
          <DotMeter value={pRep} color="var(--color-accent)" label="Kleos says" />
          <p className="text-sm leading-relaxed text-muted">
            Each sharp: {money(bet)} × {f2(m)} = <span className="text-ink">{money(eff)}</span> of weight. The whale: {money(whale)} × 1 ={" "}
            <span className="text-ink">{money(whale)}</span>. Same market, two readings. The gap is what Kleos adds: what people who are usually
            right think, not just who has the most money.
          </p>
        </div>
      </div>

      <div className="grid gap-4 border-t border-line pt-6 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex flex-col gap-2">
          <span className="lbl">03  If YES wins, each sharp gets</span>
          <code className="w-fit rounded-[10px] bg-card-alt px-3 py-2 font-mono text-[15px]">
            payout = m + (m / Σwinning$) · (L − 2%)      bonus = pool · ΔR·M / Σ(ΔR·M)
          </code>
          <p className="text-sm leading-relaxed text-muted">
            Principal: {money(bet)} + ({money(bet)} / {money(yesMoney)}) × {money(whale * 0.98)} = <span className="text-ink">{money(principal)}</span>.
            The 2% fee ({money(bonusPool)}) becomes a bonus for winners who gained reputation, weighted by ΔR × M:{" "}
            <span className="text-ink">{money(bonusPool / sharps)}</span> each. Money pays money, so a newcomer on the same side gets the same
            principal per dollar. Reputation steers the signal and earns the bonus. Nobody prints money: everything paid out was bet.
          </p>
        </div>
        <DotNumber value={money(each)} className="text-[56px] leading-none text-accent" />
      </div>
    </Step>
  );
}

// ─── 05 Reputation update ────────────────────────────────────────────────────
function UpdateStep() {
  const [p, setP] = useState(30);
  const [stake, setStake] = useState(80);
  const [won, setWon] = useState(true);
  const price = p / 100;
  const s = stakeFactor(stake);
  const d = reputationDelta(won, price, stake);

  return (
    <Step n="04" title="How reputation moves" formula="Right: ΔR = +k·s·(1 − p)      Wrong: ΔR = −λ·k·s·p      λ = 1.5">
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Slider label="Price of your side when you bet (p)" value={p} min={1} max={99} display={`${p}%`} onChange={setP} />
          <Slider label="Stake" value={stake} min={5} max={200} step={5} display={`${money(stake)} → s = ${f2(s)}`} onChange={setStake} />
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Outcome">
            <button role="radio" aria-checked={won} className={`btn ${won ? "btn-yes" : "btn-no text-muted"}`} onClick={() => setWon(true)}>
              You were right
            </button>
            <button role="radio" aria-checked={!won} className={`btn ${!won ? "border-ink bg-ink text-ground" : "btn-no text-muted"}`} onClick={() => setWon(false)}>
              You were wrong
            </button>
          </div>
        </div>
        <div className="flex flex-col justify-center gap-3">
          <DotNumber value={`${d >= 0 ? "+" : ""}${f2(d)}`} className={`text-[88px] leading-none ${won ? "text-accent" : "text-ink"}`} />
          <span className="lbl">ΔR</span>
          <code className="font-mono text-sm text-muted">
            {won ? `+1 · ${f2(s)} · (1 − ${f2(price)}) = +${f2(d)}` : `−1.5 · 1 · ${f2(s)} · ${f2(price)} = ${f2(d)}`}
          </code>
          <p className="text-sm leading-relaxed text-muted">
            You earn reputation for how much you surprised the market. Agreeing with everyone and being right is worth almost nothing.
            Following the herd and being wrong hurts a lot. Stakes under $50 count partially, so nobody farms reputation with dust bets.
          </p>
        </div>
      </div>
    </Step>
  );
}

// ─── 06 Honesty ──────────────────────────────────────────────────────────────
function HonestyStep() {
  const [q, setQ] = useState(60);
  const [p, setP] = useState(30);
  const qq = q / 100, pp = p / 100;
  const ev = qq * (1 - pp) - PARAMS.lambda * (1 - qq) * pp;
  const worth = ev > 0;
  return (
    <Step n="05" title="Why honesty is the only strategy" formula="E[ΔR] = q·(1 − p) − λ·(1 − q)·p">
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Slider label="What you believe (q)" value={q} min={1} max={99} display={`${q}%`} onChange={setQ} />
          <Slider label="What the market says (p)" value={p} min={1} max={99} display={`${p}%`} onChange={setP} />
        </div>
        <div className="flex flex-col gap-3">
          <DotNumber value={`${ev >= 0 ? "+" : ""}${f2(ev)}`} className={`text-[72px] leading-none ${worth ? "text-accent" : "text-muted"}`} />
          <span className="lbl !text-ink">{worth ? "Worth betting YES" : "Don't bet YES"}</span>
          <p className="text-sm leading-relaxed text-muted">
            With λ = 1 the expected gain is exactly q − p: you only win reputation by knowing something the market doesn&apos;t. With λ = 1.5
            you need a real edge, not a coin flip. Lying or guessing has negative expected value.
          </p>
        </div>
      </div>
    </Step>
  );
}

export function FormulaLab() {
  return (
    <div className="flex flex-col gap-6">
      <MultiplierStep />
      <WhaleStep />
      <UpdateStep />
      <HonestyStep />
      <section className="card flex flex-col gap-3 p-6 md:p-8">
        <span className="lbl"><span className="text-ink">06</span>  Influence cap</span>
        <code className="w-fit rounded-[10px] bg-card-alt px-3 py-2 font-mono text-[15px]">boost stops at 10% of ΣE (pools ≥ $5,000)</code>
        <p className="text-sm leading-relaxed text-muted">
          Once a market is deep, no address can gain extra weight beyond 10% of the reputation-weighted pool, not even the best sharp.
          The cap trims the boost, never the money you put in.
        </p>
      </section>
    </div>
  );
}

"use client";

import { useState } from "react";
import { PARAMS, multiplier, reputationDelta, reputationFormula, stakeFactor } from "@/lib/math";
import { linearPath } from "@/lib/path";
import { whaleScenario } from "@/lib/whale-scenario";
import { BoostGauge } from "./boost-gauge";
import { DotNumber } from "./dot-number";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const preciseMoney = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  const [activated, setActivated] = useState(true);
  const m = activated ? multiplier(r) : 1;
  const W = 520, H = 180, RMAX = 100;
  const x = (v: number) => 10 + (v / RMAX) * (W - 20);
  // Top padding leaves room for the "CAP 5×" label above the ceiling line.
  const y = (v: number) => 28 + (1 - (v - 1) / (PARAMS.mMax - 1)) * (H - 38);
  const curve = linearPath(Array.from({ length: 41 }, (_, i) => [x((i / 40) * RMAX), y(multiplier((i / 40) * RMAX))]));
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
          <label className="text-sm text-muted"><input type="checkbox" checked={activated} onChange={(e) => setActivated(e.target.checked)} /> At least ten qualifying prior positions</label>
          <Slider label="Your reputation R" value={r} min={0} max={100} display={String(r)} onChange={setR} />
          <p className="text-sm leading-relaxed text-muted">
            1 + 0.5·√{r} = <span className="text-ink">{f2(1 + 0.5 * Math.sqrt(r))}</span>
            {m === PARAMS.mMax && " → capped at 5×"}. The square root means diminishing returns: 1× → 3× takes R = 16, but 5× takes R = 64.
            Before activation the applied multiplier remains 1×. The displayed curve is the activated schedule.
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

  const scenario = whaleScenario(whale, sharps, bet, r);
  const { multiplier: m, repYes: pRep, moneyYes: pMoney, principal, bonusPool } = scenario;

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
            Whale enters first; each YES address then makes one bet. All YES accounts have ten prior qualifying positions, R = {r}, and no flag.
            Applied YES weights range from {preciseMoney(scenario.effectiveMin)} to {preciseMoney(scenario.effectiveMax)}; entry prices range from {pct(scenario.entryMin)} to {pct(scenario.entryMax)}.
            Both gauges are pool shares. Neither is a calibrated forecast probability.
          </p>
        </div>
      </div>

      <div className="grid gap-4 border-t border-line pt-6 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex flex-col gap-2">
          <span className="lbl">03  If YES wins, returns by entry order</span>
          <code className="w-fit rounded-[10px] bg-card-alt px-3 py-2 font-mono text-[15px]">
            payout = m + (m / Σwinning$) · (L − 3%)      bonus = pool · ΔR·M / Σ(ΔR·M)
          </code>
          <p className="text-sm leading-relaxed text-muted">
            Principal per YES address: {preciseMoney(principal)}. The losing pool supplies {preciseMoney(bonusPool)} for bonuses and {preciseMoney(scenario.protocol)} protocol revenue.
            {scenario.qualifies ? ` Bonuses range from ${preciseMoney(scenario.minBonus)} to ${preciseMoney(scenario.maxBonus)}: later entries have different capped gains and applied weights.` : ` This market fails the $1,000 / ten-address depth gates. No reputation or bonus is earned; ${preciseMoney(scenario.rollover)} rolls over.`}
            Integer divisions follow the contract. Bonuses open only after every bettor settles.
          </p>
        </div>
        <div className="flex flex-col gap-2"><DotNumber value={preciseMoney(scenario.averageTotal)} className="text-[42px] leading-none text-accent" /><span className="lbl">Average total · range {preciseMoney(scenario.minTotal)}–{preciseMoney(scenario.maxTotal)}</span></div>
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
  const [availableR, setAvailableR] = useState(2);
  const [eligible, setEligible] = useState(true);
  const nominal = reputationDelta(won, price, stake);
  const d = eligible ? won ? nominal : -Math.min(availableR, -nominal) : 0;

  return (
    <Step n="04" title="How reputation moves" formula="Gain = min(k·s·(1 − p), 0.8)   Taken loss = min(available R, 1.5·k·s·p)">
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Slider label="Price of your side when you bet (p)" value={p} min={5} max={95} display={`${p}%`} onChange={setP} />
          <Slider label="Stake" value={stake} min={5} max={200} step={5} display={`${money(stake)} → s = ${f2(s)}`} onChange={setStake} />
          <Slider label="Available vested + pending R" value={availableR} min={0} max={5} step={0.1} display={f2(availableR)} onChange={setAvailableR} />
          <label className="text-sm text-muted"><input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} /> Market has ≥ $1,000 and ≥ ten addresses</label>
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
            {eligible ? won ? reputationFormula(true, price, stake) : `−min(${f2(availableR)}, 1.5·${f2(s)}·${f2(price)}) = ${f2(d)}` : "Depth gate failed: ΔR = 0"}
          </code>
          <p className="text-sm leading-relaxed text-muted">
            Entry prices clamp to 5–95%. Gains cap at +0.8 and wait for vesting; losses apply immediately to vested and pending R, stopping at zero.
            Stakes under $50 scale the update. These rules do not prove independent ownership or prevent reputation farming.
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
  const [availableR, setAvailableR] = useState(2);
  const gain = reputationDelta(true, pp, 50);
  const loss = Math.min(availableR, -reputationDelta(false, pp, 50));
  const ev = qq * gain - (1 - qq) * loss;
  const worth = ev > 0;
  return (
    <Step n="05" title="Expected applied reputation" formula="E[ΔR] = q·min(1 − p, 0.8) − (1 − q)·min(available R, 1.5p)">
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Slider label="What you believe (q)" value={q} min={1} max={99} display={`${q}%`} onChange={setQ} />
          <Slider label="Entry price of your side (p)" value={p} min={5} max={95} display={`${p}%`} onChange={setP} />
          <Slider label="Available vested + pending R" value={availableR} min={0} max={5} step={0.1} display={f2(availableR)} onChange={setAvailableR} />
        </div>
        <div className="flex flex-col gap-3">
          <DotNumber value={`${ev >= 0 ? "+" : ""}${f2(ev)}`} className={`text-[72px] leading-none ${worth ? "text-accent" : "text-muted"}`} />
          <span className="lbl !text-ink">{worth ? "Positive expected R change" : "Nonpositive expected R change"}</span>
          <p className="text-sm leading-relaxed text-muted">
            Assumes one full-size side, an eligible market and no review flag. This is an R calculation, not a monetary return or betting recommendation.
            A fresh account has no R to lose and can have positive expected gains without an informational edge. Side and stake are recorded; your belief q is not elicited by the contract.
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
        <code className="w-fit rounded-[10px] bg-card-alt px-3 py-2 font-mono text-[15px]">Prospective boost bound; applies when prior ΣE + new stake ≥ $5,000</code>
        <p className="text-sm leading-relaxed text-muted">
          The current contract trims a new bet using the address&apos;s existing weight and the prior effective pool, while preserving its money weight.
          Historical weight is retained. Entry order and splitting a position into transactions can change the result; this is not a permanent 10% ownership limit.
        </p>
      </section>
    </div>
  );
}

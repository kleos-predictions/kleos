import type { Metadata } from "next";
import { FormulaLab } from "@/components/formula-lab";
import { LaurelBadge } from "@/components/laurel";
import { PARAMS } from "@/lib/math";
import { TIER_NAMES, TIER_THRESHOLDS } from "@/lib/tiers";

export const metadata: Metadata = {
  title: "How it works · Kleos",
  description: "Why reputation is social, the formulas behind Kleos, and what runs on-chain.",
};

const WHY = [
  {
    title: "Opinions with receipts",
    body: "Every bet can carry a call: a public one-line reason, written before the outcome and scored after it. Follow the traders who call it early, and see who was right, not who was loudest.",
  },
  {
    title: "Glory you earn, not buy",
    body: "Kleos is the Greek word for the renown a person earns through their deeds, carried by what others say about them. Here that renown is your track record: public, non-transferable and impossible to buy.",
  },
  {
    title: "Attention goes to who was right",
    body: "Feeds reward the loudest voice and markets reward the biggest wallet. Kleos shifts attention to people who called it before the crowd did, and shows their read next to the money's read.",
  },
  {
    title: "Status anyone can check",
    body: "Every reputation change is an on-chain event with the math attached. Look up any trader, retrace every point they earned or lost, and verify it on Monadscan. No private scores, no black box.",
  },
  {
    title: "A culture of calling it early",
    body: "Agreeing with the crowd earns almost nothing. Being early and right earns a lot. Being loud and wrong costs more than it pays. The incentives favor independent thinking over hype.",
  },
];

const STACK = [
  ["Chain", "Monad testnet · EVM, ~400 ms blocks, cheap enough to log every reputation change"],
  ["Contracts", "Kleos.sol (markets, weighting, payouts, reputation, Kleos Court) · KleosSocial.sol (usernames, follows, votes on calls) · KleosUSD.sol (test stablecoin)"],
  ["Accounts", "Mera passkeys: no wallet, no extension, no seed phrase. The account is derived from the passkey on any device; nothing secret is stored. Gas and test USD are sponsored, so a first bet is one transaction"],
  ["Sessions", "Prompt-free while unlocked: bets up to $100, follows, votes, settling. The passkey is asked again for bigger bets, bonds, jury votes and the recovery phrase. 15 idle minutes lock the account"],
  ["Verifiability", "ReputationChanged(user, marketId, delta, newR, entryPrice, side, outcome) on every update"],
  ["Market creation", "The team, or any tier-V trader (R ≥ 36) with a $25 bond plus a $2 fee. The bond comes back on a clean resolution and is lost if the court rules the question ambiguous. Creators can't propose the outcome or sit on the jury"],
  ["Resolution", "Propose with a $10 bond → dispute window → finalize. A dispute ($15 bond) goes to the Kleos Court: 5 jurors, commit-reveal votes, 3 of 5 decide"],
  ["Jury secrets", "A juror's hidden vote is salted with a deterministic passkey signature, so it can be revealed from any device with nothing stored"],
  ["Social", "Calls: a public 140-character reason attached to a bet, scored when the market resolves. Feed, follows, usernames and ▲▼ votes live on-chain"],
  ["Settlement", "Permissionless: anyone can settle any trader, so losses land even if the loser never comes back"],
  ["Frontend", "Next.js · wagmi / viem · formulas mirrored client-side so every preview matches the contract"],
  ["Tests", "Hardhat · 34 tests; the pitch numbers (44% vs 71%, $177 + bonus payout, +0.70 / −1.43) are asserted against the contract"],
];

const EVENTS = [
  "MarketCreated", "BetPlaced", "RevenueAccrued", "CallPosted", "OutcomeProposed", "OutcomeDisputed", "JuryDrawn", "VoteRevealed", "Verdict",
  "MarketResolved", "Settled", "ReputationChanged", "Followed", "CallVoted", "NameSet",
];

const FAILURES = [
  {
    title: "Resolution capture",
    date: "Mar 2025",
    what: "In Polymarket's $7M Ukraine minerals market, one UMA token whale reportedly cast about 25% of dispute votes and forced a premature \u201cYes\u201d.",
    source: "https://thedefiant.io/news/defi/polymarket-s-usd7m-ukraine-mineral-deal-debacle-traced-to-oracle-whale",
    answer: "Resolvers are gated by earned reputation, not purchasable tokens.",
    live: true,
  },
  {
    title: "Conflicted judges",
    date: "2026",
    what: "A Wall Street Journal investigation found nearly 20% of disputed Polymarket outcomes involved oracle voters with stakes in the market they judged.",
    source: "https://www.turbinefi.com/blog/how-prediction-markets-resolve-oracles-disputes-2026",
    answer: "Anyone with a position is excluded from resolving that market.",
    live: true,
  },
  {
    title: "Price distortion",
    date: "Oct 2024",
    what: "One trader with eleven linked wallets pushed Polymarket's election odds 10\u201315 points above competing platforms.",
    source: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6670638",
    answer: "A reputation-weighted price shown next to the money price, with a 10% per-address cap.",
    live: true,
  },
  {
    title: "Insider trading",
    date: "Apr 2026",
    what: "In the first criminal case, a soldier allegedly used classified information to bet $33,000 on the Maduro operation and cashed out about $400,000.",
    source: "https://fortune.com/2026/04/26/prediction-markets-insider-trading-illegal-kalshi-polymarket-robin-hanson-economist/",
    answer: "Reputation vests over time, gains are capped per market, anomalies are reviewed.",
    live: true,
  },
];

const EVIDENCE = [
  {
    text: "Small crowds of proven forecasters outperform larger crowds in both markets and polls.",
    cite: "Atanasov, Witkowski, Mellers & Tetlock, International Journal of Forecasting, 2025",
    source: "https://www.sciencedirect.com/science/article/abs/pii/S0169207023001413",
  },
  {
    text: "Across 5,456 Polymarket and Kalshi markets, bigger bettors were not more accurate; in some markets whales had negative edge.",
    cite: "Daleep et al., 2026",
    source: "https://klementoninvesting.substack.com/p/a-fundamental-flaw-of-prediction",
  },
];

const SAFEGUARDS = [
  ["Activation", "Boost stays 1.0× until 10 resolved bets. A handful of bets is mostly luck."],
  ["Money pays money", "Payouts split the losing pool by money, so reputation can't be rented out. A 2% fee funds a bonus for winners who gained reputation; 1% is protocol revenue."],
  ["Vesting", "Gains vest over 7 days; losses apply immediately. The boost uses vested reputation only."],
  ["Per-market cap", "Reputation gained from any single market is capped at +0.8."],
  ["Minimum depth", "Reputation only moves in markets deep enough that you can't farm it against your own wallets."],
  ["Anomaly review", "New accounts that win a long shot with a big bet are held for review before gains vest. A heuristic, not an accusation."],
  ["Resolver gating", "Proposing an outcome needs earned reputation and no position in that market. Disputing costs a $15 bond, so nobody disputes just because they lost."],
  ["Kleos Court", "Disputes go to 5 jurors drawn from tier-V traders with no stake. Votes stay hidden until everyone has committed. 3 matching votes decide YES, NO or AMBIGUOUS (full refund). Jurors who vote with the verdict gain reputation; jurors whose absence forces a refund lose it."],
  ["Topic limits", "No markets on military operations or internal government decisions."],
];

const LIMITATIONS = [
  ["Jury bribery", "Votes are hidden until the reveal, but a juror can prove their vote afterward, so open bribes are possible. Random draws and reputation at stake make it costly, not impossible. Jury draws use block randomness, which block producers can nudge."],
  ["Parimutuel pricing", "Thin markets move sharply with each bet. LMSR is the planned upgrade for thin markets."],
  ["Heuristic flag", "The anomaly flag is a heuristic, not proof of insider trading."],
];

function Status({ live }: { live: boolean }) {
  return live ? (
    <span className="lbl flex items-center gap-1.5 !text-accent"><span className="size-1.5 rounded-full bg-accent" />Live</span>
  ) : (
    <span className="lbl rounded-full border border-line-strong px-2 py-0.5">Building</span>
  );
}

export default function HowItWorks() {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-16 px-4 pt-10 pb-20 md:px-12">
      <header className="flex flex-col gap-5">
        <span className="lbl">How it works</span>
        <h1 className="font-dot text-[40px] leading-[1.02] font-black md:text-[72px]">
          KLEOS IN CHAOS<span className="cursor-blink text-accent">_</span>
        </h1>
        <p className="max-w-[720px] text-xl leading-relaxed text-muted md:text-2xl">
          A prediction market with a verifiable reputation layer. Every bet weighs{" "}
          <span className="text-ink">money × reputation</span>, and reputation only comes from being right when the crowd was wrong.
        </p>
      </header>

      <section className="flex flex-col gap-6" aria-labelledby="why-kleos">
        <div className="flex flex-col gap-2">
          <h2 id="why-kleos" className="font-dot text-[28px] font-black md:text-[36px]">WHY KLEOS</h2>
          <p className="text-muted">Prediction markets are failing in four specific ways. Each one has a direct answer here.</p>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          {FAILURES.map((f, i) => (
            <article key={f.title} className="card flex flex-col gap-4 p-6">
              <div className="flex items-center justify-between gap-3">
                <span className="lbl">
                  <span className="text-ink">{String(i + 1).padStart(2, "0")}</span>
                  {"  "}
                  {f.date}
                </span>
                <Status live={f.live} />
              </div>
              <h3 className="text-[21px] font-medium">{f.title}</h3>
              <p className="leading-relaxed text-muted">
                {f.what}{" "}
                <a href={f.source} target="_blank" rel="noreferrer" className="lbl whitespace-nowrap underline">
                  Source ↗
                </a>
              </p>
              <p className="mt-auto flex gap-3 border-t border-line pt-4 leading-relaxed">
                <span className="lbl shrink-0 pt-1 !text-accent">Kleos</span>
                {f.answer}
              </p>
            </article>
          ))}
        </div>
        <div className="card flex flex-col divide-y divide-line">
          {EVIDENCE.map((e) => (
            <div key={e.cite} className="grid gap-2 p-5 md:grid-cols-[140px_1fr] md:gap-6">
              <span className="lbl">Evidence</span>
              <p className="leading-relaxed">
                {e.text}{" "}
                <a href={e.source} target="_blank" rel="noreferrer" className="text-muted underline">
                  {e.cite} ↗
                </a>
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="why">
        <h2 id="why" className="font-dot text-[28px] font-black md:text-[36px]">WHY IT&apos;S SOCIAL</h2>
        <div className="grid gap-6 md:grid-cols-2">
          {WHY.map((w, i) => (
            <article key={w.title} className="card flex flex-col gap-3 p-6">
              <span className="lbl"><span className="text-ink">{String(i + 1).padStart(2, "0")}</span></span>
              <h3 className="text-[21px] font-medium">{w.title}</h3>
              <p className="leading-relaxed text-muted">{w.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="tiers">
        <h2 id="tiers" className="font-dot text-[28px] font-black md:text-[36px]">THE LAUREL</h2>
        <div className="card grid grid-cols-2 gap-6 p-6 sm:grid-cols-3 md:grid-cols-5">
          {TIER_THRESHOLDS.map((t, i) => (
            <div key={t} className="flex flex-col items-center gap-3 text-center">
              <LaurelBadge r={t} size={72} />
              <span className="font-dot text-2xl font-black">TIER {TIER_NAMES[i + 1]}</span>
              <span className="lbl">R ≥ {t}</span>
            </div>
          ))}
        </div>
        <p className="text-muted">The wreath fills in dot by dot as your tier rises. It shows up next to your address everywhere: bets, leaderboards, profiles.</p>
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="formulas">
        <div className="flex flex-col gap-2">
          <h2 id="formulas" className="font-dot text-[28px] font-black md:text-[36px]">THE MATH, LIVE</h2>
          <p className="text-muted">Move the sliders. These are the same formulas the contract runs.</p>
        </div>
        <FormulaLab />
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="tech">
        <h2 id="tech" className="font-dot text-[28px] font-black md:text-[36px]">TECH FOOTPRINT</h2>
        <div className="card divide-y divide-line">
          {STACK.map(([k, v]) => (
            <div key={k} className="grid gap-2 p-5 md:grid-cols-[180px_1fr] md:gap-6">
              <span className="lbl">{k}</span>
              <span className="leading-relaxed">{v}</span>
            </div>
          ))}
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="card flex flex-col gap-4 p-6">
            <span className="lbl">Events</span>
            <ul className="flex flex-wrap gap-2">
              {EVENTS.map((e) => (
                <li key={e} className={`rounded-full border px-3 py-1 font-mono text-sm ${e === "ReputationChanged" ? "border-accent text-accent" : "border-line-strong"}`}>
                  {e}
                </li>
              ))}
            </ul>
          </div>
          <div className="card flex flex-col gap-4 p-6">
            <span className="lbl">Parameters</span>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm">
              {[
                ["α (slope)", PARAMS.alpha],
                ["M max", `${PARAMS.mMax}×`],
                ["k (step)", PARAMS.k],
                ["λ (loss weight)", PARAMS.lambda],
                ["Full stake at", `$${PARAMS.stakeRef}`],
                ["Boost cap", `${PARAMS.boostCap * 100}%`],
                ["Fee → bonus", `${PARAMS.feeBps / 100}%`],
                ["Protocol fee", `${PARAMS.protocolFeeBps / 100}%`],
                ["Creation", "$25 bond + $2 fee"],
                ["Max ΔR / market", PARAMS.deltaRMax],
                ["Activation", `${PARAMS.nMin} bets`],
              ].map(([k, v]) => (
                <div key={String(k)} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className="card flex flex-col gap-4 p-6">
          <div className="flex items-center justify-between gap-3">
            <span className="lbl">Reputation safeguards</span>
            <Status live />
          </div>
          <dl className="divide-y divide-line">
            {SAFEGUARDS.map(([k, v]) => (
              <div key={k} className="grid gap-1 py-3 md:grid-cols-[180px_1fr] md:gap-6">
                <dt className="lbl">{k}</dt>
                <dd className="leading-relaxed">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="limits">
        <h2 id="limits" className="font-dot text-[28px] font-black md:text-[36px]">KNOWN LIMITATIONS</h2>
        <div className="grid gap-6 md:grid-cols-3">
          {LIMITATIONS.map(([k, v]) => (
            <article key={k} className="card flex flex-col gap-3 p-6">
              <span className="lbl !text-ink">{k}</span>
              <p className="leading-relaxed text-muted">{v}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

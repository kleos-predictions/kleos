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
    body: "A bet can carry a public one-line reason posted before market close. Recorded outcomes label the chosen side after resolution. Whether a call preceded public knowledge depends on the event and its deadline.",
  },
  {
    title: "A public record",
    body: "Kleos records bets, results and reputation updates on-chain. R is bound to an address; addresses do not establish independent people or prevent account transfer.",
  },
  {
    title: "Attention goes to who was right",
    body: "The feed makes calls and results easy to inspect. Reputation-weighted pool shares appear beside money shares. Whether this helps readers find useful forecasts still needs measurement.",
  },
  {
    title: "Status anyone can check",
    body: "Profiles link observed reputation changes to on-chain transactions. Administrator adjustments and court rewards also affect R; unavailable history is shown explicitly.",
  },
  {
    title: "An experiment in forecasting",
    body: "The scoring experiment rewards correct contrarian sides. Caps, the zero floor and wallet partitioning affect incentives. Predictive value still needs measurement against independent baselines.",
  },
];

const STACK = [
  ["Chain", "Monad testnet · EVM. Recorded outcomes and reputation updates are on-chain; this prototype uses nonredeemable test tokens."],
  ["Contracts", "Kleos.sol (markets, weighting, payouts, reputation, Kleos Court) · KleosSocial.sol (usernames, follows, votes on calls) · KleosUSD.sol (test stablecoin)"],
  ["Accounts", "Mera passkeys derive an account without a wallet extension. Public credential metadata is cached; signing keys live only in memory. Recovery can reveal a phrase after a fresh prompt. A bet is one user-signed transaction after separate sponsor funding."],
  ["Sessions", "While unlocked, the account holds full signing authority. The UI re-prompts for larger bets, bonds and jury votes; these are UI rules, not cryptographic spending limits. Fifteen idle minutes lock the session."],
  ["Verifiability", "ReputationChanged records applied updates and pending R. Vested records transfers into vested R. Seed, slash and court activity also appear in the public record."],
  ["Market creation", "The team, or any tier-V trader (R ≥ 36) with a $25 bond plus a $2 fee. The bond comes back on a clean resolution and is lost if the court rules the question ambiguous. Creators cannot sit on their jury. Only the owner has a proposal exception on its own unbet markets."],
  ["Resolution", "Propose with a $10 bond → dispute window → finalize. A dispute ($15 bond) draws up to five eligible court addresses; three matching revealed votes decide."],
  ["Jury secrets", "The app derives a vote salt from a deterministic passkey signature and binds it to chain, market, round, address and vote. Cross-device recovery still needs physical-device verification."],
  ["Social", "Calls contain up to 140 UTF-8 bytes. Results compare the chosen side with the recorded outcome. Usernames, follows and per-address engagement votes are on-chain."],
  ["Settlement", "Permissionless: anyone can settle any trader, so losses land even if the loser never comes back"],
  ["Frontend", "Next.js · wagmi / viem. Live quotes come from a pinned contract read; the mined BetPlaced event supplies actual applied weight. Quotes can change before execution."],
  ["Tests", "Hardhat local tests cover pitch arithmetic, payouts, court and repair regressions. Test counts and coverage are recorded in the repository; they are not a security certification."],
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
    answer: "Proposers need R and a bond. R can include administrative and court adjustments; independent qualification remains a mechanism decision.",
    live: true,
  },
  {
    title: "Conflicted judges",
    date: "2026",
    what: "Secondary reporting describes disputed outcomes involving oracle voters who also held market positions. The original methodology has not been verified here.",
    source: "https://www.turbinefi.com/blog/how-prediction-markets-resolve-oracles-disputes-2026",
    answer: "The same address cannot propose or judge a market where it bet. Other controlled addresses and off-platform interests are not detected.",
    live: true,
  },
  {
    title: "Whale concentration",
    date: "Oct 2024",
    what: "One trader spread more than $45 million of Trump bets across several Polymarket accounts.",
    source: "https://www.theblock.co/post/324996/polymarket-whale-us-election-profit-france-ban",
    answer: "A reputation-weighted pool share beside the money share. The prospective cap is path dependent and does not impose a permanent 10% limit.",
    live: true,
  },
  {
    title: "Insider trading",
    date: "Apr 2026",
    what: "The DOJ alleges a soldier used classified information to wager about $33,034 and profit about $409,881 on Maduro-related markets.",
    source: "https://www.justice.gov/opa/pr/us-soldier-charged-using-classified-information-profit-prediction-market-bets",
    answer: "Reputation vests over time, gains are capped per market, anomalies are reviewed.",
    live: true,
  },
];

const EVIDENCE = [
  {
    text: "Research on a forecasting competition found selected elite crowds outperformed larger crowds. This motivates testing Kleos; it does not validate its score or pool shares.",
    cite: "Atanasov, Witkowski, Mellers & Tetlock · author-hosted preprint, 2024",
    source: "https://faculty.wharton.upenn.edu/wp-content/uploads/2016/11/Crowd-Prediction-Systems.pdf",
  },
];

const SAFEGUARDS = [
  ["Activation", "Boost stays 1.0× until 10 resolved positions of at least $50. A handful of bets is mostly luck."],
  ["Money pays money", "Principal payouts split the losing pool by money. Reputation affects signal and bonus weight. A 2% fee funds eligible bonuses; 1% is protocol revenue. These rules do not prevent account transfer or wallet partitioning."],
  ["Vesting", "Vesting is deployment-configured: the recorded testnet uses 300 seconds. Source repairs preserve an already matured, unflagged balance before adding a gain. Immature gains still share a deadline; losses apply immediately."],
  ["Per-market cap", "Reputation gained from any single market is capped at +0.8."],
  ["Minimum depth", "Reputation requires a $1,000 pool and ten addresses. These gates do not establish capital at risk or independent ownership."],
  ["Anomaly review", "New accounts that win a long shot with a big bet are held for review before gains vest. A heuristic, not an accusation."],
  ["Resolver gating", "Proposing needs R ≥ 4 and no position, with an owner exception for its own unbet market. Anyone except the proposer can dispute with a $15 bond, including bettors."],
  ["Kleos Court", "Disputes draw up to five eligible addresses. Votes remain hidden until the commit deadline. Three matching votes decide YES, NO or AMBIGUOUS. A failed round can redraw; failure after two rounds refunds stakes. Rewards track agreement with the verdict, not independently established truth."],
  ["Topic limits", "Category IDs are allowlisted. Military and internal-government topics require semantic curation; categorizing a question as Crypto does not technically block its content."],
];

const LIMITATIONS = [
  ["Jury bribery", "Votes can be proven after reveal. Address exclusions do not detect common control, and a random starting slot followed by consecutive eligible entries creates correlated juries. Independence, selection and incentives need redesign."],
  ["Parimutuel pricing", "Thin markets move sharply. Principal returns depend on final pool composition; positions cannot be sold or withdrawn. A funded market-maker design would require separate mechanism review."],
  ["Heuristic flag", "The anomaly flag is a heuristic, not proof of insider trading."],
];

function Status({ live }: { live: boolean }) {
  return live ? (
    <span className="lbl flex items-center gap-1.5 !text-accent"><span className="size-1.5 rounded-full bg-accent" />Prototype</span>
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
          <span className="text-ink">money × reputation multiplier</span>. The score is experimental and includes bets, court duties and administrator adjustments.
        </p>
      </header>

      <section className="flex flex-col gap-6" aria-labelledby="why-kleos">
        <div className="flex flex-col gap-2">
          <h2 id="why-kleos" className="font-dot text-[28px] font-black md:text-[36px]">WHY KLEOS</h2>
          <p className="text-muted">Reported market disputes motivate these rules. The rules narrow some risks; they do not demonstrate their elimination.</p>
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

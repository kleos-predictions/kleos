# Kleos in Chaos

A parimutuel prediction-market prototype with public calls and an experimental reputation layer, using nonredeemable kUSD on Monad testnet.

Each market shows money and reputation-weighted pool shares. Principal payout depends on final money pools. Reputation also affects signal weight and bonus allocation; it is not yet a validated measure of independent forecasting skill.

## Current status

Security review is ongoing. Existing testnet contracts do not acquire source repairs automatically. This prototype is not ready for production or real funds.

The full local contract and operator suite currently has **109 passing tests** (60 contract tests and 49 operator tests). The web has 48 regression tests; the indexer has 34 simulated tests passing, with two chain integrations skipped. Verification details are in the repair report. Tests do not certify commercial demand, physical passkey behavior or mechanism security.

## Implemented mechanics

- Activated multiplier: `min(1 + 0.5√R, 5)`, after a deployment-configured number of qualifying positions (ten in the recorded demo).
- Winning principal: stake plus its money share of losing principal, after 2% bonus funding and 1% protocol fees. Void and no-winner markets refund principal.
- Winning R gain: `min(k·min(stake/50, 1)·(1-p), 0.8)`, with entry p clamped to 5–95%. Losses apply immediately to available R/pending R, stopping at zero. Gains require a $1,000 pool and ten addresses; those are not independent-person or meaningful-risk guarantees.
- Bonus: positive net market gain times the multiplier actually carried by winning bets, shared after every bettor settles. Entry order affects bonus shares. The $2,000 whale / twenty $80 YES example pays $177 principal per YES address plus unequal bonuses averaging about $2.
- Court: R-gated addresses, commit/reveal deadlines and three matching votes. A failed two-round court refunds stakes. Address conflicts and a random starting slot do not establish independent adjudication.
- Creation: owner exception, otherwise R≥36, no flag, a $25 bond and $2 fee. The category allowlist does not semantically ban prohibited topics. Source and criteria are human-readable strings, not an automatic oracle adapter.

## App behavior

Configured live contracts supply market IDs, pools, quote weights, receipts, profiles and observed participant rankings. Failed live reads show an unavailable state. Without addresses, sample data keeps demo mode working. Historical data has explicit budgets and unknown fields; it does not invent activity or sharp counts.

Mera passkeys derive signing accounts. Public credential metadata is cached; signing authority stays in memory until lock. Small-action prompting limits are UI policy, not cryptographic spending caps. Fresh authorization preserves the selected signer. Recovery phrases clear on timeout/background/lock; supported real-device recovery still needs verification.

The sponsor requires a short-lived receiving-account signature and checks transaction execution. Its process-local queue and cooldown are partial controls. A shared durable budget and signer queue are needed for public operation across replicas. See [account and sponsor details](web/docs/account-and-sponsor.md).

Calls contain up to 140 UTF-8 bytes. Results compare a chosen side with the recorded outcome. Engagement votes count addresses, not independent endorsements. Public calls and follows are permanent.

## Run locally

```bash
npm --prefix contracts test
npm --prefix web run dev
```

For a local chain, follow `.agents/skills/dev-stack/SKILL.md`; deployment, seeding and the bot run from `contracts/`:

```bash
npm run node
npm run deploy:local
npm run seed:local
npm run court-bot
```

Use separate terminals for the node and web server. Demo catalog times are set relative to the chain when seeded. Seed and court scripts have durable local journals; replay or reset rules are documented in `contracts/scripts/README.md`. Replay cannot finish an unbroadcast bet after its fixed close time.

Testnet deployment, signed actions and private-key use require the owner's explicit authorization for that specific action. Secrets belong in server env variables; only `NEXT_PUBLIC_*` configuration reaches the browser.

## Repository and next decisions

`contracts/` holds contracts and lifecycle scripts; `web/` the Next.js app; `indexer/` Envio handlers; `brand/` design assets.

Participant independence, court economics and mechanism security still need validation. No buyer, renewal, forecast improvement or real-value operating route has been established.

# Kleos in Chaos

A parimutuel prediction-market prototype with public calls and an experimental reputation layer, using nonredeemable kUSD on Monad testnet.

Each market shows money and reputation-weighted pool shares. Principal payout depends on final money pools. Reputation also affects signal weight and bonus allocation; it is not yet a validated measure of independent forecasting skill.

<img width="3000" height="1000" alt="Kleos: your track record is worth more than their bankroll" src="https://github.com/user-attachments/assets/3f0683aa-7e7a-4590-9c67-e028b576fd30" />

**[Live app](https://kleos-iota.vercel.app)** · **Demo video** _(link soon)_ · **Pitch deck** _(link soon)_

| Contract (Monad testnet, chain 10143) | Address |
|---|---|
| Kleos (markets, reputation, Kleos Court) | [`0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb`](https://testnet.monadscan.com/address/0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb) |
| KleosSocial (usernames, follows, call votes) | [`0x766d184Fc25Fe88d30cF62dC9A391cBb2975B9aA`](https://testnet.monadscan.com/address/0x766d184Fc25Fe88d30cF62dC9A391cBb2975B9aA) |
| KleosUSD (test stablecoin) | [`0x74cb7e5f0Ef6d1A32D3b9bb7b40495b61a45B750`](https://testnet.monadscan.com/address/0x74cb7e5f0Ef6d1A32D3b9bb7b40495b61a45B750) |

## Current status

Known security findings remain unresolved. The contract fixes in this branch have not been deployed; existing testnet contracts remain unchanged. This prototype is not ready for production or real funds.

The full local contract and operator suite currently has **145 passing tests** (60 contract tests and 85 operator tests). The web has 118 regression tests; the indexer has 36 simulations and one fresh actual local handler replay passing. Testnet integration and hosted GraphQL acceptance remain unexecuted. Tests do not certify commercial demand, physical passkey behavior or mechanism security.

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

## Data flow

The server-only `INDEXER_URL` enables the GraphQL adapter in `web/src/lib/indexer.ts`. The adapter validates processing checkpoints, chain/deployment configuration, freshness and exact/unknown field provenance before serving indexed data. The repaired schema still requires hosted replay and acceptance. Contract reads remain authoritative for actions. If indexed data is unavailable or incompatible, bounded contract/HyperSync reads provide the live fallback; missing live data is not replaced by samples.

Changed schema and handlers require replay and hosted acceptance; a source adapter does not prove the current deployment uses it.

## Team

Daniela Zschaber ([@danimim](https://github.com/danimim)): product, contracts and web. Artur Pokusin ([@apokusin](https://github.com/apokusin)): Envio indexer and review.

## Repository and next decisions

`contracts/` holds contracts and lifecycle scripts; `web/` the Next.js app; `indexer/` Envio handlers; `brand/` design assets.

Participant independence, court economics and mechanism security still need validation. No buyer, renewal, forecast improvement or real-value operating route has been established.

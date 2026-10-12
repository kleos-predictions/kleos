# Kleos in Chaos

## Prediction Market with a Verifiable Reputation Layer. Built on Monad testnet.

<img width="3000" height="1000" alt="Kleos: your track record is worth more than their bankroll" src="https://github.com/user-attachments/assets/3f0683aa-7e7a-4590-9c67-e028b576fd30" />

**[Live app](https://kleos-iota.vercel.app)** · **Demo video** _(link soon)_ · **Pitch deck** _(link soon)_ · **[Envio GraphQL](https://indexer.dev.hyperindex.xyz/27dbf62/v1/graphql)**

**Testnet prototype.** Kleos is built for testing and demos on Monad testnet, using testnet MON and kUSD. It is not ready for production or real funds.

| Contract (Monad testnet, chain 10143) | Address |
|---|---|
| Kleos (markets, reputation, Kleos Court) | [`0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb`](https://testnet.monadscan.com/address/0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb) |
| KleosSocial (usernames, follows, call votes) | [`0x766d184Fc25Fe88d30cF62dC9A391cBb2975B9aA`](https://testnet.monadscan.com/address/0x766d184Fc25Fe88d30cF62dC9A391cBb2975B9aA) |
| KleosUSD (test stablecoin) | [`0x74cb7e5f0Ef6d1A32D3b9bb7b40495b61a45B750`](https://testnet.monadscan.com/address/0x74cb7e5f0Ef6d1A32D3b9bb7b40495b61a45B750) |


Every bet weighs money × reputation. Reputation only grows when you are right against the crowd, it shrinks faster than it grows, and every change is an on-chain event anyone can audit. Each market shows two prices: what the money says and what proven forecasters say.

## Why Kleos

Prediction markets are failing in four specific ways. Each one has a direct answer in Kleos.

| Failure | What happened | Kleos answer |
|---|---|---|
| **Resolution capture** (Mar 2025) | In Polymarket's $7M Ukraine minerals market, one UMA token whale reportedly cast about 25% of dispute votes and forced a premature "Yes". [Source](https://thedefiant.io/news/defi/polymarket-s-usd7m-ukraine-mineral-deal-debacle-traced-to-oracle-whale) | Resolvers are gated by earned reputation, not purchasable tokens. |
| **Conflicted judges** (2026) | A Wall Street Journal investigation reportedly found nearly 20% of disputed Polymarket outcomes involved oracle voters with stakes in the market they judged. [Source](https://www.turbinefi.com/blog/how-prediction-markets-resolve-oracles-disputes-2026) | Anyone with a position is excluded from resolving that market. |
| **Whale concentration** (Oct 2024) | One trader spread more than $45 million of Trump bets across several Polymarket accounts. [Source](https://www.theblock.co/post/324996/polymarket-whale-us-election-profit-france-ban) | A reputation-weighted price shown next to the money price, with a 10% per-address cap. |
| **Insider trading** (Apr 2026) | In a federal criminal case, a soldier is charged with using classified information to bet about $33,000 on the Maduro operation and cashing out about $400,000. [Source](https://www.justice.gov/opa/pr/us-soldier-charged-using-classified-information-profit-prediction-market-bets) | Reputation vests over time, gains are capped per market, anomalies are reviewed. |

### Evidence

- Small crowds of proven forecasters outperform larger crowds in both markets and polls (Atanasov, Witkowski, Mellers & Tetlock, *International Journal of Forecasting* 41(2), 2025). [Source](https://www.sciencedirect.com/science/article/abs/pii/S0169207023001413)
- Across 5,456 Polymarket and Kalshi markets, bigger bettors were not more accurate; in some markets whales had negative edge (Daleep et al., 2026). [Paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6322678) · [Summary](https://klementoninvesting.substack.com/p/a-fundamental-flaw-of-prediction)

> **Implementation status:** every answer above is implemented and tested in `contracts/` (48 tests). The contracts are deployed on Monad testnet (`contracts/ignition/deployments/chain-10143/deployed_addresses.json`).

## How it works

| Formula | Meaning |
|---|---|
| `M = min(1 + 0.5·√R, 5)` | Reputation becomes a multiplier with diminishing returns |
| `P_rep = YES_E / total_E`, `P_money = YES$ / total$` | The signal and the money price, side by side |
| Right: `ΔR = +k·s·(1 − p)` · Wrong: `ΔR = −1.5·k·s·p` | You earn reputation for surprising the market; losses hurt 1.5× more |

Money pays money: payouts split the losing pool by stake, so newcomers earn the same per dollar as veterans. Losing costs your stake, never more: fees come only out of the losing side, once, at resolution. 2% funds a bonus for winners who beat the market and 1% is Kleos revenue, along with a $2 fee per community-created market. The interactive version lives at `/how-it-works`.

## What's in the app

- **Passkey accounts (Mera).** No wallet extension, no seed phrase. The account is derived from a passkey and rebuilt on any device; nothing secret is stored. Gas and test USD are sponsored, so a first bet is a single transaction. Sessions lock after 15 idle minutes; bigger bets, bonds and jury votes ask for the passkey again.
- **Market creation.** The team, and tier-V traders (R ≥ 36) with a $25 bond plus a $2 fee. The bond comes back when the market resolves YES or NO and is lost if the court rules the question ambiguous. Whoever writes a question can't propose its outcome or sit on its jury.
- **Kleos Court.** A disputed outcome goes to 5 randomly drawn tier-V jurors with no position in the market. Votes are committed hidden and revealed later; 3 of 5 decide YES, NO or AMBIGUOUS, which voids the market and refunds everyone. A dispute needs at least 3 eligible jurors, and a closed market nobody resolves expires into refunds, so stakes are never stuck. A juror's hidden-vote secret is derived from their passkey, so it can be revealed from any device.
- **Calls and the feed.** Any bet can carry a call: a public, permanent one-line reason, scored when the market resolves ("Called it" / "Missed"). The feed filters by All, Sharps and Following; calls take ▲▼ votes.
- **Profiles.** Usernames, follows, reputation over time and a history where every change links to its transaction, with the math shown on hover.
- **Compare.** Real controversies (the Zelensky suit, Khamenei on Kalshi) replayed on Kleos, including what Kleos would *not* fix.

## Hackathon

**Track: Social, Attention & Culture.** Kleos moves attention from the loudest voice and the biggest wallet to whoever called it first. Calls are opinions with receipts, scored when the market resolves.

**Best Mera-Powered UX on Monad**
- Landing → "Start with a passkey" → Touch ID → a confirmed bet on Monad. Gas and test USD are sponsored, and the trade panel shows the seconds it took.
- Small bets, follows, votes, settling and claiming need no prompt inside a session. Bets over $100, bonds and jury votes ask for the passkey again.
- Nothing secret is stored: sign in on another device and get the same account. A juror's hidden-vote secret comes from the passkey, so a vote cast on a laptop can be revealed on a phone.

**Best Use of Envio**
- A HyperIndex indexer (`indexer/`) on Envio Cloud, synced through HyperSync, covering Kleos, the Kleos Court and KleosSocial.
- Entities no single event contains: `Trader` aggregated from six event types, and a per-market sharp signal that joins bets with reputation.
- The web app reads markets, bets, calls, the feed, the leaderboard and reputation history from its GraphQL, and every reputation change links to its transaction.

## Team

Daniela Zschaber ([@danimim](https://github.com/danimim)): product, contracts and web. Artur Pokusin ([@apokusin](https://github.com/apokusin)): Envio indexer and review.

## Repository

```
contracts/   Solidity (Hardhat 3): Kleos.sol (markets, reputation, Kleos Court), KleosSocial.sol
             (usernames, follows, votes), KleosUSD.sol (test stablecoin), tests, deploy and demo scripts
web/         Next.js app: markets, market page with the court, feed, profiles, compare, how it works
indexer/     Envio HyperIndex: config.yaml, schema.graphql, src/handlers/ (see indexer/ARCHITECTURE.md)
brand/       Brand kit: logos, tier laurels, palette, typography, icons (see brand/README.md)
design/      Reference exports from Claude Design
BLUEPRINT.md Technical blueprint and roadmap
```

## Run it

```bash
npm --prefix contracts test
```

```bash
npm --prefix web run dev
```

Without contract addresses in `web/.env.local`, the app runs in demo mode with sample data. See `web/.env.example`.

**Full local stack** (a local chain with demo traders, a resolved market and a live court), from `contracts/`, each in its own terminal:

```bash
npm run node
```

```bash
npm run deploy:local && npm run seed:local && npm run court-bot
```

`deploy:local` writes the addresses into `web/.env.local`. On Monad testnet, set `ENVIO_API_TOKEN` in the web server's env: event reads go through Envio HyperSync, since the public RPC serves logs 100 blocks at a time. Set `KLEOS_ME=0x…` before `seed:local` to give your passkey account demo reputation, and use `npm run dispute` to send a proposal to the court.

## Data flow

```
Kleos.sol, KleosSocial.sol (Monad testnet)
  → events
  → Envio HyperIndex on Envio Cloud (indexer/, reads the chain through HyperSync)
  → GraphQL, queried only by the web server (web/src/lib/indexer.ts, cached 10 s)
  → pages
```

Markets, prices, recent bets, the sharp signal, calls, the feed, the leaderboard and reputation history come from the indexer. Balances, the trade panel and the account's own reputation are read from the contracts, because they must be exact at the moment of an action. Set the server-only `INDEXER_URL` to the deployment's GraphQL endpoint (`indexer/DEPLOY.md`). Without it, or if the indexer fails, pages read the chain directly, and with no contract addresses they show sample data.

## Known limitations

- **Audit status.** The full [audit remediation PR #10](https://github.com/kleos-predictions/kleos/pull/10) is still unmerged. Focused demo fixes do not close all of its findings, and its proposed contract changes have not been deployed. The existing testnet contracts remain unchanged.
- **Jury bribery.** Disputes go to the Kleos Court, where votes stay hidden until the reveal, but a juror can prove their vote afterward, so open bribes are possible. Random draws and reputation at stake make it costly, not impossible. Jury draws use block randomness, which block producers can nudge.
- **Parimutuel pricing.** Thin markets move sharply with each bet. LMSR is the planned upgrade for thin markets.
- **The anomaly flag is a heuristic, not proof of insider trading.** It holds back unvested reputation for review; it does not accuse anyone.

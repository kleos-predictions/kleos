# Kleos in Chaos

**Testnet prototype.** This project uses test tokens and is not ready for production or real funds. Security review and live acceptance remain incomplete.

**Prediction Market with a Verifiable Reputation Layer.** Built on Monad testnet.

Every bet weighs money × reputation. Reputation only grows when you are right against the crowd, it shrinks faster than it grows, and every change is an on-chain event anyone can audit. Each market shows two prices: what the money says and what proven forecasters say.

## Why Kleos

Prediction markets are failing in four specific ways. Each one has a direct answer in Kleos.

| Failure | What happened | Kleos answer |
|---|---|---|
| **Resolution capture** (Mar 2025) | In Polymarket's $7M Ukraine minerals market, one UMA token whale reportedly cast about 25% of dispute votes and forced a premature "Yes". [Source](https://thedefiant.io/news/defi/polymarket-s-usd7m-ukraine-mineral-deal-debacle-traced-to-oracle-whale) | Resolvers are gated by earned reputation, not purchasable tokens. |
| **Conflicted judges** (2026) | A Wall Street Journal investigation found nearly 20% of disputed Polymarket outcomes involved oracle voters with stakes in the market they judged. [Source](https://www.turbinefi.com/blog/how-prediction-markets-resolve-oracles-disputes-2026) | Anyone with a position is excluded from resolving that market. |
| **Price distortion** (Oct 2024) | One trader with eleven linked wallets pushed Polymarket's election odds 10–15 points above competing platforms. [Source](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6670638) | A reputation-weighted price shown next to the money price, with a 10% per-address cap. |
| **Insider trading** (Apr 2026) | In the first criminal case, a soldier allegedly used classified information to bet $33,000 on the Maduro operation and cashed out about $400,000. [Source](https://fortune.com/2026/04/26/prediction-markets-insider-trading-illegal-kalshi-polymarket-robin-hanson-economist/) | Reputation vests over time, gains are capped per market, anomalies are reviewed. |

### Evidence

- Small crowds of proven forecasters outperform larger crowds in both markets and polls (Atanasov, Witkowski, Mellers & Tetlock, *International Journal of Forecasting*, 2025). [Source](https://www.sciencedirect.com/science/article/abs/pii/S0169207023001413)
- Across 5,456 Polymarket and Kalshi markets, bigger bettors were not more accurate; in some markets whales had negative edge (Daleep et al., 2026). [Source](https://klementoninvesting.substack.com/p/a-fundamental-flaw-of-prediction)

> **Implementation status:** every answer above is implemented and tested in `contracts/` (34 tests). The Monad testnet deployment is pending.

## How it works

| Formula | Meaning |
|---|---|
| `M = min(1 + 0.5·√R, 5)` | Reputation becomes a multiplier with diminishing returns |
| `P_rep = YES_E / total_E`, `P_money = YES$ / total$` | The signal and the money price, side by side |
| Right: `ΔR = +k·s·(1 − p)` · Wrong: `ΔR = −1.5·k·s·p` | You earn reputation for surprising the market; losses hurt 1.5× more |

Money pays money: payouts split the losing pool by stake, so newcomers earn the same per dollar as veterans. A 2% fee funds a bonus for winners who beat the market. The interactive version lives at `/how-it-works`.

## What's in the app

- **Passkey accounts (Mera).** No wallet extension, no seed phrase. The account is derived from a passkey and rebuilt on any device; nothing secret is stored. Gas and test USD are sponsored, so a first bet is a single transaction. Sessions lock after 15 idle minutes; bigger bets, bonds and jury votes ask for the passkey again.
- **Kleos Court.** A disputed outcome goes to 5 randomly drawn tier-V jurors with no position in the market. Votes are committed hidden and revealed later; 3 of 5 decide YES, NO or AMBIGUOUS, which voids the market and refunds everyone. A juror's hidden-vote secret is derived from their passkey, so it can be revealed from any device.
- **Calls and the feed.** Any bet can carry a call: a public, permanent one-line reason, scored when the market resolves ("Called it" / "Missed"). The feed filters by All, Sharps and Following; calls take ▲▼ votes.
- **Profiles.** Usernames, follows, reputation over time and a history where every change links to its transaction, with the math shown on hover.
- **Compare.** Real controversies (the Zelensky suit, Khamenei on Kalshi) replayed on Kleos, including what Kleos would *not* fix.

## Repository

```
contracts/   Solidity (Hardhat 3): Kleos.sol (markets, reputation, Kleos Court), KleosSocial.sol
             (usernames, follows, votes), KleosUSD.sol (test stablecoin), tests, deploy and demo scripts
web/         Next.js app: markets, market page with the court, feed, profiles, compare, how it works
design/      Reference exports from Claude Design
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

`deploy:local` writes the addresses into `web/.env.local`. Set `KLEOS_ME=0x…` before `seed:local` to give your passkey account demo reputation, and use `npm run dispute` to send a proposal to the court.

## Known limitations

- **Jury bribery.** Disputes go to the Kleos Court, where votes stay hidden until the reveal, but a juror can prove their vote afterward, so open bribes are possible. Random draws and reputation at stake make it costly, not impossible. Jury draws use block randomness, which block producers can nudge.
- **Parimutuel pricing.** Thin markets move sharply with each bet. LMSR is the planned upgrade for thin markets.
- **The anomaly flag is a heuristic, not proof of insider trading.** It holds back unvested reputation for review; it does not accuse anyone.

# Kleos in Chaos

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

> **Implementation status:** every answer above is implemented and tested in `contracts/src/Kleos.sol` (22 tests). The testnet deployment is pending.

## How it works

| Formula | Meaning |
|---|---|
| `M = min(1 + 0.5·√R, 5)` | Reputation becomes a multiplier with diminishing returns |
| `P_rep = YES_E / total_E`, `P_money = YES$ / total$` | The signal and the money price, side by side |
| Right: `ΔR = +k·s·(1 − p)` · Wrong: `ΔR = −1.5·k·s·p` | You earn reputation for surprising the market; losses hurt 1.5× more |

The interactive version lives at `/how-it-works` in the app.

## Repository

```
contracts/   Solidity (Hardhat 3): Kleos.sol, KleosUSD.sol, tests, Ignition deploy module
web/         Next.js app: markets, market page, profiles, leaderboard, how it works
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

## Known limitations

- **Admin arbitration for disputed events.** Undisputed outcomes finalize on their own, but a dispute is settled by the contract owner.
- **Parimutuel pricing.** Thin markets move sharply with each bet. LMSR is the planned upgrade for thin markets.
- **The anomaly flag is a heuristic, not proof of insider trading.** It holds back unvested reputation for review; it does not accuse anyone.

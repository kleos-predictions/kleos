# Indexer plan: issues #1 and #2

Goal: every read in the web app comes from an Envio HyperIndex indexer (#1), including bet buddies (#2), without stepping on the rest of the team's work.
Live status: `PROGRESS.md`. Update it at the end of every step.

## Ground rules

- **Stay in our files.** We create `indexer/`, `web/src/lib/indexer.ts` and new components. Pages, `data.ts`, `onchain.ts` and `contracts/` belong to Daniela. We change them only in one announced wiring PR (phase 5). New scripts go in new files; existing ones stay untouched.
- **Local first.** Build and test against the local Hardhat chain (see the `dev-stack` skill). Testnet and Envio Cloud come last (phase 6), and every testnet action needs Daniela's explicit OK.
- **The contract is the truth.** Each derived value must match what the contract computes. Integration tests compare indexer entities with contract reads.
- **Branch:** `indexer`. Keep commits small and rebase on `main` before each PR.

## How we test without Docker

`createTestIndexer()` runs the real handlers in memory. Two modes:

| Mode | Use | Needs |
|---|---|---|
| `simulate: [...]` | Unit tests for exact edge cases | Nothing |
| `{ startBlock, endBlock }` on chain 31337 | Integration: the real seeded chain through the real handlers | Local node + deploy + seed |

Integration tests skip themselves when the local RPC doesn't answer, so `pnpm test` always runs.
Only `envio dev` (a local GraphQL server) needs Docker. We don't need it until phase 5, and Envio Cloud covers it.

## Contract facts the handlers depend on

- Money: 6 decimals. R, M, prices, weights: 18 decimals (WAD). Store raw `BigInt`s.
- `ReputationChanged.marketId == 0` means a demo seed or an admin slash, not a market. `entryPrice == 0` with `marketId > 0` means jury duty, not a bet.
- `ReputationChanged` carries `newR` and `pendingR`, so `Trader.r` and `Trader.pending` are set from it, never accumulated. `Vested` carries `newR`, and pending becomes 0.
- Reputation (and bet buddies) only count in markets with ≥ $1,000 and ≥ 10 distinct bettors (`MIN_REP_POOL`, `MIN_BETTORS`).
- `MarketResolved` never fires for voided markets. A court AMBIGUOUS verdict, a failed court or expiry emits `MarketVoided` instead.
- `Settled.payout > 0` doesn't mean "won": refunds pay out too. Winners come from positions plus the outcome.
- Call id = the `callId` in `CallPosted`, numbered by `Kleos` from 1. `KleosSocial.vote` uses the same number.
- Markets are created by the team (free) or tier-V traders (bond + fee). `MarketCreated` carries the creator. `CreatorBondReleased` says whether a trader's bond was forfeited (court ruled the question AMBIGUOUS).
- `RevenueAccrued` for the creation fee is emitted *before* `MarketCreated`, so any handler for it must not assume the market exists.
- `resolvedBets` is not in any event. It's derived from settles of positions ≥ $50 (`STAKE_REF`) in deep markets. Seeds set it off-event, so seeded traders read low.
- `MarketExpired` follows `MarketVoided` in the same transaction. A court that fails its last round emits only `MarketVoided`.

## Phases

### Phase 0: set up
- `indexer/` scaffold on chain 31337 (done), pnpm build approval for esbuild, `viem` for the integration test.
- Envio's official skills live in `indexer/.agents/skills/`, symlinked from `indexer/.claude/skills/` (same pattern as the repo root).
- Remove `indexer/.github/`: GitHub ignores nested workflows.

### Phase 1: core entities (tier 1)
Schema and handlers, each with simulated-event tests:

| Entity | Id | Built from | Serves |
|---|---|---|---|
| `Market` | marketId | MarketCreated, BetPlaced, Sponsored, OutcomeProposed, OutcomeDisputed, MarketResolved, MarketVoided | Markets grid, market page |
| `Position` | `marketId_user` | BetPlaced | Distinct bettors, bet buddies |
| `Bet` | `block_logIndex` | BetPlaced | Recent bets |
| `PricePoint` | `block_logIndex` | BetPlaced (prices after the bet) | Price chart |
| `Trader` | lowercase address | ReputationChanged, Vested, Flagged, FlagCleared, BetPlaced | Leaderboard, profile, badges |
| `ReputationChange` | `block_logIndex` | ReputationChanged | Profile history with the math and tx links |
| `Call` | call id (above) | CallPosted, then MarketResolved / MarketVoided set `result` | Feed, market calls, profile |

Then an integration test: process the seeded local chain and compare with contract reads (`getMarket`, `prices`, `reputation`, `getBettors`).

### Phase 2: lifecycle on the local chain
`seed-demo.ts` on `main` already resolves and settles a deep market and sets up a jury pool; `scripts/dispute.ts` and `scripts/court-bot.ts` run the court. Reuse them to exercise resolution, settlement, bonus and court handlers on real events, and extend the integration test to compare those values with the contract. Write a new script only for paths they don't reach.

### Phase 3: social, sharp signal, court (tier 2)
- Add `KleosSocial` to `config.yaml`. `Trader.name`, `Follow`, follower and following counts, `Call.ups`/`downs`.
- `SharpSignal` per market: distinct traders with R ≥ 16 at bet time, by side.
- `CourtRound` (jury, commits, reveals, tally, verdict) and `Trader.isJuror`.

### Phase 4: bet buddies, #2 (tier 3)
- `BuddyPair` (id = the two sorted lowercase addresses), `wonTogether`, `lastMarket`, `lastAt`.
- Computed on `MarketResolved`: `getWhere` the market's positions, keep holders of the winning side, pair them, and skip shallow markets. Voided markets never emit `MarketResolved`.
- Tests: #2's case (3 traders, 2 winners → 1 pair), shallow market → no pairs, voided → no pairs.

### Phase 5: web client, then the one wiring PR
- `web/src/lib/indexer.ts`: `fetch` against the server-only `INDEXER_URL` (queries run server-side, cached briefly), returning the existing types in `web/src/lib/data.ts`. One function per read the pages make today.
- New components: `court-panel.tsx`, `bet-buddies.tsx`.
- Wiring PR, announced to Daniela first: pages pick `indexer → onchain → sample`.

### Phase 6: testnet and Envio Cloud (needs Daniela)
- `config.testnet.yaml` (chain 10143 on HyperSync, both addresses, start block). The local `config.yaml` stays for development and tests.
- Deploy to Envio Cloud, spot-check against Monadscan, and add the README data-flow section. Close #1 and #2.

## Out of scope
Contract changes, page redesigns, BLUEPRINT edits, resolution UI. Anything we find there goes to Daniela as a note, not a commit.

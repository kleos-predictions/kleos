# Kleos indexer

An [Envio HyperIndex](https://docs.envio.dev) indexer for Kleos. It reads the events of both contracts and serves them as one GraphQL API:

- `Kleos.sol`: markets, bets, calls, settlement, reputation and Kleos Court.
- `KleosSocial.sol`: usernames, follows and call votes.

Two configs list the same contracts and events:

- `config.yaml`: the local Hardhat chain (31337), read over RPC.
- `config.testnet.yaml`: Monad testnet (10143), read through HyperSync. Envio Cloud runs this file.

## Entities

Defined in `schema.graphql`, built by `src/handlers/`.

| Entity | Built from | Used for |
|---|---|---|
| `Category` | `CategoryAdded` | Market categories |
| `Market` | Market lifecycle events, `BetPlaced`, `CallPosted`, `JuryDrawn`, `Verdict` | Market pages: pools, prices, state, sharp signal, bonus |
| `Position` | `BetPlaced`, `Settled`, `BonusClaimed` | One trader's stake in one market, payout and bonus |
| `Bet` | `BetPlaced` | Trade history, R at bet time |
| `PricePoint` | `BetPlaced` | Price charts |
| `Trader` | Reputation, bet, court and social events | Profiles and the leaderboard: R, wins, losses, juror status, name, follower counts |
| `ReputationChange` | `ReputationChanged` | Reputation history, labelled Bet, Jury or Admin |
| `Call` | `CallPosted`, `MarketResolved`, `MarketVoided`, `CallVoted` | Calls with their result and up/down votes |
| `CourtRound` | `JuryDrawn`, `VoteCommitted`, `VoteRevealed`, `CourtRedrawn`, `Verdict`, `MarketVoided` | Each Kleos Court round on a disputed market |
| `JurorVote` | `JuryDrawn`, `VoteCommitted`, `VoteRevealed` | Each juror's seat and vote in a round |
| `Follow` | `Followed`, `Unfollowed` | Who follows whom |
| `CallVote` | `CallVoted` | Each address's vote on a call |
| `Protocol` | Market, bet, call, juror and revenue events | Totals across the protocol (Envio Cloud has no `_aggregate` queries) |

Bet buddies (`BuddyPair`, issue #2) and the web client (`web/src/lib/indexer.ts`, issue #3) are planned.

## Test

Needs Node.js 22 or newer and pnpm. No Docker.

```bash
pnpm install && pnpm codegen && pnpm test
```

`pnpm test` runs the simulated handler tests and an integration test against the local chain. The integration test skips itself when no local chain with the contracts is running (see the `dev-stack` skill).

```bash
pnpm test:testnet
```

Runs the real handlers over the live Monad testnet deployment and compares the result with the contracts. It needs `ENVIO_API_TOKEN` in `indexer/.env` for HyperSync.

Run `pnpm codegen` again after changing `schema.graphql` or a config.

## Run a local GraphQL server (optional)

```bash
pnpm dev
```

Needs Docker or Podman. The GraphQL Playground is at http://localhost:8080 (local password `testing`). The tests above don't need it.

## More

- `ARCHITECTURE.md`: diagrams of which event updates what, the entities and a market's life.

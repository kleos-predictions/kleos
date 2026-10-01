---
name: envio-indexer
description: Build, test and deploy the Kleos Envio HyperIndex indexer (indexer/), and wire the web app to its GraphQL API. Kleos-specific event semantics, local testing without Docker, and the plan and progress files for issues #1 and #2. Use for any work in indexer/, web/src/lib/indexer.ts, or GitHub issues #1 and #2.
---

# Envio indexer

The indexer turns contract events into the reads the app needs: markets, prices, bets, the sharp signal, the leaderboard, profile history, court state and bet buddies. It is also the entry for the Envio bounty, so schema depth and code quality are judged.

## Start here

1. **`indexer/PROGRESS.md`:** where the work stands and how to resume. Update it at the end of every step.
2. **`indexer/PLAN.md`:** phases, ownership rules and the contract facts the handlers rely on.
3. **`indexer/ARCHITECTURE.md`:** diagrams of the data flow, the event → entity map, the market lifecycle and the settle event order.
4. **Issues #1 and #2:** the requirements (`gh issue view 1`, `gh issue view 2 --comments`).

## Envio API reference

Envio 3.12.1 ships official skills in `indexer/.agents/skills/indexer-*` (handlers, schema, testing, configuration, transactions and more). They match the installed version, so use them for API questions instead of memory. Training data is mostly older Envio, and the API changed a lot.

## Kleos-specific rules

- **pnpm only.** pnpm 11 blocks install scripts, so `esbuild` is allowed in `indexer/pnpm-workspace.yaml`.
- **Env vars** in `config.yaml` must start with `ENVIO_`, or Envio Cloud won't see them.
- **Request `transaction: ["hash"]`** in `fields` for anything the UI links to Monadscan.
- **Envio Cloud has no `_aggregate` queries.** Compute every count, sum and ranking in handlers.
- Money uses 6 decimals. R, M, prices and weights use 18 (WAD). Store raw `BigInt`s, and convert in the app.

## Event semantics that are easy to get wrong

- **`marketId` 0** in `ReputationChanged` marks demo seeds and admin slashes, not a market.
- **Jury rewards and penalties** are `ReputationChanged` rows with `entryPrice` 0 and `marketId` > 0. They aren't bets: don't count them as wins or losses.
- **`ReputationChanged` carries `newR` and `pendingR`.** Set the trader's values from them rather than accumulating deltas. Positive ΔR goes to pending, and R grows only on `Vested`.
- **The `Settled` payout doesn't say who won.** `payout > 0` also covers refunds. Derive winners from indexed positions plus the `MarketResolved` outcome.
- **`MarketResolved` never fires for voided markets.** A court AMBIGUOUS verdict, a failed court or expiry emits `MarketVoided` instead (`MarketExpired` follows it).
- **Reputation only moves in markets with ≥ $1,000 and ≥ 10 distinct bettors.** Track both on `Market`. `resolvedBets` also needs the position (both sides) to be ≥ $50.
- **The sharp signal** uses the trader's R at bet time (R ≥ 16), from the `Trader` entity when `BetPlaced` fires.
- **A call's id** is the `callId` field of its `CallPosted` event, numbered by `Kleos` from 1 (`callCount`). `KleosSocial.vote` and `CallVoted` use the same number, so use it as the `Call` entity id.

## Testing locally, without Docker

`createTestIndexer()` runs the real handlers in memory:

- **Unit:** `simulate: [...]` feeds synthetic events. Use it for edge cases.
- **Integration:** `{ startBlock, endBlock }` on chain 31337 reads the real local chain over RPC. Bring the chain up with the `dev-stack` skill first. These tests skip when the RPC is down.
- **Live testnet:** `pnpm test:testnet` swaps in `config.testnet.yaml`, indexes the real deployment through HyperSync and compares it with the contracts. Needs `ENVIO_API_TOKEN` in `indexer/.env`.

Only `envio dev` (the local GraphQL server) needs Docker. For the web app, use Envio Cloud instead.

## Deploy

`DEPLOY.md` is the runbook. Envio Cloud runs `config.testnet.yaml` on Monad testnet (10143) through HyperSync; hosted indexers need no token, so there are no env vars. The free plan allows 3 deployments at once, gives each its own URL and deletes them after 30 days, so deploy on purpose and check with `pnpm test:testnet` first. Deploying needs the owner's go-ahead (`AGENTS.md`). After any contract redeploy, update both addresses and the start block in the testnet config.

## App wiring

- `web/src/lib/indexer.ts` is a small server-side `fetch` client for `INDEXER_URL` (server-only, so a new Envio deployment URL needs no client rebuild; cached to stay under the free plan's 100 queries a minute). No SDK.
- Return the same types as `web/src/lib/data.ts` so pages barely change. When the env var is empty, fall back to `web/src/lib/onchain.ts`, then to sample data.
- GraphQL returns numerics as strings and addresses checksummed. Parse the numbers, and lowercase addresses before comparing.

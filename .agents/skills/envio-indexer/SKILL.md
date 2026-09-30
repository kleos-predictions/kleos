---
name: envio-indexer
description: Build, test and deploy the Kleos Envio HyperIndex indexer (indexer/), and wire the web app to its GraphQL API. Covers HyperIndex v3.12.1 specifics that differ from older Envio versions. Use for any work in indexer/, web/src/lib/indexer.ts, or GitHub issues #1 and #2.
---

# Envio indexer

The indexer turns contract events into the reads the app needs: markets, prices, bets, the sharp signal, the leaderboard, profile history, court state and bet buddies. It is also the entry for the Envio bounty, so schema depth and code quality are judged. Requirements live in GitHub issues #1 (indexer) and #2 (bet buddies); read them first.

## Verify before you rely on this

These notes were written for **HyperIndex v3.12.1**. Envio's API changed a lot across versions, and model training data is mostly older. Before writing handlers, check the installed version's docs or types (`indexer/node_modules/envio`) for anything below that matters to the task, and fix this file if it is wrong.

## Setup

- **Location:** `indexer/` at the repo root. Envio Cloud supports a monorepo root dir.
- **Package manager: pnpm only.** `npm install` fails with an `edgesOut` error.
- **Scaffold without prompts:**
  ```bash
  npm --prefix contracts run compile   # ABI: contracts/artifacts/src/Kleos.sol/Kleos.json
  pnpx envio@3.12.1 -d ./indexer init contract-import local \
    -a <path-to-abi.json> --contract-name Kleos -b 10143 \
    -c <KleosAddress> -s <deployBlock> --single-contract --all-events \
    -n kleos-indexer -l typescript --api-token "" </dev/null
  ```
  Then add `KleosSocial` (`NameSet`, `Followed`, `Unfollowed`, `CallVoted`) as a second contract in `config.yaml`.
- **Config:** `config.yaml` uses the v3 `chains:` syntax, not `networks:`. Monad testnet (10143) is on HyperSync natively, so no RPC URL is needed.
- **Env vars** that Envio Cloud should see must start with `ENVIO_`.

## Handlers

- Register with `indexer.onEvent({ contract, event, fields }, async ({ event, context }) => …)`. Loaders are deprecated.
- Request `transaction: ["hash"]` in `fields`: every profile row links to Monadscan.
- Entities are read-only. Write a copy: `context.X.set({ ...existing, field })`.
- **Envio Cloud has no `_aggregate` queries.** Compute every count, sum and ranking in handlers (`Trader.wins`, `SharpSignal`, `BuddyPair.wonTogether`).
- Money uses 6 decimals. R, M, prices and weights use 18 (WAD). Store raw `BigInt`s, and convert in the app.

## Event semantics that are easy to get wrong

- **`marketId` 0** in `ReputationChanged` marks demo seeds and admin slashes, not a market.
- **Jury rewards and penalties** are `ReputationChanged` rows with `entryPrice` 0. They aren't bets: don't count them as wins or losses.
- **Positive ΔR goes to pending**, so it isn't part of R yet: R grows only on `Vested`. Losses and `Slashed` reduce R, then pending.
- **The `Settled` payout doesn't say who won.** `payout > 0` also covers refunds (a voided market, or nobody on the winning side). Derive winners from indexed positions plus the `MarketResolved` outcome, and skip markets that emit `MarketVoided`.
- **Reputation only moves in markets with ≥ $1,000 and ≥ 10 distinct bettors.** Track both on `Market` for bet buddies (#2).
- **The sharp signal** uses the trader's R at bet time (R ≥ 16), read from the `Trader` entity when `BetPlaced` fires.
- **A call's id** is the `callId` field of its `CallPosted` event, numbered by `Kleos` from 1 (`callCount`). `KleosSocial.vote` and `CallVoted` use the same number, so use it as the `Call` entity id.

## Tests

Docker isn't installed, so the indexer can't run locally. Prove handlers with `createTestIndexer` (`pnpm test` in `indexer/`), with at least one test per entity. Bet buddies needs a test with 3 traders and 2 winners on one market, which gives one pair with `wonTogether = 1`.

## Deploy

Envio Cloud (free plan: 3 indexers, 100k events) reads from Monad testnet only after the contracts are deployed there. That deploy needs the owner's authorization (`AGENTS.md`). After any contract redeploy, update the address and start block in `config.yaml`.

## App wiring

- `web/src/lib/indexer.ts` is a small `fetch` client for `NEXT_PUBLIC_INDEXER_URL`. No SDK.
- Return the same types as `web/src/lib/data.ts` so pages barely change. When the env var is empty, fall back to sample data (demo mode) or to `web/src/lib/onchain.ts`.
- GraphQL returns numerics as strings and addresses checksummed. Parse the numbers, and lowercase addresses before comparing.

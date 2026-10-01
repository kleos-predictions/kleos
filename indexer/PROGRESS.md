# Indexer progress

Plan: `PLAN.md`. Diagrams: `ARCHITECTURE.md`. Deploy runbook: `DEPLOY.md` (update them when handlers change). Update this file at the end of every step, before committing.

**Branch:** `main` · **Last updated:** 2026-10-01

## Resume here

1. `cd indexer && pnpm install && pnpm codegen && pnpm test`. The local-chain test skips unless the `dev-stack` skill's chain is up (Kleos at `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`, KleosSocial at `0x5FbDB2315678afecb367f032d93F642f64180aa3`, both deterministic on a fresh node).
2. `pnpm test:testnet` checks the real handlers against the live Monad testnet contracts (needs `ENVIO_API_TOKEN` in `indexer/.env`).
3. Continue at the first unchecked item below. Deploying: `DEPLOY.md`.

## Status

### Phase 0: set up
- [x] Scaffold `indexer/` (Envio 3.12.1, chain 31337 over RPC, all 25 Kleos events)
- [x] Allow esbuild's build in `pnpm-workspace.yaml` (pnpm 11 blocks it by default)
- [x] Confirm the in-memory test indexer reads the real local chain over RPC (blocks 0–84: 37 events, 6 markets, 11 bets, 10 calls, 6 seeds)
- [x] Add `viem` dependency (integration test reads the contracts)
- [x] Move Envio skills to `indexer/.agents/skills/` + symlinks in `indexer/.claude/skills/`
- [x] Remove `indexer/.github/`
- [x] Stacked on `agent-skills` until PR #3 merged; rebased onto `main` on 2026-09-29
- [x] Root `envio-indexer` skill: points here and to Envio's skills; local testing without Docker

### Phase 1: core entities
- [x] Schema: Category, Market, Position, Bet, PricePoint, Trader, ReputationChange, Call (`schema.graphql`)
- [x] Handlers in `src/handlers/{markets,bets,reputation}.ts`, helpers in `src/utils.ts`
- [x] Simulated tests (`src/test/core.test.ts`, 11 tests). Mutation-checked: 15 deliberate regressions all caught.
- [x] Integration test (`src/test/local-chain.test.ts`): every market's pools, prices and bettors, and every trader's R, pending and flag match the contract on the seeded chain. Skips when the RPC is down (`KLEOS_TEST_RPC` overrides the URL).

### Phase 1b: catch up with main's contract (2026-09-29)
Daniela's `6351afd` and `c72c3a2` changed events: `MarketCreated` gained `creator`, `CallPosted` gained a contract-numbered `callId` (KleosSocial votes use it), and `RevenueAccrued`, `RevenueWithdrawn`, `CreatorBondReleased` are new.
- [x] Rebase onto `main`; `config.yaml` matches the new ABI (28 events)
- [x] `Call.id` = `callId` (the keccak id and its helper are gone); `Market.creator`, `Market.creatorBondForfeited`
- [x] Tests: simulated (12) + integration now also checks each market's creator and that seeded votes land on indexed call ids. 4 new mutations all caught.

### Phase 2: lifecycle on the local chain
Daniela's `seed-demo.ts` on `main` (commit `3a8d383`) now resolves and settles a deep market for real (11 bettors, $1,000+), sets up an 8-juror pool, and ships `scripts/dispute.ts` + `scripts/court-bot.ts` to run the court. So we reuse it instead of writing our own seed:
- [x] Reseed a fresh chain with `main`'s `seed-demo.ts` (2026-10-01)
- [x] `local-chain.test.ts` checks state, outcome, `bonusOpen`, the bonus pot and weight (`payouts`), and each position's `settled` and `bonusWeight`
- [x] Court on real events: market 8 proposed by the team, disputed with `dispute.ts`, voted on by `court-bot.ts`. Both rounds closed without reveals, so it covers the redraw, the failed court, the void and the no-show penalties. The test checks each round's jury, commits, reveals and `failed` against `getJury`, `commitments` and `votes`.
- [ ] Not on real events yet: a court that reaches a verdict (covered by simulated tests). Note for Daniela: in this run `court-bot.ts` committed but never revealed after `evm_increaseTime` jumps; on testnet real time passes, so it may be fine there

### Phase 3: social, sharp signal, court (2026-10-01)
- [x] Checked every handler against the final contract (652f4e3), not past notes. Fixed: `resolvedBets` counts only positions ≥ $50 (`STAKE_REF`); `MarketExpired` and `JurorPruned` indexed; `BonusRolledOver` and `Slashed` recorded; stale comments about unchecked market ids removed. Every Kleos and KleosSocial event in the configs matches the compiled ABI; only `OwnershipTransferred` is left out on purpose.
- [x] Sharp signal on `Market` (`sharpYes`, `sharpNo`) and `Bet` (`traderR`, `sharp`): distinct traders per side with R ≥ 16 at bet time. No separate `SharpSignal` entity: the counts live on the market, so one query serves the card.
- [x] Kleos Court: `Trader.isJuror`, `juryDuties`; `CourtRound` (jurors, commits, reveals, tally, verdict, failed) and `JurorVote` seats created at the draw, so no-shows show
- [x] `Protocol` singleton: totals the UI would otherwise need `_aggregate` for, plus revenue
- [x] KleosSocial: `Trader.name`, follower and following counts, `Follow` edges, `CallVote` rows and `Call.ups`/`downs` (votes cast before their call are picked up)
- [x] Tests: 24 simulated (each new rule mutation-checked), plus `pnpm test:testnet` against the live contracts: 8 markets, 20 traders, 14 calls, 8 jurors, 7 follows, 36 votes, all matching

### Phase 4: bet buddies (#2)
- [ ] BuddyPair + tests

### Phase 5: web
- Note: the free Envio plan allows 100 queries a minute across all visitors. `indexer.ts` makes one GraphQL request per page and caches it briefly (Next `revalidate`), never one query per component.
- [ ] `web/src/lib/indexer.ts`
- [ ] `court-panel.tsx`, `bet-buddies.tsx`
- [ ] Wiring PR (announce to Daniela first)

### Phase 6: testnet + Envio Cloud (needs Daniela)
- [x] Runbook: `DEPLOY.md` (checked against Envio docs; the indexer builds under Envio Cloud's pnpm 10.32)
- [x] `config.testnet.yaml`: chain 10143 over HyperSync, all 28 events, address and start block from `ENVIO_KLEOS_ADDRESS` / `ENVIO_KLEOS_START_BLOCK`. Codegen passes with dummy values and fails clearly without them; default codegen, tsc and tests still pass.
- [x] Checked (2026-09-29): HyperSync 10143 answers `/height` without a token, data queries return 401 without one. `envio-cloud` CLI runs, no session yet. Not logged in to envio.dev in the browser.
- [x] Envio account and API token in `indexer/.env` (2026-09-29). Token verified: an authorized HyperSync query on 10143 returns 200 (401 without it).
- [x] Testnet smoke test (2026-09-29): with `config.testnet.yaml`, the real handlers processed the latest 200 Monad testnet blocks through HyperSync (placeholder address, 0 events as expected). It caught an unquoted `${ENVIO_KLEOS_ADDRESS}` that YAML can read as a number; now quoted.
- [x] Repo moved to the `kleos-predictions` org (2026-10-01): `kleos-predictions/kleos` is a new repo, and `danimim/kleos` is no longer used. Local remotes point at the org.
- [x] Envio Deployments GitHub app installed on the `kleos-predictions` org (2026-10-01)
- [x] Hackathon offer checked (2026-10-01): none before judging. The Metropolis perks list no Envio voucher; Envio's prize for winners is 2 months of hosting free, then a third at 50% off. We stay on the free plan
- [x] Contracts on Monad testnet (Daniela, 2026-09-30): Kleos `0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb`, deployed in block 67114811. Deployed bytecode of all three contracts matches the source on `main`.
- [x] Real testnet range tested locally (2026-10-01): with `config.testnet.yaml` and the values above, the handlers indexed blocks 67114811–67345206: 8 markets (matches `marketCount`), 33 bets, 14 calls, 20 traders, 27 reputation changes. Bettor counts and both prices match the contract for every market.
- [x] Address and start block written into `config.testnet.yaml` as literals (2026-10-01)
- [x] Envio Cloud indexer `kleos` added (2026-10-01): org `kleos-predictions`, root `indexer`, `config.testnet.yaml`, branch `main`, Development plan, auto-deploy off, 0/3 deployments used
- [x] ~~Testnet config reads from the public RPC~~ (2026-10-01, reverted the same day): Envio's docs say hosted indexers "have their own access to HyperSync and don't need a token", so the testnet config reads HyperSync again: 0.5 s for the full range instead of 532 s
- [x] Start block moved to 67114786, KleosSocial's deploy block (Kleos followed at 67114811)
- [x] `DEPLOY.md` rewritten around the free plan's checked limits: 3 deployments at once, a URL per deployment, 30-day lifetime, and the deploy schedule that keeps one alive through judging
- [ ] First Cloud deployment (needs the commits pushed and the owner's go-ahead), then `INDEXER_URL` for #3
- [ ] Final deployment on Oct 12–13; README data flow; close #1 and #2

## Decisions

- **2026-09-28:** local-first, no Docker. `createTestIndexer` covers unit and real-chain tests. Envio Cloud is the only GraphQL server we'll run.
- **2026-09-28:** the web switch happens in `web/src/lib/indexer.ts` (new file) with the existing types, plus one wiring PR, so Daniela's files change once.
- **2026-09-28:** bet buddies are computed on `MarketResolved` from positions, not on `Settled`.
- **2026-09-28:** new seed behavior goes in a new script; `seed-demo.ts` stays untouched. **2026-09-29:** phase 2 reuses Daniela's new seed and court scripts instead.

- **2026-09-28:** `ReputationChange.kind` is Bet when the trader holds a position in that market, Jury otherwise, Admin for marketId 0. `entryPrice == 0` alone can't tell jury from a bet into an empty side.
- **2026-09-28, updated 2026-10-01:** `Trader.resolvedBets` counts settles of positions ≥ $50 in deep, non-voided markets (mirrors `Kleos._settleReputation`). Seeded values aren't in any event, so the index undercounts seeded traders. For the boost, the UI can use the `multiplier` on each `Bet` (the contract's real M at bet time). Revisit with the Effect API only if the UI needs the exact count.

- **2026-09-28 (review):** wins and losses come from `side == outcome` on bet changes, not the sign of delta. A loss only takes what the trader has, so at R = 0 it emits delta 0, and counting by sign missed it. A trader on both sides of a market gets one win and one loss, as the contract emits one change for each side. `web/src/lib/onchain.ts` still counts by sign and has the same gap (noted for Daniela).
- **2026-09-28 (review):** market handlers skip events for markets that were never created instead of throwing, which would halt the indexer on that block.

- **2026-09-28 (high-effort review):** no data bugs on well-formed events; the gaps were in the tests. Every handler now has a positive-path test, each depth rule (money, bettors, voided) is isolated, and a mutation run of 15 deliberate regressions is all caught on a green baseline. Also: `Position.bonusWeight` and `Market.bonusWeight` are stored so the UI can show an unclaimed bonus (`bonusPool · position.bonusWeight / market.bonusWeight`); `sponsored` counts third-party sponsorships only; the redundant `BonusRolledOver` handler is gone (`BonusOpened` carries the final pool); the integration test skips unless the contract is actually deployed.
- **Kept on purpose:** `PricePoint` stays separate from `Bet` even though it duplicates fields. Issue #1 asks for it, and chart queries stay small.
- ~~**Known gap:** a court on phantom market 0~~: closed by the contract (`propose` rejects id 0 since d117cf1).

- **2026-09-29:** Envio Cloud deploys from `main` with "Automatically deploy on push" off. We deploy a chosen commit (`envio-cloud deployment deploy` or the dashboard), so web pushes to `main` never redeploy the indexer. No separate deploy branch.
- **2026-10-01:** HyperSync on Envio Cloud, no env vars. The deployment the judges see is made on Oct 12–13, so the free plan's 30-day lifetime covers judging (until Nov 3).
- **2026-09-29:** the local config's Kleos address can be overridden with `ENVIO_LOCAL_KLEOS_ADDRESS`, kept apart from the testnet `ENVIO_KLEOS_ADDRESS` in `.env`.

## For Daniela (found while indexing, not changed by us)

- ~~**`web/src/lib/onchain.ts` counts wins and losses by the sign of delta**~~: fixed, it now counts by `side == outcome` and tells jury changes from bets by `hasBet`, not by `entryPrice == 0`.

- ~~**`Kleos.propose` and `fundFromGlobal` accept market ids that were never created**~~: fixed before the testnet deploy (`id == 0 || id > marketCount` reverts `BadState`, with a test). The original note: (still true on `main` as of `c72c3a2`). A missing id reads as state Open with closeTime 0, so both guards pass. Verified with a dry-run call on the local chain: `propose(99, …)` and `propose(0, …)` from a tier-II trader would succeed, then finalize, dispute, the court and settle all work on the phantom market, and a bond gets locked in it. `sponsor()` already checks `id == 0 || id > marketCount`; the same check belongs in `propose` and `fundFromGlobal`. It's a contract change, so it has to land before the testnet deploy. The indexer now skips these events instead of halting (`knownMarket` in `src/handlers/markets.ts`).

- ~~Seed voted on the wrong call ids~~: fixed by #4, then superseded by the contract numbering calls (`c72c3a2`).

## Open questions

- **Fields the UI shows with no on-chain source** (`Market.type` e.g. "Price feed", `closesAt` wording): ask Daniela in phase 5.

## Notes for whoever picks this up

- Envio's own skills (`indexer/.agents/skills/indexer-*`) are the reference for the v3 API. The root `envio-indexer` skill holds the Kleos-specific notes.
- After changing `schema.graphql` or `config.yaml`: `pnpm codegen`. After TypeScript changes: `pnpm tsc --noEmit`.

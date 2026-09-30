---
name: contract-change
description: Checklist for changing Kleos smart contracts (Kleos.sol, KleosUSD.sol, KleosSocial.sol), their constants, events or errors. Keeps the tests, the generated ABI, the web app's mirrored formulas, error messages and the docs in sync. Use whenever a .sol file changes.
---

# Changing a contract

The contract is the source of truth. Four places copy it and drift silently, so every change runs this whole list.

## 1. Change and test

```bash
cd contracts
npm run compile
npm test
```

- Add or update a test in `contracts/test/Kleos.test.ts` for every behavior change. Match the existing style: one `describe` per mechanism, `it` names that state the rule, and exact pitch numbers asserted with `assert.equal`.
- The pitch numbers are part of the product (44% vs 71%, $177 principal, $40 bonus, $20 protocol revenue, +0.70 / +0.05 / −0.45 / −1.43). If a change moves them, say so explicitly: the README, BLUEPRINT and demo script quote them.

## 2. Regenerate the ABI

```bash
npm run abi   # from contracts/: writes web/src/lib/abi.ts. Never edit that file by hand.
```

For a new contract, add it to the list in `contracts/scripts/export-abi.mjs` and to `contracts/ignition/modules/Kleos.ts`. Also add its address to `scripts/sync-env.mjs`, `web/.env.example` and `web/src/lib/chain.ts`.

## 3. Update the web mirrors

| If you changed | Update |
|---|---|
| A constant (`ALPHA`, `M_MAX`, `LAMBDA`, `STAKE_REF`, `BOOST_CAP*`, `FEE_BPS`, `DELTA_R_MAX`, `N_MIN` …) | `PARAMS` in `web/src/lib/math.ts` |
| A formula (multiplier, quote/boost cap, ΔR, payout, fee) | The matching function in `web/src/lib/math.ts`, and `explainChange` if it's a ΔR |
| Tier thresholds, `RESOLVER_MIN_R`, `JUROR_MIN_R` | `web/src/lib/tiers.ts` and the copy that names tiers |
| A custom error users can hit | `CONTRACT_ERRORS` in `web/src/lib/mera.ts` (plain-language message) |
| An event or its fields | `web/src/lib/onchain.ts` and `web/src/lib/hypersync.ts` readers; in the indexer, the event lists in **both** `indexer/config.yaml` (local) and `indexer/config.testnet.yaml`, the handlers, their tests and `indexer/ARCHITECTURE.md` (see `envio-indexer`) |
| Bonds, windows, fees quoted in copy ($10 / $15 / $25 + $2, 2% + 1%, 7 days) | `web/src/app/market/[id]/page.tsx`, `web/src/app/how-it-works/page.tsx`, `web/src/lib/cases.ts` |

Then build the web app so type errors from the new ABI surface:

```bash
npm --prefix web run build
```

## 4. Update the docs

- **`README.md` and `BLUEPRINT.md`:** mechanism tables, rules and the passing test count. Get the count from the `npm test` output; don't guess it.
- **`web/src/app/how-it-works/page.tsx`:** the `EVENTS`, `STACK`, `SAFEGUARDS` and `PARAMS` sections.

## 5. Redeploy locally

If the local stack is running, redeploy and reseed (see `dev-stack`). Old deployments don't pick up changes.

## Testnet

Deploying to Monad testnet (`npm run deploy:monad`) needs the owner's explicit authorization for that specific deploy. A redeploy resets every market, bet and reputation, and the indexer must be re-pointed at the new address and start block. So batch contract changes and land them before the testnet deploy.

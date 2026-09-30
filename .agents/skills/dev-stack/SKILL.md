---
name: dev-stack
description: Run Kleos locally end to end, with a local Hardhat chain, the three contracts deployed, demo traders seeded and the Next.js app in live mode. Use when asked to run, start, reset or test the app locally, or when the local chain was restarted and the app shows errors or empty data.
---

# Local dev stack

The local chain keeps its state only in memory. Every restart of the node needs a fresh deploy and seed.

## 1. Dependencies

```bash
test -d contracts/node_modules || npm --prefix contracts install
test -d web/node_modules || npm --prefix web install
```

## 2. Chain

Check whether a node is already up before starting one:

```bash
curl -s -X POST localhost:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'
```

If nothing answers, start one as a long-running background process (from the repo root, via `npm --prefix`):

```bash
npm --prefix contracts run node
```

It serves `http://127.0.0.1:8545`, chain id 31337, with pre-funded public dev accounts.

## 3. Deploy and seed

Run these from `contracts/`: the scripts use relative paths.

```bash
cd contracts
npm run deploy:local   # --reset deploy, then scripts/sync-env.mjs writes the 3 addresses into web/.env.local
npm run seed:local     # 6 demo traders (@kleos_maxi …) with reputation, bets, calls, follows and votes
```

Local deploys (chain 31337) don't prompt for confirmation. On a fresh node the addresses are deterministic, so they usually don't change.

## 4. Web env

`deploy:local` runs `sync-env.mjs`, which writes the chain mode, the three contract addresses and the deploy block into `web/.env.local`. One line has to be added by hand, once, and never overwritten:

```
SPONSOR_PRIVATE_KEY=<Account #0's private key>
```

Copy it from the `Private Key` under `Account #0` in the node's startup output (step 2). That account deployed the contracts, so it's the kUSD sponsor that funds new passkey accounts. `web/.env.local` is git-ignored. Never paste a key into docs, commits or chat, and never use a real key locally. On Monad testnet the sponsor is a separate wallet (see `web/.env.example`).

## 5. App

Port 3000 may belong to another project. Pick a free port and run in the background:

```bash
lsof -iTCP:3100 -sTCP:LISTEN || (cd web && npx next dev -p 3100)
```

## 6. Verify

```bash
for p in /markets /feed /leaderboard /compare /how-it-works /market/1 \
         /profile/0x70997970c51812dc3a010c7d01b50e0d17dc79c8; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' localhost:3100$p)" "$p"
done
curl -s localhost:3100/feed | grep -c kleos_maxi   # > 0 means live data from the chain
```

Every page should return 200, and `/feed` should show the seeded `@kleos_maxi` calls. Samples appear only in demo mode.

## 7. Indexer (only when working on it)

`indexer/` uses **pnpm**, unlike `web/` and `contracts/`. Codegen output isn't committed, so run it after every pull that changes `schema.graphql` or a config:

```bash
cd indexer && pnpm install && pnpm codegen && pnpm test
```

- `pnpm test` runs the simulated tests anywhere. The local-chain test runs the real handlers over this stack and compares the results with the contracts; it skips itself when the chain isn't up and seeded.
- `config.yaml` targets this local chain. It expects Kleos at the address a fresh node gives it; if the deploy order changes, set `ENVIO_LOCAL_KLEOS_ADDRESS` in `indexer/.env`.
- `config.testnet.yaml` is what Envio Cloud runs. Testing it locally needs `ENVIO_API_TOKEN` in `indexer/.env` (see `indexer/README.md`).
- The seed takes a few minutes, because it waits out a real dispute window to resolve one market.

## Notes

- **Demo mode:** remove the address lines from `web/.env.local` and restart Next. The app then renders sample data with no chain.
- **Passkeys** work on `localhost` over plain HTTP. Desktop Chrome with only a local profile has no PRF support: use Safari, or Chrome with iCloud Keychain, Google Password Manager or 1Password.
- **Reads that list data** (the feed, profile history) come from `getContractEvents` on the RPC for now. The Envio indexer replaces them (see `envio-indexer`).
- **Time-based flows** (dispute window 120 s, vesting 300 s, court phases 180 s) run in real time on the node. Use `evm_increaseTime` + `evm_mine` over RPC to skip ahead.

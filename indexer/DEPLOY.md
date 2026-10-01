# Deploying the indexer to Envio Cloud

Official bounty page: <https://hackathon.monad.xyz/tracks/best-use-of-envio> (sign-in required). Deadline: Oct 13, 2026, 20:59 PDT. Bounties are scored 40% on adherence to the published requirements, 30% technical implementation, 20% Monad integration, 10% innovation (Rules §5.2). No hackathon-specific Envio signup, referral link or promo code exists, so a normal signup is fine. Winners get two months of Envio Cloud hosting free, then a third at 50% off (up to $5,000).

Runbook for the **Best Use of Envio** bounty. BLUEPRINT §4a lists what judges need:
- a deployed indexer
- a public repo with `config.yaml`, `schema.graphql` and the handlers
- a frontend that consumes the data
- a short demo of data flowing end to end

Facts below were checked on 2026-09-29 against Envio's docs and this repo. Envio Cloud builds with pnpm 10.32; this indexer installs, codegens and passes its tests under pnpm 10.32.0. Envio Cloud ignores `pnpm-lock.yaml` and resolves dependencies on every build, which is why `package.json` pins exact versions. Monad testnet (10143) is served by HyperSync: `https://10143.hypersync.xyz/height` answers without a token, but a data query without one returns HTTP 401. The bounty deadline is Oct 13, 2026, 20:59 PDT.

## Who does what

| Step | Who | Needs |
|---|---|---|
| 0. Contracts on Monad testnet (done, 2026-09-30) | Daniela authorizes and signs (`AGENTS.md` rule) | Deploy wallet with testnet MON |
| 1. Envio account and API token | Whoever owns the indexer | GitHub login |
| 2. GitHub app on `kleos-predictions/kleos` | An owner of the `kleos-predictions` org | — |
| 3. Testnet config | Claude | Step 0's address and deploy block |
| 4–6. Add, configure and deploy | Indexer owner (or Claude with CLI access) | Steps 1–3 |
| 7. Point the web app at it | Claude (config), host owner (env var) | Step 6's endpoint |
| 8. Make the repo public | Daniela | Before submission |

## 0. Contracts on Monad testnet

**Freeze contract events first.** Every change to an event means new handlers and a full re-index. Land any pending contract fixes before this deploy, including the `propose`/`fundFromGlobal` bounds check in `PROGRESS.md`.

1. Daniela deploys: `npm --prefix contracts run deploy:monad` (asks for confirmation on non-local chains).
2. Record two values from `contracts/ignition/deployments/chain-10143/`:
   - the `KleosModule#Kleos` address
   - the block the Kleos contract was deployed in (the deployment journal, or the contract's creation tx on Monadscan)
3. Seed the demo **after** the final deploy. A redeploy wipes testnet state, and each push to Envio Cloud re-indexes from the start block anyway.

## 1. Envio account and API token

1. Log in at <https://envio.dev/app/login> with GitHub, and pick your personal account or an org as the owner. The free development plan covers the hackathon (limits below). Envio's pricing page lists no "Developer" plan, only Development (free), Production Small, Medium and Large ($70, $300, $800 a month) and Dedicated. The Metropolis sponsor perks list no Envio voucher either, so ask Envio (Discord) how the "3 months free" hackathon offer is claimed and which plan it maps to before relying on it.
2. Create an API token at <https://envio.dev/app/api-tokens>. HyperSync requires one, both on Envio Cloud and when testing against testnet locally.
3. Keep the token in a password manager. Locally, put it in `indexer/.env` as `ENVIO_API_TOKEN=…`; that file is git-ignored. Never commit it.

## 2. Install the Envio Deployments GitHub app

In the Envio dashboard, install the **Envio Deployments** GitHub app and grant it access to `kleos-predictions/kleos`. Only an owner of the `kleos-predictions` organization can do this. The app works on private repos, so this doesn't have to wait for the repo to go public.

## 3. Testnet config (done, waiting on step 0)

`config.yaml` stays pointed at the local chain, because the tests use it. `config.testnet.yaml` is what Envio Cloud runs:
- the same `name`, `disable_default_cross_chain: true` and all 28 events as `config.yaml`
- chain `10143` with no `rpc:` entry, since HyperSync serves it natively
- the address and start block read from env vars: `${ENVIO_KLEOS_ADDRESS}` and `${ENVIO_KLEOS_START_BLOCK}`

Envio substitutes env vars before it parses the file, so both fields work and are still validated: a non-number start block or a malformed address fails codegen. A missing variable fails codegen too, naming the variable. Checked with:

```bash
ENVIO_KLEOS_ADDRESS=0x1111111111111111111111111111111111111111 ENVIO_KLEOS_START_BLOCK=12345678 \
  pnpm envio codegen --config config.testnet.yaml
pnpm codegen   # back to the local config afterwards; the tests use its generated types
```

After step 0, either set the two values as env vars (locally in `.env`, see `.env.example`; on Envio Cloud in step 5), or write them into `config.testnet.yaml` as literals. Literals make the public config show the real contract, which helps judges. Changing either one needs a new deployment.

Before any deploy, check it locally against real testnet data. No Docker is needed: `createTestIndexer` can process a real testnet block range with `ENVIO_API_TOKEN` set.

## 4. Add the indexer

Either in the dashboard (Add Indexer), or with the CLI:

```bash
npx envio-cloud login
npx envio-cloud indexer add --name kleos --repo kleos-predictions/kleos --branch main --dry-run   # check, then run without --dry-run
```

## 5. Configure it

| Setting | Value | Why |
|---|---|---|
| Root directory | `indexer` | This is a monorepo |
| Config file | `config.testnet.yaml` | `config.yaml` is the local one |
| Deployment branch | `main` | The indexer lives on `main` once PR #5 merges |
| Automatically deploy on push | **Off** | `main` gets frequent pushes, mostly web changes. The free plan allows 3 deployments per indexer, and each one re-indexes and may change the URL, so we deploy on purpose |
| Env var | `ENVIO_API_TOKEN` = the token from step 1 | HyperSync access. Keys must start with `ENVIO_`, and changes apply on the next deployment |
| Env vars | `ENVIO_KLEOS_ADDRESS`, `ENVIO_KLEOS_START_BLOCK` from step 0 | Only if `config.testnet.yaml` still reads them from env vars (step 3) |

The config file path is relative to the root directory. Envio Cloud uploads only the root directory, and skips dotfiles and any folder named `generated` or `node_modules`, so `.env` is never uploaded.

```bash
npx envio-cloud indexer settings set kleos      # root dir, config file, branch
npx envio-cloud indexer env set kleos           # ENVIO_API_TOKEN, plus the two above if needed
```

## 6. Deploy and verify

```bash
# In the dashboard: Recent Commits → pick the commit on main → deploy. (The CLI has no deploy command.)
npx envio-cloud deployment status kleos <commit> --watch-till-synced
npx envio-cloud deployment logs kleos <commit> --level error,warn
npx envio-cloud deployment endpoint kleos <commit>                       # the GraphQL URL
```

Verify with one query against the endpoint, and compare the numbers with the contract or Monadscan:

```graphql
query {
  Market(order_by: { id: asc }) { id question state yesMoney noMoney bettorCount creator }
  Trader(order_by: { r: desc }, limit: 5) { id r pending wins losses }
}
```

The API is Hasura-style: `Entity(where:, order_by:, limit:, offset:)`, and BigInt comes back as a string. Rows are keyed by `(id, chainId)` because the config sets `disable_default_cross_chain`, so look single rows up with `where: { id: { _eq: … } }`.

## 7. Point the web app at it

Set `INDEXER_URL` (server-only) to the endpoint in the host's environment (Vercel or wherever the site runs), then redeploy the site. Pages read indexer → RPC → sample data, so nothing breaks while it's unset.

**Static URL: unclear on the free plan.** Envio's features page says every indexer gets a static production endpoint that you point at a deployment with "Promote to Production" (`npx envio-cloud deployment promote`). The pricing page lists it only on paid plans. Once the account exists, try `deployment promote` on the free plan and ask in the Envio Discord.

Either way the URL only changes when a new deployment is pushed, so deploy rarely: once after the final contracts, plus fixes. The web app keeps the endpoint in one **server-only** env var (`INDEXER_URL`, not `NEXT_PUBLIC_`): all indexer queries run on the server with short caching, which also keeps us under the free plan's 100 queries a minute. After a new deployment, update that one variable and redeploy the site. If a fixed URL matters for judging, Production Small ($70/month) adds one, plus no auto-deletion.

## 8. Before submitting

- [ ] Repo public (Envio requires it): `config.yaml`, `config.testnet.yaml`, `schema.graphql`, `src/handlers/`, plus `ARCHITECTURE.md` for the judges
- [ ] The live site reads from the indexer (item 7)
- [ ] The demo video shows data flowing end to end. For example: place a bet, then the market and profile update from the indexer, then the same row on Monadscan. Envio's dashboard showing the synced indexer is a useful shot too.
- [ ] README section: chain → Envio → UI

## Free plan limits that matter here

- **3 indexers per org, 3 deployments per indexer.** Delete old deployments (`npx envio-cloud deployment delete kleos <commit> --yes`) before pushing a fourth.
- **Every push re-indexes from the start block.** The previous deployment keeps serving until the new one syncs, but under its own URL (see step 7).
- **Query rate 100 a minute, about 100k events stored, 750 indexing hours** (pricing page). Production Small raises these to 250 a minute and about 1M events, and adds a static endpoint, backups and no auto-deletion.
- **Automatic deletion:**
  - hard limits: over 20 GB of storage, or 30 days old
  - soft limits, whichever comes first: 100k events, 5 GB of storage, or 7 days without requests. After a soft limit: 7 days' grace, then 3 days read-only, then deletion

  Judging may run until after the Oct 13 deadline, so keep the live site querying the indexer, and redeploy if it gets close to 30 days old.

## If contracts are redeployed

1. Update the address and start block: the env vars on Envio Cloud, or the literals in `config.testnet.yaml`.
2. Commit to `main`, then deploy that commit from **Recent Commits**. That's a new deployment, so mind the limit of 3.
3. Reseed the demo.

# Deploying the indexer to Envio Cloud

Runbook for the **Best Use of Envio** bounty (<https://hackathon.monad.xyz/tracks/best-use-of-envio>, sign-in required). Deadline: Oct 13, 2026, 20:59 PDT. Judging runs Oct 13 – Nov 3, and winners are announced from Nov 4. Judges want:
- a deployed indexer
- a public repo with `config.yaml`, `schema.graphql` and the handlers
- a frontend that consumes the data
- a short demo of data flowing end to end

There is no hackathon offer for Envio Cloud before judging. The Metropolis sponsor perks list no Envio voucher, and Envio's prize for winners is two months of Cloud hosting, then a third at 50% off. We run on the free **Development** plan.

Facts below were checked on 2026-10-01 against Envio's docs, the pricing page and `envio-cloud` 1.0.0.

## Where things stand

| | |
|---|---|
| Contracts | Monad testnet (10143). Kleos `0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb` (block 67114811), KleosSocial `0x766d184Fc25Fe88d30cF62dC9A391cBb2975B9aA` (block 67114786) |
| Envio org | `kleos-predictions`, Development plan |
| Indexer | `kleos`: repo `kleos-predictions/kleos`, branch `main`, root directory `indexer`, config file `config.testnet.yaml`, auto-deploy **off** |
| GitHub app | Envio Deployments, installed on the `kleos-predictions` org |
| Data source | HyperSync. Hosted indexers get their own HyperSync access, so Envio Cloud needs no token or env vars |
| Deployments | `cebb79d`, deployed 2026-10-01, deleted automatically around Oct 31. GraphQL: `https://indexer.dev.hyperindex.xyz/25439e6/v1/graphql`. Synced through HyperSync with no token; matches the contracts |

## Free plan rules that shape how we work

| Rule | What we do about it |
|---|---|
| **3 deployments per indexer at once.** Deleting one frees its slot. | Keep at most two: the one the site uses and the one being checked. Delete the rest. |
| **Each deployment has its own GraphQL URL.** A static production URL is a paid feature. | The web app reads one server-only env var, `INDEXER_URL`. Switching deployments means changing it and redeploying the site. Nothing is rebuilt into the client. |
| **Deployments are deleted 30 days after creation.** | A deployment made today dies on Oct 31, before judging ends. Make the final one on Oct 12 or 13, so it lives until about Nov 12. |
| **Soft limits: 100k events, 5 GB, or 7 days without requests.** After one, 7 days normal, 3 days read-only, then deletion. | Testnet has about 250 events. The live site queries the indexer, which counts as requests. Check once a week during judging. |
| **100 queries a minute**, across all visitors. | All queries run on the web server, one per page render, with short caching. Never one query per component, never from the browser. |
| **Every deployment indexes from the start block.** | Cheap here: the full testnet range takes under a second through HyperSync. A new deployment is ready in minutes, mostly build time. |
| Env vars | Not needed. Envio's pricing lists env-var management only for paid plans, so we don't depend on them. |

Paid plans start at $70 a month (Production Small: static URL, no auto-deletion, 250 queries a minute). We don't need one for the hackathon.

## Before each deployment

Run these from `indexer/`. A deployment is cheap but it changes the URL, so ship only what passes:

```bash
pnpm install && pnpm codegen && pnpm tsc --noEmit
pnpm test               # simulated + local-chain tests
pnpm test:testnet       # real handlers over the live testnet, compared with the contracts
```

`pnpm test:testnet` needs `ENVIO_API_TOKEN` in `indexer/.env` (git-ignored). Locally HyperSync needs a token; Envio Cloud doesn't.

Envio Cloud uploads only the `indexer` folder and skips dotfiles and any folder named `generated` or `node_modules`, so `.env` never leaves the machine. It ignores `pnpm-lock.yaml`, which is why `package.json` pins exact versions.

## Deploy

The commit has to be on GitHub first. Pushing to `main` doesn't deploy anything, because auto-deploy is off.

```bash
npx envio-cloud login
npx envio-cloud config set-org kleos-predictions        # optional: then <org> can be left out below
npx envio-cloud indexer commits kleos kleos-predictions  # recent commits on main
npx envio-cloud deployment deploy kleos <commit> kleos-predictions
npx envio-cloud deployment status kleos <commit> kleos-predictions --watch-till-synced
npx envio-cloud deployment logs kleos <commit> kleos-predictions --level error,warn
npx envio-cloud deployment endpoint kleos <commit> kleos-predictions   # the GraphQL URL
```

The dashboard's **Deploy** button on a commit does the same.

## Check it

One query against the endpoint, compared with the contract (or `pnpm test:testnet`, which checks all of it):

```graphql
query {
  Protocol { marketCount betCount bettorCount callCount jurorCount }
  Market(order_by: { id: asc }) { id question state voided yesMoney noMoney bettorCount sharpYes sharpNo }
  Trader(order_by: { r: desc }, limit: 5) { id name r pending wins losses isJuror }
}
```

The API is Hasura-style: `Entity(where:, order_by:, limit:, offset:)`. BigInt comes back as a string and there are no `_aggregate` queries, so totals live on `Protocol` and on each entity. Rows are keyed by `(id, chainId)` because the config sets `disable_default_cross_chain`, so look single rows up with `where: { id: { _eq: … } }`.

## Switch the site to it

1. Set `INDEXER_URL` to the new endpoint in the web host's environment. It is server-only: never `NEXT_PUBLIC_`.
2. Redeploy the site and open a market, a profile and the leaderboard.
3. Delete the old deployment: `npx envio-cloud deployment delete kleos <old-commit> kleos-predictions --yes`.

Pages read indexer → RPC → sample data, so nothing breaks while `INDEXER_URL` is unset or wrong.

## Schedule

| When | Deployment |
|---|---|
| Oct 1 (done) | First deployment, `cebb79d`, for building `web/src/lib/indexer.ts` (#3) against real data |
| As needed | One per indexer change worth showing. Delete the previous one |
| Oct 12–13 | The final one, after the last indexer change. It is the one judges see, and it lives until about Nov 12 |
| Weekly until Nov 4 | `deployment status`, and a page load on the live site |

## If the contracts are redeployed

1. Update both addresses and the start block (the earlier of the two deploy blocks) in `config.testnet.yaml`.
2. Reseed the demo, run `pnpm test:testnet`, commit and push.
3. Deploy that commit, switch the site, delete the old deployment.

## Before submitting

- [ ] Repo public: `config.yaml`, `config.testnet.yaml`, `schema.graphql`, `src/handlers/`, `ARCHITECTURE.md`
- [ ] The live site reads from the indexer
- [ ] Demo video: place a bet, then the market, profile and leaderboard update from the indexer, then the same transaction on Monadscan. The Envio dashboard showing the synced indexer is a useful shot too.
- [ ] README section: chain → Envio → UI

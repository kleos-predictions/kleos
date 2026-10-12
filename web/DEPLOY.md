# Vercel environment checklist

Checked on 2026-10-11 against `main` (`83e7909`). Daniela owns the Vercel project
[`danielas-projects-955f4c8d/kleos`](https://vercel.com/danielas-projects-955f4c8d/kleos).
GitHub reports a successful Production deployment of that commit. The account used
for this audit cannot read the project's settings (403), so the table below lists
the required configuration, not a verified list of missing Vercel variables.

## Deployment readiness

The Oct 11 follow-up found `main` at `74de1d4`. Its Vercel check failed with
"Cannot deploy from a private GitHub organization repository on the Hobby plan."
The last successful GitHub deployment record is still `83e7909`, and
`https://kleos-iota.vercel.app/markets` still shows the six sample market figures.
Saving variables alone has therefore not established a working live deployment.

The user chose to keep the repository private; Daniela will address the Vercel
plan restriction, then redeploy Production. Confirm the exact production URL,
deployed commit, and live contract
addresses before creating a passkey or funding a demo account.
This check used public pages and GitHub deployment metadata; it did not read
Daniela's environment values.

## Production configuration

Set these in the project's **Production** environment. Configure Preview separately
if it also needs live testnet access. Redeploy after changing environment variables;
Vercel applies changes only to new deployments.

| Variable | Value / purpose |
|---|---|
| `NEXT_PUBLIC_KLEOS_ADDRESS` | `0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb` |
| `NEXT_PUBLIC_USD_ADDRESS` | `0x74cb7e5f0Ef6d1A32D3b9bb7b40495b61a45B750` |
| `NEXT_PUBLIC_SOCIAL_ADDRESS` | `0x766d184Fc25Fe88d30cF62dC9A391cBb2975B9aA` |
| `NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK` | `67114811`; bounds Kleos event-history fallback reads |
| `SPONSOR_PRIVATE_KEY` | Secret, server-only. Key for the address returned by `KleosUSD.sponsor()`; required for automatic gas and test-USD funding |
| `INDEXER_URL` | `https://indexer.dev.hyperindex.xyz/27dbf62/v1/graphql` — server-only; deployed and verified Oct 11 |
| `ENVIO_API_TOKEN` | Secret, server-only. Recommended so calls, feed and reputation history still load through HyperSync if the indexer is unavailable |

The three addresses come from
`contracts/ignition/deployments/chain-10143/deployed_addresses.json`.
Read-only RPC checks confirmed 8 markets and that `KleosUSD.market()` points to the
Kleos address above. At the time of the audit, `KleosUSD.sponsor()` was
`0x0A1Dd0504C9071B5aebF3e9940B75Db92e2A92e9`, with 2 MON. This differs from the
token owner; use the sponsor's key. No private key was used to verify this.

Optional configuration:

- `MONAD_RPC_URL`: private server RPC for ordinary contract reads. Public RPC is the default.
- `MONAD_LOGS_RPC`: alternative history source if HyperSync is not configured. Not needed alongside `ENVIO_API_TOKEN`.
- `HYPERSYNC_URL`: defaults to `https://10143.hypersync.xyz`; omit normally.
- `SPONSOR_PER_IP_PER_HOUR`, `SPONSOR_PER_MINUTE`, `SPONSOR_PER_DAY`: defaults are 5, 10 and 300 fundings. These limits and nonce serialization are in memory per server instance, not shared across Vercel instances.
- `NEXT_PUBLIC_CHAIN`: leave unset for Monad testnet. Never copy `local` from a local development env into Vercel.

For the controlled testnet demo, use one funding flow at a time and keep the sponsor
balance small. Funding now checks successful receipts and preserves an uncertain
transaction hash within the same process. Budgets, pending hashes and the signer
queue are still not shared across Vercel instances or restarts. A send that fails
before returning a hash also needs operator reconciliation. This is not a durable
production faucet. If a bet or court action times out, inspect the transaction
before retrying; this patch does not add a persistent client transaction journal.

No Vercel API token or Mera API key is read by the web app. Keep the sponsor key,
RPC credentials and Envio token out of all `NEXT_PUBLIC_*` variables.

## Envio recovery

The old endpoint `https://indexer.dev.hyperindex.xyz/25439e6/v1/graphql` returned
HTTP 404 to a GraphQL `Protocol` query during this audit. The signed-in dashboard
then confirmed that deployment `cebb79d` was deleted **2d ago** for **Inactive
Deployment**. The old endpoint cannot be reused.

Reuse the existing **`kleos` indexer in `kleos-predictions`**, with root `indexer`,
branch `main`, and `config.testnet.yaml`. No new contracts or indexer implementation
are needed. Those settings were verified in the dashboard; auto-deploy is off.
With user authorization, current `main` (`83e7909`) was deployed on Oct 11 at
17:58 PDT. It is **Active, 100% synced through HyperSync**, with 158 events and
**1/3** deployment slots used. CLI inspection requires a separate CLI login:

```bash
npx envio-cloud indexer get kleos kleos-predictions
npx envio-cloud deployment status kleos 83e7909 kleos-predictions
npx envio-cloud indexer commits kleos kleos-predictions
```

Codegen, TypeScript, 25 simulated tests and the read-only live-testnet comparison
passed before deployment. Hosted GraphQL data then matched the contracts for all
8 markets, 20 traders, 14 calls and 8 jurors, including names and social counts.
The endpoint also returns 33 bets, 11 distinct bettors, 7 follows and 36 call votes.

Daniela's remaining action is to set this server-only variable in Vercel Production
and redeploy the site:

```dotenv
INDEXER_URL=https://indexer.dev.hyperindex.xyz/27dbf62/v1/graphql
```

Our account still cannot access Daniela's Vercel project settings, so this final
configuration and live-frontend verification remain pending. Future deployments
follow [`../indexer/DEPLOY.md`](../indexer/DEPLOY.md).

Envio Cloud's hosted indexer needs no `ENVIO_API_TOKEN`; its HyperSync access is
provided by Envio. The web server's fallback and local testnet tests need their
own token configuration.

The existing local `ENVIO_API_TOKEN` in `indexer/.env` in the primary checkout was
verified with a read-only HyperSync query (HTTP 200). It can still support the web
fallback; the old Cloud endpoint's failure does not mean that token needs replacing.
Its value was not printed or copied into this checklist.

On the Development plan, deployments expire after 30 days. Seven days without
requests also triggers the documented grace/deletion process. This Oct 11
deployment expires around Nov 10 if it remains active, covering the judging window;
regular use does not remove the 30-day limit.
For ongoing hosting, use a production plan or self-host instead of relying on an
expiring development deployment.

After configuration, verify `/markets`, a market detail page, a profile, the feed
and leaderboard. A healthy page alone is not proof of a healthy indexer: contract
fallback can serve markets, while the leaderboard falls back to sample traders
when the indexer is unavailable.

References: [Vercel environment variables](https://vercel.com/docs/environment-variables),
[Envio free-plan limits](https://envio.dev/pricing),
[Envio Cloud CLI](https://docs.envio.dev/docs/HyperIndex/envio-cloud-cli).

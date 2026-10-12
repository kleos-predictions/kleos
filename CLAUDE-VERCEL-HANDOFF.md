# Configure Kleos on Daniela's Vercel project

Configure the existing Vercel project `kleos` under team
`danielas-projects-955f4c8d`, then redeploy Production and verify the live site.
Use the existing project and its current `main` branch. Do not create a new
project or change the contracts.

## Secret handling

The accompanying `.env.daniela.production.secrets.local` contains the existing
working `ENVIO_API_TOKEN`. It was copied directly from the local indexer env file
without displaying or inspecting its value.

Do not open, print, summarize, or return secret values to the conversation. Do not
use `cat`, debugging output, shell tracing, command-line arguments, or logs to
expose them. Use a local process to parse the env file and pass each value directly
to Vercel through CLI stdin or the authenticated API request body. Treat the file
as data; do not source or execute it. Keep temporary secret files restricted to
the current user and outside version control. Report variable names and scopes
only. Inspect existing Vercel variable metadata without revealing values.

`SPONSOR_PRIVATE_KEY` is intentionally absent from the supplied file. The key
available in the sender's web env belongs to a local-chain configuration and has
not been verified for testnet. Preserve an existing Production sponsor key. If
it is missing, obtain the testnet sponsor key from Daniela's local configuration
without displaying it. If unavailable, finish the other configuration and report
this specific missing dependency; never substitute a development or deployer key.

At the Oct 11 check, `KleosUSD.sponsor()` was
`0x0A1Dd0504C9071B5aebF3e9940B75Db92e2A92e9`. The key must correspond to the current
on-chain sponsor. Read-only RPC checks are fine. This task does not authorize
contract deployment, changing the sponsor, or sending blockchain transactions.

## Production variables

Add or correct these exact values:

```dotenv
INDEXER_URL=https://indexer.dev.hyperindex.xyz/27dbf62/v1/graphql
NEXT_PUBLIC_KLEOS_ADDRESS=0xd68a1F212fa52663468BBB6F0456Cd6e7Ce854Cb
NEXT_PUBLIC_USD_ADDRESS=0x74cb7e5f0Ef6d1A32D3b9bb7b40495b61a45B750
NEXT_PUBLIC_SOCIAL_ADDRESS=0x766d184Fc25Fe88d30cF62dC9A391cBb2975B9aA
NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK=67114811
```

Set `ENVIO_API_TOKEN` from the accompanying file as a server-only secret in
Production. Set `SPONSOR_PRIVATE_KEY` only from the correct testnet sponsor source
if it is not already configured. Never add a `NEXT_PUBLIC_` prefix to either key.
Leave `NEXT_PUBLIC_CHAIN` unset so the app uses Monad testnet. Preserve other
existing settings, including optional `MONAD_RPC_URL` and sponsor budgets. Do not
copy a local Hardhat `.env.local` wholesale into Vercel or change Preview/Development.

## Deployment and verification

1. Confirm access to the exact team/project above and inspect existing variable
   names and Production scopes. The sender's Vercel account lacked access; use
   Daniela's authorized session.
2. Apply the configuration, then redeploy Production from current `main` using
   the project's existing build/root settings. The tested commit at handoff is
   `83e7909a3ea201f8f0a6a2e8460cef0ceb9d321b`.
3. Wait for the deployment to become Ready and use its canonical production URL.
4. Verify `/markets`, a market detail page, `/feed`, a trader profile, and
   `/leaderboard`. Check server logs for indexer failures. Do not trigger the
   sponsorship endpoint or wallet actions as part of verification.
5. Confirm a direct read-only GraphQL query works. Envio deployment `83e7909`
   was active and 100% synced at handoff. Its data matched the contracts:
   8 markets, 33 bets, 11 bettors, 20 traders, 14 calls, 8 jurors, 7 follows and
   36 call votes. The leaderboard falls back to sample traders on indexer failure,
   so HTTP 200 alone does not prove successful integration.
6. Report the production URL, deployed commit, variable names changed, checks
   passed, and any unresolved sponsor-key issue. Never include secret values.

The old Envio endpoint ending in `/25439e6/v1/graphql` was deleted for inactivity;
do not use it. The new Development deployment remains subject to inactivity limits
and its 30-day lifetime, approximately until November 10, 2026.

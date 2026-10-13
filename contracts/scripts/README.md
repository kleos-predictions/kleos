# Demo operations

These scripts are demo operators. Remote testnet execution requires the owner's explicit approval for that particular action. A source change does not change an existing deployment.

## Fresh local demo

From `contracts/`, use the existing local workflow:

```sh
npm run node
# In another terminal:
npm run deploy:local
npm run seed:local
```

The Ignition module now deploys and binds the three contracts. Seeding creates six catalog markets, then one resolved example and one short room-vote example. The catalog deadlines use a recorded chain timestamp, so deployment no longer depends on October 2026 dates. Generic fixture questions are marked as demos and require concrete event/source definitions before any real-value use.

`deploy:local` has an explicit `--reset` flag. Restarting the local node and deploying starts a fresh demo. Preserve the prior journal for diagnosis; the new contract creation receipts give the fresh chain a distinct identity. Do not use a reset or a deleted journal to repeat a historical testnet seed.

## Resuming a seed

Re-run `npm run seed:local` on the same deployment. Keep any original `KLEOS_ME` value and the same demo wallet configuration. The script reads confirmed receipts again and does not mint, reseed reputation, add bets or create markets a second time. Call and market IDs come from the actual transaction events.

New mints use the current on-chain KleosUSD sponsor. After a sponsor handoff, replay reconciles an existing mint's original sender and receipt before considering any new send. It does not replace historical journal entries with the new sponsor. Unknown broadcasts and changed-sender retries of reverted mints require operator reconciliation.

The seed and web faucet can now use the same sponsor account, but their queues are separate. Pause the faucet and ensure exclusive sponsor ownership while seeding. The seed/court lock does not coordinate web replicas or external nonce users. A shared durable signer queue and outbox remain required for concurrent operation.

Replay does not guarantee completion after arbitrary downtime. If a run stops before all planned bets are broadcast and their market closes, those remaining bets cannot be placed. The resolved example closes after 120 seconds locally or 600 seconds remotely; the room-vote example closes after 600 seconds. Reconcile the partially completed fixture and choose a fresh local demo if needed. Do not silently extend an existing close time, delete a journal or replace a remote fixture without the owner's specific approval.

State lives in `.demo-state/`, which is git-ignored. The directory is restricted to its owner, and journal files have mode `0600`. Each journal is tied to chain ID, all three contract addresses, runtime code hashes and canonical contract creation receipts. The seeder also pins wallet addresses and its optional funded recipient. An unjournaled deployment with existing activity is rejected before demo wallet creation or funding. Names, current balances and guessed call numbers cannot prove which old operations succeeded.

Every operation records intent before broadcasting, then its hash, then a successful receipt. A receipt timeout preserves the hash for the next run. A mined revert is recorded as a failure and can be retried. Replacement transactions and reorged confirmed receipts require reconciliation. A lost broadcast response leaves an uncertain intent: the script stops instead of sending another mint or bet. Inspect the sender nonce, actual transaction and receipt before repairing that journal; keep a copy and do not delete an uncertain operation to force a retry.

New operations record their sender. Before another send from that address, known pending hashes are reconciled and unknown broadcast results block it. An unresolved historical entry without sender metadata blocks every new sender conservatively. The seeder reconciles recorded proposal/finalize receipts even when the market has already advanced. It verifies the planned proposer, outcome and evidence before finalizing, and rejects a voided or differing terminal outcome.

A shared deployment process lock prevents the seed and court operators from running concurrently and reusing the same sender nonce. Do not run other scripts from those sender accounts at the same time. After an abrupt crash, check the PID in the `.lock` file and confirm no operator is running before removing **only** that stale lock. Never remove its `.json` journal. Gracefully stopping the court bot releases its lock.

## Court bot

```sh
npm run court-bot
```

The bot persists both the vote and its random salt before committing. Its journal is not a wallet/key store, but salts must stay private until reveal. Do not commit or share `.demo-state/`. A restart or a changed `KLEOS_BOT_VOTE` does not change the saved vote used for a reveal. The bot checks the on-chain commitment before acting and refuses to overwrite an unknown or mismatched commitment.

All selected demo jurors participate. There is no automatic last-juror sit-out, which previously left a three-seat jury below the three-reveal quorum. A problem with one juror or market is logged while other duties continue. Receipts must succeed before an action is reported confirmed. Reverted closes remain retryable; timeouts retain their known hashes.

An uncertain juror send blocks later sends from that juror, including other markets and rounds. Unrelated jurors can continue. An uncertain close blocks further sends from the shared closing account. Existing commit/reveal operations are reconciled before the bot skips them based on contract state; changing a vote mode or observing the saved commitment is not permission to clear an unknown broadcast result.

Optional budgets:

| Variable | Default | Allowed range |
| --- | ---: | ---: |
| `KLEOS_BOT_SCAN_LIMIT` | 25 markets per poll | 1–100 |
| `KLEOS_BOT_WRITE_LIMIT` | 20 operations per poll | 1–100 |
| `KLEOS_BOT_POLL_MS` | 3000 ms | 1–60000 |
| `KLEOS_BOT_VOTE` | `uphold` | `uphold`, `overturn`, `yes`, `no`, `ambiguous` |

The market scan rotates through bounded pages. It mines an empty block only on the local chain instead of sending signed self-transfers. It remains one local process, without a production keeper service, alerting, durable shared queue, nonce coordination with external operators, or a funded operations budget. The selected scan/write budgets must cover all active duties before their deadlines. The write ceiling limits new operation attempts, not wall-clock duration or receipt/read calls: twenty sequential 30-second waits already exceed a 180-second phase, and reconciliation can add waits. Demo windows remain short; a large queue or RPC outage can cause missed phases. A public court's randomness and incentive design are separate unresolved mechanism questions.

The owner still needs to choose operating windows, accountable keeper coverage, shared nonce/budget infrastructure and reconciliation responsibility. `dispute.ts` and `setup-sponsor.ts` now require successful matching-intent receipts and stop on uncertainty. Sponsor setup keeps private key custody in an atomic owner-only local file before broadcasts and publishes the web env only after confirmations and current-state verification. These remain one-off helpers without durable sender journals; reconcile any uncertain send before rerunning, do not run them concurrently from any seed/bot sender, and do not assume their reruns have the same recovery protections.

## Verification

```sh
node --test contracts/test/DemoOperations.test.ts
node contracts/node_modules/typescript/bin/tsc --noEmit -p contracts/tsconfig.json
```

Run these commands from the repository root. The tests use fake transactions and temporary files, including real process exits during pending and uncertain broadcasts. They do not load Hardhat configuration, read env files, sign transactions or access a network. They verify receipt failures, replay, journal privacy, process exclusivity, restart recovery, sender isolation, original vote persistence, deployment identity, future deadlines and three-seat participation. The actual seed resolution orchestrator is tested with fake clients across advanced-state restart, changed-proposal and deadline-race cases.

The October 2 remediation also ran the real deploy/seed/replay/dispute/bot workflow in an isolated fresh local chain: eight seeded markets/fourteen calls, replay invariance, and a ninth three-seat court that recovered the original committed votes after a changed-mode restart. Exact settlement and all eleven bonus claims matched bigint calculations. The remediation report records the commands and public evidence. High-population load, provider outages, deadline coverage and production operation still need acceptance.

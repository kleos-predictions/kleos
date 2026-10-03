# Account and testnet sponsor behavior

The account is a full EOA signing session in browser memory. The $100 per-bet prompt policy is not a cumulative spending limit or a contract-enforced session permission. Session end prevents later signing through that session; it does not revoke submitted transactions or signatures already produced.

Public credential metadata stays available in memory if localStorage is blocked. Fresh authentication must rebuild the selected address. A synchronous guard allows one passkey ceremony at a time, and lock/sign-out/account replacement invalidates its result. Storage events lock other tabs when persistence is available; blocked storage cannot provide that cross-tab signal.

The recovery phrase requires a fresh ceremony for the selected credential and address. It clears on lock, sign-out, account replacement, backgrounding, loss of focus while visible, dismissal or 60 seconds. A phrase is displayed only while the document is visible and focused. Native passkey choosers can blur the browser, so focus return needs verification on supported devices. Owned PRF, seed, derivation-node and signing-session buffers are wiped; immutable JavaScript strings and browser-managed copies cannot be guaranteed erased.

Existing-account discovery is visible on mobile. A fixed production relying-party hostname is still required. Phrase import and external-wallet signing are not implemented in this app. A recovery phrase can be used in a compatible external wallet, but that does not by itself restore an app signing session. Domain migration and the real-device recovery matrix remain open work.

## Testnet funding

The recipient signs an EIP-191 message containing the site origin, chain ID, address, issuance time and request ID. The server rejects expired or mismatched proofs. This proves control of the receiving EOA; it does not prove one independent person or stop someone from generating many accounts.

Within one server process, funding requests share a signer queue, same-address concurrent requests coalesce, and repeated proof IDs return the same job. Balance reads occur inside the queue. A 30-second cooldown is reserved before sending and applies to zero-USD addresses and failed attempts. The queue is bounded to 50 addresses; proof records are bounded to 2,000 and expire after two minutes. Gas and mint receipts must confirm the intended sender, destination, input and value. Funding failures reject on the client, and callers bind waits/retries to their authorized signer's address.

These are process controls. Restarts or multiple replicas do not share cooldowns, proof records, budgets or nonce coordination. There is currently no durable per-account/global spending budget, and no claim that the public service is resistant to unlimited controlled accounts. The existing sponsor key is read only by the server when an authorized request is executed; no new infrastructure or storage service is provisioned by this change.

Before wider use, the owner needs to choose a shared transactional store and signer-worker arrangement, reserve per-account and global budgets atomically, set the MON/kUSD funding budget and eligibility policy, and decide how partially completed jobs reconcile after restart. Receipt hashes and job state must survive failures; ownership proof alone is insufficient. Use a dedicated testnet sponsor with an intentionally limited balance while those decisions remain open.

## Local verification

Run `node --test tests/account-sponsor.test.mjs` from `web/`. The tests execute the production provider and sponsor handler with deterministic hooks, fake WebAuthn and fake network/wallet clients, and verify synthetic signatures offline. They cover blocked persistence, fresh signer binding, overlapping/stale prompts, recovery cancellation, cross-tab replacement, funding failures, proof binding/expiry, queue behavior, derivation compatibility, cooldown reservation and idempotent replay. They do not send transactions or authenticate a real device.

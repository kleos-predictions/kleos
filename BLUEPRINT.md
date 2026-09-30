# Kleos in Chaos — Blueprint

**Prediction Market with a Verifiable Reputation Layer.**
Track: Social, Attention & Culture · Submission: by Oct 2, 2026 (official deadline Oct 13)

---

## 1. Product in one paragraph

Every bet on Kleos weighs **money × reputation**. Reputation (R) only grows when you are right against the crowd, it shrinks faster than it grows, and every change is an on-chain event anyone can audit. Each market shows two prices side by side: what the money says and what the people who are usually right say.

**Why social:** kleos is the Greek word for the renown a person earns through their deeds and that others carry for them. Here that renown is a public, non-transferable track record. Attention shifts from the loudest voice and the biggest wallet to whoever called it first.

---

## 2. Status

| Area | State |
|---|---|
| Contracts (`contracts/`) | ✅ v2: payout v2, safeguards, evidence fields; 22 tests passing; Ignition deploy module |
| Frontend (`web/`) | ✅ Markets, market page, profile, leaderboard, How it works (interactive formulas), sharp signal |
| On-chain wiring | 🟡 Wallet, faucet and bet go on-chain when `.env` is set; reads still use demo data |
| Monad testnet deploy | ⬜ Needs the user's key; **only with explicit authorization** |

---

## 3. Mechanism (implemented)

| Formula | Meaning |
|---|---|
| `M = min(1 + 0.5·√R, 5)` | Reputation becomes a multiplier with diminishing returns and a cap |
| `E = m · M` | Effective weight of a bet |
| `P_money = YES$ / total$`, `P_rep = YES_E / total_E` | The two prices |
| `payout = m + (E / ΣE_winners) · L` | Winners split the losers' money by weight, so no money is printed |
| Right: `ΔR = +k·s·(1 − p)` · Wrong: `ΔR = −1.5·k·s·p` | p = price of your side at entry, s = min(stake / $50, 1) |
| Boost cap | Once the pool is ≥ $5k, no address gains boost past 10% of ΣE; money always counts in full |

Resolution: propose with a $10 bond → dispute window → finalize, or the Kleos Court (§3c). Settlement is permissionless, so losses land even if the loser never returns.

Events: `MarketCreated`, `BetPlaced`, `OutcomeProposed`, `OutcomeDisputed`, `MarketResolved`, `Settled`, `ReputationChanged`.

---

## 3a. Payout v2 (implemented, replaces the payout rule above)

Money pays money. Reputation steers the signal and earns a fee-funded bonus.

- **Principal payout:** pure parimutuel by money. `payout_i = m_i + (m_i / ΣwinningMoney) · (losingPool − fee)`
- **Displayed odds** stay reputation-weighted (`P_rep`), shown next to the payout odds implied by money. The UI must say which number sets the payout ("pays 2.25×").
- **Fees:** `FEE_BPS` (2%) of the losing pool goes to that market's `bonusPool`; `PROTOCOL_FEE_BPS` (1%) accrues as protocol revenue, which the owner withdraws to the treasury (`RevenueAccrued`, `RevenueWithdrawn` events). No fees when nobody picked the winner.
- **Sponsorship:** `sponsor(marketId, amount)` adds to `bonusPool`; the market page shows "Sponsored by [address]". It is neutral: the bonus pays accurate contrarians on either side.
- **Bonus:** `bonus_i = bonusPool · w_i / Σw`, with `w_i = ΔR_i · M_i` for winners whose ΔR is positive. Weighting by M (not ΔR alone) stops a whale from splitting into many fresh $50 wallets to capture the bonus.
- **Two-phase settlement:** Σw is only known once every bettor is settled. Phase 1 settles principal and ΔR; phase 2 opens bonus claims.
- **Rollover:** if no one has positive ΔR, `bonusPool` moves to a global pool that seeds the bonus of new markets.
- **Tests:** newcomer and sharp get the same principal return per dollar; money paid + fees = money staked; bonuses sum to `bonusPool`; the split-wallet attack gains no bonus advantage.

Demo check: $2,000 losing pool → $40 bonus (2%) and $20 protocol revenue (1%). Each of 20 identical sharps gets $80 + $97 + $2 = **$179**.

---

## 3b. Reputation safeguards (implemented)

| Safeguard | Rule | Default |
|---|---|---|
| Activation | M stays 1.0 until the user has `N_MIN` resolved bets; a handful of bets is mostly luck | `N_MIN = 10` |
| Vesting | Positive ΔR goes to `pendingR` with a `vestAt`; anyone calls `vest(user)` after it (emits `Vested`). Negative ΔR applies immediately. M uses vested R only | 7 days (5 min in demo) |
| Per-market cap | Positive ΔR from one market ≤ `DELTA_R_MAX` | 0.8 (keeps the +0.70 pitch example intact) |
| Anomaly flag | Fewer than `N_MIN` resolved bets **and** a win at entry price ≤ `FLAG_PRICE` with size ≥ `FLAG_SIZE` → flagged (emits `Flagged`). Flagged pendingR cannot vest. Admin can `clearFlag` or `slash`. Profile shows "Under review" | `FLAG_PRICE = 0.10` |
| Blocked topics | `createMarket` rejects blocked categories | military operations, internal government decisions |
| Minimum depth | ΔR only counts in markets with pool ≥ `MIN_REP_POOL` and ≥ `MIN_BETTORS` distinct addresses | $1,000 · 10 |
| Resolver gating | Proposing and disputing require vested R ≥ a threshold; addresses with a position in the market cannot propose or dispute it | tier II |

**Design notes (decisions baked into the spec above):**

1. **Losses hit pending gains too.** If a loss is larger than vested R, the rest comes out of `pendingR`. Otherwise R's floor at 0 would let someone bank pending gains and absorb losses for free.
2. **Minimum depth raises the cost of self-dealing.** Without it, wallet A bets YES and burner wallet B bets NO in an empty market: A gains R for the cost of the fee, and B has nothing to lose at R = 0. With it, a farmer needs 10 wallets and $1,000 at risk, pays the 2% fee each time, waits out vesting, and still needs 10 resolved bets before any boost. It raises the cost; it doesn't make farming impossible. Known limitation.
3. **Categories as an allowlist, not a blocklist.** `category` is free text, so a string blocklist is bypassed with a different spelling ("Military", "defense ops"). The contract accepts a fixed set of category ids, so blocked topics simply have no id.
4. **`DELTA_R_MAX` = 0.8.** With k = 1 and s ≤ 1 a market yields ΔR < 1, so the cap only bites on long shots below 20%, which is where insider windfalls sit.
5. **Demo seeding must include history.** With activation, seeded sharps need `N_MIN` resolved bets as well as R, or their multiplier stays at 1.0 and the 44% vs 71% demo disappears. `seedReputation` sets both, and emits both publicly.
6. **The 10% cap is on the boost.** It limits the extra weight an address gains from reputation; money always counts in full. The 11-wallet case is answered mainly by the reputation-weighted price itself: fresh wallets carry 1× weight.

**Tests:** multiplier stays 1.0 below `N_MIN`; gains vest only after the period; losses apply immediately, including against pending gains; the per-market cap holds; flagged users cannot vest; blocked categories revert; position holders cannot propose or dispute; shallow markets produce no ΔR.

---

## 3b-2. Market creation (implemented)

| Rule | Value |
|---|---|
| Who creates | The team (free, curated) and tier-V traders (R ≥ 36, not flagged) |
| Cost | $25 bond + $2 fee (protocol revenue) |
| Bond | Back when the market resolves YES/NO or the court fails for lack of quorum; forfeited to the global bonus pool if the court rules AMBIGUOUS |
| Conflicts | The creator can't propose the outcome or be drawn as a juror on their own market |
| Required | Question, category from the allowlist, source of truth, resolution criteria, a future close time |

Benchmark: Polymarket and Kalshi curate markets in-house; Augur let anyone create with a bond; Manifold lets creators resolve their own markets. Kleos opens creation to proven forecasters and separates writing a question from judging it.

---

## 3c. Kleos Court (implemented)

Disputes are judged by reputation, not by the platform or token holders.

| Rule | Value |
|---|---|
| Who can dispute | Anyone except the proposer, bettors included. One dispute per market |
| Dispute bond | $15: if the jury upholds the proposal, it's split among the majority jurors |
| Jury pool | Opt-in (`joinCourt`) for tier V: vested R ≥ 36, 10+ resolved bets, not flagged |
| Draw | 5 jurors per round, with no position in the market, never the proposer or disputer; a redraw excludes the previous jury |
| Voting | Commit a hidden vote, then reveal. Options: YES, NO, AMBIGUOUS |
| Verdict | 3 matching votes. YES/NO resolves the market; AMBIGUOUS voids it and refunds everyone |
| No verdict | One redraw. If the second round also fails, the market is voided and refunded |
| Juror incentives | With the verdict: +0.3 R (vests), plus a share of the losing bond. Against: −0.3 R |
| No-shows | Penalized −1.0 R **only** when their round lacked quorum and the market ended up refunded. If the market still closes, a no-show costs nothing |
| Bonds | Proposal upheld: proposer refunded, disputer's $15 pays the jury. Overturned: disputer gets $15 + the proposer's $10. AMBIGUOUS or failed court: both refunded |

**Known limits:** jurors can prove their vote after the reveal, so open bribes are possible (costly, not impossible). The draw uses block randomness, which block producers can nudge. The demo seeds a transparent jury pool (marketId 0 events).

---

## 4. Resolution evidence

Proposals carry their proof, so anyone can check a resolution the same way they check reputation.

- `createMarket(question, categoryId, oracle, criteria, closeTime)`: the resolution criteria are stored on-chain and shown on the market page.
- `propose(id, outcome, evidenceHash, evidenceURI)`: the proposer attaches a link to the proof (e.g. the official result page) and its hash; both are emitted in `OutcomeProposed`.
- The market page shows the criteria, the evidence link and the resolution track together.

---

## 3d. Social layer (implemented)

- **Calls:** `betWithCall` attaches a public, permanent one-liner (≤ 140 bytes) to a bet via the `CallPosted` event, which carries a `callId` numbered by the contract. Votes, the app and the indexer all use that one id. Written before the outcome, scored after it: opinions with receipts.
- **Feed (`/feed`):** every call with its bet and market, filterable by All, Sharps (R ≥ 16) and Following. Resolved markets turn calls into "Called it" / "Missed" receipts.
- **Follow:** `KleosSocial.sol`, a separate contract (`follow`, `unfollow`, `following`, `followerCount`) so social features never touch money or reputation. On-chain, so the graph follows the passkey to any device. Prompt-free inside a session.
- **Bet buddies:** traders who won the same markets together, derived in the indexer (issue #2).

---

## 4a. Envio HyperIndex (bounty: Best Use of Envio)

The indexer turns contract events into the queries the app needs, so reputation stays verifiable end to end: chain → Envio → UI.

| Entity | Built from | Used by |
|---|---|---|
| `Market` (prices, pools, state, evidence) | MarketCreated, BetPlaced, Outcome*, MarketResolved, Sponsored | Markets grid, market page |
| `Bet` | BetPlaced | Recent bets, sharp signal |
| `Trader` (R, pending, resolved bets, flagged) | ReputationChanged, Vested, Flagged, FlagCleared, Slashed | Leaderboard, profile, laurel badges |
| `ReputationChange` (delta, entry price, tx hash) | ReputationChanged | Profile history with the math and Monadscan links |
| `SharpSignal` per market | BetPlaced joined with Trader R ≥ 16 | "X of Y sharps bet YES" |

Docker is not installed locally, so the indexer runs on Envio Cloud.

**Judging:** depth of use (non-trivial schema, derived/aggregated entities), working product with live and correct data, originality, craft (readable code, sensible schema).
**Deliverables:** a deployed indexer with a **public repo** showing `config.yaml`, `schema.graphql` and event handlers; a frontend that consumes the data; a short demo of data flowing end to end.
**Why Kleos scores well:** `Trader` is aggregated from six event types, `SharpSignal` joins bets with reputation, and every profile row traces back to a transaction. Reputation is only "verifiable" if the data path is too.

> The repo is private today. It must be made public before submission.

**Setup notes (HyperIndex v3.12.1):**
- Lives in `indexer/` (Envio Cloud supports a monorepo root dir). pnpm, not npm: npm fails on install.
- `config.yaml` uses v3 `chains:` syntax. Monad testnet (10143) is supported by HyperSync natively, so no RPC is needed.
- Aggregates (`Trader`, `SharpSignal`) are computed in handlers: Envio Cloud has no `_aggregate` queries.
- Local dev without Docker: handler tests via `createTestIndexer`; the app reads from an Envio Cloud dev deployment (free plan: 3 indexers, 100k events).
- The GraphQL endpoint is public; numbers come back as strings and addresses checksummed.

## 4b. Mera accounts (bounty: Best Mera-Powered UX on Monad)

Mera is the whole account layer: sign in with a passkey, get test USD, bet. No seed phrase, no extension, no custody backend. It replaces the injected-wallet connector in the nav. The goal: the user never notices there's a blockchain underneath.

**Judging:** time-to-first-transaction (taps and seconds from landing to a confirmed Monad tx), session design (which actions are prompt-free vs re-prompt, clean session-expiry UX), the stateless test, and bonus credit for composing with the account stack (gas sponsorship, intents, recovery, smart accounts).

**Plan:**
- Landing → "Start with a passkey" → one tap creates the account, funds it and places the first bet. Target: ≤ 3 taps.
- New accounts have no MON for gas, so the first-run flow must fund them (a faucet drip or gas sponsorship; the approach depends on what Mera supports).
- Prompt-free inside a session: betting small amounts, claiming, vesting. Re-prompt: large bets and resolution actions that post a bond.
- Nothing sensitive is persisted: the account is re-derived from the passkey on any device.

**Setup notes (`@category-labs/mera` 0.2.0, preview):**
- Passkey → PRF output → BIP-39 → BIP-44 key → `toViemAccount(session)`. Signing inside a live session shows no prompt; `session.end()` zeroes the key.
- Sessions have no built-in expiry: Kleos ends them after 15 min idle and re-prompts for bets above $100 and for bonded resolution actions.
- Store only the credential id and cached address. Never persist the PRF output, mnemonic, seed, key or session. Don't use vault mode (it stores state).
- The rpId must be one fixed domain: Vercel preview URLs would derive different accounts.
- Every WebAuthn call must be the first `await` in a click handler (Safari).
- PRF isn't available on desktop Chrome with a local profile, Bitwarden or Dashlane: show a clear message on `PRF_UNAVAILABLE`.
- No gas sponsorship built in: a server route with a sponsor wallet drips MON and calls `KleosUSD.sponsorMint` for new accounts. Recovery: "Show recovery phrase" re-derives the BIP-39 phrase behind a fresh ceremony.

---

## 5. Remaining build

**Daniela (unblocks everything else)**

- [ ] A fresh Monad testnet wallet for deploying (not a personal wallet) + testnet MON from the faucet
- [ ] Vercel account for hosting (optional: any host works)
- [ ] Open every source link in the README and confirm the numbers match

**Contracts (Claude)**

- [x] Payout v2: money parimutuel, 2% fee → bonus pool, 1% protocol revenue, sponsor(), bonus by ΔR·M, two-phase settlement (§3a)
- [x] Safeguards: activation, vesting, per-market cap, minimum depth, anomaly flag, resolver gating, category allowlist (§3b)
- [x] Resolution criteria + evidence hash and URI (§4)
- [x] Tests for all of the above; update the pitch-number tests
- [x] Kleos Court: jury disputes with commit-reveal and AMBIGUOUS refunds (§3c)
- [x] Calls, feed and follow (§3d); 32 tests passing
- [ ] Bet buddies in the indexer (issue #2)

**App (Claude)**

- [ ] Envio indexer + app reads from it (§4a)
- [x] Compare page: traditional markets vs Kleos on real cases (Zelensky suit source pending)
- [ ] Mera sign-in replacing the injected wallet (§4b)
- [ ] Resolution UI: propose, dispute, finalize, settle, claim bonus, vest
- [x] Payout panel shows money odds ("pays 2.25×") next to the reputation signal
- [ ] "Under review" and "Sponsored by" on profile and market pages

**Ship**

- [x] Git repo (private: github.com/danimim/kleos, teammate apokusin invited)
- [ ] Make the repo public before submission (required by the Envio bounty)
- [ ] Deploy contracts to Monad testnet: Claude prepares, **Daniela authorizes and signs**
- [ ] Seed the demo on-chain (whale vs sharps, one market in dispute, one resolved)
- [ ] Host the web app and point it at the deployed contracts

**Submission deliverables**

- [ ] Pitch deck
- [ ] Demo video, ~3 min (§6)
- [ ] Submission form: repo link, live URL, video, track selected

### Timeline: everything done by Oct 2 (Daniela travels Oct 3)

| Day | Claude | Daniela |
|---|---|---|
| Sep 28 | Contracts (payout v2 + safeguards + evidence fields + tests), git repo | Deploy wallet + testnet MON, check sources |
| Sep 29 | On-chain reads + resolution UI | Review the app |
| Sep 30 | Polish the demo flow; mobile pass | Authorize the deploy; start the deck |
| Oct 1 | Deploy + seed the demo + host the site | Record the demo video |
| Oct 2 | Fixes only, no new features | Final deck, **submit** |

**Cut to fit:** the anomaly flag ships as the on-chain rule only, without an admin review screen. The Hunyuan bounty was dropped on Sep 28.

---

## 5b. Bounty highlights for the demo and pitch

Say these out loud; judges score exactly these points.

**Mera (Best Mera-Powered UX on Monad)**
- **Time to first transaction:** landing → "Start with passkey" → Touch ID → bet confirmed. The sponsor funds gas and test USD, and kUSD trusts the market, so a first bet is one transaction. The panel shows the seconds it took.
- **Session design:** bets up to $100, follows, votes on calls, settling and claiming are prompt-free while unlocked. Bets over $100, bonds (propose, dispute), jury votes and the recovery phrase ask for the passkey again. 15 idle minutes lock the session.
- **The stateless test:** sign out, clear storage, sign in on another device with "I have one" → same address, same profile, same follows (they're on-chain).
- **Jury votes without storage:** the secret salt behind a hidden (commit-reveal) vote is derived from the passkey itself: a deterministic signature over the market and round. Vote on a laptop, reveal on a phone, nothing saved anywhere.
- **Recovery:** "Show recovery phrase" re-derives a standard 24-word phrase behind a fresh prompt.

**Envio (Best Use of Envio)**
- Derived entities no event contains: `Trader` aggregated from six events, `SharpSignal`, and **bet buddies** (traders who won the same markets together).
- Every reputation change on a profile traces back to its transaction: verifiable end to end.

**Track (Social, Attention & Culture)**
- Calls: opinions with receipts, scored when markets resolve. Feed with All / Sharps / Following. Follows and usernames on-chain.
- Kleos Court: disputes judged by earned reputation, not by token whales or the platform.

---

## 6. Demo script (3 min)

1. **Hook:** "Your track record is worth more than their bankroll." Show the markets page.
2. **The problem:** a whale bets $2,000 against 20 sharps betting $80 each. By money, the market says 44%. Kleos says 71%. Show it live on How it works.
3. **Resolution:** propose YES with a link to the official result. The dispute window starts, then the market finalizes and settles.
4. **Reputation:** open a trader's profile. Hover a ΔR to see the math, then click through to Monadscan.
5. **Close:** "Kleos: glory you earn, not buy."

---

## 7. Ground rules

- No wallet interaction, deploy or private-key use without Daniela's explicit authorization for that specific action.
- Secrets live only in env vars, never in the repo or the client bundle.

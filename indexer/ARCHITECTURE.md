# Indexer architecture

How contract events become the data the app reads. Solid lines are built; dashed lines are planned (see `PLAN.md` for phases, `PROGRESS.md` for status).

## 1. The big picture

```mermaid
flowchart LR
  subgraph chain["Chain"]
    kleos["Kleos.sol<br/>markets · reputation · court"]
    social["KleosSocial.sol<br/>names · follows · votes"]
  end

  subgraph sources["Where events come from"]
    local["Local Hardhat · 31337<br/>RPC 127.0.0.1:8545<br/>config.yaml"]
    testnet["Monad testnet · 10143<br/>HyperSync<br/>config.testnet.yaml"]
  end

  subgraph envio["indexer/ · Envio HyperIndex"]
    handlers["src/handlers/<br/>markets · bets · reputation<br/>court · social"]
    planned["bet buddies (#2)"]
    store[("Entities<br/>schema.graphql")]
  end

  subgraph serve["Serving"]
    cloud["Envio Cloud<br/>GraphQL API"]
  end

  subgraph web["web/"]
    client["src/lib/indexer.ts (#3)"]
    onchain["src/lib/onchain.ts<br/>RPC reads (today)"]
    sample["src/lib/data.ts<br/>sample data (demo mode)"]
    pages["Pages<br/>markets · market · feed · profile · leaderboard"]
  end

  kleos --> local
  kleos --> testnet
  social --> local
  social --> testnet
  local --> handlers
  testnet --> handlers
  handlers --> store
  planned -.-> store
  store -.-> cloud -.-> client
  client -.->|"1st choice"| pages
  onchain -->|"fallback"| pages
  sample -->|"no chain configured"| pages
```

Both configs list the same contracts and events. Only the chain, the addresses and the data source differ. Envio Cloud runs `config.testnet.yaml`. The Cloud deploy and `web/src/lib/indexer.ts` are still to come.

Pages pick the first source that's configured: indexer, then RPC, then sample data. Only the indexer path is new. The other two keep working throughout.

Testnet is read through HyperSync. Envio Cloud gives hosted indexers HyperSync access without a token. Running the testnet config locally needs `ENVIO_API_TOKEN` in `indexer/.env`. The start block is 67114786, where KleosSocial was deployed; Kleos followed in 67114811.

## 2. How we test it without Docker

```mermaid
flowchart LR
  subgraph unit["src/test/core.test.ts · 24 tests"]
    sim["simulate: [...]<br/>synthetic events"]
  end
  subgraph integ["src/test/local-chain.test.ts"]
    range["startBlock..endBlock<br/>real local chain"]
  end
  subgraph live["src/test/testnet.test.ts"]
    trange["startBlock..head<br/>Monad testnet via HyperSync"]
  end
  views["Contract view functions<br/>getMarket · prices · getBettors · reputation<br/>jurorPool · namesOf · tallies"]
  handlers["Real handlers<br/>createTestIndexer · in memory"]

  sim --> handlers
  range --> handlers
  trange --> handlers
  handlers --> assertU["assert entities"]
  handlers --> compare{"indexed == contract?"}
  views --> compare
```

- `pnpm test` runs the simulated tests and the local-chain test. The local-chain test skips itself unless the local chain is running with the contracts deployed (`dev-stack` skill).
- `pnpm test:testnet` runs `scripts/test-testnet.sh`. It swaps `config.testnet.yaml` in for `config.yaml`, runs the real handlers over the live deployment, compares markets, prices, bettors, reputation, the juror pool, names, follows and vote tallies with the contracts, and swaps the config back. It needs `ENVIO_API_TOKEN`.

## 3. Which event updates what

One diagram per handler file. The labels on the arrows name the fields each event changes.

**`src/handlers/markets.ts`: the market lifecycle**

```mermaid
flowchart LR
  CategoryAdded --> Category
  MarketCreated -->|"new Market, creator"| Market
  MarketCreated -->|"marketCount"| Protocol
  CreatorBondReleased -->|"creatorBondForfeited"| Market
  Sponsored -->|"bonusPool, sponsored*"| Market
  OutcomeProposed -->|"state, evidence"| Market
  OutcomeDisputed -->|"state, disputer"| Market
  MarketResolved -->|"state, outcome, fee"| Market
  MarketVoided -->|"state, voided"| Market
  MarketExpired -->|"expired"| Market
  BonusRolledOver -->|"rolledOver"| Market
  BonusOpened -->|"final bonusPool, bonusWeight"| Market
  MarketResolved -->|"result Right / Wrong"| Call
  MarketVoided -->|"result Refunded"| Call
  MarketVoided -->|"failed, if the last round had no verdict"| CourtRound
  RevenueAccrued -->|"revenueAccrued"| Protocol
  RevenueWithdrawn -->|"revenueWithdrawn"| Protocol
```

\* `sponsored` skips top-ups from the global pool (sponsor = the Kleos contract itself).

**`src/handlers/bets.ts`: trading and settlement**

```mermaid
flowchart LR
  BetPlaced -->|"traderR, sharp"| Bet
  BetPlaced --> PricePoint
  BetPlaced -->|"pools, prices, betCount, bettorCount, sharpYes, sharpNo"| Market
  BetPlaced -->|"money per side, sharp flags"| Position
  BetPlaced -->|"betCount, volume, marketCount"| Trader
  BetPlaced -->|"betCount, bettorCount, volume"| Protocol
  CallPosted -->|"new Call, id = callId, ups and downs from earlier votes"| Call
  CallPosted -->|"callCount"| Market
  CallPosted -->|"callCount"| Trader
  CallPosted -->|"callCount"| Protocol
  Settled -->|"payout, bonusWeight"| Position
  Settled -->|"resolvedBets + 1 if deep and at least $50"| Trader
  BonusClaimed -->|"bonus"| Position
```

The sharp signal counts each trader once per side, by their vested R at bet time. Sharp means R of at least 16 (tier IV).

**`src/handlers/reputation.ts`: reputation**

```mermaid
flowchart LR
  ReputationChanged --> ReputationChange
  ReputationChanged -->|"r, pending, wins, losses"| Trader
  Vested -->|"r, pending = 0"| Trader
  Flagged -->|"flagged"| Trader
  FlagCleared -->|"flagged"| Trader
  Slashed -->|"slashed"| Trader
```

`ReputationChanged` also reads the trader's `Position` in that market to label the change: Bet if one exists, Jury if not (jurors can never hold one), Admin for market 0. After a `Slashed`, the `ReputationChanged` with market 0 sets R and pending.

**`src/handlers/court.ts`: Kleos Court**

```mermaid
flowchart LR
  JurorJoined -->|"isJuror"| Trader
  JurorLeft -->|"isJuror"| Trader
  JurorPruned -->|"isJuror"| Trader
  JurorJoined -->|"jurorCount"| Protocol
  JurorLeft -->|"jurorCount"| Protocol
  JurorPruned -->|"jurorCount"| Protocol
  JuryDrawn -->|"new round, jurors"| CourtRound
  JuryDrawn -->|"one seat per juror"| JurorVote
  JuryDrawn -->|"juryDuties"| Trader
  JuryDrawn -->|"courtRound"| Market
  VoteCommitted -->|"committed"| JurorVote
  VoteCommitted -->|"commits"| CourtRound
  VoteRevealed -->|"vote"| JurorVote
  VoteRevealed -->|"reveals, yes, no, ambiguous"| CourtRound
  CourtRedrawn -->|"failed"| CourtRound
  Verdict -->|"verdict"| CourtRound
  Verdict -->|"verdict"| Market
```

Seats are created when the jury is drawn, so jurors who never commit or reveal stay visible.

**`src/handlers/social.ts`: KleosSocial**

```mermaid
flowchart LR
  NameSet -->|"name"| Trader
  Followed -->|"new edge"| Follow
  Followed -->|"followingCount, followerCount"| Trader
  Unfollowed -->|"edge deleted"| Follow
  Unfollowed -->|"followingCount, followerCount"| Trader
  CallVoted -->|"set, or deleted on 0"| CallVote
  CallVoted -->|"ups, downs"| Call
```

KleosSocial doesn't check that a call exists, so a vote can arrive before its `CallPosted`. The `CallPosted` handler counts the votes already stored. Social data never touches money or reputation.

Not indexed on purpose: `OwnershipTransferred`. Nothing in the app shows the owner.

## 4. The entities

```mermaid
erDiagram
  Category ||--o{ Market : groups
  Market ||--o{ Position : "one per trader"
  Trader ||--o{ Position : holds
  Market ||--o{ Bet : ""
  Trader ||--o{ Bet : places
  Market ||--o{ PricePoint : "after each bet"
  Market ||--o{ Call : ""
  Trader ||--o{ Call : posts
  Trader ||--o{ ReputationChange : ""
  Market |o--o{ ReputationChange : "none for seeds"
  Market ||--o{ CourtRound : "1 or 2 if disputed"
  CourtRound ||--o{ JurorVote : "one seat per juror"
  Trader ||--o{ JurorVote : "sits on"
  Trader ||--o{ Follow : follows
  Trader ||--o{ Follow : "is followed"
  Call ||--o{ CallVote : ""
  Trader ||--o{ CallVote : casts

  Market {
    ID id "marketId"
    String creator "team or tier-V trader"
    MarketState state "Open Proposed Disputed Resolved"
    Boolean voided "refunded"
    Boolean expired "nobody proposed in time"
    BigInt yesMoney
    BigInt noMoney
    BigInt priceRepYes "WAD"
    Int bettorCount "distinct"
    Int sharpYes "traders with R at least 16"
    Int sharpNo
    Int courtRound "0 until disputed"
    BigInt bonusPool
    BigInt bonusWeight "sum of winner weights"
    BigInt rolledOver "sent to the global pool"
  }
  Position {
    ID id "marketId_address"
    BigInt yesMoney
    BigInt noMoney
    BigInt payout
    BigInt bonusWeight
    BigInt bonus "claimed"
  }
  Bet {
    ID id "block_logIndex"
    BigInt amount
    BigInt multiplier
    BigInt traderR "vested R at bet time"
    Boolean sharp
  }
  Trader {
    ID id "lowercase address"
    String name "KleosSocial username"
    BigInt r "vested, WAD"
    BigInt pending
    Int resolvedBets "at least $50, deep markets only"
    Boolean flagged
    BigInt slashed
    Boolean isJuror
    Int juryDuties
    Int followerCount
    Int followingCount
  }
  ReputationChange {
    ID id "block_logIndex"
    ChangeKind kind "Bet Jury Admin"
    BigInt delta "signed"
    BigInt newR
  }
  Call {
    ID id "callId, numbered by Kleos"
    CallResult result "Open Right Wrong Refunded"
    String text
    Int ups
    Int downs
  }
  CourtRound {
    ID id "marketId_round"
    Int commits
    Int reveals
    Int verdict "1 YES 2 NO 3 AMBIGUOUS"
    Boolean failed "no verdict"
  }
  JurorVote {
    ID id "marketId_round_juror"
    Boolean committed
    Int vote "0 until revealed"
  }
  Follow {
    ID id "follower_followee"
    Int since
  }
  CallVote {
    ID id "callId_voter"
    Int value "1 up, -1 down"
  }
  Protocol {
    ID id "kleos"
    Int marketCount
    Int betCount
    Int bettorCount
    BigInt volume
    Int callCount
    Int jurorCount
    BigInt revenueAccrued
    BigInt revenueWithdrawn
  }
```

`Protocol` is a single row of totals. Envio Cloud has no `_aggregate` queries, so totals and per-entity counters (`bettorCount`, `callCount`, `followerCount` and so on) are kept up to date by the handlers.

Planned: `BuddyPair` (#2).

## 5. A market's life, and what the indexer does at each step

```mermaid
stateDiagram-v2
  [*] --> Open: MarketCreated
  Open --> Open: BetPlaced / CallPosted / Sponsored
  Open --> Proposed: OutcomeProposed (after close, $10 bond)
  Open --> Voided: expire → MarketVoided, MarketExpired
  Proposed --> Resolved: finalize → MarketResolved
  Proposed --> Disputed: OutcomeDisputed ($15 bond) + JuryDrawn round 1
  Disputed --> Disputed: VoteCommitted / VoteRevealed
  Disputed --> Disputed: CourtRedrawn (no verdict in round 1) + JuryDrawn round 2
  Disputed --> Resolved: Verdict YES/NO → MarketResolved
  Disputed --> Voided: Verdict AMBIGUOUS, or round 2 without one → MarketVoided
  Resolved --> Settling: settle(users) → Settled per bettor
  Voided --> Settling: settle(users) → refunds
  Settling --> BonusOpen: last bettor settled → BonusOpened
  BonusOpen --> [*]: BonusClaimed per winner

  note right of Resolved
    Calls scored Right / Wrong.
    2% of the losing pool joins bonusPool.
  end note
  note right of Voided
    Market.state = Resolved, voided = true.
    expired = true if nobody proposed in time.
    Calls marked Refunded. No MarketResolved.
    A court that failed its last round is marked failed.
  end note
```

`propose`, `expire`, `sponsor` and `fundFromGlobal` reject market ids that were never created, so every market event follows its `MarketCreated`. The market handlers still look markets up with `knownMarket`, which logs a warning and skips the event instead of halting the indexer.

## 6. Inside one settle, in event order

Order within a transaction matters: the handlers rely on the `Position` already existing (it was created at bet time) and on `BonusOpened` coming last.

```mermaid
sequenceDiagram
  participant K as Kleos.settle(id, users)
  participant R as reputation.ts
  participant B as bets.ts
  participant M as markets.ts

  loop each user (deep market, not voided)
    K->>R: ReputationChanged (+gain, side == outcome)
    R->>R: Position exists → kind Bet, wins + 1
    opt new account won a long shot
      K->>R: Flagged
    end
    opt also bet the losing side
      K->>R: ReputationChanged (−loss, side ≠ outcome)
      R->>R: losses + 1 (counted even if delta is 0 at R = 0)
    end
    K->>B: Settled (payout, bonusWeight)
    B->>B: Position settled, resolvedBets + 1 if the position is at least $50
  end
  opt every bettor settled
    opt nobody gained reputation
      K->>M: BonusRolledOver (rolledOver)
    end
    K->>M: BonusOpened (final pool, total weight)
  end
```

In a voided market or a shallow one, `Settled` comes alone: no reputation changes and no `resolvedBets`.

In a court with a verdict, the jurors' `ReputationChanged` events come right after `Verdict` and before `MarketResolved` or `MarketVoided`. When the court fails its last round, `MarketVoided` comes first and the no-show penalties follow. Jurors never hold a position, so their changes are recorded as `Jury` either way.

## 7. Where the work stands

```mermaid
flowchart LR
  p0["0 · Scaffold<br/>local chain, skills"]:::done
  p1["1 · Core entities<br/>+ tests, review fixes"]:::done
  p2["2 · Lifecycle on the local chain<br/>seed + court scripts"]:::done
  p3["3 · Social, sharp signal,<br/>court, protocol totals"]:::done
  p4["4 · Bet buddies (#2)"]:::todo
  p5["5 · web/src/lib/indexer.ts (#3)<br/>+ one wiring PR"]:::todo
  p6["6 · Testnet + Envio Cloud<br/>testnet checked, Cloud deploy next"]:::next
  p0 --> p1 --> p2 --> p3 --> p4 --> p5 --> p6
  classDef done fill:#1f6f3f,stroke:#1f6f3f,color:#fff
  classDef next fill:#ff5a36,stroke:#ff5a36,color:#0d0c0b
  classDef todo fill:#fff,stroke:#999,color:#333,stroke-dasharray: 4 3
```

The local-chain test checks resolution, settlement, the bonus and every court round against the contract. A court with a verdict is covered by the simulated tests only; the local run took a court through a redraw and a failed last round.

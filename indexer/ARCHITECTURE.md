# Indexer architecture

How contract events become the data the app reads. Solid lines are built; dashed lines are planned.

## 1. The big picture

```mermaid
flowchart LR
  subgraph chain["Chain"]
    kleos["Kleos.sol<br/>markets · reputation · court"]
    social["KleosSocial.sol<br/>names · follows · votes"]
  end

  subgraph sources["Where events come from"]
    local["Local Hardhat · 31337<br/>RPC 127.0.0.1:8545<br/>(development, now)"]
    testnet["Monad testnet · 10143<br/>HyperSync<br/>(phase 6)"]
  end

  subgraph envio["indexer/ · Envio HyperIndex"]
    config["config.yaml<br/>which contracts and events"]
    handlers["src/handlers/<br/>markets.ts · bets.ts · reputation.ts"]
    planned["social · court · buddies<br/>(phases 3–4)"]
    store[("Entities<br/>schema.graphql")]
  end

  subgraph serve["Serving"]
    cloud["Envio Cloud<br/>GraphQL API"]
  end

  subgraph web["web/"]
    client["src/lib/indexer.ts"]
    onchain["src/lib/onchain.ts<br/>RPC reads (today)"]
    sample["src/lib/data.ts<br/>sample data (demo mode)"]
    pages["Pages<br/>markets · market · feed · profile · leaderboard"]
  end

  kleos --> local
  kleos -.-> testnet
  social -.-> local
  social -.-> testnet
  local --> config
  testnet -.-> config
  config --> handlers --> store
  config -.-> planned -.-> store
  store -.-> cloud -.-> client
  client -.->|"1st choice"| pages
  onchain -->|"fallback"| pages
  sample -->|"no chain configured"| pages
```

Pages pick the first source that's configured: indexer, then RPC, then sample data. Only the indexer path is new. The other two keep working throughout.

## 2. How we test it without Docker

```mermaid
flowchart LR
  subgraph unit["src/test/core.test.ts · 11 tests"]
    sim["simulate: [...]<br/>synthetic events"]
  end
  subgraph integ["src/test/local-chain.test.ts · 1 test"]
    range["startBlock..endBlock<br/>real local chain"]
    views["Kleos view functions<br/>getMarket · prices · getBettors · reputation"]
  end
  handlers["Real handlers<br/>createTestIndexer · in memory"]

  sim --> handlers
  range --> handlers
  handlers --> assertU["assert entities"]
  handlers --> compare{"indexed == contract?"}
  views --> compare
```

The integration test skips itself unless the local chain is running with the contracts deployed (`dev-stack` skill).

## 3. Which event updates what

One diagram per handler file. The labels on the arrows name the fields each event changes.

**`src/handlers/markets.ts`: the market lifecycle**

```mermaid
flowchart LR
  CategoryAdded --> Category
  MarketCreated -->|"creator"| Market
  CreatorBondReleased -->|"creatorBondForfeited"| Market
  Sponsored -->|"bonusPool, sponsored*"| Market
  OutcomeProposed -->|"state, evidence"| Market
  OutcomeDisputed -->|"state, disputer"| Market
  MarketResolved -->|"state, outcome, fee"| Market
  MarketVoided -->|"state, voided"| Market
  BonusOpened -->|"final bonusPool, bonusWeight"| Market
  MarketResolved -->|"result Right / Wrong"| Call
  MarketVoided -->|"result Refunded"| Call
```

**`src/handlers/bets.ts`: trading and settlement**

```mermaid
flowchart LR
  BetPlaced --> Bet
  BetPlaced --> PricePoint
  BetPlaced -->|"pools, prices, betCount, bettorCount"| Market
  BetPlaced -->|"money per side"| Position
  BetPlaced -->|"betCount, volume, marketCount"| Trader
  CallPosted -->|"new Call, id = callId; callCount + 1 on Market and Trader"| Call
  Settled -->|"payout, bonusWeight"| Position
  Settled -->|"resolvedBets + 1 if deep"| Trader
  BonusClaimed -->|"bonus"| Position
```

**`src/handlers/reputation.ts`: reputation**

```mermaid
flowchart LR
  ReputationChanged --> ReputationChange
  ReputationChanged -->|"r, pending, wins, losses"| Trader
  Vested -->|"r, pending = 0"| Trader
  Flagged -->|"flagged"| Trader
  FlagCleared -->|"flagged"| Trader
```

`ReputationChanged` also reads the trader's `Position` in that market to label the change: Bet if one exists, Jury if not (jurors can never hold one), Admin for market 0.

\* `sponsored` skips top-ups from the global pool (sponsor = the Kleos contract itself).

Not handled on purpose:
- `BonusRolledOver`: the `BonusOpened` right after it carries the final pool.
- `Slashed`: the `ReputationChanged` in the same transaction carries the result.
- `RevenueAccrued`, `RevenueWithdrawn`: protocol revenue isn't shown anywhere or scored. The creation-fee `RevenueAccrued` also comes before its `MarketCreated`.

Not handled yet (phase 3): the court events (`JuryDrawn`, `VoteCommitted`, `VoteRevealed`, `CourtRedrawn`, `Verdict`), `JurorJoined`/`JurorLeft`, and everything from `KleosSocial`.

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

  Market {
    ID id "marketId"
    String creator "team or tier-V trader"
    MarketState state "Open Proposed Disputed Resolved"
    BigInt yesMoney
    BigInt noMoney
    BigInt priceRepYes "WAD"
    Int bettorCount "distinct"
    BigInt bonusPool
    BigInt bonusWeight "sum of winner weights"
  }
  Position {
    ID id "marketId_address"
    BigInt yesMoney
    BigInt noMoney
    BigInt payout
    BigInt bonusWeight
    BigInt bonus "claimed"
  }
  Trader {
    ID id "lowercase address"
    BigInt r "vested, WAD"
    BigInt pending
    Int resolvedBets "deep markets only"
    Int wins
    Int losses
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
  }
```

Planned: `BuddyPair` (#2), `CourtRound`, `SharpSignal`, and `Follow`, plus names and vote counts from `KleosSocial`.

## 5. A market's life, and what the indexer does at each step

```mermaid
stateDiagram-v2
  [*] --> Open: MarketCreated
  Open --> Open: BetPlaced / CallPosted / Sponsored
  Open --> Proposed: OutcomeProposed (after close, $10 bond)
  Proposed --> Resolved: finalize → MarketResolved
  Proposed --> Disputed: OutcomeDisputed ($15 bond)
  Disputed --> Disputed: CourtRedrawn (no verdict, round 1)
  Disputed --> Resolved: Verdict YES/NO → MarketResolved
  Disputed --> Voided: Verdict AMBIGUOUS or 2 failed rounds → MarketVoided
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
    Calls marked Refunded. No MarketResolved.
  end note
```

A market id that was never created can still reach `Proposed` and beyond, because `Kleos.propose` doesn't check that the market exists. The market handlers skip these events (`knownMarket`) instead of halting. This contract behavior requires a bounds check.

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
    B->>B: Position settled, resolvedBets + 1
  end
  opt every bettor settled
    opt nobody gained reputation
      K-->>M: BonusRolledOver (ignored)
    end
    K->>M: BonusOpened (final pool, total weight)
  end
```

In a court, the jurors' `ReputationChanged` events come right after `Verdict` and before `MarketResolved`. Jurors never hold a position, so they're recorded as `Jury`.

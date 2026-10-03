// Market lifecycle: creation, sponsorship, proposal, dispute, resolution, bonus.
import { indexer, type Call, type EvmOnEventContext } from "envio";
import { WAD, addressId, eventId, getProtocol, roundId } from "../utils.js";
import { creationConfiguration } from "../transaction-input.js";
import { getConfiguration } from "../configuration.js";

indexer.onEvent(
  { contract: "Kleos", event: "CategoryAdded", fields: { transaction: ["hash", "input", "to", "from", "contractAddress"] } },
  async ({ event, context }) => {
    context.Category.set({ id: event.params.id.toString(), name: event.params.name });
    const [config, protocol] = await Promise.all([getConfiguration(context, event.srcAddress), getProtocol(context)]);
    const creation = creationConfiguration(event);
    if (!creation) return;
    context.ContractConfiguration.set({
      ...config, ...creation, source: "DirectCreation", blockNumber: event.block.number,
      txHash: event.transaction.hash, blockHash: undefined, runtimeSha256: undefined,
    });
    if (event.transaction.from) {
      context.Protocol.set({ ...protocol, owner: addressId(event.transaction.from), ownerSource: "DirectCreation" });
    }
  },
);

indexer.onEvent(
  { contract: "Kleos", event: "OwnershipTransferred", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const protocol = await getProtocol(context);
    const owner = addressId(event.params.newOwner);
    context.Protocol.set({ ...protocol, owner, ownerSource: "Event" });
    context.OwnershipChange.set({
      id: eventId(event), previousOwner: addressId(event.params.previousOwner), newOwner: owner,
      timestamp: event.block.timestamp, txHash: event.transaction.hash,
      blockNumber: event.block.number, logIndex: event.logIndex, contractAddress: addressId(event.srcAddress),
    });
  },
);

indexer.onEvent(
  { contract: "Kleos", event: "MarketCreated", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const p = event.params;
    const protocol = await getProtocol(context);
    context.Protocol.set({ ...protocol, marketCount: protocol.marketCount + 1 });
    context.Market.set({
      id: p.marketId.toString(),
      question: p.question,
      category_id: p.category.toString(),
      creator: p.creator.toLowerCase(),
      creatorBondForfeited: undefined,
      oracle: p.oracle,
      criteria: p.criteria,
      closeTime: p.closeTime,
      createdAt: event.block.timestamp,
      state: "Open",
      outcome: undefined,
      voided: false,
      expired: false,
      resolvedAt: undefined,
      proposedOutcome: undefined,
      proposer: undefined,
      proposedAt: undefined,
      evidenceHash: undefined,
      evidenceURI: undefined,
      disputer: undefined,
      yesMoney: 0n,
      noMoney: 0n,
      yesEff: 0n,
      noEff: 0n,
      priceRepYes: WAD / 2n,
      priceMoneyYes: WAD / 2n,
      betCount: 0,
      bettorCount: 0,
      callCount: 0,
      sharpYes: 0,
      sharpNo: 0,
      courtRound: 0,
      verdict: undefined,
      fee: 0n,
      bonusPool: 0n,
      bonusWeight: 0n,
      sponsored: 0n,
      lastSponsor: undefined,
      bonusOpen: false,
      rolledOver: 0n,
    });
  },
);

indexer.onEvent({ contract: "Kleos", event: "Sponsored" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  const fromPool = event.params.sponsor.toLowerCase() === event.srcAddress.toLowerCase(); // fundFromGlobal
  context.Market.set({
    ...m,
    bonusPool: m.bonusPool + event.params.amount,
    sponsored: m.sponsored + (fromPool ? 0n : event.params.amount),
    lastSponsor: fromPool ? m.lastSponsor : event.params.sponsor.toLowerCase(),
  });
});

indexer.onEvent(
  { contract: "Kleos", event: "OutcomeProposed", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const p = event.params;
    const m = await knownMarket(context, p.marketId);
    if (!m) return;
    context.Market.set({
      ...m,
      state: "Proposed",
      proposedOutcome: p.outcome,
      proposer: p.proposer.toLowerCase(),
      proposedAt: event.block.timestamp,
      evidenceHash: p.evidenceHash,
      evidenceURI: p.evidenceURI,
    });
  },
);

indexer.onEvent({ contract: "Kleos", event: "OutcomeDisputed" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  context.Market.set({ ...m, state: "Disputed", disputer: event.params.disputer.toLowerCase() });
});

indexer.onEvent(
  { contract: "Kleos", event: "MarketResolved", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const { marketId, outcome, fee } = event.params;
    const m = await knownMarket(context, marketId);
    if (!m) return;
    context.Market.set({ ...m, state: "Resolved", outcome, fee, bonusPool: m.bonusPool + fee, resolvedAt: event.block.timestamp });
    await scoreCalls(context, m.id, (c) => (c.side === outcome ? "Right" : "Wrong"));
  },
);

// Court AMBIGUOUS, a failed court, or expiry: everyone is refunded and no MarketResolved is emitted.
indexer.onEvent(
  { contract: "Kleos", event: "MarketVoided", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const m = await knownMarket(context, event.params.marketId);
    if (!m) return;
    context.Market.set({ ...m, state: "Resolved", voided: true, resolvedAt: event.block.timestamp });
    await scoreCalls(context, m.id, () => "Refunded");
    // Voided while disputed with no verdict: the last round closed without one, and Kleos emits no
    // other event for that.
    if (m.state === "Disputed" && m.verdict === undefined && m.courtRound > 0) {
      const round = await context.CourtRound.get(roundId(m.id, m.courtRound));
      if (round) context.CourtRound.set({ ...round, failed: true });
    }
  },
);

// Follows MarketVoided in the same transaction: nobody proposed an outcome in time.
indexer.onEvent({ contract: "Kleos", event: "MarketExpired" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  context.Market.set({ ...m, expired: true });
});

// The $2 creation fee accrues before its MarketCreated, so this never touches the market.
indexer.onEvent({ contract: "Kleos", event: "RevenueAccrued" }, async ({ event, context }) => {
  const protocol = await getProtocol(context);
  context.Protocol.set({ ...protocol, revenueAccrued: protocol.revenueAccrued + event.params.amount });
});

indexer.onEvent({ contract: "Kleos", event: "RevenueWithdrawn" }, async ({ event, context }) => {
  const protocol = await getProtocol(context);
  context.Protocol.set({ ...protocol, revenueWithdrawn: protocol.revenueWithdrawn + event.params.amount });
});

// Only trader-created markets have a bond. It's forfeited when the court rules the question
// AMBIGUOUS, and returned otherwise (including when the court fails).
indexer.onEvent({ contract: "Kleos", event: "CreatorBondReleased" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  context.Market.set({ ...m, creatorBondForfeited: event.params.forfeited });
});

// When nobody gained reputation the pot funds future markets. BonusOpened follows with a pool of 0.
indexer.onEvent({ contract: "Kleos", event: "BonusRolledOver" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  context.Market.set({ ...m, rolledOver: event.params.amount });
});

// Carries the final pot, so this handler alone keeps bonusPool right.
indexer.onEvent({ contract: "Kleos", event: "BonusOpened" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  context.Market.set({ ...m, bonusOpen: true, bonusPool: event.params.bonusPool, bonusWeight: event.params.totalWeight });
});

/**
 * Every market event follows its MarketCreated: propose, expire, sponsor and fundFromGlobal reject
 * ids that were never created, and the rest need a state only those reach. Kept as a guard anyway,
 * so an unexpected event logs a warning instead of halting the indexer on that block.
 */
async function knownMarket(context: EvmOnEventContext, marketId: bigint) {
  const m = await context.Market.get(marketId.toString());
  if (!m) context.log.warn(`Skipping event for market ${marketId}, which was never created`);
  return m;
}

/** Calls are written before the outcome; resolution turns them into receipts. */
async function scoreCalls(context: EvmOnEventContext, marketId: string, result: (c: Call) => Call["result"]) {
  const calls = await context.Call.getWhere({ market_id: { _eq: marketId } });
  for (const c of calls) context.Call.set({ ...c, result: result(c) });
}

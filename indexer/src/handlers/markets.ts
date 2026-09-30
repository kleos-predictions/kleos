// Market lifecycle: creation, sponsorship, proposal, dispute, resolution, bonus.
import { indexer, type Call, type EvmOnEventContext } from "envio";
import { WAD } from "../utils.js";

indexer.onEvent({ contract: "Kleos", event: "CategoryAdded" }, async ({ event, context }) => {
  context.Category.set({ id: event.params.id.toString(), name: event.params.name });
});

indexer.onEvent(
  { contract: "Kleos", event: "MarketCreated", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const p = event.params;
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
      fee: 0n,
      bonusPool: 0n,
      bonusWeight: 0n,
      sponsored: 0n,
      lastSponsor: undefined,
      bonusOpen: false,
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

// Court AMBIGUOUS or a failed court: everyone is refunded and no MarketResolved is emitted.
indexer.onEvent(
  { contract: "Kleos", event: "MarketVoided", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const m = await knownMarket(context, event.params.marketId);
    if (!m) return;
    context.Market.set({ ...m, state: "Resolved", voided: true, resolvedAt: event.block.timestamp });
    await scoreCalls(context, m.id, () => "Refunded");
  },
);

// Only trader-created markets have a bond. It's forfeited when the court rules the question
// AMBIGUOUS, and returned otherwise (including when the court fails).
indexer.onEvent({ contract: "Kleos", event: "CreatorBondReleased" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  context.Market.set({ ...m, creatorBondForfeited: event.params.forfeited });
});

// Carries the final pot. When nobody gained reputation, Kleos emits BonusRolledOver first and then
// BonusOpened with a pool of 0, so this handler alone keeps bonusPool right.
indexer.onEvent({ contract: "Kleos", event: "BonusOpened" }, async ({ event, context }) => {
  const m = await knownMarket(context, event.params.marketId);
  if (!m) return;
  context.Market.set({ ...m, bonusOpen: true, bonusPool: event.params.bonusPool, bonusWeight: event.params.totalWeight });
});

/**
 * Kleos.propose and fundFromGlobal don't check that a market exists: an id that was never created
 * reads as Open with closeTime 0, so events can arrive for a market we never indexed. Skip them
 * rather than halt the indexer on that block.
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

// Bets, calls and settlement.
import { indexer } from "envio";
import { countsForReputation, eventId, getTrader, positionId } from "../utils.js";

indexer.onEvent(
  { contract: "Kleos", event: "BetPlaced", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const p = event.params;
    const marketId = p.marketId.toString();
    const [m, trader, existing] = await Promise.all([
      context.Market.getOrThrow(marketId),
      getTrader(context, p.user),
      context.Position.get(positionId(p.marketId, p.user)),
    ]);
    const firstInMarket = !existing;

    context.Market.set({
      ...m,
      yesMoney: m.yesMoney + (p.side ? p.amount : 0n),
      noMoney: m.noMoney + (p.side ? 0n : p.amount),
      yesEff: m.yesEff + (p.side ? p.effective : 0n),
      noEff: m.noEff + (p.side ? 0n : p.effective),
      priceRepYes: p.priceRepYes,
      priceMoneyYes: p.priceMoneyYes,
      betCount: m.betCount + 1,
      bettorCount: m.bettorCount + (firstInMarket ? 1 : 0),
    });

    const pos = existing ?? {
      id: positionId(p.marketId, p.user),
      market_id: marketId,
      trader_id: trader.id,
      yesMoney: 0n,
      noMoney: 0n,
      yesEff: 0n,
      noEff: 0n,
      settled: false,
      payout: 0n,
      bonusWeight: 0n,
      bonus: 0n,
    };
    context.Position.set({
      ...pos,
      yesMoney: pos.yesMoney + (p.side ? p.amount : 0n),
      noMoney: pos.noMoney + (p.side ? 0n : p.amount),
      yesEff: pos.yesEff + (p.side ? p.effective : 0n),
      noEff: pos.noEff + (p.side ? 0n : p.effective),
    });

    context.Trader.set({
      ...trader,
      betCount: trader.betCount + 1,
      volume: trader.volume + p.amount,
      marketCount: trader.marketCount + (firstInMarket ? 1 : 0),
    });

    const id = eventId(event);
    context.Bet.set({
      id,
      market_id: marketId,
      trader_id: trader.id,
      side: p.side,
      amount: p.amount,
      effective: p.effective,
      multiplier: p.multiplier,
      entryPrice: p.entryPrice,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    });
    context.PricePoint.set({
      id,
      market_id: marketId,
      timestamp: event.block.timestamp,
      priceRepYes: p.priceRepYes,
      priceMoneyYes: p.priceMoneyYes,
    });
  },
);

// Emitted right after its BetPlaced, in the same transaction.
indexer.onEvent(
  { contract: "Kleos", event: "CallPosted", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const p = event.params;
    const [m, trader] = await Promise.all([context.Market.getOrThrow(p.marketId.toString()), getTrader(context, p.user)]);
    context.Call.set({
      id: p.callId.toString(), // numbered by Kleos; KleosSocial votes use the same id
      market_id: m.id,
      trader_id: trader.id,
      side: p.side,
      amount: p.amount,
      entryPrice: p.entryPrice,
      text: p.text,
      result: "Open",
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    });
    context.Market.set({ ...m, callCount: m.callCount + 1 });
    context.Trader.set({ ...trader, callCount: trader.callCount + 1 });
  },
);

indexer.onEvent({ contract: "Kleos", event: "Settled" }, async ({ event, context }) => {
  const p = event.params;
  const [m, pos, trader] = await Promise.all([
    context.Market.getOrThrow(p.marketId.toString()),
    context.Position.getOrThrow(positionId(p.marketId, p.user)),
    getTrader(context, p.user),
  ]);
  context.Position.set({ ...pos, settled: true, payout: p.payout, bonusWeight: p.bonusWeight });
  // Mirrors Kleos._settle: the bet counts toward activation only in deep, non-voided markets.
  if (!m.voided && countsForReputation(m)) {
    context.Trader.set({ ...trader, resolvedBets: trader.resolvedBets + 1 });
  }
});

// Anyone can claim for anyone; the bonus belongs to `user`.
indexer.onEvent({ contract: "Kleos", event: "BonusClaimed" }, async ({ event, context }) => {
  const pos = await context.Position.get(positionId(event.params.marketId, event.params.user));
  if (pos) context.Position.set({ ...pos, bonus: pos.bonus + event.params.amount });
});


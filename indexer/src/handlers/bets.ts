// Bets, calls and settlement.
import { indexer } from "envio";
import { SHARP_R, STAKE_REF, countsForReputation, eventId, getProtocol, getTrader, positionId } from "../utils.js";

indexer.onEvent(
  { contract: "Kleos", event: "BetPlaced", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const p = event.params;
    const marketId = p.marketId.toString();
    const [m, trader, existing, protocol] = await Promise.all([
      context.Market.getOrThrow(marketId),
      getTrader(context, p.user),
      context.Position.get(positionId(p.marketId, p.user)),
      getProtocol(context),
    ]);
    const firstInMarket = !existing;
    // The sharp signal counts each trader once per side, by their vested R at the time of the bet.
    const sharp = trader.r >= SHARP_R;
    const newSharpYes = sharp && p.side && !existing?.sharpYes;
    const newSharpNo = sharp && !p.side && !existing?.sharpNo;

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
      sharpYes: m.sharpYes + (newSharpYes ? 1 : 0),
      sharpNo: m.sharpNo + (newSharpNo ? 1 : 0),
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
      bonusClaimed: false,
      sharpYes: false,
      sharpNo: false,
    };
    context.Position.set({
      ...pos,
      yesMoney: pos.yesMoney + (p.side ? p.amount : 0n),
      noMoney: pos.noMoney + (p.side ? 0n : p.amount),
      yesEff: pos.yesEff + (p.side ? p.effective : 0n),
      noEff: pos.noEff + (p.side ? 0n : p.effective),
      sharpYes: pos.sharpYes || newSharpYes,
      sharpNo: pos.sharpNo || newSharpNo,
    });

    context.Trader.set({
      ...trader,
      betCount: trader.betCount + 1,
      volume: trader.volume + p.amount,
      marketCount: trader.marketCount + (firstInMarket ? 1 : 0),
    });
    context.Protocol.set({
      ...protocol,
      betCount: protocol.betCount + 1,
      bettorCount: protocol.bettorCount + (trader.betCount === 0 ? 1 : 0),
      volume: protocol.volume + p.amount,
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
      traderR: trader.r,
      sharp,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      contractAddress: event.srcAddress.toLowerCase(),
    });
    context.PricePoint.set({
      id,
      market_id: marketId,
      timestamp: event.block.timestamp,
      priceRepYes: p.priceRepYes,
      priceMoneyYes: p.priceMoneyYes,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
    });
  },
);

// Emitted right after its BetPlaced, in the same transaction.
indexer.onEvent(
  { contract: "Kleos", event: "CallPosted", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const p = event.params;
    const [m, trader, protocol, earlier] = await Promise.all([
      context.Market.getOrThrow(p.marketId.toString()),
      getTrader(context, p.user),
      getProtocol(context),
      context.CallVote.getWhere({ call_id: { _eq: p.callId.toString() } }),
    ]);
    context.Call.set({
      id: p.callId.toString(), // numbered by Kleos; KleosSocial votes use the same id
      market_id: m.id,
      trader_id: trader.id,
      side: p.side,
      amount: p.amount,
      entryPrice: p.entryPrice,
      text: p.text,
      result: "Open",
      // Votes can come in before the call itself, so start from whatever is already there.
      ups: earlier.filter((v) => v.value > 0).length,
      downs: earlier.filter((v) => v.value < 0).length,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    });
    context.Market.set({ ...m, callCount: m.callCount + 1 });
    context.Trader.set({ ...trader, callCount: trader.callCount + 1 });
    context.Protocol.set({ ...protocol, callCount: protocol.callCount + 1 });
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
  // Mirrors Kleos._settleReputation: only a position of at least $50 (both sides together) in a
  // deep, non-voided market counts toward activation, so it can't be bought with $1 bets.
  if (!pos.settled && !m.voided && countsForReputation(m) && pos.yesMoney + pos.noMoney >= STAKE_REF && trader.resolvedBets !== undefined) {
    // The updated contract saturates uint32 history; older deployments cannot emit an
    // additional successful settlement at the maximum because they revert on overflow.
    const count = trader.resolvedBets < 0xffffffffn ? trader.resolvedBets + 1n : trader.resolvedBets;
    context.Trader.set({ ...trader, resolvedBets: count });
  }
});

// Anyone can claim for anyone; the bonus belongs to `user`.
indexer.onEvent(
  { contract: "Kleos", event: "BonusClaimed", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const p = event.params;
    const [pos, trader] = await Promise.all([
      context.Position.get(positionId(p.marketId, p.user)), getTrader(context, p.user),
    ]);
    context.BonusClaim.set({
      id: positionId(p.marketId, p.user), market_id: p.marketId.toString(), trader_id: trader.id,
      amount: p.amount, eventId: eventId(event), timestamp: event.block.timestamp,
      txHash: event.transaction.hash, blockNumber: event.block.number, logIndex: event.logIndex,
      contractAddress: event.srcAddress.toLowerCase(),
    });
    // No Position is fabricated for a claim made by someone who never bet.
    if (pos) context.Position.set({ ...pos, bonus: p.amount, bonusClaimed: true });
  },
);

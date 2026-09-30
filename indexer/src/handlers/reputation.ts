// Reputation: every change is recorded so anyone can rebuild R and check the math.
import { indexer } from "envio";
import { eventId, getTrader, positionId } from "../utils.js";

indexer.onEvent(
  { contract: "Kleos", event: "ReputationChanged", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const p = event.params;
    const [trader, position] = await Promise.all([
      getTrader(context, p.user),
      p.marketId === 0n ? undefined : context.Position.get(positionId(p.marketId, p.user)),
    ]);
    // marketId 0 = demo seed or admin slash. Otherwise a bet if the trader holds a position here;
    // jurors can never hold one, so the rest is jury duty. (entryPrice 0 alone isn't enough:
    // a bet into an empty side also enters at 0.) Known gap: until Kleos.propose rejects id 0, a
    // court on a phantom market 0 emits jury changes that land here as Admin.
    const kind = p.marketId === 0n ? "Admin" : position ? "Bet" : "Jury";

    context.ReputationChange.set({
      id: eventId(event),
      trader_id: trader.id,
      market_id: p.marketId === 0n ? undefined : p.marketId.toString(),
      kind,
      delta: p.delta,
      newR: p.newR,
      pendingR: p.pendingR,
      entryPrice: p.entryPrice,
      side: p.side,
      outcome: p.outcome,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    });

    // The event carries the resulting R and pending, so take them as-is instead of summing deltas.
    // Right or wrong comes from side vs outcome, not the sign of delta: a loss only takes what the
    // trader has, so at R = 0 it emits delta 0. A trader on both sides gets one of each.
    const right = p.side === p.outcome;
    context.Trader.set({
      ...trader,
      r: p.newR,
      pending: p.pendingR,
      wins: trader.wins + (kind === "Bet" && right ? 1 : 0),
      losses: trader.losses + (kind === "Bet" && !right ? 1 : 0),
    });
  },
);

indexer.onEvent({ contract: "Kleos", event: "Vested" }, async ({ event, context }) => {
  const trader = await getTrader(context, event.params.user);
  context.Trader.set({ ...trader, r: event.params.newR, pending: 0n });
});

indexer.onEvent({ contract: "Kleos", event: "Flagged" }, async ({ event, context }) => {
  const trader = await getTrader(context, event.params.user);
  context.Trader.set({ ...trader, flagged: true });
});

indexer.onEvent({ contract: "Kleos", event: "FlagCleared" }, async ({ event, context }) => {
  const trader = await getTrader(context, event.params.user);
  context.Trader.set({ ...trader, flagged: false });
});

// Reputation: every change is recorded so anyone can rebuild R and check the math.
import { indexer } from "envio";
import { eventId, getTrader, positionId } from "../utils.js";
import { seedHistory } from "../transaction-input.js";
import { getConfiguration } from "../configuration.js";

indexer.onEvent(
  { contract: "Kleos", event: "ReputationChanged", fields: { block: ["timestamp"], transaction: ["hash", "input", "to"] } },
  async ({ event, context }) => {
    const p = event.params;
    const [trader, position, precedingSlash, config] = await Promise.all([
      getTrader(context, p.user),
      p.marketId === 0n ? undefined : context.Position.get(positionId(p.marketId, p.user)),
      p.marketId === 0n && event.logIndex > 0 ? context.Slash.get(`${event.block.number}_${event.logIndex - 1}`) : undefined,
      getConfiguration(context, event.srcAddress),
    ]);
    // marketId 0 = demo seed or admin slash. Otherwise a bet if the trader holds a position here;
    // jurors can never hold one, so the rest is jury duty. (Jury changes also carry entryPrice 0,
    // while bet entry prices are clamped to at least 5%, but the position is the direct test.)
    const kind = p.marketId === 0n ? "Admin" : position ? "Bet" : "Jury";
    const isSlash = precedingSlash?.trader_id === trader.id && precedingSlash.txHash === event.transaction.hash;
    const count = p.marketId === 0n && !isSlash ? seedHistory(event) : undefined;
    const adminAction = p.marketId !== 0n ? undefined : isSlash ? "Slash" : count !== undefined ? "Seed" : "Unknown";
    const history = p.marketId !== 0n || isSlash ? trader.resolvedBets : count;
    const historySource = p.marketId !== 0n || isSlash ? trader.resolvedBetsSource : count !== undefined ? "DirectInput" : "Unknown";
    // Every winning-side bet resets the deadline, even a zero gain. Jury penalties and
    // seed/slash calls do not. Vested deliberately leaves the deadline in storage.
    const right = p.side === p.outcome;
    const resetsDeadline = (kind === "Bet" && right) || (kind === "Jury" && p.delta > 0n);
    const vestAt = resetsDeadline
      ? config.vestPeriod === undefined ? undefined : (BigInt(event.block.timestamp) + config.vestPeriod) & 0xffffffffffffffffn
      : trader.vestAt;
    const vestAtSource = resetsDeadline
      ? config.source === "DirectCreation" ? "DirectCreation" : config.source === "PinnedSnapshot" ? "PinnedSnapshot" : "Unknown"
      : trader.vestAtSource;

    context.ReputationChange.set({
      id: eventId(event),
      trader_id: trader.id,
      market_id: p.marketId === 0n ? undefined : p.marketId.toString(),
      kind,
      adminAction,
      resolvedBets: count,
      delta: p.delta,
      newR: p.newR,
      pendingR: p.pendingR,
      entryPrice: p.entryPrice,
      side: p.side,
      outcome: p.outcome,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      contractAddress: event.srcAddress.toLowerCase(),
    });

    // The event carries the resulting R and pending, so take them as-is instead of summing deltas.
    // Right or wrong comes from side vs outcome, not the sign of delta: a loss only takes what the
    // trader has, so at R = 0 it emits delta 0. A trader on both sides gets one of each.
    context.Trader.set({
      ...trader,
      r: p.newR,
      pending: p.pendingR,
      resolvedBets: history,
      resolvedBetsSource: historySource,
      vestAt,
      vestAtSource,
      lastGainAt: resetsDeadline ? event.block.timestamp : trader.lastGainAt,
      wins: trader.wins + (kind === "Bet" && right ? 1 : 0),
      losses: trader.losses + (kind === "Bet" && !right ? 1 : 0),
    });
  },
);

indexer.onEvent(
  { contract: "Kleos", event: "Vested", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const trader = await getTrader(context, event.params.user);
    context.Trader.set({ ...trader, r: event.params.newR, pending: 0n });
    context.Vesting.set({
      id: eventId(event), trader_id: trader.id, amount: event.params.amount, newR: event.params.newR,
      timestamp: event.block.timestamp, txHash: event.transaction.hash,
      blockNumber: event.block.number, logIndex: event.logIndex, contractAddress: event.srcAddress.toLowerCase(),
    });
  },
);

indexer.onEvent({ contract: "Kleos", event: "Flagged" }, async ({ event, context }) => {
  const trader = await getTrader(context, event.params.user);
  context.Trader.set({ ...trader, flagged: true });
});

indexer.onEvent({ contract: "Kleos", event: "FlagCleared" }, async ({ event, context }) => {
  const trader = await getTrader(context, event.params.user);
  context.Trader.set({ ...trader, flagged: false });
});

// Followed by a ReputationChanged with marketId 0, which sets R and pending.
indexer.onEvent({ contract: "Kleos", event: "Slashed", fields: { transaction: ["hash"] } }, async ({ event, context }) => {
  const trader = await getTrader(context, event.params.user);
  context.Trader.set({ ...trader, slashed: trader.slashed + event.params.amount });
  context.Slash.set({ id: eventId(event), trader_id: trader.id, amount: event.params.amount, txHash: event.transaction.hash });
});

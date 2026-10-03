// Kleos Court: the juror pool, jury draws, hidden commits, reveals and verdicts.
import { indexer, type EvmOnEventContext, type CourtRound, type JurorVote } from "envio";
import { addressId, getProtocol, getTrader, roundId, seatId } from "../utils.js";
import { voteCommitment } from "../transaction-input.js";

const VOTE_YES = 1;
const VOTE_NO = 2;

async function setPoolMembership(context: EvmOnEventContext, juror: string, isJuror: boolean) {
  const [trader, protocol] = await Promise.all([getTrader(context, juror), getProtocol(context)]);
  // joinCourt emits nothing for a member who joins again, and leaveCourt nothing for a non-member,
  // so every event is a real change. The check only guards the count against surprises.
  if (trader.isJuror === isJuror) return;
  context.Trader.set({ ...trader, isJuror });
  context.Protocol.set({ ...protocol, jurorCount: protocol.jurorCount + (isJuror ? 1 : -1) });
}

indexer.onEvent({ contract: "Kleos", event: "JurorJoined" }, async ({ event, context }) => {
  await setPoolMembership(context, event.params.juror, true);
});

indexer.onEvent({ contract: "Kleos", event: "JurorLeft" }, async ({ event, context }) => {
  await setPoolMembership(context, event.params.juror, false);
});

// Anyone can remove a member who fell below tier V or got flagged.
indexer.onEvent({ contract: "Kleos", event: "JurorPruned" }, async ({ event, context }) => {
  await setPoolMembership(context, event.params.juror, false);
});

// Emitted by dispute (round 1) and by closeCourt's redraw (round 2). A dispute that draws fewer
// than 3 jurors reverts, so every drawn round is real.
indexer.onEvent(
  { contract: "Kleos", event: "JuryDrawn", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const { marketId, round, jurors } = event.params;
    const m = await context.Market.get(marketId.toString());
    if (!m) return;
    const id = roundId(marketId, round);
    context.Market.set({ ...m, courtRound: Number(round) });
    context.CourtRound.set({
      id,
      market_id: m.id,
      round: Number(round),
      jurors: jurors.map(addressId),
      drawnAt: event.block.timestamp,
      commits: 0,
      commitEvents: 0,
      reveals: 0,
      yes: 0,
      no: 0,
      ambiguous: 0,
      verdict: undefined,
      failed: false,
    });
    // Loaded together so Envio can batch the reads; a juror sits at most once per round.
    const traders = await Promise.all(jurors.map((juror) => getTrader(context, juror)));
    for (const trader of traders) {
      context.Trader.set({ ...trader, juryDuties: trader.juryDuties + 1 });
      context.JurorVote.set({
        id: seatId(marketId, round, trader.id), round_id: id, juror_id: trader.id,
        committed: false, commitment: undefined, commitmentSource: "Genesis", vote: 0,
      });
    }
  },
);

async function currentCommits(context: EvmOnEventContext, round: CourtRound, updated: JurorVote) {
  const seats = await context.JurorVote.getWhere({ round_id: { _eq: round.id } });
  const states = seats.map((s) => s.id === updated.id ? updated.committed : s.committed);
  return states.some((s) => s === undefined) ? undefined : states.filter((s) => s === true).length;
}

// A juror can replace a commitment, including replacing it with zero in the deployed contract.
// This counts current nonzero storage, rather than assuming every event means "committed".
indexer.onEvent({ contract: "Kleos", event: "VoteCommitted", fields: { transaction: ["input", "to", "from"] } }, async ({ event, context }) => {
  const { marketId, round, juror } = event.params;
  const [seat, r] = await Promise.all([
    context.JurorVote.get(seatId(marketId, round, juror)),
    context.CourtRound.get(roundId(marketId, round)),
  ]);
  if (!seat || !r) return;
  const commitment = voteCommitment(event);
  const updated: JurorVote = {
    ...seat, commitment, committed: commitment === undefined ? undefined : BigInt(commitment) !== 0n,
    commitmentSource: commitment === undefined ? "Unknown" : "DirectInput",
  };
  const commits = await currentCommits(context, r, updated);
  context.JurorVote.set(updated);
  context.CourtRound.set({ ...r, commits, commitEvents: r.commitEvents + 1 });
});

indexer.onEvent({ contract: "Kleos", event: "VoteRevealed" }, async ({ event, context }) => {
  const { marketId, round, juror, vote } = event.params;
  const [seat, r] = await Promise.all([
    context.JurorVote.get(seatId(marketId, round, juror)),
    context.CourtRound.get(roundId(marketId, round)),
  ]);
  if (!seat || !r) return;
  const v = Number(vote);
  const updated: JurorVote = {
    ...seat, vote: v, committed: true,
    commitmentSource: seat.commitmentSource === "DirectInput" ? "DirectInput" : "Reveal",
  };
  const commits = await currentCommits(context, r, updated);
  context.JurorVote.set(updated);
  context.CourtRound.set({
    ...r,
    commits,
    reveals: r.reveals + 1,
    yes: r.yes + (v === VOTE_YES ? 1 : 0),
    no: r.no + (v === VOTE_NO ? 1 : 0),
    ambiguous: r.ambiguous + (v !== VOTE_YES && v !== VOTE_NO ? 1 : 0),
  });
});

// No verdict this round: a fresh jury is drawn (JuryDrawn follows in the same transaction).
indexer.onEvent({ contract: "Kleos", event: "CourtRedrawn" }, async ({ event, context }) => {
  const r = await context.CourtRound.get(roundId(event.params.marketId, event.params.failedRound));
  if (r) context.CourtRound.set({ ...r, failed: true });
});

// MarketResolved (YES/NO) or MarketVoided (AMBIGUOUS) follows in the same transaction.
indexer.onEvent({ contract: "Kleos", event: "Verdict" }, async ({ event, context }) => {
  const { marketId, round, vote } = event.params;
  const [m, r] = await Promise.all([context.Market.get(marketId.toString()), context.CourtRound.get(roundId(marketId, round))]);
  if (m) context.Market.set({ ...m, verdict: Number(vote) });
  if (r) context.CourtRound.set({ ...r, verdict: Number(vote) });
});

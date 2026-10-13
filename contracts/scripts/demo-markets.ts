export const DEMO_MARKETS = [
  ["Demo: BTC closes above $120K at the deadline?", 1, "Chainlink BTC/USD", "YES if the stated BTC/USD feed is above 120,000 at this market's UTC close time.", 30 * 86400],
  ["Demo: Monad passes 10M daily transactions before the deadline?", 3, "Monadscan daily tx count", "YES if Monadscan reports a UTC day above 10,000,000 transactions after creation and before this market closes.", 60 * 86400],
  ["Demo: home side wins the next announced derby?", 2, "Official league result", "Demo placeholder. Specify the league, teams and fixture before using real stakes. YES means a home win in regular time.", 7 * 86400],
  ["Demo: ETH closes above $5K at the deadline?", 1, "Chainlink ETH/USD", "YES if the stated ETH/USD feed is above 5,000 at this market's UTC close time.", 90 * 86400],
  ["Demo: next announced demo day draws over 500 attendees?", 4, "Organizer check-in count", "Demo placeholder. Specify the event and organizer before using real stakes. YES means a published check-in count above 500.", 14 * 86400],
  ["Demo: an open-weights model tops the text leaderboard at the deadline?", 3, "LMArena text leaderboard", "YES if a model with publicly released weights is ranked #1 on the stated text leaderboard at this market's UTC close time.", 60 * 86400],
] as const;

export function demoCloseTimes(baseTimestamp: bigint): bigint[] {
  if (baseTimestamp <= 0n) throw new Error("Demo market base timestamp must be positive.");
  return DEMO_MARKETS.map((market) => baseTimestamp + BigInt(market[4]));
}

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Demo markets from the Kleos design. Category ids: 1 Crypto, 2 Sports, 3 Tech, 4 Culture.
const DAY = 86_400n;
const now = BigInt(Math.floor(Date.now() / 1000));

const MARKETS: [string, number, string, string, bigint][] = [
  ["BTC closes above $120K on Oct 31?", 1, "Chainlink BTC/USD",
    "YES if the Chainlink BTC/USD feed reads above 120,000 at 23:59 UTC on Oct 31.", now + 30n * DAY],
  ["Monad mainnet passes 10M daily transactions by December?", 3, "Monadscan daily tx count",
    "YES if Monadscan shows any UTC day with more than 10,000,000 transactions before Dec 1.", now + 60n * DAY],
  ["Home side wins Sunday's derby?", 2, "Official league result",
    "YES if the home side wins in regular time, per the league's official result.", now + 2n * DAY],
  ["ETH above $5K before year end?", 1, "Chainlink ETH/USD",
    "YES if the Chainlink ETH/USD feed reads above 5,000 at any point before Dec 31, 23:59 UTC.", now + 90n * DAY],
  ["Demo day draws more than 500 attendees?", 4, "Organizer check-in count",
    "YES if the organizer's published check-in count is above 500.", now + 1n * DAY],
  ["An open-weights model tops the main leaderboard by November?", 3, "LMArena text leaderboard",
    "YES if a model with public weights is ranked #1 on the LMArena text leaderboard on Nov 30.", now + 45n * DAY],
];

export default buildModule("KleosModule", (m) => {
  // Demo timings: 2-minute dispute window, 5-minute vesting, 3-minute court phases. Production would use days.
  const disputeWindow = m.getParameter("disputeWindow", 120n);
  const vestPeriod = m.getParameter("vestPeriod", 300n);
  const nMin = m.getParameter("nMin", 10n);
  const courtPeriod = m.getParameter("courtPeriod", 180n); // 3 min to commit, 3 min to reveal

  const usd = m.contract("KleosUSD");
  const kleos = m.contract("Kleos", [usd, disputeWindow, vestPeriod, nMin, courtPeriod]);

  MARKETS.forEach(([question, category, oracle, criteria, closeTime], i) => {
    m.call(kleos, "createMarket", [question, category, oracle, criteria, closeTime], { id: `market_${i + 1}` });
  });

  return { usd, kleos };
});

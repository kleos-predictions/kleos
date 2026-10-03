import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// The module has no wall-clock-dependent futures. `seed-demo.ts` creates demo markets from
// a persisted chain timestamp, so a fresh deployment remains valid after old demo deadlines.

export default buildModule("KleosModule", (m) => {
  // Demo timings: 2-minute dispute window, 5-minute vesting, 3-minute court phases. Production would use days.
  const disputeWindow = m.getParameter("disputeWindow", 120n);
  const vestPeriod = m.getParameter("vestPeriod", 300n);
  const nMin = m.getParameter("nMin", 10n);
  const courtPeriod = m.getParameter("courtPeriod", 180n); // 3 min to commit, 3 min to reveal

  const usd = m.contract("KleosUSD");
  const kleos = m.contract("Kleos", [usd, disputeWindow, vestPeriod, nMin, courtPeriod]);
  m.call(usd, "setMarket", [kleos]); // first bets skip the approval transaction

  const social = m.contract("KleosSocial");

  return { usd, kleos, social };
});

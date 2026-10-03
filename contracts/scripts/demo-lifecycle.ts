// The same orchestration is used by the seeder and offline crash/restart tests.
import { DemoJournal, type Receipt } from "./demo-journal.ts";

export type DemoResolutionMarket = {
  state: number; closeTime: bigint; proposedAt: bigint; proposer: string;
  proposedOutcome: boolean; evidenceHash: string; evidenceURI: string;
  outcome: boolean; voided: boolean;
};

export type DemoProposal = { proposer: string; outcome: boolean; evidenceHash: string; evidenceURI: string };

function verifyProposal(market: DemoResolutionMarket, expected: DemoProposal) {
  if (market.proposer.toLowerCase() !== expected.proposer.toLowerCase() || market.proposedOutcome !== expected.outcome ||
      market.evidenceHash.toLowerCase() !== expected.evidenceHash.toLowerCase() || market.evidenceURI !== expected.evidenceURI) {
    throw new Error("Resolved demo proposal differs from its planned proposer, outcome or evidence. Stop and reconcile the external change.");
  }
}

/** Reconcile the journal before deciding that a later contract state makes an action skippable.
 * Re-read after each wait: an external dispute or resolution can change the state meanwhile. */
export async function resumeDemoResolution<R extends Receipt>(journal: DemoJournal, key: string, expected: DemoProposal, actions: {
  wait: (hash: `0x${string}`) => Promise<R>;
  readMarket: () => Promise<DemoResolutionMarket>;
  waitUntil: (timestamp: bigint) => Promise<void>;
  disputeWindow: () => Promise<bigint>;
  propose: () => Promise<unknown>;
  finalize: () => Promise<unknown>;
}): Promise<DemoResolutionMarket> {
  await journal.reconcile(`${key}:propose`, actions.wait);
  await journal.reconcile(`${key}:finalize`, actions.wait);
  let market = await actions.readMarket();
  if (market.state === 0) {
    await actions.waitUntil(market.closeTime);
    market = await actions.readMarket();
    if (market.state === 0) {
      await actions.propose();
      market = await actions.readMarket();
    }
  }
  if (market.state === 1) {
    verifyProposal(market, expected);
    await actions.waitUntil(market.proposedAt + await actions.disputeWindow());
    market = await actions.readMarket();
    if (market.state === 1) {
      verifyProposal(market, expected);
      await actions.finalize();
      market = await actions.readMarket();
    }
  }
  if (market.state !== 3) throw new Error("Resolved demo was disputed or is not resolved; let its court resolve. Do not overwrite it.");
  verifyProposal(market, expected);
  if (market.voided || market.outcome !== expected.outcome) throw new Error("Resolved demo outcome differs from its planned non-void outcome. Stop and reconcile it.");
  return market;
}

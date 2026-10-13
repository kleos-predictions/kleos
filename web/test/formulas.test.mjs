import test from "node:test";
import assert from "node:assert/strict";
import { reputationDelta, reputationFormula, explainChange } from "../src/lib/math.ts";
import { tierOfWad } from "../src/lib/tiers.ts";
import { linearPath, stepPath } from "../src/lib/path.ts";
import { whaleScenario } from "../src/lib/whale-scenario.ts";

test("expected applied gain respects the cap and zero floor", () => {
  const gain = reputationDelta(true, .1, 50), loss = -reputationDelta(false, .1, 50);
  assert.equal(gain, .8);
  assert.ok(Math.abs(.15 * gain - .85 * loss + .0075) < 1e-12, "the former positive-edge example is negative after the cap");
  assert.equal(.5 * reputationDelta(true, .5, 50) - .5 * Math.min(0, -reputationDelta(false, .5, 50)), .25, "a zero-R account has no available loss");
});
test("entry clamps and explanatory equalities match the applied formula", () => {
  assert.equal(reputationDelta(true, 0, 50), .8);
  assert.ok(Math.abs(reputationDelta(false, 1, 50) + 1.425) < 1e-12);
  assert.match(reputationFormula(true, .1, 50), /min\(.+0\.8\)/);
  assert.match(reputationFormula(false, .3, 50), /= −1.5/);
  assert.match(explainChange({ marketId: 0, delta: 0, entryPrice: 0, kind: "vest" }), /not a new gain/);
  assert.match(explainChange({ marketId: 1, delta: 0, entryPrice: .5, isBet: true, side: false, outcome: true }), /floor/);
});
test("live tier thresholds stay exact one wei below every boundary", () => {
  for (const [index, r] of [1n,4n,9n,16n,36n].entries()) {
    assert.equal(tierOfWad(r*10n**18n - 1n), index);
    assert.equal(tierOfWad(r*10n**18n), index+1);
  }
});
test("the teaching replay shows sequential unequal bonuses and depth rollover", () => {
  const standard = whaleScenario(2000,20,80,16);
  assert.equal(standard.principal, 177);
  assert.equal(standard.bonusPool, 40);
  assert.equal(Math.round(standard.moneyYes*100),44);
  assert.equal(Math.round(standard.repYes*100),71);
  assert.ok(standard.minBonus < standard.maxBonus);
  assert.ok(standard.minTotal > 178 && standard.maxTotal < 181);
  const thin = whaleScenario(2000,1,80,16);
  assert.equal(thin.principal,2020);
  assert.equal(thin.maxBonus,0);
  assert.equal(thin.rollover,40);
});
test("observed charts use bounded line segments and discrete event steps", () => {
  assert.equal(linearPath([[0,0],[1,1],[2,0]]),"M0.0 0.0 L1.0 1.0 L2.0 0.0");
  assert.equal(stepPath([[0,0],[1,1],[1,0]]),"M0.0 0.0 H1.0 V1.0 H1.0 V0.0");
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { keccak256, maxUint256, parseEther, parseUnits, toHex, zeroAddress, zeroHash, getAddress, type Address } from "viem";

const { viem, networkHelpers } = await network.create();

const usd = (n: number) => parseUnits(String(n), 6);
const wad = (n: number) => parseEther(String(n));
const DISPUTE_WINDOW = 120n;
const VEST_PERIOD = 300n;
const N_MIN = 10;
const COURT_PERIOD = 60n;
const EVIDENCE = keccak256(toHex("official result page"));

async function deploy() {
  const wallets = await viem.getWalletClients();
  const token = await viem.deployContract("KleosUSD");
  const kleos = await viem.deployContract("Kleos", [token.address, DISPUTE_WINDOW, VEST_PERIOD, BigInt(N_MIN), COURT_PERIOD]);
  const now = BigInt(await networkHelpers.time.latest());
  const closeTime = now + 3600n;
  await kleos.write.createMarket([
    "BTC closes above $120K on Oct 31?",
    1,
    "Chainlink BTC/USD",
    "YES if the Chainlink BTC/USD price is above 120,000 at 23:59 UTC on Oct 31",
    closeTime,
  ]);

  for (const w of wallets) {
    await token.write.faucet({ account: w.account });
    await token.write.approve([kleos.address, maxUint256], { account: w.account });
  }

  // The last wallet never bets and has earned enough reputation to resolve.
  const resolver = wallets[wallets.length - 1];
  await kleos.write.seedReputation([resolver.account.address, wad(5), N_MIN]);

  async function resolve(outcome: boolean) {
    await networkHelpers.time.increaseTo(closeTime);
    await kleos.write.propose([1n, outcome, EVIDENCE, "https://example.com/result"], { account: resolver.account });
    await networkHelpers.time.increase(DISPUTE_WINDOW);
    await kleos.write.finalize([1n]);
  }

  async function settleAll() {
    await kleos.write.settle([1n, await kleos.read.getBettors([1n])]);
  }

  return { wallets, token, kleos, closeTime, resolver, resolve, settleAll };
}

type Ctx = Awaited<ReturnType<typeof deploy>>;

/** Ten crowd wallets set the YES price (as a %) with $1,000 total, so the market is deep enough to count. */
async function crowdAt(ctx: Ctx, yesPct: number) {
  const crowd = ctx.wallets.slice(1, 11);
  for (const [i, w] of crowd.entries()) {
    const yes = i < 5;
    const amount = (yes ? yesPct * 10 : (100 - yesPct) * 10) / 5;
    await ctx.kleos.write.bet([1n, yes, usd(amount)], { account: w.account });
  }
}

const rep = async (ctx: Ctx, a: Address) => ctx.kleos.read.reputation([a]);
const asNumber = (x: bigint) => Number(x) / 1e18;

describe("multiplier", () => {
  it("M = min(1 + 0.5·√R, 5) matches the pitch table", async () => {
    const { kleos } = await deploy();
    assert.equal(await kleos.read.multiplier([0n]), wad(1));
    assert.equal(await kleos.read.multiplier([wad(4)]), wad(2));
    assert.equal(await kleos.read.multiplier([wad(16)]), wad(3));
    assert.equal(await kleos.read.multiplier([wad(64)]), wad(5));
    assert.equal(await kleos.read.multiplier([wad(400)]), wad(5), "capped at 5×");
  });

  it("stays 1.0 below N_MIN resolved bets", async () => {
    const { kleos, wallets } = await deploy();
    const a = wallets[1].account.address;
    await kleos.write.seedReputation([a, wad(16), N_MIN - 1]);
    assert.equal(await kleos.read.multiplierOf([a]), wad(1));
    await kleos.write.seedReputation([a, wad(16), N_MIN]);
    assert.equal(await kleos.read.multiplierOf([a]), wad(3));
  });
});

describe("pitch demo: one whale vs 20 sharps", () => {
  it("prices, principal, bonus and conservation", async () => {
    const ctx = await deploy();
    const { wallets, token, kleos, resolve, settleAll } = ctx;
    const whale = wallets[1];
    const sharps = wallets.slice(2, 22);
    for (const s of sharps) await kleos.write.seedReputation([s.account.address, wad(16), N_MIN]);

    // Whale needs $2,000: top up with the owner's faucet money.
    await token.write.transfer([whale.account.address, usd(1000)]);
    await kleos.write.bet([1n, false, usd(2000)], { account: whale.account });
    for (const s of sharps) await kleos.write.bet([1n, true, usd(80)], { account: s.account });

    const [repYes, moneyYes] = await kleos.read.prices([1n]);
    assert.equal(Math.round(Number(moneyYes) / 1e16), 44, "money only: 1,600 / 3,600");
    assert.equal(Math.round(Number(repYes) / 1e16), 71, "reputation: 4,800 / 6,800");

    await resolve(true);
    const before = await Promise.all(sharps.map((s) => token.read.balanceOf([s.account.address])));
    await settleAll();
    const afterSettle = await Promise.all(sharps.map((s) => token.read.balanceOf([s.account.address])));

    // Principal: $80 + (80 / 1,600) · ($2,000 − 2% bonus fee − 1% protocol fee) = $177, identical for every sharp.
    for (let i = 0; i < sharps.length; i++) assert.equal(afterSettle[i] - before[i], usd(177));

    const pay = await kleos.read.payouts([1n]);
    assert.equal(pay[0], usd(40), "2% of the losing pool funds the bonus");
    assert.equal(pay[3], true, "bonus opens once everyone is settled");

    let bonusTotal = 0n;
    for (const s of sharps) {
      const b0 = await token.read.balanceOf([s.account.address]);
      await kleos.write.claimBonus([1n, s.account.address]);
      bonusTotal += (await token.read.balanceOf([s.account.address])) - b0;
    }
    // Bonuses sum to the pool (minus rounding dust); each sharp ends near $180.
    assert.ok(usd(40) - bonusTotal < 20n, `bonus dust ${usd(40) - bonusTotal}`);
    // 1% of the losing pool stays as protocol revenue; everything else was paid out.
    assert.equal(await kleos.read.protocolRevenue(), usd(20));
    const leftover = (await token.read.balanceOf([kleos.address])) - usd(20);
    assert.ok(leftover < 40n, `money paid + fees == money staked (dust ${leftover})`);
    const treasury = wallets[29].account.address;
    const t0 = await token.read.balanceOf([treasury]);
    await kleos.write.withdrawRevenue([treasury]);
    assert.equal((await token.read.balanceOf([treasury])) - t0, usd(20), "revenue reaches the treasury");
    await assert.rejects(kleos.write.withdrawRevenue([treasury], { account: whale.account }), /NotOwner/);

    // The whale had R = 0 and stays at 0; sharps' gains are pending until they vest.
    assert.equal((await rep(ctx, whale.account.address)).r, 0n);
    assert.ok((await rep(ctx, sharps[0].account.address)).pending > 0n);
  });
});

describe("payout v2", () => {
  it("a newcomer and a sharp get the same principal per dollar", async () => {
    const ctx = await deploy();
    const { wallets, token, kleos, resolve, settleAll } = ctx;
    await crowdAt(ctx, 50);
    const [newcomer, sharp] = [wallets[12], wallets[13]];
    await kleos.write.seedReputation([sharp.account.address, wad(64), N_MIN]);
    await kleos.write.bet([1n, true, usd(80)], { account: newcomer.account });
    await kleos.write.bet([1n, true, usd(80)], { account: sharp.account });

    await resolve(true);
    const [n0, s0] = await Promise.all([newcomer, sharp].map((w) => token.read.balanceOf([w.account.address])));
    await settleAll();
    const [n1, s1] = await Promise.all([newcomer, sharp].map((w) => token.read.balanceOf([w.account.address])));
    assert.equal(n1 - n0, s1 - s0);

    // …but the sharp's bonus weight is ΔR · M, so it takes the larger bonus share.
    const sharpBonus = await kleos.read.bonusOf([1n, sharp.account.address]);
    const newcomerBonus = await kleos.read.bonusOf([1n, newcomer.account.address]);
    assert.ok(sharpBonus > newcomerBonus);
  });

  it("sponsorship adds to the bonus pool", async () => {
    const ctx = await deploy();
    await crowdAt(ctx, 50);
    await ctx.kleos.write.sponsor([1n, usd(100)], { account: ctx.wallets[20].account });
    assert.equal((await ctx.kleos.read.payouts([1n]))[0], usd(100));
  });

  it("rolls the bonus over to the global pool when no one earns reputation", async () => {
    const ctx = await deploy();
    // Two bettors: too shallow for reputation, so nobody has bonus weight.
    await ctx.kleos.write.bet([1n, true, usd(100)], { account: ctx.wallets[1].account });
    await ctx.kleos.write.bet([1n, false, usd(100)], { account: ctx.wallets[2].account });
    await ctx.resolve(true);
    await ctx.settleAll();
    assert.equal(await ctx.kleos.read.globalBonusPool(), usd(2));
  });
});

describe("reputation update", () => {
  async function playOne(yesPct: number, outcome: boolean) {
    const ctx = await deploy();
    await crowdAt(ctx, yesPct);
    const user = ctx.wallets[12];
    const a = user.account.address;
    await ctx.kleos.write.seedReputation([a, wad(10), N_MIN]);
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: user.account });
    await ctx.resolve(outcome);
    await ctx.kleos.write.settle([1n, [a]]);
    const r = await rep(ctx, a);
    return { ctx, a, r, gain: asNumber(r.pending), change: asNumber(r.r) - 10 };
  }

  it("right against the crowd at 30% → +0.70, pending", async () => {
    const { gain, change } = await playOne(30, true);
    assert.equal(gain.toFixed(2), "0.70");
    assert.equal(change, 0, "gains wait to vest");
  });
  it("right with the crowd at 95% → +0.05", async () => {
    assert.equal((await playOne(95, true)).gain.toFixed(2), "0.05");
  });
  it("wrong at 30% → −0.45, immediately", async () => {
    assert.equal((await playOne(30, false)).change.toFixed(2), "-0.45");
  });
  it("wrong at 95% → −1.43, immediately", async () => {
    assert.equal((await playOne(95, false)).change.toFixed(2), "-1.43");
  });

  it("caps the gain from a single market", async () => {
    // At 5% the uncapped gain would be 0.95.
    assert.equal((await playOne(5, true)).gain, 0.8);
  });

  it("vests only after the vesting period", async () => {
    const { ctx, a } = await playOne(30, true);
    await assert.rejects(ctx.kleos.write.vest([a]));
    await networkHelpers.time.increase(VEST_PERIOD);
    await ctx.kleos.write.vest([a]);
    const r = await rep(ctx, a);
    assert.equal(asNumber(r.r).toFixed(2), "10.70");
    assert.equal(r.pending, 0n);
  });

  async function twoWins(flagged = false) {
    const ctx = await deploy();
    const user = ctx.wallets[12];
    await ctx.kleos.write.createMarket(["Second objective result", 1, "Official result", "YES if the result is positive", ctx.closeTime]);
    await crowdAt(ctx, flagged ? 5 : 30);
    for (const [i, w] of ctx.wallets.slice(1, 11).entries()) {
      await ctx.kleos.write.bet([2n, i < 5, usd(i < 5 ? 60 : 140)], { account: w.account });
    }
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: user.account });
    await ctx.kleos.write.bet([2n, true, usd(50)], { account: user.account });
    await ctx.resolve(true);
    await ctx.kleos.write.propose([2n, true, EVIDENCE, "https://example.com/second"], { account: ctx.resolver.account });
    await networkHelpers.time.increase(DISPUTE_WINDOW);
    await ctx.kleos.write.finalize([2n]);
    await ctx.kleos.write.settle([1n, [user.account.address]]);
    return { ctx, user };
  }

  it("a new gain preserves an already matured pending balance", async () => {
    const { ctx, user } = await twoWins();
    const before = await rep(ctx, user.account.address);
    assert.equal(before.pending, wad(0.7));
    await networkHelpers.time.increaseTo(before.vestAt);
    await ctx.kleos.write.settle([2n, [user.account.address]]);
    const after = await rep(ctx, user.account.address);
    assert.equal(after.r, wad(0.7), "old gain is vested before the new gain is added");
    assert.equal(after.pending, wad(0.7), "only the new gain waits");
    assert.equal(after.vestAt, BigInt(await networkHelpers.time.latest()) + VEST_PERIOD);
  });

  it("a new gain cannot prematurely release immature pending reputation", async () => {
    const { ctx, user } = await twoWins();
    await ctx.kleos.write.settle([2n, [user.account.address]]);
    const after = await rep(ctx, user.account.address);
    assert.equal(after.r, 0n);
    assert.equal(after.pending, wad(1.4));
    await assert.rejects(ctx.kleos.write.vest([user.account.address]), /StillVesting/);
  });

  it("automatic maturation cannot bypass a flagged balance", async () => {
    const { ctx, user } = await twoWins(true);
    const before = await rep(ctx, user.account.address);
    assert.equal(before.flagged, true);
    await networkHelpers.time.increaseTo(before.vestAt);
    await ctx.kleos.write.settle([2n, [user.account.address]]);
    const after = await rep(ctx, user.account.address);
    assert.equal(after.r, 0n);
    assert.equal(after.pending, wad(1.5));
    assert.equal(after.flagged, true);
    await networkHelpers.time.increase(VEST_PERIOD);
    await assert.rejects(ctx.kleos.write.vest([user.account.address]), /UnderReview/);
  });

  it("the activation counter saturates without blocking principal settlement", async () => {
    const ctx = await deploy();
    await crowdAt(ctx, 50);
    const user = ctx.wallets[12];
    await ctx.kleos.write.seedReputation([user.account.address, wad(1), 4294967295]);
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: user.account });
    await ctx.resolve(true);
    await ctx.kleos.write.settle([1n, [user.account.address]]);
    assert.equal((await rep(ctx, user.account.address)).resolvedBets, 4294967295);
    assert.equal(await ctx.kleos.read.settled([1n, user.account.address]), true);
  });

  it("losses beyond R come out of pending gains", async () => {
    const ctx = await deploy();
    await crowdAt(ctx, 30);
    const user = ctx.wallets[12];
    const a = user.account.address;
    // Win $50 on YES at 30% (+0.70 pending) and lose $50 on NO at 70% (−1.05) in the same market.
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: user.account });
    await ctx.kleos.write.bet([1n, false, usd(50)], { account: user.account });
    await ctx.resolve(true);
    await ctx.kleos.write.settle([1n, [a]]);
    const r = await rep(ctx, a);
    assert.equal(r.r, 0n);
    assert.equal(r.pending, 0n, "the loss ate the pending gain instead of hitting the floor");
  });

  it("does not move in shallow markets", async () => {
    const ctx = await deploy();
    const [a, b] = [ctx.wallets[1], ctx.wallets[2]];
    await ctx.kleos.write.bet([1n, true, usd(500)], { account: a.account });
    await ctx.kleos.write.bet([1n, false, usd(500)], { account: b.account });
    await ctx.resolve(true);
    await ctx.settleAll();
    const r = await rep(ctx, a.account.address);
    assert.equal(r.pending, 0n);
    assert.equal(r.resolvedBets, 0);
  });
});

describe("anomaly flag", () => {
  it("flags a new account that wins a big long shot, blocks vesting until cleared", async () => {
    const ctx = await deploy();
    await crowdAt(ctx, 5);
    const insider = ctx.wallets[12];
    const a = insider.account.address;
    await ctx.kleos.write.bet([1n, true, usd(100)], { account: insider.account });
    await ctx.resolve(true);
    await ctx.kleos.write.settle([1n, [a]]);
    assert.equal((await rep(ctx, a)).flagged, true);

    await networkHelpers.time.increase(VEST_PERIOD);
    await assert.rejects(ctx.kleos.write.vest([a]));
    await ctx.kleos.write.clearFlag([a]);
    await ctx.kleos.write.vest([a]);
    assert.ok((await rep(ctx, a)).r > 0n);
  });

  it("admin can slash, pending first", async () => {
    const ctx = await deploy();
    await crowdAt(ctx, 30);
    const u = ctx.wallets[12];
    const a = u.account.address;
    await ctx.kleos.write.seedReputation([a, wad(2), N_MIN]);
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: u.account });
    await ctx.resolve(true);
    await ctx.kleos.write.settle([1n, [a]]);
    await ctx.kleos.write.slash([a, wad(1)]);
    const r = await rep(ctx, a);
    assert.equal(r.pending, 0n);
    assert.equal(asNumber(r.r).toFixed(2), "1.70");
  });
});

describe("markets and resolution", () => {
  it("rejects categories that are not on the allowlist", async () => {
    const { kleos } = await deploy();
    await assert.rejects(kleos.write.createMarket(["Will the army move?", 9, "x", "x", 9_999_999_999n]));
    await kleos.write.addCategory([5, "Science"]);
    await kleos.write.createMarket(["Will the probe land?", 5, "x", "x", 9_999_999_999n]);
  });

  it("bettors and unproven accounts cannot resolve", async () => {
    const ctx = await deploy();
    const bettor = ctx.wallets[1];
    await ctx.kleos.write.seedReputation([bettor.account.address, wad(10), N_MIN]);
    await ctx.kleos.write.bet([1n, true, usd(10)], { account: bettor.account });
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await assert.rejects(ctx.kleos.write.propose([1n, true, EVIDENCE, ""], { account: bettor.account }), /NotEligibleResolver/);
    await assert.rejects(ctx.kleos.write.propose([1n, true, EVIDENCE, ""], { account: ctx.wallets[2].account }), /NotEligibleResolver/);
    await ctx.kleos.write.propose([1n, true, EVIDENCE, "https://example.com"], { account: ctx.resolver.account });
    assert.equal((await ctx.kleos.read.getMarket([1n])).evidenceHash, EVIDENCE);
  });

  it("rejects proposals and funding for markets that were never created", async () => {
    const ctx = await deploy();
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await assert.rejects(ctx.kleos.write.propose([99n, true, EVIDENCE, ""], { account: ctx.resolver.account }), /BadState/);
    await assert.rejects(ctx.kleos.write.propose([0n, true, EVIDENCE, ""], { account: ctx.resolver.account }), /BadState/);
    await assert.rejects(ctx.kleos.write.fundFromGlobal([99n, 0n]), /BadState/);
  });

  it("cannot finalize while the dispute window is open", async () => {
    const ctx = await deploy();
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await ctx.kleos.write.propose([1n, true, EVIDENCE, ""], { account: ctx.resolver.account });
    await assert.rejects(ctx.kleos.write.finalize([1n]));
  });

  it("rejects bets after close", async () => {
    const ctx = await deploy();
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await assert.rejects(ctx.kleos.write.bet([1n, true, usd(10)]));
  });

  it("boost cap trims the boost to 10% of a deep pool but never the money", async () => {
    const { wallets, kleos } = await deploy();
    for (const i of [1, 2, 3, 4, 5]) await kleos.write.bet([1n, i % 2 === 1, usd(1000)], { account: wallets[i].account });
    const sharp = wallets[6].account.address;
    await kleos.write.seedReputation([sharp, wad(64), N_MIN]); // 5×
    const [eff] = await kleos.read.quote([1n, sharp, usd(500)]);
    // pool $5,000 → e ≤ (500 − 0) / 0.9 ≈ $555.55, below the uncapped $2,500
    assert.equal(eff, 555_555_555n);
  });
});

describe("calls", () => {
  it("posts a public call with the bet, capped at 140 bytes", async () => {
    const { kleos, wallets } = await deploy();
    const u = wallets[4];
    const hash = await kleos.write.betWithCall([1n, true, usd(20), "ETF flows are accelerating"], { account: u.account });
    const receipt = await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });
    const events = await kleos.getEvents.CallPosted({}, { blockHash: receipt.blockHash });
    assert.equal(events[0].args.text, "ETF flows are accelerating");
    assert.equal(events[0].args.callId, 1n, "calls are numbered by the contract");
    await kleos.write.betWithCall([1n, false, usd(5), "second"], { account: u.account });
    assert.equal(await kleos.read.callCount(), 2n);
    await kleos.write.betWithCall([1n, false, usd(5), ""], { account: u.account }); // empty call: a plain bet, no number
    assert.equal(await kleos.read.callCount(), 2n);
    assert.equal((await kleos.read.positions([1n, u.account.address, true]))[0], usd(20), "the bet itself went through");
    await assert.rejects(kleos.write.betWithCall([1n, true, usd(1), "x".repeat(141)], { account: u.account }), /CallTooLong/);
  });
});

describe("KleosUSD", () => {
  it("lets the Kleos market take a bet without a separate approval", async () => {
    const { token, kleos, wallets } = await deploy();
    const fresh = wallets[7];
    await token.write.approve([kleos.address, 0n], { account: fresh.account });
    await assert.rejects(kleos.write.bet([1n, true, usd(10)], { account: fresh.account }));
    await token.write.setMarket([kleos.address]);
    await kleos.write.bet([1n, true, usd(10)], { account: fresh.account });
  });

  it("only the sponsor can top up accounts, within the limit", async () => {
    const { token, wallets } = await deploy();
    const fresh = wallets[5].account.address;
    await token.write.sponsorMint([fresh, usd(1000)]);
    assert.equal(await token.read.balanceOf([fresh]), usd(2000), "faucet + sponsor");
    await assert.rejects(token.write.sponsorMint([fresh, usd(1001)]), /MintTooLarge/);
    await assert.rejects(token.write.sponsorMint([fresh, usd(1)], { account: wallets[5].account }), /NotSponsor/);
  });
});

describe("Kleos Court", () => {
  const VOTE = { yes: 1, no: 2, ambiguous: 3 } as const;
  type Vote = keyof typeof VOTE;

  /** Ten tier-V jurors join the pool; wallet 3 bets YES; the resolver proposes NO; wallet 3 disputes. */
  async function disputed() {
    const ctx = await deploy();
    const jurors = ctx.wallets.slice(18, 28);
    for (const j of jurors) {
      await ctx.kleos.write.seedReputation([j.account.address, wad(40), N_MIN]);
      await ctx.kleos.write.joinCourt({ account: j.account });
    }
    const disputer = ctx.wallets[3];
    await ctx.kleos.write.bet([1n, true, usd(10)], { account: disputer.account });
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await ctx.kleos.write.propose([1n, false, EVIDENCE, "https://example.com"], { account: ctx.resolver.account });
    await ctx.kleos.write.dispute([1n], { account: disputer.account });
    return { ctx, disputer };
  }

  /** Runs one round: each drawn juror votes per `plan` (null = no-show), then the round is closed. */
  async function runRound(ctx: Ctx, plan: (i: number) => Vote | null, id = 1n) {
    const court = await ctx.kleos.read.getCourt([id]);
    const jury = await ctx.kleos.read.getJury([id, court.round]);
    const byAddress = new Map(ctx.wallets.map((w) => [w.account.address.toLowerCase(), w]));
    const cast = jury.map((j, i) => ({ w: byAddress.get(j.toLowerCase())!, vote: plan(i), salt: keccak256(toHex(`salt-${court.round}-${i}`)) }));
    for (const { w, vote, salt } of cast) {
      if (!vote) continue;
      const c = await ctx.kleos.read.voteCommitment([id, court.round, w.account.address, VOTE[vote], salt]);
      await ctx.kleos.write.commitVote([id, c], { account: w.account });
    }
    await networkHelpers.time.increaseTo(court.commitEnd);
    for (const { w, vote, salt } of cast) {
      if (vote) await ctx.kleos.write.revealVote([id, VOTE[vote], salt], { account: w.account });
    }
    if (cast.some((c) => !c.vote)) await networkHelpers.time.increaseTo(court.revealEnd);
    await ctx.kleos.write.closeCourt([id]);
    return cast.map((c) => c.w.account.address);
  }

  it("draws 5 jurors with no stake; bettors may dispute, only once, and the proposer may not", async () => {
    const { ctx } = await disputed();
    const jury = await ctx.kleos.read.getJury([1n, 1]);
    assert.equal(jury.length, 5);
    await assert.rejects(ctx.kleos.write.dispute([1n], { account: ctx.wallets[4].account }), /BadState/);
  });

  it("an empty commitment cannot erase an existing jury commitment", async () => {
    const { ctx } = await disputed();
    const [juror] = await ctx.kleos.read.getJury([1n, 1]);
    const wallet = ctx.wallets.find((w) => w.account.address.toLowerCase() === juror.toLowerCase())!;
    await assert.rejects(ctx.kleos.write.commitVote([1n, zeroHash], { account: wallet.account }), /BadVote/);
    const salt = keccak256(toHex("ordinary valid jury commitment"));
    const commitment = await ctx.kleos.read.voteCommitment([1n, 1, juror, 1, salt]);
    await ctx.kleos.write.commitVote([1n, commitment], { account: wallet.account });
    await assert.rejects(ctx.kleos.write.commitVote([1n, zeroHash], { account: wallet.account }), /BadVote/);
    assert.equal(await ctx.kleos.read.commitments([1n, 1, juror]), commitment);
    await networkHelpers.time.increaseTo((await ctx.kleos.read.getCourt([1n])).commitEnd);
    await ctx.kleos.write.revealVote([1n, 1, salt], { account: wallet.account });
    assert.equal(await ctx.kleos.read.votes([1n, 1, juror]), 1);
  });

  it("a new jury reward vests a previous matured reward first", async () => {
    const { ctx } = await disputed();
    const firstJury = await runRound(ctx, () => "no");
    const selected = new Set(firstJury.map((a) => a.toLowerCase()));
    for (const w of ctx.wallets.slice(18, 28)) {
      if (!selected.has(w.account.address.toLowerCase())) await ctx.kleos.write.leaveCourt({ account: w.account });
    }
    const close = BigInt(await networkHelpers.time.latest()) + VEST_PERIOD + 60n;
    await ctx.kleos.write.createMarket(["Second court case", 1, "Official record", "YES if the record says yes", close]);
    await networkHelpers.time.increaseTo(close);
    await ctx.kleos.write.propose([2n, false, EVIDENCE, "https://example.com/second-case"], { account: ctx.resolver.account });
    await ctx.kleos.write.dispute([2n], { account: ctx.wallets[3].account });
    const secondJury = await runRound(ctx, () => "no", 2n);
    assert.equal(secondJury.length, 5);
    for (const a of secondJury) {
      const r = await rep(ctx, a);
      assert.equal(r.r, wad(40.3), "the original reward is mature");
      assert.equal(r.pending, wad(0.3), "the new court reward still vests");
    }
  });

  it("only tier V can join the jury pool", async () => {
    const ctx = await deploy();
    await ctx.kleos.write.seedReputation([ctx.wallets[1].account.address, wad(20), N_MIN]);
    await assert.rejects(ctx.kleos.write.joinCourt({ account: ctx.wallets[1].account }), /NotEligibleJuror/);
  });

  it("3 of 5 uphold the proposal: the disputer's bond pays the majority, reputation moves", async () => {
    const { ctx, disputer } = await disputed();
    const before = await ctx.token.read.balanceOf([disputer.account.address]);
    const jurors = await runRound(ctx, (i) => (i < 3 ? "no" : "yes"));
    const m = await ctx.kleos.read.getMarket([1n]);
    assert.equal(m.outcome, false);
    assert.equal(await ctx.token.read.balanceOf([disputer.account.address]), before, "disputer's $15 bond is gone");
    assert.equal(asNumber((await rep(ctx, jurors[0])).pending), 0.3, "majority juror earns reputation (vesting)");
    assert.equal(asNumber((await rep(ctx, jurors[4])).r), 39.7, "minority juror loses reputation");
  });

  it("3 of 5 overturn the proposal: the disputer gets both bonds", async () => {
    const { ctx, disputer } = await disputed();
    const before = await ctx.token.read.balanceOf([disputer.account.address]);
    await runRound(ctx, () => "yes");
    assert.equal((await ctx.kleos.read.getMarket([1n])).outcome, true);
    assert.equal((await ctx.token.read.balanceOf([disputer.account.address])) - before, usd(25), "$15 bond back + the proposer's $10");
  });

  it("an AMBIGUOUS verdict forfeits the creator's bond, and the creator never sits on the jury", async () => {
    const ctx = await deploy();
    const jurors = ctx.wallets.slice(18, 28);
    for (const j of jurors) {
      await ctx.kleos.write.seedReputation([j.account.address, wad(40), N_MIN]);
      await ctx.kleos.write.joinCourt({ account: j.account });
    }
    const creator = jurors[0]; // a tier-V juror who also writes a market
    await ctx.kleos.write.createMarket(["What counts as a suit?", 4, "o", "c", ctx.closeTime], { account: creator.account });
    await ctx.kleos.write.bet([2n, true, usd(10)], { account: ctx.wallets[3].account });
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await ctx.kleos.write.propose([2n, false, EVIDENCE, ""], { account: ctx.resolver.account });
    await ctx.kleos.write.dispute([2n], { account: ctx.wallets[3].account });
    const jury = (await ctx.kleos.read.getJury([2n, 1])).map((a) => a.toLowerCase());
    assert.ok(!jury.includes(creator.account.address.toLowerCase()), "the creator isn't on the jury");

    const court = await ctx.kleos.read.getCourt([2n]);
    const byAddress = new Map(ctx.wallets.map((w) => [w.account.address.toLowerCase(), w]));
    for (const [i, j] of jury.entries()) {
      const salt = keccak256(toHex(`s${i}`));
      const c = await ctx.kleos.read.voteCommitment([2n, 1, j as Address, 3, salt]);
      await ctx.kleos.write.commitVote([2n, c], { account: byAddress.get(j)!.account });
    }
    await networkHelpers.time.increaseTo(court.commitEnd);
    for (const [i, j] of jury.entries()) {
      await ctx.kleos.write.revealVote([2n, 3, keccak256(toHex(`s${i}`))], { account: byAddress.get(j)!.account });
    }
    const pool = await ctx.kleos.read.globalBonusPool();
    await ctx.kleos.write.closeCourt([2n]);
    assert.equal((await ctx.kleos.read.getMarket([2n])).voided, true);
    assert.equal((await ctx.kleos.read.globalBonusPool()) - pool, usd(25), "the bond funds future bonuses");
  });

  it("AMBIGUOUS voids the market and refunds everyone, with no reputation change", async () => {
    const { ctx, disputer } = await disputed();
    const before = await ctx.token.read.balanceOf([disputer.account.address]);
    await runRound(ctx, (i) => (i < 3 ? "ambiguous" : "no"));
    assert.equal((await ctx.kleos.read.getMarket([1n])).voided, true);
    await ctx.settleAll();
    // Bond back ($15) plus the $10 bet refunded in full.
    assert.equal((await ctx.token.read.balanceOf([disputer.account.address])) - before, usd(25));
    assert.equal((await rep(ctx, disputer.account.address)).resolvedBets, 0);
  });

  it("no-shows cost nothing when the market still closes", async () => {
    const { ctx } = await disputed();
    const round1 = await runRound(ctx, (i) => (i < 2 ? "no" : null)); // no quorum → redraw
    assert.equal((await ctx.kleos.read.getCourt([1n])).round, 2);
    await runRound(ctx, () => "no");
    assert.equal((await ctx.kleos.read.getMarket([1n])).outcome, false);
    assert.equal(asNumber((await rep(ctx, round1[4])).r), 40, "round-1 no-show keeps reputation");
  });

  it("no-shows are slashed when their absence forces a refund", async () => {
    const { ctx } = await disputed();
    const round1 = await runRound(ctx, () => null);
    const round2 = await runRound(ctx, (i) => (i === 0 ? "yes" : null));
    assert.equal((await ctx.kleos.read.getMarket([1n])).voided, true);
    assert.equal(asNumber((await rep(ctx, round1[0])).r), 39);
    assert.equal(asNumber((await rep(ctx, round2[1])).r), 39);
    assert.equal(asNumber((await rep(ctx, round2[0])).r), 40, "the one juror who voted isn't slashed");
  });
});

describe("KleosSocial", () => {
  it("follows, counts, lists and unfollows", async () => {
    const [a, b, c] = await viem.getWalletClients();
    const social = await viem.deployContract("KleosSocial");
    await social.write.follow([b.account.address], { account: a.account });
    await social.write.follow([c.account.address], { account: a.account });
    await social.write.follow([b.account.address], { account: a.account }); // idempotent
    assert.equal(await social.read.followerCount([b.account.address]), 1n);
    assert.deepEqual((await social.read.following([a.account.address])).map((x) => x.toLowerCase()), [b.account.address, c.account.address].map((x) => x.toLowerCase()));

    await social.write.unfollow([b.account.address], { account: a.account });
    assert.equal(await social.read.isFollowing([a.account.address, b.account.address]), false);
    assert.equal(await social.read.followerCount([b.account.address]), 0n);
    assert.deepEqual((await social.read.following([a.account.address])).map((x) => x.toLowerCase()), [c.account.address.toLowerCase()]);
    await assert.rejects(social.write.follow([a.account.address], { account: a.account }), /CannotFollowSelf/);
  });
});

describe("KleosSocial votes", () => {
  it("one vote per address per call; switching and clearing adjust the tallies", async () => {
    const [a, b] = await viem.getWalletClients();
    const social = await viem.deployContract("KleosSocial");
    const id = 1n;
    await social.write.vote([id, 1], { account: a.account });
    await social.write.vote([id, 1], { account: a.account }); // no double count
    await social.write.vote([id, -1], { account: b.account });
    let [up, down, mine] = await social.read.tallies([[id], a.account.address]);
    assert.deepEqual([up[0], down[0], mine[0]], [1n, 1n, 1]);

    await social.write.vote([id, -1], { account: a.account }); // switch
    [up, down] = await social.read.tallies([[id], a.account.address]);
    assert.deepEqual([up[0], down[0]], [0n, 2n]);

    await social.write.vote([id, 0], { account: b.account }); // clear
    [up, down] = await social.read.tallies([[id], a.account.address]);
    assert.deepEqual([up[0], down[0]], [0n, 1n]);
    await assert.rejects(social.write.vote([id, 2], { account: a.account }), /BadVote/);
  });
});

describe("KleosSocial names", () => {
  it("unique lowercase usernames; renaming frees the old one", async () => {
    const [a, b] = await viem.getWalletClients();
    const social = await viem.deployContract("KleosSocial");
    await social.write.setName(["sharp_ana"], { account: a.account });
    await assert.rejects(social.write.setName(["sharp_ana"], { account: b.account }), /NameTaken/);
    await assert.rejects(social.write.setName(["Ana"], { account: b.account }), /BadName/);
    await assert.rejects(social.write.setName(["ab"], { account: b.account }), /BadName/);
    await social.write.setName(["ana2"], { account: a.account });
    await social.write.setName(["sharp_ana"], { account: b.account }); // freed
    assert.deepEqual(await social.read.namesOf([[a.account.address, b.account.address]]), ["ana2", "sharp_ana"]);
  });
});

describe("market creation", () => {
  it("rejects each empty immutable field without creating a market or charging its creator", async () => {
    const ctx = await deploy();
    const creator = ctx.wallets[2];
    await ctx.kleos.write.seedReputation([creator.account.address, wad(40), N_MIN]);
    const before = await ctx.token.read.balanceOf([creator.account.address]);
    const cases: [string, number, string, string, bigint][] = [
      ["", 1, "Official record", "YES if the record says yes", ctx.closeTime],
      ["An objective question?", 1, "", "YES if the record says yes", ctx.closeTime],
      ["An objective question?", 1, "Official record", "", ctx.closeTime],
    ];
    for (const args of cases) {
      await assert.rejects(ctx.kleos.write.createMarket(args, { account: creator.account }), /BadMarketText/);
    }
    assert.equal(await ctx.kleos.read.marketCount(), 1n);
    assert.equal(await ctx.token.read.balanceOf([creator.account.address]), before);
    assert.equal(await ctx.kleos.read.protocolRevenue(), 0n);
  });

  it("rejects ASCII whitespace-only question, source, and criteria", async () => {
    const ctx = await deploy();
    for (const whitespace of [" ", "\t", "\n", "\r", "\v", "\f", " \t\n\r\v\f "]) {
      const cases: [string, number, string, string, bigint][] = [
        [whitespace, 1, "Official record", "YES if the record says yes", ctx.closeTime],
        ["An objective question?", 1, whitespace, "YES if the record says yes", ctx.closeTime],
        ["An objective question?", 1, "Official record", whitespace, ctx.closeTime],
      ];
      for (const args of cases) await assert.rejects(ctx.kleos.write.createMarket(args), /BadMarketText/);
    }
    assert.equal(await ctx.kleos.read.marketCount(), 1n);
  });

  it("preserves valid immutable text including Unicode and surrounding whitespace", async () => {
    const ctx = await deploy();
    const question = "\tWill São Paulo report rain?\n";
    const oracle = "\rOfficial weather record ";
    const criteria = "\nYES if the record reports rain; otherwise NO.\t";
    await ctx.kleos.write.createMarket([question, 4, oracle, criteria, ctx.closeTime]);
    const market = await ctx.kleos.read.getMarket([2n]);
    assert.equal(market.question, question);
    assert.equal(market.oracle, oracle);
    assert.equal(market.criteria, criteria);
    assert.equal(market.category, 4);
    assert.equal(market.closeTime, ctx.closeTime);
  });

  it("tier V creates with a $25 bond and a $2 fee; the team creates for free", async () => {
    const ctx = await deploy();
    const [trader, creator] = [ctx.wallets[1], ctx.wallets[2]];
    const close = ctx.closeTime;
    await ctx.kleos.write.seedReputation([trader.account.address, wad(20), N_MIN]);
    await assert.rejects(ctx.kleos.write.createMarket(["Q?", 1, "o", "c", close], { account: trader.account }), /NotEligibleCreator/);

    await ctx.kleos.write.seedReputation([creator.account.address, wad(40), N_MIN]);
    const before = await ctx.token.read.balanceOf([creator.account.address]);
    await ctx.kleos.write.createMarket(["Will it rain in Buenos Aires on Oct 5?", 4, "SMN", "YES if SMN reports rain.", close], { account: creator.account });
    assert.equal(before - (await ctx.token.read.balanceOf([creator.account.address])), usd(27));
    assert.equal(await ctx.kleos.read.protocolRevenue(), usd(2));
    const m = await ctx.kleos.read.getMarket([2n]);
    assert.equal(m.creator.toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(m.creatorBond, usd(25));
    await assert.rejects(ctx.kleos.write.createMarket(["Late?", 1, "o", "c", 1n]), /BadCloseTime/);
  });

  it("returns the bond on a clean resolution, and the creator can't propose", async () => {
    const ctx = await deploy();
    const creator = ctx.wallets[2];
    await ctx.kleos.write.seedReputation([creator.account.address, wad(40), N_MIN]);
    await ctx.kleos.write.createMarket(["Q?", 1, "o", "c", ctx.closeTime], { account: creator.account });
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await assert.rejects(ctx.kleos.write.propose([2n, true, EVIDENCE, ""], { account: creator.account }), /NotEligibleResolver/);
    const before = await ctx.token.read.balanceOf([creator.account.address]);
    await ctx.kleos.write.propose([2n, true, EVIDENCE, ""], { account: ctx.resolver.account });
    await networkHelpers.time.increase(DISPUTE_WINDOW);
    await ctx.kleos.write.finalize([2n]);
    assert.equal((await ctx.token.read.balanceOf([creator.account.address])) - before, usd(25));
  });
});

describe("review fixes (pre-deploy)", () => {
  async function poolOf(ctx: Ctx, count: number, from = 18) {
    const jurors = ctx.wallets.slice(from, from + count);
    for (const j of jurors) {
      await ctx.kleos.write.seedReputation([j.account.address, wad(40), N_MIN]);
      await ctx.kleos.write.joinCourt({ account: j.account });
    }
    return jurors;
  }
  async function proposedYes(ctx: Ctx) {
    await ctx.kleos.write.bet([1n, true, usd(10)], { account: ctx.wallets[3].account });
    await ctx.kleos.write.bet([1n, false, usd(10)], { account: ctx.wallets[4].account });
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await ctx.kleos.write.propose([1n, true, EVIDENCE, ""], { account: ctx.resolver.account });
  }

  it("a dispute needs enough eligible jurors: a loser can't void a market for free", async () => {
    const ctx = await deploy();
    await proposedYes(ctx);
    await assert.rejects(ctx.kleos.write.dispute([1n], { account: ctx.wallets[4].account }), /NotEnoughJurors/);
    await poolOf(ctx, 2);
    await assert.rejects(ctx.kleos.write.dispute([1n], { account: ctx.wallets[4].account }), /NotEnoughJurors/);
    await networkHelpers.time.increase(DISPUTE_WINDOW);
    await ctx.kleos.write.finalize([1n]); // the proposal stands
    assert.equal((await ctx.kleos.read.getMarket([1n])).outcome, true);
  });

  it("a redraw falls back to earlier jurors, so a 5-juror pool can still reach a verdict", async () => {
    const ctx = await deploy();
    const jurors = await poolOf(ctx, 5);
    await proposedYes(ctx);
    await ctx.kleos.write.dispute([1n], { account: ctx.wallets[4].account });
    const c1 = await ctx.kleos.read.getCourt([1n]);
    await networkHelpers.time.increaseTo(c1.revealEnd);
    await ctx.kleos.write.closeCourt([1n]); // nobody voted: redraw
    const round2 = await ctx.kleos.read.getJury([1n, 2]);
    assert.equal(round2.length, 5, "round 2 is seated from round-1 jurors");
    const c2 = await ctx.kleos.read.getCourt([1n]);
    const byAddress = new Map(jurors.map((w) => [w.account.address.toLowerCase(), w]));
    for (const [i, j] of round2.slice(0, 3).entries()) {
      const salt = keccak256(toHex(`r2-${i}`));
      await ctx.kleos.write.commitVote([1n, await ctx.kleos.read.voteCommitment([1n, 2, j, 1, salt])], { account: byAddress.get(j.toLowerCase())!.account });
    }
    await networkHelpers.time.increaseTo(c2.commitEnd);
    for (const [i, j] of round2.slice(0, 3).entries()) {
      await ctx.kleos.write.revealVote([1n, 1, keccak256(toHex(`r2-${i}`))], { account: byAddress.get(j.toLowerCase())!.account });
    }
    await networkHelpers.time.increaseTo(c2.revealEnd);
    await ctx.kleos.write.closeCourt([1n]);
    const m = await ctx.kleos.read.getMarket([1n]);
    assert.equal(m.voided, false);
    assert.equal(m.outcome, true);
  });

  it("a juror who commits but withholds the reveal is penalized even when quorum is met", async () => {
    const ctx = await deploy();
    const jurors = await poolOf(ctx, 5);
    await proposedYes(ctx);
    await ctx.kleos.write.dispute([1n], { account: ctx.wallets[4].account });
    const court = await ctx.kleos.read.getCourt([1n]);
    const jury = await ctx.kleos.read.getJury([1n, 1]);
    const byAddress = new Map(jurors.map((w) => [w.account.address.toLowerCase(), w]));
    for (const [i, j] of jury.slice(0, 4).entries()) {
      const salt = keccak256(toHex(`w-${i}`));
      await ctx.kleos.write.commitVote([1n, await ctx.kleos.read.voteCommitment([1n, 1, j, 1, salt])], { account: byAddress.get(j.toLowerCase())!.account });
    }
    await networkHelpers.time.increaseTo(court.commitEnd);
    for (const [i, j] of jury.slice(0, 3).entries()) {
      await ctx.kleos.write.revealVote([1n, 1, keccak256(toHex(`w-${i}`))], { account: byAddress.get(j.toLowerCase())!.account });
    }
    await networkHelpers.time.increaseTo(court.revealEnd);
    await ctx.kleos.write.closeCourt([1n]);
    assert.equal(asNumber((await rep(ctx, jury[3])).r), 39.7, "withheld reveal: −0.3");
    assert.equal(asNumber((await rep(ctx, jury[4])).r), 40, "never committed: no penalty");
  });

  it("the team can propose on its own markets, and unresolved markets expire into refunds", async () => {
    const ctx = await deploy();
    await ctx.kleos.write.bet([1n, true, usd(10)], { account: ctx.wallets[3].account });
    await networkHelpers.time.increaseTo(ctx.closeTime);
    await assert.rejects(ctx.kleos.write.expire([1n]), /NotExpired/);
    await networkHelpers.time.increase(20n * DISPUTE_WINDOW);
    const before = await ctx.token.read.balanceOf([getAddress(ctx.wallets[3].account.address)]);
    await ctx.kleos.write.expire([1n]);
    await ctx.settleAll();
    assert.equal((await ctx.token.read.balanceOf([ctx.wallets[3].account.address])) - before, usd(10));

    // Owner (the creator of every team market) can still propose.
    const now = BigInt(await networkHelpers.time.latest());
    await ctx.kleos.write.createMarket(["Team market?", 1, "o", "c", now + 100n]);
    await networkHelpers.time.increase(101);
    await ctx.kleos.write.propose([2n, true, EVIDENCE, ""]);
  });

  it("entry prices are clamped: betting into an empty side still risks reputation", async () => {
    const ctx = await deploy();
    for (const w of ctx.wallets.slice(1, 11)) await ctx.kleos.write.bet([1n, false, usd(100)], { account: w.account });
    const u = ctx.wallets[12];
    await ctx.kleos.write.seedReputation([u.account.address, wad(10), N_MIN]);
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: u.account });
    await ctx.resolve(false);
    await ctx.kleos.write.settle([1n, [u.account.address]]);
    assert.equal(asNumber((await rep(ctx, u.account.address)).r).toFixed(3), "9.925", "−1.5 · 0.05");
  });

  it("the anomaly flag catches $50 long shots, and flagged or hedged winners get no bonus", async () => {
    const ctx = await deploy();
    await crowdAt(ctx, 5);
    const [insider, hedger] = [ctx.wallets[12], ctx.wallets[13]];
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: insider.account });
    await ctx.kleos.write.seedReputation([hedger.account.address, wad(36), N_MIN]);
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: hedger.account });
    await ctx.kleos.write.bet([1n, false, usd(50)], { account: hedger.account });
    await ctx.resolve(true);
    await ctx.kleos.write.settle([1n, [insider.account.address, hedger.account.address]]);
    assert.equal((await rep(ctx, insider.account.address)).flagged, true);
    assert.equal(await ctx.kleos.read.bonusWeight([1n, insider.account.address]), 0n, "flagged: no bonus");
    // Hedger: +0.8 capped on YES at ~5%, −1.5·~0.95 on NO → net negative, no bonus.
    assert.equal(await ctx.kleos.read.bonusWeight([1n, hedger.account.address]), 0n, "net-negative hedge: no bonus");
  });

  it("activation only counts positions of at least $50", async () => {
    const ctx = await deploy();
    await crowdAt(ctx, 50);
    const [small, full] = [ctx.wallets[12], ctx.wallets[13]];
    await ctx.kleos.write.bet([1n, true, usd(1)], { account: small.account });
    await ctx.kleos.write.bet([1n, true, usd(50)], { account: full.account });
    await ctx.resolve(true);
    await ctx.kleos.write.settle([1n, [small.account.address, full.account.address]]);
    assert.equal((await rep(ctx, small.account.address)).resolvedBets, 0);
    assert.equal((await rep(ctx, full.account.address)).resolvedBets, 1);
  });

  it("the boost cap applies to a big bet that makes the pool deep", async () => {
    const { wallets, kleos } = await deploy();
    const whale = wallets[6];
    await kleos.write.seedReputation([whale.account.address, wad(64), N_MIN]); // 5×
    await kleos.write.bet([1n, false, usd(100)], { account: wallets[1].account });
    const [eff] = await kleos.read.quote([1n, whale.account.address, usd(10_000)]);
    assert.equal(eff, usd(10_000), "boost trimmed to the stake, not 5×");
  });

  it("owner and sponsor guards", async () => {
    const ctx = await deploy();
    await assert.rejects(ctx.kleos.write.transferOwnership(["0x0000000000000000000000000000000000000000"]), /ZeroAddress/);
    await assert.rejects(ctx.kleos.write.withdrawRevenue(["0x0000000000000000000000000000000000000000"]), /ZeroAddress/);
    await assert.rejects(ctx.kleos.write.seedReputation([ctx.wallets[1].account.address, wad(2_000_000), 0]), /BadState/);
    await proposedYes(ctx);
    await networkHelpers.time.increase(DISPUTE_WINDOW);
    await ctx.kleos.write.finalize([1n]);
    await assert.rejects(ctx.kleos.write.sponsor([1n, usd(5)], { account: ctx.wallets[5].account }), /BadState/);
  });

  it("anyone can prune a juror who no longer qualifies", async () => {
    const ctx = await deploy();
    const [j] = await poolOf(ctx, 1);
    await assert.rejects(ctx.kleos.write.pruneJuror([j.account.address]), /NotEligibleJuror/);
    await ctx.kleos.write.slash([j.account.address, wad(10)]);
    await ctx.kleos.write.pruneJuror([j.account.address], { account: ctx.wallets[5].account });
    assert.equal((await ctx.kleos.read.jurorPool()).length, 0);
  });
});

describe("constructor configuration", () => {
  it("rejects a zero collateral token", async () => {
    await assert.rejects(viem.deployContract("Kleos", [zeroAddress, DISPUTE_WINDOW, VEST_PERIOD, BigInt(N_MIN), COURT_PERIOD]), /ZeroAddress/);
  });
});

describe("bounded discovery", () => {
  it("pages bettors in insertion order without duplicating repeated bettors", async () => {
    const ctx = await deploy();
    for (const w of ctx.wallets.slice(1, 4)) await ctx.kleos.write.bet([1n, true, usd(10)], { account: w.account });
    await ctx.kleos.write.bet([1n, false, usd(10)], { account: ctx.wallets[1].account });
    assert.equal(await ctx.kleos.read.bettorCount([1n]), 3n);
    assert.deepEqual(await ctx.kleos.read.getBettorsPage([1n, 0n, 2n]), ctx.wallets.slice(1, 3).map(w => getAddress(w.account.address)));
    assert.deepEqual(await ctx.kleos.read.getBettorsPage([1n, 2n, 2n]), [getAddress(ctx.wallets[3].account.address)]);
    assert.deepEqual(await ctx.kleos.read.getBettorsPage([1n, maxUint256, 100n]), []);
    assert.deepEqual(await ctx.kleos.read.getBettorsPage([2n, 0n, 100n]), []);
    await assert.rejects(ctx.kleos.read.getBettorsPage([1n, 0n, 0n]), /BadPagination/);
    await assert.rejects(ctx.kleos.read.getBettorsPage([1n, 0n, 101n]), /BadPagination/);
  });
  it("pages the current juror pool after a member leaves", async () => {
    const ctx = await deploy();
    for (const w of ctx.wallets.slice(18, 21)) {
      await ctx.kleos.write.seedReputation([w.account.address, wad(40), N_MIN]);
      await ctx.kleos.write.joinCourt({ account: w.account });
    }
    assert.equal(await ctx.kleos.read.jurorCount(), 3n);
    await ctx.kleos.write.leaveCourt({ account: ctx.wallets[19].account });
    assert.equal(await ctx.kleos.read.jurorCount(), 2n);
    assert.deepEqual(await ctx.kleos.read.jurorPoolPage([0n, 1n]), [getAddress(ctx.wallets[18].account.address)]);
    assert.deepEqual(await ctx.kleos.read.jurorPoolPage([1n, 100n]), [getAddress(ctx.wallets[20].account.address)]);
    assert.deepEqual(await ctx.kleos.read.jurorPoolPage([2n, 100n]), []);
    await assert.rejects(ctx.kleos.read.jurorPoolPage([0n, 101n]), /BadPagination/);
  });
});

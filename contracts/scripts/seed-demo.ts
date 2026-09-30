// Seeds a deployed Kleos with demo traders: usernames, starting reputation (published on-chain
// as marketId 0 seeds), bets with calls, follows and votes.
//
//   KLEOS_ME=0xYourAddress npx hardhat run scripts/seed-demo.ts --network localhost
//
// Also sets up the Kleos Court demo: a jury pool, one market resolved for real (so profiles have
// genuine reputation history) and one short market that closes a few minutes after seeding.
// KLEOS_ME (optional) gets demo reputation so that account can propose outcomes live.
//
// Local only for now: it uses the node's pre-funded accounts. The testnet version funds fresh
// wallets from the deployer instead.
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseEther, parseUnits, type Address, type Hex } from "viem";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployed = JSON.parse(readFileSync(`ignition/deployments/chain-${chainId}/deployed_addresses.json`, "utf8"));

const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"] as Address);
const usd = await viem.getContractAt("KleosUSD", deployed["KleosModule#KleosUSD"] as Address);
const social = await viem.getContractAt("KleosSocial", deployed["KleosModule#KleosSocial"] as Address);

const [owner, ...wallets] = await viem.getWalletClients();
const usdAmount = (n: number) => parseUnits(String(n), 6);

type Persona = { name: string; r: number; resolved: number; cash: number; bets: [number, boolean, number, string?][] };

// [marketId, side, amount, call]
const PERSONAS: Persona[] = [
  { name: "kleos_maxi", r: 41.2, resolved: 34, cash: 1000, bets: [
    [1, true, 80, "ETF inflows haven't slowed in six weeks"],
    [4, false, 60, "No catalyst before year end"],
    [6, true, 50, "The gap to #1 closed to 8 points this month"],
  ] },
  { name: "oracle_ana", r: 24.5, resolved: 21, cash: 1000, bets: [
    [1, true, 80, "Funding is neutral, spot is doing the lifting"],
    [2, false, 50, "Mainnet launches later than people think"],
  ] },
  { name: "contrarian", r: 17.3, resolved: 15, cash: 1000, bets: [
    [3, true, 50, "Their striker is out, but the home record is 9-0"],
    [4, true, 40, "Staking ETF approval changes everything"],
  ] },
  { name: "base_rates", r: 9.6, resolved: 12, cash: 1000, bets: [[1, true, 80], [6, false, 30, "Leaderboards lag new releases by weeks"]] },
  { name: "pollster", r: 4.3, resolved: 10, cash: 1000, bets: [[2, true, 25, "Testnet already peaks above 8M on busy days"]] },
  { name: "whale_watcher", r: 0, resolved: 0, cash: 3000, bets: [[1, false, 2000, "Too much optimism, fading it"]] },
];

const calls: { id: Hex; author: number }[] = [];
// A call's id comes from its CallPosted log. BetPlaced in the same tx also has 3 topics, so match the event.
const [CALL_POSTED] = encodeEventTopics({ abi: kleos.abi, eventName: "CallPosted" });

for (const [i, p] of PERSONAS.entries()) {
  const w = wallets[i];
  const a = w.account.address;
  await kleos.write.seedReputation([a, parseEther(String(p.r)), p.resolved], { account: owner.account });
  await usd.write.sponsorMint([a, usdAmount(Math.min(p.cash, 1000))], { account: owner.account });
  for (let extra = p.cash - 1000; extra > 0; extra -= 1000) {
    await usd.write.sponsorMint([a, usdAmount(Math.min(extra, 1000))], { account: owner.account });
  }
  await social.write.setName([p.name], { account: w.account });

  for (const [marketId, side, amount, text] of p.bets) {
    const hash = text
      ? await kleos.write.betWithCall([BigInt(marketId), side, usdAmount(amount), text], { account: w.account })
      : await kleos.write.bet([BigInt(marketId), side, usdAmount(amount)], { account: w.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (text) {
      const log = receipt.logs.find((l) => l.address.toLowerCase() === kleos.address.toLowerCase() && l.topics[0] === CALL_POSTED)!;
      calls.push({ id: keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [hash, BigInt(log.logIndex!)])), author: i });
    }
  }
  console.log(`@${p.name} ${a}  R=${p.r}`);
}

// Everyone follows the top sharp; sharps follow each other.
for (let i = 1; i < PERSONAS.length; i++) await social.write.follow([wallets[0].account.address], { account: wallets[i].account });
await social.write.follow([wallets[1].account.address], { account: wallets[0].account });
await social.write.follow([wallets[2].account.address], { account: wallets[1].account });

// Votes: people upvote the sharps' calls and downvote the whale's.
for (const c of calls) {
  for (let v = 0; v < PERSONAS.length; v++) {
    if (v === c.author) continue;
    const value = c.author === 5 ? -1 : (v + c.author) % 3 === 0 ? 0 : 1;
    if (value !== 0) await social.write.vote([c.id, value], { account: wallets[v].account });
  }
}

console.log(`Seeded ${PERSONAS.length} traders and ${calls.length} calls on chain ${chainId}.`);

// ─── Kleos Court demo ────────────────────────────────────────────────────────
const jurors = wallets.slice(6, 14); // 8 tier-V jurors, never betting
const extras = wallets.slice(14, 19); // extra bettors so markets are deep enough to move reputation
const traders = [...wallets.slice(0, 6), ...extras];

for (const j of jurors) {
  await kleos.write.seedReputation([j.account.address, parseEther("40"), 12], { account: owner.account });
  await kleos.write.joinCourt({ account: j.account });
  await usd.write.sponsorMint([j.account.address, usdAmount(100)], { account: owner.account }); // bonds for proposing
}
for (const e of extras) await usd.write.sponsorMint([e.account.address, usdAmount(1000)], { account: owner.account });
console.log(`Jury pool: ${jurors.length} tier-V jurors`);

const me = process.env.KLEOS_ME as Address | undefined;
if (me) {
  await kleos.write.seedReputation([me, parseEther("20"), 10], { account: owner.account }); // tier IV: can propose
  await usd.write.sponsorMint([me, usdAmount(1000)], { account: owner.account });
  await owner.sendTransaction({ to: me, value: parseEther("1") });
  console.log(`Demo reputation for ${me}: R = 20`);
}

const now = async () => Number((await publicClient.getBlock()).timestamp);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function createMarket(question: string, category: number, oracle: string, criteria: string, closesIn: number) {
  const hash = await kleos.write.createMarket([question, category, oracle, criteria, BigInt((await now()) + closesIn)], { account: owner.account });
  await publicClient.waitForTransactionReceipt({ hash });
  return await kleos.read.marketCount();
}

// A market that resolves during seeding: 11 bettors, $1,000+ pool, so reputation really moves.
const resolved = await createMarket(
  "Kleos demo: does the first Monad testnet block of the day land under a second?", 3, "Monad testnet explorer",
  "YES if the first block after 00:00 UTC is produced within 1 second of the previous one.", 25,
);
const RESOLVED_BETS: [boolean, number, string?][] = [
  [true, 150, "Monad's 400ms blocks make this easy"], [true, 120, "Block times haven't slipped all week"], [true, 100],
  [false, 90, "Midnight is when the batch jobs hit"], [true, 110], [false, 250, "Fading the hype on this one"],
  [true, 80], [false, 60], [true, 90], [false, 70], [true, 100],
];
for (const [i, [side, amount, text]] of RESOLVED_BETS.entries()) {
  const w = traders[i];
  if (text) await kleos.write.betWithCall([resolved, side, usdAmount(amount), text], { account: w.account });
  else await kleos.write.bet([resolved, side, usdAmount(amount)], { account: w.account });
}
const waitUntil = async (t: number) => { while ((await now()) < t) { await sleep(1000); await owner.sendTransaction({ to: owner.account.address, value: 0n }); } };
await waitUntil(Number((await kleos.read.getMarket([resolved])).closeTime));
await kleos.write.propose([resolved, true, keccak256(new TextEncoder().encode("https://testnet.monadexplorer.com")), "https://testnet.monadexplorer.com"], { account: jurors[0].account });
console.log(`Market ${resolved} proposed YES; waiting out the dispute window…`);
await waitUntil(Number((await kleos.read.getMarket([resolved])).proposedAt) + Number(await kleos.read.DISPUTE_WINDOW()));
await kleos.write.finalize([resolved], { account: owner.account });
await kleos.write.settle([resolved, await kleos.read.getBettors([resolved])], { account: owner.account });
console.log(`Market ${resolved} resolved YES and settled: reputation history is real now.`);

// A short market for the live demo: closes a few minutes after seeding.
const live = await createMarket(
  "Kleos demo: will the room vote YES on this market?", 4, "Show of hands at the demo",
  "YES if more than half the room raises a hand when asked.", 240,
);
for (const [i, w] of traders.entries()) await kleos.write.bet([live, i % 3 !== 0, usdAmount(50 + i * 10)], { account: w.account });
console.log(`Market ${live} closes in ~4 minutes: propose, dispute and watch the Kleos Court.`);

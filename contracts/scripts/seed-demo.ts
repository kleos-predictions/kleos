// Seeds a deployed Kleos with demo traders: usernames, starting reputation (published on-chain
// as marketId 0 seeds), bets with calls, follows and votes.
//
//   npx hardhat run scripts/seed-demo.ts --network localhost
//
// Local only for now: it uses the node's pre-funded accounts. The testnet version funds fresh
// wallets from the deployer instead.
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { encodeAbiParameters, keccak256, parseEther, parseUnits, type Address, type Hex } from "viem";

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
      const log = receipt.logs.find((l) => l.address.toLowerCase() === kleos.address.toLowerCase() && l.topics.length === 3)!;
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

// Resumable demo setup. Run only with explicit authorization on a remote testnet.
// Fresh deploys create no markets; this script anchors demo deadlines to the chain and records
// every operation in contracts/.demo-state (git-ignored). Never delete its journal to retry.
import { network } from "hardhat";
import { isAddress, keccak256, parseEther, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LOCAL_CHAIN_ID, demoSecret, getDemoWallets } from "./demo-wallets.ts";
import { DemoJournal, acquireJournalLock, contextId } from "./demo-journal.ts";
import { demoDeployment } from "./demo-deployment.ts";
import { DEMO_MARKETS, demoCloseTimes } from "./demo-markets.ts";
import { resumeDemoResolution } from "./demo-lifecycle.ts";
import { mintDemoTokens } from "./demo-funding.ts";
import { readDemoBettors } from "./demo-bettors.ts";

const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const { deployed, context } = await demoDeployment(publicClient, chainId);
const journalPath = `.demo-state/seed-${contextId(context)}.json`;
const release = acquireJournalLock(`.demo-state/operator-${contextId(context)}.json`);
try {
  const journal = new DemoJournal(journalPath, { deployment: context, plan: "seed-v2" });
  const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"]);
  const usd = await viem.getContractAt("KleosUSD", deployed["KleosModule#KleosUSD"]);
  const social = await viem.getContractAt("KleosSocial", deployed["KleosModule#KleosSocial"]);
  const [owner] = await viem.getWalletClients();
  const LOCAL = chainId === LOCAL_CHAIN_ID;
  const ownerAddress = owner.account.address;
  if ((await kleos.read.owner()).toLowerCase() !== ownerAddress.toLowerCase() ||
      (await usd.read.market()).toLowerCase() !== kleos.address.toLowerCase() ||
      (await kleos.read.usd()).toLowerCase() !== usd.address.toLowerCase()) {
    throw new Error("The connected account must own Kleos and use its bound demo token.");
  }
  // The dedicated sponsor must be exclusive to this run: pause the web faucet first.
  // Keep main's sponsor handoff support without re-running journaled funding. Do not load
  // sponsor custody when the deployer is still the minter (including the normal local demo).
  const sponsorAddress = await usd.read.sponsor();
  const sponsorKey = sponsorAddress.toLowerCase() === ownerAddress.toLowerCase()
    ? undefined : demoSecret("SPONSOR_PRIVATE_KEY") as Hex | undefined;
  const minter = sponsorAddress.toLowerCase() === ownerAddress.toLowerCase() ? owner.account
    : sponsorKey ? privateKeyToAccount(sponsorKey) : undefined;
  if (!minter || minter.address.toLowerCase() !== sponsorAddress.toLowerCase()) {
    throw new Error(`KleosUSD's sponsor is ${sponsorAddress}; restore its matching sponsor custody before seeding.`);
  }
  // Do this before wallet creation/funding. An unjournaled historical seed cannot safely be
  // inferred from names or balances: neither proves whether reputation, mints and calls ran.
  if (!journal.value<boolean>("initialized")) {
    if (await kleos.read.marketCount() !== 0n || await usd.read.totalSupply() !== 0n) {
      throw new Error("This deployment already has activity but no seed journal. Stop and reconcile it. Reset/deploy a fresh local chain for a fresh demo; never delete state to force a remote reseed.");
    }
    journal.setValue("baseTimestamp", (await publicClient.getBlock()).timestamp.toString());
    journal.setValue("initialized", true);
  }
  const requestedMe = process.env.KLEOS_ME;
  if (requestedMe && !isAddress(requestedMe)) throw new Error("KLEOS_ME must be a valid address.");
  if (journal.value<string>("optionalRecipient") === undefined) journal.setValue("optionalRecipient", requestedMe?.toLowerCase() ?? "");
  const recordedMe = journal.value<string>("optionalRecipient")!;
  if ((requestedMe?.toLowerCase() ?? "") !== recordedMe) throw new Error("KLEOS_ME changed during this seed run. Restore the original recipient.");
  const wallets = await getDemoWallets(viem, chainId);
  if (wallets.length !== 19) throw new Error("The demo requires 19 trader/juror wallets.");
  const walletAddresses = wallets.map((wallet) => wallet.account.address.toLowerCase());
  if (!journal.value<string[]>("wallets")) journal.setValue("wallets", walletAddresses);
  if (JSON.stringify(journal.value<string[]>("wallets")) !== JSON.stringify(walletAddresses)) throw new Error("Demo wallet addresses changed. Restore the original wallet configuration before resuming.");
  const usdAmount = (n: number) => parseUnits(String(n), 6);
  const wait = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const operation = (key: string, send: () => Promise<`0x${string}`>, sender = ownerAddress) => journal.run(key, send, wait, sender);
  const mint = (key: string, recipient: Address, amount: bigint) => mintDemoTokens(journal, key, minter.address,
    () => usd.write.sponsorMint([recipient, amount], { account: minter }), wait);

  // Top up gas once per deployment, with receipt checks and crash-safe intent recording.
  if (!LOCAL) for (const [i, wallet] of wallets.entries()) {
    const budget = parseEther(i < 6 ? "0.4" : i < 14 ? "0.12" : "0.08");
    const key = `gas:${wallet.account.address.toLowerCase()}`;
    const balance = await publicClient.getBalance({ address: wallet.account.address });
    if (journal.hasOperation(key) || balance < budget) await operation(key, () => owner.sendTransaction({ to: wallet.account.address, value: balance < budget ? budget - balance : 0n }));
  }

  const closeTimes = demoCloseTimes(BigInt(journal.value<string>("baseTimestamp")!));
  for (const [i, [question, category, oracle, criteria]] of DEMO_MARKETS.entries()) {
    const receipt = await operation(`base-market:${i}`, () => kleos.write.createMarket([question, category, oracle, criteria, closeTimes[i]], { account: owner.account }));
    const [created] = parseEventLogs({ abi: kleos.abi, eventName: "MarketCreated", logs: receipt.logs }).filter((event) => event.address.toLowerCase() === kleos.address.toLowerCase());
    if (!created || created.args.marketId !== BigInt(i + 1)) throw new Error("Demo market IDs changed. Stop before placing persona bets.");
  }

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


  const calls: { id: bigint; author: number }[] = [];
  for (const [i, persona] of PERSONAS.entries()) {
    const wallet = wallets[i];
    const address = wallet.account.address;
    await operation(`persona:${i}:reputation`, () => kleos.write.seedReputation([address, parseEther(String(persona.r)), persona.resolved], { account: owner.account }));
    for (let offset = 0; offset < persona.cash; offset += 1000) {
      await mint(`persona:${i}:mint:${offset}`, address, usdAmount(Math.min(persona.cash - offset, 1000)));
    }
    await operation(`persona:${i}:name`, () => social.write.setName([persona.name], { account: wallet.account }), address);
    for (const [betIndex, [marketId, side, amount, text]] of persona.bets.entries()) {
      const receipt = await operation(`persona:${i}:bet:${betIndex}`, () => text
        ? kleos.write.betWithCall([BigInt(marketId), side, usdAmount(amount), text], { account: wallet.account })
        : kleos.write.bet([BigInt(marketId), side, usdAmount(amount)], { account: wallet.account }), address);
      if (text) {
        const [posted] = parseEventLogs({ abi: kleos.abi, eventName: "CallPosted", logs: receipt.logs }).filter((event) => event.address.toLowerCase() === kleos.address.toLowerCase());
        if (!posted) throw new Error(`Persona ${i} bet did not emit CallPosted.`);
        calls.push({ id: posted.args.callId, author: i });
      }
    }
    console.log(`@${persona.name} ${address}`);
  }
  for (let i = 1; i < PERSONAS.length; i++) await operation(`follow:${i}:0`, () => social.write.follow([wallets[0].account.address], { account: wallets[i].account }), wallets[i].account.address);
  await operation("follow:0:1", () => social.write.follow([wallets[1].account.address], { account: wallets[0].account }), wallets[0].account.address);
  await operation("follow:1:2", () => social.write.follow([wallets[2].account.address], { account: wallets[1].account }), wallets[1].account.address);
  for (const call of calls) for (let voter = 0; voter < PERSONAS.length; voter++) {
    if (voter === call.author) continue;
    const value = call.author === 5 ? -1 : (voter + call.author) % 3 === 0 ? 0 : 1;
    if (value !== 0) await operation(`vote:${call.id}:${voter}`, () => social.write.vote([call.id, value], { account: wallets[voter].account }), wallets[voter].account.address);
  }

  const jurors = wallets.slice(6, 14);
  const extras = wallets.slice(14, 19);
  const traders = [...wallets.slice(0, 6), ...extras];
  for (const [i, juror] of jurors.entries()) {
    await operation(`juror:${i}:reputation`, () => kleos.write.seedReputation([juror.account.address, parseEther("40"), 12], { account: owner.account }));
    await operation(`juror:${i}:join`, () => kleos.write.joinCourt({ account: juror.account }), juror.account.address);
    await mint(`juror:${i}:mint`, juror.account.address, usdAmount(100));
  }
  for (const [i, extra] of extras.entries()) await mint(`extra:${i}:mint`, extra.account.address, usdAmount(1000));

  // The optional recipient is immutable once this seed run starts; changing it would grant
  // extra authority and funding outside the original operation plan.
  if (recordedMe) {
    const me = recordedMe as Address;
    await operation("optional:reputation", () => kleos.write.seedReputation([me, parseEther("20"), 10], { account: owner.account }));
    await mint("optional:mint", me, usdAmount(1000));
    await operation("optional:gas", () => owner.sendTransaction({ to: me, value: parseEther(LOCAL ? "1" : "0.05") }));
  }

  const now = async () => (await publicClient.getBlock()).timestamp;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (timestamp: bigint) => {
    // Bound a stuck RPC/clock. This is a demo, not a perpetual keeper.
    const deadline = Date.now() + 30 * 60_000;
    while (await now() < timestamp) {
      if (Date.now() > deadline) throw new Error("Demo deadline did not advance within 30 minutes; restart with the same journal.");
      if (LOCAL) await publicClient.request({ method: "evm_mine" as never });
      await sleep(LOCAL ? 1000 : 3000);
    }
  };
  async function createMarket(key: string, question: string, category: number, oracle: string, criteria: string, closesIn: number) {
    let closeTime = journal.value<string>(`${key}:close`);
    if (!closeTime) { closeTime = (await now() + BigInt(closesIn)).toString(); journal.setValue(`${key}:close`, closeTime); }
    const receipt = await operation(key, () => kleos.write.createMarket([question, category, oracle, criteria, BigInt(closeTime!)], { account: owner.account }));
    const [created] = parseEventLogs({ abi: kleos.abi, eventName: "MarketCreated", logs: receipt.logs }).filter((event) => event.address.toLowerCase() === kleos.address.toLowerCase());
    if (!created) throw new Error(`${key} did not emit MarketCreated.`);
    return created.args.marketId;
  }
  const resolved = await createMarket("resolved-demo", "Kleos demo: does the first Monad testnet block of the day land under a second?", 3, "Monad testnet explorer", "Demo-only resolution example; the seed operator proposes YES. This is not a verified block-time oracle.", LOCAL ? 120 : 600);
  const RESOLVED_BETS: [boolean, number, string?][] = [
    [true, 150, "Monad's 400ms blocks make this easy"], [true, 120, "Block times haven't slipped all week"], [true, 100],
    [false, 90, "Midnight is when the batch jobs hit"], [true, 110], [false, 250, "Fading the hype on this one"],
    [true, 80], [false, 60], [true, 90], [false, 70], [true, 100],
  ];
  for (const [i, [side, amount, text]] of RESOLVED_BETS.entries()) {
    await operation(`resolved-demo:bet:${i}`, () => text
      ? kleos.write.betWithCall([resolved, side, usdAmount(amount), text], { account: traders[i].account })
      : kleos.write.bet([resolved, side, usdAmount(amount)], { account: traders[i].account }), traders[i].account.address);
  }
  const evidenceURI = "https://testnet.monadexplorer.com";
  const evidenceHash = keccak256(new TextEncoder().encode(evidenceURI));
  await resumeDemoResolution(journal, "resolved-demo", { proposer: jurors[0].account.address, outcome: true, evidenceHash, evidenceURI }, {
    wait,
    readMarket: () => kleos.read.getMarket([resolved]),
    waitUntil,
    disputeWindow: () => kleos.read.DISPUTE_WINDOW(),
    propose: () => operation("resolved-demo:propose", () => kleos.write.propose([resolved, true, evidenceHash, evidenceURI], { account: jurors[0].account }), jurors[0].account.address),
    finalize: () => operation("resolved-demo:finalize", () => kleos.write.finalize([resolved], { account: owner.account })),
  });
  const resolvedBettors = await readDemoBettors(publicClient, kleos, resolved);
  await operation("resolved-demo:settle", () => kleos.write.settle([resolved, resolvedBettors], { account: owner.account }));

  const live = await createMarket("live-demo", "Kleos demo: will the room vote YES on this market?", 4, "Show of hands at the demo", "YES if more than half the room raises a hand when asked at this market's close time. Demo only.", 600);
  for (const [i, wallet] of traders.entries()) await operation(`live-demo:bet:${i}`, () => kleos.write.bet([live, i % 3 !== 0, usdAmount(50 + i * 10)], { account: wallet.account }), wallet.account.address);
  console.log(`Seed complete: ${PERSONAS.length} personas, ${calls.length} calls, resolved market ${resolved}, live market ${live}. Re-running uses the same confirmed operations.`);
} finally { release(); }

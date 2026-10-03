// Demo-only court operator. Remote testnet execution needs the owner's specific approval.
// Vote/salt pairs are persisted before committing so a restart or mode change can still reveal.
// No juror automatically sits out: a three-seat jury needs all three possible reveals.
import { network } from "hardhat";
import { randomBytes } from "node:crypto";
import { type Address, type Hex, zeroHash } from "viem";
import { LOCAL_CHAIN_ID, ROLES, getDemoWallets } from "./demo-wallets.ts";
import { DemoJournal, acquireJournalLock, boundedInteger, contextId, selectDemoJurors } from "./demo-journal.ts";
import { demoDeployment } from "./demo-deployment.ts";

const mode = (process.env.KLEOS_BOT_VOTE ?? "uphold").toLowerCase();
if (!["uphold", "overturn", "yes", "no", "ambiguous"].includes(mode)) throw new Error("KLEOS_BOT_VOTE must be uphold, overturn, yes, no or ambiguous.");
const scanBudget = boundedInteger(process.env.KLEOS_BOT_SCAN_LIMIT, 25, 100, "KLEOS_BOT_SCAN_LIMIT");
const writeBudget = boundedInteger(process.env.KLEOS_BOT_WRITE_LIMIT, 20, 100, "KLEOS_BOT_WRITE_LIMIT");
const pollMs = boundedInteger(process.env.KLEOS_BOT_POLL_MS, 3000, 60_000, "KLEOS_BOT_POLL_MS");
const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const { deployed, context } = await demoDeployment(publicClient, chainId);
const journalPath = `.demo-state/court-${contextId(context)}.json`;
const release = acquireJournalLock(`.demo-state/operator-${contextId(context)}.json`);
try {
  const journal = new DemoJournal(journalPath, { deployment: context, plan: "court-v2" });
  const kleos = await viem.getContractAt("Kleos", deployed["KleosModule#Kleos"] as Address);
  const [operator] = await viem.getWalletClients();
  const wallets = await getDemoWallets(viem, chainId);
  const jurors = new Map(wallets.slice(...ROLES.jurors).map((wallet) => [wallet.account.address.toLowerCase(), wallet]));
  const demoAddresses = new Set(jurors.keys());
  const demoJurors = [...demoAddresses];
  if (!journal.value<string[]>("jurors")) journal.setValue("jurors", demoJurors);
  if (JSON.stringify(journal.value<string[]>("jurors")) !== JSON.stringify(demoJurors)) throw new Error("Demo juror addresses changed; restore the original wallet configuration.");
  let stopped = false;
  process.once("SIGINT", () => { stopped = true; });
  process.once("SIGTERM", () => { stopped = true; });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = async () => (await publicClient.getBlock()).timestamp;
  const wait = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  function voteFor(proposed: boolean): number {
    if (mode === "yes") return 1;
    if (mode === "no") return 2;
    if (mode === "ambiguous") return 3;
    return (mode === "uphold" ? proposed : !proposed) ? 1 : 2;
  }
  type SavedVote = { vote: number; salt: Hex; commitment: Hex };
  let cursor = 1n;
  console.log(`Court bot watching ${jurors.size} demo jurors (vote: ${mode}; max ${scanBudget} markets / ${writeBudget} writes per poll).`);
  while (!stopped) {
    let writes = 0;
    const send = async (key: string, sender: Address, action: () => Promise<Hex>) => {
      if (writes >= writeBudget) return false;
      writes++;
      await journal.run(key, action, wait, sender);
      return true;
    };
    try {
      // Mining an empty local block avoids a signed self-transfer nonce/funding dependency.
      if (chainId === LOCAL_CHAIN_ID) await publicClient.request({ method: "evm_mine" as never });
      const count = await kleos.read.marketCount();
      if (cursor > count || cursor < 1n) cursor = 1n;
      const end = cursor + BigInt(scanBudget) - 1n > count ? count : cursor + BigInt(scanBudget) - 1n;
      for (let id = cursor; id <= end && !stopped; id++) {
        try {
          const market = await kleos.read.getMarket([id]);
          if (market.state !== 2) continue;
          const court = await kleos.read.getCourt([id]);
          const jury = await kleos.read.getJury([id, court.round]);
          const mine = selectDemoJurors(jury, demoAddresses);
          const key = `${id}:${court.round}`;
          const timestamp = await now();
          if (timestamp < court.commitEnd) {
            for (const address of mine) {
              try {
              const voteKey = `${key}:${address.toLowerCase()}`;
              await journal.reconcile(`${voteKey}:commit`, wait);
              let saved = journal.value<SavedVote>(voteKey);
              const existing = await kleos.read.commitments([id, court.round, address]);
              if (!saved && existing !== zeroHash) throw new Error(`Juror ${address} has an unknown commitment; its original salt is required.`);
              if (!saved) {
                const vote = voteFor(market.proposedOutcome);
                const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
                const commitment = await kleos.read.voteCommitment([id, court.round, address, vote, salt]);
                saved = { vote, salt, commitment };
                journal.setValue(voteKey, saved); // durable before broadcasting the hidden vote
              }
              if (existing !== zeroHash && existing !== saved.commitment) throw new Error(`Juror ${address}'s commitment differs from the saved vote; refusing to overwrite it.`);
              if (existing === saved.commitment) continue;
              if (!await send(`${voteKey}:commit`, address, () => kleos.write.commitVote([id, saved!.commitment], { account: jurors.get(address.toLowerCase())!.account }))) break;
              console.log(`Market ${id} round ${court.round}: ${address} committed.`);
              } catch (error) { console.error(`Market ${id}, juror ${address}: ${error instanceof Error ? error.message : "commit failed"}`); }
            }
          } else if (timestamp < court.revealEnd) {
            for (const address of mine) {
              try {
              const voteKey = `${key}:${address.toLowerCase()}`;
              await journal.reconcile(`${voteKey}:commit`, wait);
              await journal.reconcile(`${voteKey}:reveal`, wait);
              const saved = journal.value<SavedVote>(voteKey);
              if (await kleos.read.votes([id, court.round, address]) !== 0) continue;
              const existing = await kleos.read.commitments([id, court.round, address]);
              if (existing === zeroHash) continue;
              if (!saved || existing !== saved.commitment) throw new Error(`Juror ${address} cannot reveal without its matching saved vote and salt.`);
              if (!await send(`${voteKey}:reveal`, address, () => kleos.write.revealVote([id, saved.vote, saved.salt], { account: jurors.get(address.toLowerCase())!.account }))) break;
              console.log(`Market ${id} round ${court.round}: ${address} revealed.`);
              } catch (error) { console.error(`Market ${id}, juror ${address}: ${error instanceof Error ? error.message : "reveal failed"}`); }
            }
          } else {
            if (await send(`${key}:close`, operator.account.address, () => kleos.write.closeCourt([id], { account: operator.account }))) console.log(`Market ${id} round ${court.round}: close confirmed.`);
          }
        } catch (error) {
          // A reverted, delayed or externally closed market cannot stop all other duties.
          console.error(`Market ${id}: ${error instanceof Error ? error.message : "court action failed"}`);
        }
      }
      cursor = end + 1n;
    } catch (error) {
      console.error(`Court poll failed: ${error instanceof Error ? error.message : "RPC unavailable"}`);
    }
    if (!stopped) await sleep(pollMs);
  }
} finally { release(); }

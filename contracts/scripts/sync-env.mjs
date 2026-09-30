// Copies deployed addresses from Ignition into web/.env.local.
// Usage: node scripts/sync-env.mjs [chainId]   (default 31337, the local hardhat node)
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const chainId = process.argv[2] ?? "31337";
const addresses = JSON.parse(readFileSync(`ignition/deployments/chain-${chainId}/deployed_addresses.json`, "utf8"));
// The first block of the deployment: event reads (and the indexer) start there.
const journal = readFileSync(`ignition/deployments/chain-${chainId}/journal.jsonl`, "utf8");
const blocks = [...journal.matchAll(/"blockNumber":\s*"?(\d+)/g)].map((m) => Number(m[1]));
const values = {
  NEXT_PUBLIC_CHAIN: chainId === "31337" ? "local" : "",
  NEXT_PUBLIC_KLEOS_ADDRESS: addresses["KleosModule#Kleos"],
  NEXT_PUBLIC_USD_ADDRESS: addresses["KleosModule#KleosUSD"],
  NEXT_PUBLIC_SOCIAL_ADDRESS: addresses["KleosModule#KleosSocial"],
  NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK: blocks.length ? String(Math.min(...blocks)) : "0",
};

const path = "../web/.env.local";
let env = existsSync(path) ? readFileSync(path, "utf8") : "";
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
}
writeFileSync(path, env);
console.log(`web/.env.local ← chain ${chainId}`, values);

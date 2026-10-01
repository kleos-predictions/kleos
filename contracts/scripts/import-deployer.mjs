// Sets the Monad deploy account from a recovery phrase (or a private key), with no copy-paste
// into the keystore.
//
//   node scripts/import-deployer.mjs
//
// Reads the phrase with hidden input (any layout: one line, several lines, numbered words),
// derives the account m/44'/60'/0'/0/<ACCOUNT_INDEX>, prints only its address, and writes the
// private key to contracts/.env.deployer (git-ignored), which hardhat.config.ts loads.
// The phrase itself is never written anywhere.
import { chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { bytesToHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const VALID_COUNTS = [12, 15, 18, 21, 24];

// Reads lines with echo off until they hold a full phrase or a private key, or an empty line.
function readSecret() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    rl.output.write("Paste your recovery phrase or private key, then press Enter (nothing will show): ");
    rl._writeToOutput = () => {};
    let buf = "";
    const finish = () => {
      rl.close();
      process.stdout.write("\n");
      resolve(buf);
    };
    rl.on("line", (line) => {
      buf += ` ${line}`;
      const n = words(buf).length;
      if (!line.trim() || isKey(buf) || n >= 12) {
        if (n >= 12 && n < 24 && !VALID_COUNTS.includes(n) && line.trim()) return; // mid-paste of a longer phrase
        if (n === 12 && line.trim()) return setTimeout(() => (words(buf).length === 12 ? finish() : null), 300);
        return finish();
      }
      process.stdout.write(`\r${n} words so far. Paste the rest, or press Enter again to stop. `);
    });
    rl.on("close", () => resolve(buf));
  });
}

const words = (s) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
const keyOf = (s) => s.trim().replace(/^0x/i, "");
const isKey = (s) => /^[0-9a-f]{64}$/i.test(keyOf(s));

const input = await readSecret();
let key, address, label;
if (isKey(input)) {
  key = `0x${keyOf(input).toLowerCase()}`;
  address = privateKeyToAccount(key).address;
  label = "Deploy account";
} else {
  const w = words(input);
  if (!VALID_COUNTS.includes(w.length)) {
    console.error(`Got ${w.length} words; a recovery phrase has 12 or 24. Nothing was saved.`);
    process.exit(1);
  }
  const index = Number(process.env.ACCOUNT_INDEX ?? 0);
  const account = mnemonicToAccount(w.join(" "), { addressIndex: index });
  key = bytesToHex(account.getHdKey().privateKey);
  address = account.address;
  label = `Deploy account #${index}`;
}
// Always next to hardhat.config.ts, whatever directory this runs from.
const envPath = fileURLToPath(new URL("../.env.deployer", import.meta.url));
writeFileSync(envPath, `MONAD_PRIVATE_KEY=${key}\n`, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(`${label}: ${address}`);
console.log("Saved to contracts/.env.deployer (git-ignored).");
if (label !== "Deploy account") console.log("Not your address? Run again with ACCOUNT_INDEX=1, 2, …");

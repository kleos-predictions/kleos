// Demo wallets for seeding, the court bot and the dispute helper.
//
// On the local node they are its pre-funded accounts. On Monad testnet they are derived from a
// demo mnemonic kept in contracts/.env.demo (git-ignored, created on first use) and topped up
// from the deployer with only as much MON as each role needs. The mnemonic is never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, http, parseEther, type Account, type Address, type PublicClient, type WalletClient } from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

export const DEMO_ENV = ".env.demo";
export const LOCAL_CHAIN_ID = 31337;
const COUNT = 19; // 6 personas, 8 jurors, 5 extra bettors

// Wallet layout shared by every script: personas 0–5, jurors 6–13, extra bettors 14–18.
export const ROLES = { personas: [0, 6], jurors: [6, 14], extras: [14, 19] } as const;

// Gas budgets per role at ~100 gwei, with headroom (Monad charges the gas limit).
const BUDGET = { persona: parseEther("0.12"), juror: parseEther("0.05"), extra: parseEther("0.04") };

function readDemoEnv(): Record<string, string> {
  if (!existsSync(DEMO_ENV)) return {};
  return Object.fromEntries(
    readFileSync(DEMO_ENV, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

export function writeDemoEnv(key: string, value: string) {
  const env = { ...readDemoEnv(), [key]: value };
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(DEMO_ENV, `# Demo wallets for Monad testnet. Never commit this file.\n${body}\n`, { mode: 0o600 });
}

export function demoSecret(key: string): string | undefined {
  return readDemoEnv()[key];
}

export type DemoWallet = WalletClient & { account: Account };
type Viem = { getWalletClients: () => Promise<WalletClient[]> };

export async function getDemoWallets(viem: Viem, chainId: number): Promise<DemoWallet[]> {
  if (chainId === LOCAL_CHAIN_ID) return (await viem.getWalletClients()).slice(1, 1 + COUNT) as DemoWallet[];
  let mnemonic = demoSecret("DEMO_MNEMONIC");
  if (!mnemonic) {
    mnemonic = generateMnemonic(english);
    writeDemoEnv("DEMO_MNEMONIC", mnemonic);
    console.log(`Created demo wallets; the mnemonic is in contracts/${DEMO_ENV} (git-ignored).`);
  }
  const rpc = process.env.MONAD_RPC_URL ?? monadTestnet.rpcUrls.default.http[0];
  return Array.from({ length: COUNT }, (_, i) =>
    createWalletClient({ account: mnemonicToAccount(mnemonic!, { addressIndex: i }), chain: monadTestnet, transport: http(rpc) }),
  ) as DemoWallet[];
}

/** Tops each demo wallet up to its role's gas budget. No-op on the local node. */
export async function fundDemoWallets(owner: WalletClient, wallets: WalletClient[], publicClient: PublicClient, chainId: number) {
  if (chainId === LOCAL_CHAIN_ID) return;
  let spent = 0n;
  for (const [i, w] of wallets.entries()) {
    const budget = i < ROLES.personas[1] ? BUDGET.persona : i < ROLES.jurors[1] ? BUDGET.juror : BUDGET.extra;
    const address = w.account!.address as Address;
    const balance = await publicClient.getBalance({ address });
    if (balance >= budget) continue;
    const hash = await owner.sendTransaction({ account: owner.account!, chain: owner.chain, to: address, value: budget - balance });
    await publicClient.waitForTransactionReceipt({ hash });
    spent += budget - balance;
  }
  console.log(`Funded demo wallets with ${Number(spent) / 1e18} MON`);
}

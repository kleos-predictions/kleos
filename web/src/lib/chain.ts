import { http, createConfig } from "wagmi";
import { hardhat, monadTestnet as viemMonadTestnet } from "viem/chains";
import { createPublicClient, type Address } from "viem";

export const monadTestnet = {
  ...viemMonadTestnet,
  blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
} as const;

/** NEXT_PUBLIC_CHAIN=local targets `npx hardhat node` for end-to-end testing on this machine. */
export const IS_LOCAL_CHAIN = process.env.NEXT_PUBLIC_CHAIN === "local";
export const chain = IS_LOCAL_CHAIN ? hardhat : monadTestnet;

export const EXPLORER = monadTestnet.blockExplorers.default.url;
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;

/** Set these after deploying the contracts (see ../contracts). Empty = demo mode with sample data. */
export const KLEOS_ADDRESS = process.env.NEXT_PUBLIC_KLEOS_ADDRESS as Address | undefined;
export const USD_ADDRESS = process.env.NEXT_PUBLIC_USD_ADDRESS as Address | undefined;
export const IS_LIVE = Boolean(KLEOS_ADDRESS && USD_ADDRESS);

// Monad produces a block every ~400 ms; viem's default 4 s polling would add seconds to every confirmation.
export const POLLING_MS = 250;
export const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: POLLING_MS });

// Reads only. Accounts come from Mera passkeys (see lib/mera.ts), never from a wallet extension.
// The active chain goes first, so wagmi reads default to it.
export const wagmiConfig = createConfig({
  chains: IS_LOCAL_CHAIN ? [hardhat, monadTestnet] : [monadTestnet, hardhat],
  connectors: [],
  transports: { [monadTestnet.id]: http(), [hardhat.id]: http() },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

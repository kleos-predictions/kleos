import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet as viemMonadTestnet } from "viem/chains";
import type { Address } from "viem";

export const monadTestnet = {
  ...viemMonadTestnet,
  blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
} as const;

export const EXPLORER = monadTestnet.blockExplorers.default.url;
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;

/** Set these after `npm run deploy:monad` in /contracts. Empty = demo mode. */
export const KLEOS_ADDRESS = process.env.NEXT_PUBLIC_KLEOS_ADDRESS as Address | undefined;
export const USD_ADDRESS = process.env.NEXT_PUBLIC_USD_ADDRESS as Address | undefined;
export const IS_LIVE = Boolean(KLEOS_ADDRESS && USD_ADDRESS);

export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: { [monadTestnet.id]: http() },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

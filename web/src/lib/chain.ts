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
export const SOCIAL_ADDRESS = process.env.NEXT_PUBLIC_SOCIAL_ADDRESS as Address | undefined;
export const IS_LIVE = Boolean(KLEOS_ADDRESS && USD_ADDRESS);

// Monad produces a block every ~400 ms; viem's default 4 s polling would add seconds to every confirmation.
export const POLLING_MS = 250;
// On the server, MONAD_RPC_URL (a private node, never sent to the browser) replaces the public RPC.
const serverRpc = typeof window === "undefined" && !IS_LOCAL_CHAIN ? process.env.MONAD_RPC_URL : undefined;
// Reads made together are batched into one multicall where the chain has Multicall3 (Monad
// testnet does; a bare local node doesn't).
const batch = chain.contracts && "multicall3" in chain.contracts ? { multicall: true } : undefined;
export const publicClient = createPublicClient({ chain, transport: http(serverRpc), pollingInterval: POLLING_MS, batch });

// Event reads on the server go through Envio's HyperRPC when MONAD_LOGS_RPC is set
// (https://10143.rpc.hypersync.xyz/<ENVIO_API_TOKEN>): it serves eth_getLogs over any block range,
// where the public Monad RPC allows 100 blocks per call. Server-only; the URL carries a token.
const logsRpc = typeof window === "undefined" && !IS_LOCAL_CHAIN ? process.env.MONAD_LOGS_RPC : undefined;
export const HAS_LOGS_RPC = Boolean(logsRpc) || IS_LOCAL_CHAIN;
// Without HyperRPC, logs come from the chain's public RPC: private nodes on free plans (e.g.
// Chainstack) refuse eth_getLogs as an archive request, while the public RPC serves 100 blocks a call.
export const logsClient = createPublicClient({ chain, transport: http(logsRpc) });

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

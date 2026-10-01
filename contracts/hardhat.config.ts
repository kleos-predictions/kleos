import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Deploy key from scripts/import-deployer.mjs (git-ignored). Without it, the keystore is used.
const deployerEnv = fileURLToPath(new URL("./.env.deployer", import.meta.url));
if (existsSync(deployerEnv)) process.loadEnvFile(deployerEnv);

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: false },
  },
  paths: { sources: "./src", tests: { nodejs: "./test" } },
  networks: {
    default: { type: "edr-simulated", accounts: { count: 30 } },
    monadTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 10143,
      url: "https://testnet-rpc.monad.xyz",
      accounts: [configVariable("MONAD_PRIVATE_KEY")],
    },
  },
});

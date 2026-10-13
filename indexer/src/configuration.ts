import type { ContractConfiguration, EvmOnEventContext } from "envio";
import { addressId } from "./utils.js";

// Public immutable reads from the source-matched runtime, pinned at this exact block.
// This is one deployment's
// configuration, never a default for other addresses, chains or future deployments.
const verifiedTestnet = {
  chainId: 10143,
  address: "0xd68a1f212fa52663468bbb6f0456cd6e7ce854cb",
  source: "PinnedSnapshot" as const,
  vestPeriod: 300n,
  nMin: 10n,
  disputeWindow: 120n,
  courtPeriod: 180n,
  blockNumber: 67671344,
  blockHash: "0x3ca42a299a11b0e53f40d0635f14151a930e0ac3a48213862ed743f8930edf4d",
  runtimeSha256: "28f0bf8cfa869bd227bbc69a81a721f59f90c74350d0f4e7dea9d76122190115",
};

export function getConfiguration(context: EvmOnEventContext, contractAddress: string): Promise<ContractConfiguration> {
  const id = addressId(contractAddress);
  const verified = context.chain.id === verifiedTestnet.chainId && id === verifiedTestnet.address;
  return context.ContractConfiguration.getOrCreate({
    id,
    source: verified ? verifiedTestnet.source : "Unknown",
    vestPeriod: verified ? verifiedTestnet.vestPeriod : undefined,
    nMin: verified ? verifiedTestnet.nMin : undefined,
    disputeWindow: verified ? verifiedTestnet.disputeWindow : undefined,
    courtPeriod: verified ? verifiedTestnet.courtPeriod : undefined,
    blockNumber: verified ? verifiedTestnet.blockNumber : undefined,
    blockHash: verified ? verifiedTestnet.blockHash : undefined,
    runtimeSha256: verified ? verifiedTestnet.runtimeSha256 : undefined,
    txHash: undefined,
  });
}

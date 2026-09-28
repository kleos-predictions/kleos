// Passkey accounts with Mera. The passkey's PRF output is the root of the account:
// PRF → BIP-39 entropy → seed → m/44'/60'/0'/0/0. The same passkey rebuilds the same account
// on any device, and nothing secret is ever stored. Every function here must run in a click
// handler, with the passkey call as the first `await` (Safari requires it).

import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getEvmAddress,
  getPasskeyPrfOutput,
  isMeraError,
  type EvmAddress,
  type PasskeyCredentialMetadata,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { HDKey } from "@scure/bip32";
import { BaseError, ContractFunctionRevertedError, InsufficientFundsError, toFunctionSelector } from "viem";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export type UnlockedAccount = {
  session: Secp256k1SigningSession;
  address: EvmAddress;
  credential: PasskeyCredentialMetadata;
};

const RP_NAME = "Kleos";
const EVM_PATH = "m/44'/60'/0'/0/0";

// The rpId is the site's hostname. Accounts are bound to it, so production must use one fixed domain.
const rpId = () => location.hostname;

function accountFromPrf(prfOutput: Uint8Array, credential: PasskeyCredentialMetadata): UnlockedAccount {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  prfOutput.fill(0);
  try {
    const node = HDKey.fromMasterSeed(seed).derive(EVM_PATH);
    if (!node.privateKey) throw new Error("Key derivation failed");
    const session = createSecp256k1SigningSession({ privateKey: node.privateKey });
    return { session, address: getEvmAddress(session.publicKey), credential };
  } finally {
    seed.fill(0);
  }
}

/** Creates a new passkey and the account it derives. One or two system prompts. */
export async function createAccount(): Promise<UnlockedAccount> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: rpId(), name: RP_NAME },
    user: {
      name: "kleos",
      displayName: `Kleos · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
    },
  });
  const credential = { credentialId: created.credentialId, ...(created.transports ? { transports: created.transports } : {}) };
  return accountFromPrf(created.prfOutput, credential);
}

/** Rebuilds the account from an existing passkey. Without a pinned credential the platform offers any synced passkey. */
export async function unlockAccount(credential?: PasskeyCredentialMetadata): Promise<UnlockedAccount> {
  const { prfOutput, credentialId } = await getPasskeyPrfOutput({ rpId: rpId(), ...(credential ? { credential } : {}) });
  return accountFromPrf(prfOutput, credential?.credentialId === credentialId ? credential : { credentialId });
}

/** The 24-word recovery phrase, re-derived behind a fresh passkey prompt. Works in any standard wallet. */
export async function revealRecoveryPhrase(credential: PasskeyCredentialMetadata): Promise<string> {
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: rpId(), credential });
  try {
    return entropyToMnemonic(prfOutput, wordlist);
  } finally {
    prfOutput.fill(0);
  }
}

const CONTRACT_ERRORS: Record<string, string> = {
  InsufficientBalance: "Not enough test USD for this bet.",
  InsufficientAllowance: "Test USD isn't enabled for Kleos yet. Try again.",
  MarketClosed: "This market is closed for betting.",
  BetTooSmall: "The minimum bet is $1.",
  CallTooLong: "Your call is over 140 characters.",
  NotEligibleResolver: "You need tier II and no position in this market to do that.",
  NameTaken: "That username is taken.",
  BadName: "Usernames are 3–20 characters: a–z, 0–9 and _.",
};

// Errors raised by a contract Kleos calls into (kUSD) can't be decoded by name, so match selectors too.
const BY_SELECTOR = Object.fromEntries(Object.keys(CONTRACT_ERRORS).map((name) => [toFunctionSelector(`${name}()`), name]));

/** Turns wallet, passkey and contract failures into one sentence a person can act on. */
export function describeAccountError(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    const name =
      revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? (revert.signature ? BY_SELECTOR[revert.signature] : undefined)) : undefined;
    if (name && CONTRACT_ERRORS[name]) return CONTRACT_ERRORS[name];
    if (error.walk((e) => e instanceof InsufficientFundsError)) return "Your account is out of gas money. Refresh to top it up.";
  }
  if (isMeraError(error)) {
    switch (error.code) {
      case "PASSKEY_OPERATION_FAILED":
        return "Passkey prompt was closed. Try again when you're ready.";
      case "PRF_UNAVAILABLE":
        return "This passkey manager can't create Kleos accounts. Use iCloud Keychain, Google Password Manager or 1Password.";
      case "SESSION_ENDED":
        return "Your session ended. Unlock with your passkey to continue.";
      case "CRYPTO_UNAVAILABLE":
        return "This browser doesn't support passkeys here. Use HTTPS or localhost.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message.split("\n")[0] : "Something went wrong.";
}

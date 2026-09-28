# Kleos in Chaos

Parimutuel prediction market with a verifiable reputation layer, on Monad testnet. Product and mechanism: `README.md`.

## Layout

```
contracts/   Hardhat 3 + viem. Kleos.sol (markets, reputation, Kleos Court), KleosUSD.sol (test token),
             KleosSocial.sol (names, follows, call votes). Tests in test/, deploy in ignition/, scripts/
web/         Next.js 16 app. Has its own web/AGENTS.md: read it before touching web code.
design/      Reference exports from Claude Design. Not built.
.agents/skills/  Task playbooks for agents, in the Agent Skills format (see below).
             .claude/skills/ holds symlinks to them, because Claude Code only scans that folder.
```

## Skills

Before one of these tasks, read the matching `.agents/skills/<name>/SKILL.md` and follow it. To add a skill, create it under `.agents/skills/<name>/` and add a symlink: `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.

| Skill | Use when |
|---|---|
| `dev-stack` | Running the app locally against a local chain, or resetting it |
| `contract-change` | Editing any `.sol` file, or any constant the web app mirrors |
| `envio-indexer` | Working in `indexer/` (Envio HyperIndex) or the web code that reads from it |

## Rules

- **No deploys, wallet actions or private-key use on Monad testnet** without the owner's explicit authorization for that specific action. The local chain is fine.
- **Secrets stay in env vars**, never in the repo or the client bundle. Only `NEXT_PUBLIC_*` values reach the browser.
- **The contract is the source of truth.** `web/src/lib/math.ts` mirrors its constants and formulas, and `web/src/lib/abi.ts` is generated. Change them only via `contract-change`.
- **Demo mode must keep working.** With no contract addresses set, the app renders sample data from `web/src/lib/data.ts`. Every live read needs that fallback.
- **Passkey accounts (Mera):** the WebAuthn call must be the first `await` in a click handler (Safari). Persist only the credential id and address, never the PRF output, mnemonic, seed, key or session. Details: `web/src/lib/mera.ts`, `web/src/components/account.tsx`.
- **Accounts come from `useKleosAccount()`**, not wagmi's `useAccount()`: wagmi has no connectors here and is used for reads only.
- **Money and reputation stay apart from social features.** Social logic goes in `KleosSocial.sol`, not `Kleos.sol`.

## Checks

```bash
npm --prefix contracts test      # contract tests
npm --prefix web run lint        # web lint
npm --prefix web run build       # web type-check and build
```

## Writing

User-facing copy and docs: short, plain sentences, no hype. Figures on the compare page need a source (`web/src/lib/cases.ts`).

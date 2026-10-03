import type { PasskeyCredentialMetadata } from "@category-labs/mera";

export type PublicAccountMetadata = { credential: PasskeyCredentialMetadata; address: `0x${string}` };
export type PromptToken = { epoch: number; id: number };

/** Keeps native passkey prompts exclusive and rejects results from a locked/replaced session. */
export class AccountPromptGate {
  private version = 0;
  private nextId = 0;
  private prompt: PromptToken | null = null;

  get epoch() { return this.version; }

  begin(): PromptToken | null {
    if (this.prompt) return null;
    this.prompt = { epoch: this.version, id: ++this.nextId };
    return this.prompt;
  }

  current(epoch: number) { return epoch === this.version; }

  invalidate() { return ++this.version; }

  finish(token: PromptToken) {
    if (this.prompt?.id === token.id) this.prompt = null;
  }
}

/** Only public credential metadata is accepted from persistence. */
export function parsePublicAccount(raw: string | null): PublicAccountMetadata | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const { address, credential } = value as Partial<PublicAccountMetadata>;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || !credential || typeof credential !== "object") return null;
    if (typeof credential.credentialId !== "string" || !/^[A-Za-z0-9_-]+$/.test(credential.credentialId)) return null;
    const transports = credential.transports;
    if (transports !== undefined && (!Array.isArray(transports) || !transports.every((transport) => typeof transport === "string"))) return null;
    return { address, credential: { credentialId: credential.credentialId, ...(transports ? { transports } : {}) } };
  } catch {
    return null;
  }
}

export function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

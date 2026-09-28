"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { SOCIAL_ADDRESS, chain, publicClient } from "@/lib/chain";
import { kleosSocialAbi } from "@/lib/abi";
import { describeAccountError } from "@/lib/mera";
import { useKleosAccount } from "./account";

const VALID = /^[a-z0-9_]{3,20}$/;

/** "Edit username" on your own profile: a small dialog to pick or change your username. */
export function NameEditor({ current }: { current?: string }) {
  const account = useKleosAccount();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!SOCIAL_ADDRESS) return null;

  const trigger = (
    <button className="btn btn-no !min-h-8 !px-3 !text-xs" onClick={() => setOpen(true)}>
      Edit username
    </button>
  );
  if (!open) return trigger;

  async function save() {
    const name = value.trim().toLowerCase();
    if (!VALID.test(name)) return setError("3–20 characters: a–z, 0–9 and _");
    const client = await account.authorize(); // first await: may show the passkey prompt
    if (!client?.account) return;
    setBusy(true);
    setError(null);
    try {
      await account.whenFunded();
      const hash = await client.writeContract({ account: client.account, chain, address: SOCIAL_ADDRESS!, abi: kleosSocialAbi, functionName: "setName", args: [name] });
      await publicClient.waitForTransactionReceipt({ hash });
      setOpen(false);
      router.refresh();
    } catch (e) {
      const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      const reason = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
      setError(reason === "NameTaken" ? "That username is taken." : reason === "BadName" ? "3–20 characters: a–z, 0–9 and _" : describeAccountError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {trigger}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
        <form
          role="dialog"
          aria-label="Edit username"
          className="card flex w-full max-w-md flex-col gap-4 p-6"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <span className="lbl">Edit username</span>
          <label className="flex flex-col gap-2">
            <span className="text-sm text-muted">Username · 3–20 characters, a–z, 0–9 and _</span>
            <span className="flex items-center rounded-[12px] border border-line bg-ground px-4 focus-within:border-line-strong">
              <span className="text-muted">@</span>
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value.toLowerCase())}
                maxLength={20}
                placeholder="username"
                aria-label="Username"
                className="w-full bg-transparent py-3 pl-1 text-lg text-ink outline-none"
              />
            </span>
          </label>
          {error && <p className="text-sm text-accent">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-no" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-yes" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

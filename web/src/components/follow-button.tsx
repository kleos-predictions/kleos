"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { encodeFunctionData, type Address } from "viem";
import { SOCIAL_ADDRESS, chain } from "@/lib/chain";
import { kleosSocialAbi } from "@/lib/abi";
import { describeAccountError } from "@/lib/mera";
import { useKleosAccount } from "./account";
import { NameEditor } from "./name-editor";
import { PendingTransactionNotice, usePendingTransaction } from "./pending-transaction";

/** Follow on-chain, so the list comes with the passkey to any device. Prompt-free while unlocked. */
export function FollowButton({ who, name }: { who: Address; name?: string }) {
  const account = useKleosAccount();
  const router = useRouter();
  const me = account.address;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const transaction = usePendingTransaction(`follow:${SOCIAL_ADDRESS}:${who}`);

  const { data: following, refetch: refetchFollowing } = useReadContract({
    address: SOCIAL_ADDRESS,
    abi: kleosSocialAbi,
    functionName: "isFollowing",
    args: me ? [me, who] : undefined,
    query: { enabled: Boolean(SOCIAL_ADDRESS && me) },
  });
  const { data: followers, refetch: refetchCount } = useReadContract({
    address: SOCIAL_ADDRESS,
    abi: kleosSocialAbi,
    functionName: "followerCount",
    args: [who],
    query: { enabled: Boolean(SOCIAL_ADDRESS) },
  });

  if (!SOCIAL_ADDRESS) return null;
  const isMe = me?.toLowerCase() === who.toLowerCase();

  async function toggle() {
    if (inFlight.current || transaction.hasPending()) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const client = await account.authorize(); // first await: may show the passkey prompt
      if (!client?.account) return;
      await account.whenFunded(client.account.address);
      const functionName = following ? "unfollow" : "follow";
      const hash = await client.writeContract({
        account: client.account,
        chain,
        address: SOCIAL_ADDRESS!,
        abi: kleosSocialAbi,
        functionName,
        args: [who],
      });
      await transaction.confirm(hash, { sender: client.account.address, to: SOCIAL_ADDRESS!, data: encodeFunctionData({ abi: kleosSocialAbi, functionName, args: [who] }) });
      transaction.complete();
      await Promise.all([refetchFollowing(), refetchCount()]);
      router.refresh();
    } catch (e) {
      setError(describeAccountError(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <span className="lbl">
        <span className="text-ink">{followers?.toString() ?? "—"}</span> followers
      </span>
      {isMe ? (
        <NameEditor current={name} />
      ) : (
        <button className={`btn !min-h-8 !px-3 !text-xs ${following ? "btn-no" : "btn-yes"}`} onClick={toggle} disabled={busy || Boolean(transaction.pending)}>
          {busy ? "…" : following ? "Following" : "Follow"}
        </button>
      )}
      {error && <span className="max-w-48 text-right text-xs text-muted">{error}</span>}
      <PendingTransactionNotice transaction={transaction} onCheck={() => { void transaction.check().then(async () => { transaction.complete(); await Promise.all([refetchFollowing(), refetchCount()]); router.refresh(); }).catch(e => setError(describeAccountError(e))); }} />
    </div>
  );
}

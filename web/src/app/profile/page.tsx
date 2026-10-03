"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useKleosAccount } from "@/components/account";
import { TRADERS } from "@/lib/data";
import { IS_LIVE } from "@/lib/chain";
import { LaurelBadge } from "@/components/laurel";

export default function MyProfile() {
  const { address } = useKleosAccount();
  const router = useRouter();
  useEffect(() => {
    if (address) router.replace(`/profile/${address}`);
  }, [address, router]);

  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <LaurelBadge r={0} size={96} label={false} />
      <h1 className="font-dot text-4xl font-black">START WITH A PASSKEY TO SEE YOUR RECORD</h1>
      <p className="text-muted">Every reputation change is public. You can also look at anyone else&apos;s.</p>
      <Link href={IS_LIVE ? "/leaderboard" : `/profile/${TRADERS[0].address}`} className="btn btn-no">
        View participants
      </Link>
    </main>
  );
}

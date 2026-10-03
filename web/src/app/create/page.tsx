import type { Metadata } from "next";
import { CreateMarketForm } from "@/components/create-market-form";

export const metadata: Metadata = { title: "Create a market · Kleos" };

export default function CreatePage() {
  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-6 px-4 pt-10 pb-16 md:px-0">
      <header className="flex flex-col gap-3">
        <h1 className="font-dot text-[30px] leading-[1.08] font-black md:text-[42px]">
          ASK THE QUESTION<span className="cursor-blink text-accent">_</span>
        </h1>
        <p className="text-lg leading-relaxed text-muted">
          The team and eligible tier-V addresses can create markets. Tier V is an R threshold, not a verified skill credential.
          Creators publish fixed criteria before bets. The owner has a narrow proposal exception on its own unbet markets.
        </p>
      </header>
      <CreateMarketForm />
    </main>
  );
}

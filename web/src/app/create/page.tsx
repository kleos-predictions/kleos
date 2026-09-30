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
          On other platforms, the platform decides what you can bet on. On Kleos, the traders who&apos;ve proven they&apos;re right earn the
          right to ask. Whoever writes the question never resolves it.
        </p>
      </header>
      <CreateMarketForm />
    </main>
  );
}

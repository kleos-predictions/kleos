"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Wordmark } from "./laurel";
import { AccountButton } from "./account-button";

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/compare", label: "Compare" },
  { href: "/how-it-works", label: "How it works" },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();

  return (
    <nav className="border-b border-line">
      <div className="mx-auto flex min-h-[76px] max-w-[1440px] flex-wrap items-center gap-x-10 gap-y-3 px-4 py-3 md:px-12">
        <Link href="/markets" aria-label="Kleos home">
          <Wordmark />
        </Link>

        <div className="order-3 flex gap-7 md:order-none">
          {LINKS.map((l) => {
            const active = pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`font-mono text-sm tracking-[0.06em] uppercase ${active ? "text-ink" : "text-muted"}`}
                aria-current={active ? "page" : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </div>

        <form
          role="search"
          className="order-4 flex h-11 w-full items-center gap-2.5 rounded-[12px] border border-line bg-card px-4 lg:order-none lg:w-auto lg:flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const q = new FormData(e.currentTarget).get("q") as string;
            router.push(`/markets${q ? `?q=${encodeURIComponent(q)}` : ""}`);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            name="q"
            aria-label="Search markets"
            placeholder="Search markets"
            defaultValue={params.get("q") ?? ""}
            className="flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-muted"
          />
        </form>

        <div className="ml-auto md:ml-0">
          <AccountButton />
        </div>
      </div>
    </nav>
  );
}

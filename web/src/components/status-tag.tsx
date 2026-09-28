import type { Status } from "@/lib/data";

export function StatusTag({ status }: { status: Status }) {
  switch (status) {
    case "live":
      return (
        <span className="lbl flex items-center gap-1.5 !text-accent">
          <span className="size-1.5 rounded-full bg-accent" />
          Live
        </span>
      );
    case "closing":
      return <span className="lbl rounded-full border border-accent px-2 py-0.5 !text-ink">Closing soon</span>;
    case "dispute":
      return <span className="lbl rounded-full border border-line-strong px-2 py-0.5">Dispute window</span>;
    case "resolved":
      return <span className="lbl rounded-full bg-ink px-2 py-0.5 !text-ground">Resolved</span>;
  }
}

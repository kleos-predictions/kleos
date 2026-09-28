/**
 * Doto renders "." as a small cross, which reads like a plus sign at display sizes.
 * This swaps it for a square dot that matches the dot-matrix grid.
 */
export function DotNumber({ value, className = "" }: { value: string; className?: string }) {
  const parts = value.split(".");
  return (
    <span className={`font-dot font-black ${className}`}>
      {parts[0]}
      {parts.length > 1 && (
        <>
          <span className="mx-[0.04em] inline-block size-[0.12em] bg-current align-baseline" aria-hidden="true" />
          <span className="sr-only">.</span>
          {parts[1]}
        </>
      )}
    </span>
  );
}

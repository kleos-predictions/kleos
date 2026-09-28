import { existsSync } from "node:fs";
import path from "node:path";

/** A platform's mark, deliberately blurred: a nod, not an endorsement. */
export function BrandMark({ name, size = 24 }: { name: string; size?: number }) {
  const slug = name.toLowerCase();
  const file = ["svg", "png"]
    .map((ext) => `/brands/${slug}.${ext}`)
    .find((src) => existsSync(path.join(process.cwd(), "public", src)));
  return (
    <span className="inline-flex items-center" title={name}>
      {file ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file} alt={name} style={{ height: size, width: "auto" }} className="opacity-70 blur-[2.5px] grayscale" />
      ) : (
        <span className="font-sans font-bold tracking-tight opacity-70 blur-[2.5px] select-none" style={{ fontSize: size * 0.75 }} aria-label={name}>
          {name}
        </span>
      )}
    </span>
  );
}

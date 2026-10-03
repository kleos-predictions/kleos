import { isAddress } from "viem";
import { kleosSocialAbi } from "@/lib/abi";
import { IS_LIVE, SOCIAL_ADDRESS, publicClient } from "@/lib/chain";
import { readFeed } from "@/lib/onchain";
import { preferIndexer, readFilteredFeed } from "@/lib/indexer";

/** Public reads only: filtering occurs before pagination, within explicit RPC/history budgets. */
export async function GET(request: Request) {
  if (!IS_LIVE) return Response.json({ error: "Live feed is not configured." }, { status: 503 });
  const query = new URL(request.url).searchParams;
  const tab = query.get("tab");
  if (tab !== "sharps" && tab !== "following") return Response.json({ error: "Choose a feed filter." }, { status: 400 });
  try {
    if (tab === "sharps") return Response.json({ items: await preferIndexer(
      () => readFilteredFeed({ minR: 16n * 10n ** 18n }, 50),
      () => readFeed(50, undefined, { minR: 16n * 10n ** 18n }),
    ) }, { headers: { "Cache-Control": "no-store" } });
    const address = query.get("address");
    const socialAddress = SOCIAL_ADDRESS;
    if (!address || !isAddress(address) || !socialAddress) return Response.json({ error: "Select an account to read follows." }, { status: 400 });
    const items = await preferIndexer(() => readFilteredFeed({ follower: address }, 50), async () => {
      const blockNumber = await publicClient.getBlockNumber();
      const authors = await publicClient.readContract({ address: socialAddress, abi: kleosSocialAbi, functionName: "following", args: [address], blockNumber });
      return readFeed(50, undefined, { authors, blockNumber });
    });
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "This feed could not be read within its budget. Try again or use an indexed deployment." }, { status: 503 });
  }
}

// KleosSocial: usernames, follows and call votes. Engagement only: none of it touches money or R.
import { indexer } from "envio";
import { addressId, getTrader } from "../utils.js";

const followId = (follower: string, followee: string) => `${addressId(follower)}_${addressId(followee)}`;

indexer.onEvent({ contract: "KleosSocial", event: "NameSet" }, async ({ event, context }) => {
  const trader = await getTrader(context, event.params.user);
  context.Trader.set({ ...trader, name: event.params.name });
});

// follow and unfollow emit only on a real change, so the counts can move by one each time.
indexer.onEvent(
  { contract: "KleosSocial", event: "Followed", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const { follower, followee } = event.params;
    const [a, b] = await Promise.all([getTrader(context, follower), getTrader(context, followee)]);
    context.Follow.set({ id: followId(follower, followee), follower_id: a.id, followee_id: b.id, since: event.block.timestamp });
    context.Trader.set({ ...a, followingCount: a.followingCount + 1 });
    context.Trader.set({ ...b, followerCount: b.followerCount + 1 });
  },
);

indexer.onEvent({ contract: "KleosSocial", event: "Unfollowed" }, async ({ event, context }) => {
  const { follower, followee } = event.params;
  const [a, b] = await Promise.all([getTrader(context, follower), getTrader(context, followee)]);
  context.Follow.deleteUnsafe(followId(follower, followee));
  context.Trader.set({ ...a, followingCount: a.followingCount - 1 });
  context.Trader.set({ ...b, followerCount: b.followerCount - 1 });
});

// vote emits only when the value changes: +1 up, -1 down, 0 clears.
indexer.onEvent({ contract: "KleosSocial", event: "CallVoted" }, async ({ event, context }) => {
  const { callId, voter, vote } = event.params;
  const id = `${callId}_${addressId(voter)}`;
  const value = Number(vote);
  const [previous, call, trader] = await Promise.all([
    context.CallVote.get(id),
    context.Call.get(callId.toString()),
    getTrader(context, voter), // voters need not have traded, but CallVote.voter must resolve
  ]);
  const before = previous?.value ?? 0;

  if (value === 0) context.CallVote.deleteUnsafe(id);
  else context.CallVote.set({ id, call_id: callId.toString(), voter_id: trader.id, value });

  const move = (t: { ups: number; downs: number }) => ({
    ups: t.ups - (before > 0 ? 1 : 0) + (value > 0 ? 1 : 0),
    downs: t.downs - (before < 0 ? 1 : 0) + (value < 0 ? 1 : 0),
  });
  if (call) {
    context.Call.set({ ...call, ...move(call) });
  } else {
    // The call isn't posted yet: keep a running tally by id, so CallPosted needn't query votes.
    const tally = (await context.PendingCallTally.get(callId.toString())) ?? { id: callId.toString(), ups: 0, downs: 0 };
    context.PendingCallTally.set({ ...tally, ...move(tally) });
  }
});

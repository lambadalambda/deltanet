# Visibility tiers via multiple channels (public + locked)

## Scope decision (2026-07-08, picked up)

Split into PART 1 (this issue) and PART 2 (leak-prevention sweep, split
out to [[visibility-leak-prevention]] when reached):

- Part 1A: the locked channel (lazy, config key next to the feed's),
  `post()` channel choice, composer visibility mapped (public/unlisted →
  public channel, `private` "Followers" → locked; `direct` stays
  unimplemented for now), own locked posts render `visibility: private`,
  stats/timelineFrom/invites aggregate or parameterize over both
  channels. Migration free: the existing feed IS the public channel.
- Part 1B: locked follow-request flow. Substrate reality: securejoin
  links are capability-based — there is no join-with-approval. So the
  locked invite is NEVER published; a requester sends a `locked`-scoped
  invite-request (the existing wire convention, thread-scoping
  precedent), the owner's daemon QUEUES it (follow_request notification +
  `/api/v1/follow_requests` endpoints — the frontend UI for these already
  exists), and approval DMs the locked invite, which the requester's
  existing follow-back machinery joins.
- Part 1C: minimal LOCAL leak guards so "Followers" isn't a false
  promise: locked post uuids recorded in the store (non-derivable root,
  survives migrate), backfill serving refuses them, and boosting one's
  own locked post is refused. DEFERRED to part 2 (documented, not
  silent): envelope visibility markers + remote honoring (other daemons
  refusing to boost/serve), thread-channel gating for locked roots, and
  reply-privacy inheritance (a locked follower's reply goes to their own
  public feed today).

## Summary

Design sketch #1 (docs/design-sketches.md). One account owns two broadcast
channels: a public one (invite-requests auto-granted, link meant for
publication) and a locked one (grants require approval). The Mastodon
visibility selector maps onto them instead of being decorative.

## Requirements

- Transport/daemon: manage two owned channels (create lazily; persist
  chat ids in config like the current feed). `public` visibility posts →
  public channel; `private` → locked channel. Timeline/stats/statuses
  aggregate both plus followed feeds as today.
- Locked grants: invite-requests scoped to the locked channel queue for
  approval instead of auto-granting (approve/deny via API — map onto
  Mastodon follow_requests endpoints, which the frontend already
  understands). Public channel keeps auto-grant.
- Followers of both channels shouldn't get duplicate copies of public
  posts... decide: post public → public channel only; locked followers
  implicitly follow public too (grant both on locked approval). Document
  the choice.
- Relationship/counters: follower counts aggregate channels; relationship
  `following` true if following either; expose which tier somewhere
  sensible (pleroma extension field is fine).
- Invite endpoints (`/api/deltanet/invite`) gain a channel parameter;
  share-your-feed UI shows the public invite by default.
- Existing single-feed accounts migrate seamlessly: current feed becomes
  the public channel.

## Acceptance Criteria

- Posting with visibility public/private from the composer delivers to
  the right audience (integration: locked follower sees both tiers,
  public-only follower sees only public).
- Locked channel follow-request flow works end to end via the frontend's
  follow-request UI.
- No duplicate timeline entries for dual-tier followers.

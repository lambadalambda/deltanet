# Wire: signed thread-root ref on replies + DM copy to root author

## Summary

Prerequisite for thread auto-backfill and thread subscriptions (design
sketch #3, revised). Two defects in today's convention:

1. A reply envelope only identifies its PARENT (one hop up). A node
   holding a mid-thread message cannot tell which thread it belongs to or
   who owns it without holding the entire ancestor chain.
2. Reply DM copies go to the parent author only, so the root author does
   NOT accumulate the full thread (third-party replies deep in the thread
   never reach them) — sketch #3's original premise was wrong. A future
   thread host must be complete by construction.

## Requirements

1. **Envelope**: v2 reply envelopes gain `root`: a ref (`{u, addr}`) to
   the thread's root post, INSIDE the signed canonical payload (new
   canonical field; bump `CANONICAL_PAYLOAD_VERSION` — nothing deployed
   beyond our own test nodes, no legacy signatures to preserve, but the
   version discipline is the point of the prefix). Absent for non-replies
   and for legacy parents whose root is unknowable — the field is
   best-effort, never fabricated.
2. **Send path**: when composing a reply, derive the root: the parent's
   own `root` ref if its envelope carries one, else the parent itself if
   it is not a reply, else walk local ancestors as far as held; if the
   root is genuinely unknown (unresolvable legacy chain), omit.
3. **DM copy to root author**: reply copies go to the parent author (as
   today) AND the root author when known, distinct from the parent
   author and not SELF. Same dedupe/threading behavior as existing DM
   copies (canonical post keys already unify copies).
4. **Read side**: `parseWire`/store surface the root ref so thread
   resolution and future backfill can use it. Verification: `root`
   participates in the canonical payload exactly like `ref` (its token
   string, empty when absent).
5. Mixed-era: messages without `root` keep working everywhere (it is an
   optimization/completeness field, not a correctness gate).

## Acceptance Criteria

- Unit: canonical payload includes the root token (and its absence is
  distinct from any present value); sign/verify round-trip with and
  without root; send-path root derivation (parent-with-root,
  parent-is-root, unknown → omitted); DM copy recipient set (parent
  author, root author, dedupe when identical, never SELF).
- Integration (local relay): A posts; B replies; C (met B, in the DM
  path) replies to B's reply → A receives C's reply copy despite C's
  parent being B's message; C's envelope carries `root` = A's post.
- `pnpm test` + `pnpm test:integration` + `pnpm check` green.

## Dependencies

Blocks: thread-auto-backfill, thread-subscribe.

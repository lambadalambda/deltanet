# Thread auto-backfill: fetch dangling ancestors from the peer who showed them to us

## Summary

Design sketch #3 (revised), layer 1. Concrete QA case: alice and bob
talk a 20-message thread; carol follows only bob, so she holds bob's
half (his feed) full of reply refs dangling at alice's posts — her
thread view shows holes. The daemon should heal these automatically.

Invariant that makes this safe and precise: **a dangling reply/boost ref
always identifies a peer who holds the target** — you cannot reference a
message you never held, so the sender of the message carrying the
dangling ref can always serve it. In the two-party-thread case
backfilling is transitively complete by asking only bob: every alice
message is the parent of a bob message carol already holds.

## Requirements

1. **Request/response control messages** (v2 envelopes):
   `envelope-request` carrying a batch of post refs (uuids), answered by
   `envelope-bundle` carrying an array of the requested SIGNED envelopes
   verbatim (the responder holds the original messages whose bodies ARE
   those envelopes; unsigned/legacy targets are omitted — never
   fabricated). One message each way; batching is mandatory (60 msgs/min
   relay budget). Media: NOT bundled; a per-item follow-up request
   re-attaches a file verified by the orig's `media.sha256` (boost embed
   precedent), fetched lazily when the post is actually viewed.
2. **Held-envelope store class**: verified foreign envelopes not backed
   by a local DC message, stored under their post key (uuid), rendered
   through the existing verification ladder (sig + pin-consistency +
   contact-first attribution; never TOFU-pin from relayed content).
   Thread resolution (context BFS/ancestor walk) resolves through held
   envelopes exactly like local messages; statuses render with the
   `orig-<uuid>`-style non-actionable identity (interactions are
   issues/interact-with-embed-only-posts.md, out of scope).
3. **Auto-fetch loop**: on ingest of a message whose reply/boost ref
   does not resolve (locally or as a held envelope), queue `(peer=sender,
   ref)`; flush per-peer batches; on bundle arrival ingest + re-derive,
   which may surface NEW dangling refs (transitive ancestor fill) —
   loop with a depth/round bound. Dedupe in-flight refs; negative-cache
   misses per (peer, ref) with backoff (peers go offline; accounts
   expire); a global rate cap so backfill never starves user actions.
4. **Serving side**: answer `envelope-request` for envelopes we hold,
   from any contact, rate-limited. Never include anything unsigned.
5. Startup backfill pass: existing stores already contain dangling refs
   (carol's case predates this feature) — the re-index/derive pass seeds
   the queue, not only live ingest.

## Acceptance Criteria

- Unit: request batching/dedupe/backoff; bundle ingest → held envelopes;
  verification rejects tampered bundle items (they are dropped, the rest
  survive); transitive round loop bounded; store round-trips held
  envelopes across restart + migrate.
- Integration (local relay), the exact scenario: A and B mutual-follow
  and build a multi-message alternating thread; C follows only B (never
  met A). Without any boost, C's daemon backfills A's half by asking B;
  C's thread view (context endpoint) shows the COMPLETE thread with A's
  posts attributed to A and verified. Tamper case: B serving an altered
  A envelope → that item is dropped, not rendered.
- `pnpm test` + `pnpm test:integration` + `pnpm check` green.

## Dependencies

Blocked by: wire-thread-root-ref (root refs make thread membership
knowable; the request/bundle format should carry them from day one).
Related: interact-with-embed-only-posts (interactions on held envelopes),
thread-subscribe (same bundle format for "thread so far").

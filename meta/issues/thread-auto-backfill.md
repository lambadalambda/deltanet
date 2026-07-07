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

## Current Status

Implemented (2026-07-07, see DEVLOG). Full pipeline:

- **Protocol**: `envelope-request` / `envelope-bundle` v2 control envelopes
  (`EnvelopeType` + `parseEnvelope`; unknown-type degrades to null on old
  nodes). Refs capped at 50/request; bundles chunked at ~100KB.
- **Held-envelope store** (schema **v5 → v6**, additive fields that SURVIVE
  `migrate` like pins/notifications — a held envelope + its negative-cache
  attempt state are non-derivable roots; the version bump forces the derived-
  index re-index that seeds the queue from pre-existing dangling refs).
  Never overwrites a local/held resolution; never TOFU-pins from bundle content.
- **Render**: `resolveOrigStatus` + the context endpoint (ancestor climb +
  descendant BFS) traverse held envelopes exactly like local messages, verified
  at RENDER through the exact `verify()` + pin ladder (tampered → renders
  nothing + self-drops). Contact-first attribution; `orig-<uuid>`
  non-actionable identity.
- **Auto-fetch loop** (`src/backfill.ts`): per-peer batching + flush delay,
  global cap 4 req/min, exponential backoff (1m·4^n, give up after 5), in-flight
  dedupe, per-peer transitive round bound 10, persisted negative cache. Serve
  side rate-limited 10/min/peer.
- **Suppression** (structural): no notifications, no streaming, held envelopes
  never in home/public timelines — thread views + status fetch only.

**MEDIA DEFERRAL (decision recorded):** media is NOT bundled. A backfilled post
with media renders with its alt text and no attachment; the signed
`media.sha256` stays in the envelope so a later per-item verified fetch can
re-attach + verify. Per-item lazy media fetch is OUT of scope here and joins the
interactions follow-up — this keeps the issue focused.

`pnpm test` (952 unit, was 773), `pnpm check`, and `pnpm test:integration`
(8 files / 10 tests) all green.

**RESOLVED FINDING — key-contacts vs address-contacts (DC core 2.x).** The
first integration run failed C→B request delivery with "e2e encryption
unavailable" and was briefly misdiagnosed as a substrate wall. The real cause:
core keeps KEY-contacts (securejoin/message-derived, e2ee-capable) and
ADDRESS-contacts (`createContact`/addr lookup, KEYLESS) as SEPARATE rows —
resolving a peer BY ADDRESS lands on the keyless row even when the key-contact
exists. Fix: the backfill queue carries the dangling-ref message's SENDER
CONTACT ID (`QueuedRef.peerContactId` from `msg.fromId`; persisted as
`HeldEnvelope.fromContactId`) and `sendControlDm` targets that id — the addr is
only a dedupe/label/negative-cache key. (The serve side already replied via the
request DM's own `fromId`.) The integration test
(`tests/integration/thread-auto-backfill.test.ts`) now proves REAL end-to-end
delivery over the relay in the pure broadcast-only topology: C's request DM
reaches B, B's bundle DM reaches C, and C's context for the root renders the
complete verified thread from actually-delivered bundles — no in-process
bridging. The issue's premise ("the dangling-ref sender is always a MET,
reachable contact") HOLDS, provided sends target message-derived contact ids.
The wire-thread-root-ref cold-DM limitation stands unchanged (genuinely cold:
no securejoin ever happened with that peer, so no key-contact exists).

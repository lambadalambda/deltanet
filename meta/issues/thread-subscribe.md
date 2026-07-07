# Subscribe to thread: per-thread channel hosted by the root author

## Summary

Design sketch #3 (revised), layers 2–3. Auto-backfill heals history you
can reach through your peers; it cannot deliver the FUTURE of a thread
once no followee is active in it, nor branches none of your peers
touched. Explicit subscription covers both: a "Subscribe to thread"
action in the thread view keeps a user updated on a thread regardless of
who participates.

## Requirements

1. **Thread channel**: the root author's daemon lazily creates a
   broadcast channel per thread on first subscriber. Subscribe = scoped
   v2 invite-request (`{"type":"invite-request","scope":{"thread":"u:<root-uuid>"}}`)
   to the root author (identified via the signed `root` ref); grant =
   invite link DM (existing invite-grant flow, scoped). Auto-grant by
   default (public thread semantics; locked-mode interaction is
   visibility-channels territory, out of scope).
2. **Republication**: the root author republishes every reply it
   receives (it is complete by construction after wire-thread-root-ref)
   into the thread channel as the reply's SIGNED envelope verbatim —
   subscribers verify authorship themselves; the host can omit
   (reply control = moderation), never alter or fabricate (0002).
3. **Thread-so-far bundle**: on grant, the host sends the new subscriber
   the thread's envelopes to date (same `envelope-bundle` format as
   thread-auto-backfill; chunked if large). The 10-message core join
   backfill is NOT relied upon.
4. **Subscriber ingest**: channel messages and the bundle land as held
   envelopes (thread-auto-backfill store class), threading into the
   context view; new replies on a subscribed thread SHOULD surface (at
   minimum stream into an open thread view; a dedicated notification
   type may be a follow-up decision — pick minimal and note it).
5. **UI**: thread view gains Subscribe/Unsubscribe on the root status
   (deltanet-specific endpoint, e.g.
   `POST /api/v1/pleroma/statuses/:id/subscribe` — mirror Pleroma's
   status-subscription naming so the frontend fork stays close to home).
   Unsubscribe = leave the channel. Persist subscription state.
6. Degradation: root unreachable/expired → subscribe action fails with a
   clean, user-visible error (any-holder thread HOSTING is a possible
   future extension, not this issue).

## Acceptance Criteria

- Unit: scoped invite-request/grant round-trip; republication emits
  verbatim signed envelopes; host omission honored; subscriber ingest →
  held envelopes threading into context; subscribe/unsubscribe endpoint
  + persisted state.
- Integration (local relay): A roots a thread with B; C (follows nobody
  involved, met nobody) subscribes via the thread invite path, receives
  the thread-so-far bundle AND a subsequently posted reply, all verified
  and attributed; C's thread view is complete and stays current.
- Frontend: subscribe button visible on thread view, state persists
  across reload; Playwright coverage.
- `pnpm test` + `pnpm test:integration` + `pnpm check` green (daemon +
  frontend).

## Dependencies

Blocked by: wire-thread-root-ref (root identification + host
completeness), thread-auto-backfill (held-envelope store class + bundle
format).

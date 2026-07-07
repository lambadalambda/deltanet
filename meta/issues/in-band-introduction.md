# In-band introduction: content carries the author's contact invite

## Summary

The substrate has no cold 1:1 send: securejoin (or a received message) is
the only key-exchange path. That gap currently blocks (a) subscribing to
a stranger's thread (thread-subscribe 422s), (b) the root DM copy from a
deep replier who never met the root author (wire-thread-root-ref's
documented cold-DM limitation), and (c) the future embed-only
interactions issue. Close it by letting content carry the introduction:
the author's multi-use CONTACT invite link rides in their envelopes, so
anyone holding a verified post can securejoin its author on demand.

## Security design (why unsigned is sound)

The `invite` field is deliberately NOT in the signed canonical payload:

- Securejoin links are self-authenticating: the fingerprint + auth token
  ride in the link. A swapped link either fails the handshake (token/key
  don't match the addressed inviter) or completes against the attacker —
  yielding a contact whose ADDRESS mismatches the expected author.
- Therefore the joiner MUST verify post-join that the resulting
  contact's address equals the expected author address
  (case-insensitive); mismatch → the contact is not used. That check is
  the authenticator, not a signature.
- Keeping it unsigned avoids a dn4 canonical-layout bump and lets
  authors rotate invite links freely; a relayer stripping the field is
  plain omission (always valid).

## Requirements

1. **Envelope**: content envelopes (post/reply/boost) gain optional
   `invite: string` (the author's contact invite link, minted via core's
   chatId-less securejoin QR). Parse tolerantly (non-string → absent).
   Signatures are indifferent to it (canonical fields unchanged —
   assert).
2. **Emission**: send paths stamp `invite` on post/reply/boost. Minted
   once per daemon lifetime and cached (multi-use link).
3. **Transport**: `contactInvite()` (mint own, chatId-less QR) and
   `introduceViaInvite(invite, expectedAddr)` — secureJoin, wait for
   joiner completion (bounded, ~60s), resolve the peer contact, enforce
   the address check, return the KEY-contact id or null. Implemented
   inside the transport (it owns the event machinery). The resulting
   1:1 chat is a Single chat — never surfaces as a followed feed.
4. **Introduction policy (safety)**: introductions run ONLY on explicit
   need — (a) the subscribe endpoint when no key path to the root author
   exists (attempt inline before returning 422; source the invite from
   the locally-held or held-envelope root post), (b) our own outgoing
   root DM copy when the root author is unreachable (background,
   best-effort, fully swallowed). NEVER auto-introduce on ingest — a
   received envelope must not be able to make the daemon securejoin
   anyone. Negative-cache failed attempts per addr (in-memory) so a dead
   invite isn't hammered.
5. Mixed-era: envelopes without `invite` (all existing content) behave
   exactly as today — unreachable stays a clean 422 / skipped copy.

## Acceptance Criteria

- Unit: invite round-trip + tolerant parse; sign/verify indifferent to
  invite presence/absence/tampering; post-join addr check (match,
  case-insensitive match, mismatch → reject); subscribe endpoint
  attempts introduction only when unreachable and only with a
  root-sourced invite; root-copy path introduces then sends, failures
  swallowed; no introduction path reachable from plain ingest.
- Integration (local relay): A and B mutual-follow and thread; C follows
  B only, NEVER meets A, no pre-established path. C backfills the thread
  (held root carries A's invite), subscribes to A's thread → the
  introduction (securejoin via the held invite + addr check) succeeds →
  grant + thread-so-far → C receives A's subsequent self-reply via the
  channel. Additionally: C's deep reply root-copies to A successfully
  (the previously documented cold-DM gap heals).
- `pnpm test` + `pnpm test:integration` + `pnpm check` green.

## Dependencies

Builds on: wire-thread-root-ref, thread-auto-backfill, thread-subscribe
(all DONE). Unblocks: interact-with-embed-only-posts.

## Current Status

DONE (2026-07-07, main-loop implementation — delegation suspended).

- Envelope: unsigned `invite` on content envelopes (tolerant string-only
  parse); sign/verify INDIFFERENT to it by design (tests assert all four
  presence/absence/tamper combinations).
- Transport: `contactInvite()` (chatId-less securejoin QR) and
  `introduceViaInvite(invite, expectedAddr)` — gated on `checkQr` kind
  `askVerifyContact` (a smuggled broadcast/group invite is refused), then
  securejoin + bounded poll until an e2ee-capable key-contact for
  `expectedAddr` exists, which IS the post-join addr check.
- Send paths stamp the cached invite on post/reply/boost; the reply root
  copy resolves key-contact → in-band introduction (BACKGROUND, so a
  securejoin never delays the reply; failures negative-cached 10min per
  addr); the subscribe endpoint introduces INLINE (user-triggered) via
  the root post's invite (local or held), else the same clean 422.
- Safety: introductions only on explicit need — a test asserts plain
  ingest of invite-bearing messages triggers none.
- Tests: 1043 unit (was 1034); integration 12/12 incl. NEW
  `in-band-introduction.test.ts` — C (never met A, no reverse follow, no
  crutch) backfills A's root with its invite, subscribes via in-band
  introduction over the real relay, receives A's reply via the channel,
  AND C's deep reply root-copies to A (the wire-thread-root-ref cold-DM
  gap heals).

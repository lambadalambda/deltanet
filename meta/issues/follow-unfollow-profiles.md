# Follow/unfollow from profiles + relationships

## Summary

Following works only via pasted invite links. Profiles need working
follow/unfollow buttons and truthful relationship state.

## Requirements

- Track which contact each followed feed (InBroadcast chat) belongs to;
  expose `transport.following(): {contactId, chatId, name}[]`.
- `GET /api/v1/accounts/relationships?id[]=…` returns real `following` state
  (id is a contact id).
- `POST /api/v1/accounts/:id/unfollow` → leave/delete that feed chat
  (blockChat or deleteChat — pick what actually stops delivery; note choice).
- `POST /api/v1/accounts/:id/follow`: without a known invite for that contact
  we cannot join — return 422 with a clear error pointing at invite links
  for v1 (the auto-invite-request convention is future work).
- `GET /api/v1/accounts/:id/statuses` returns that contact's messages from
  feed chats (real implementation replacing the `[]` stub).
- Account entities include `pleroma.relationship` where the frontend expects
  it.

## Acceptance Criteria

- Profile of a followed account shows "Following"; unfollow works and their
  posts stop appearing in new timeline fetches; profile shows their posts.
- Unit tests for relationships, unfollow, and profile statuses.

## Current Status (2026-07-06)

Implemented. `Transport.following()` (`daemon/src/transport/deltachat.ts`)
lists InBroadcast chats and resolves each one's owner contact; `unfollow()`
uses `blockChat` rather than `deleteChat`, deliberately — see the DEVLOG
entry below for why (`deleteChat`'s own doc comment says it doesn't block
the contact, so it wouldn't actually stop delivery/resurrection; there is
no broadcast "leave" RPC, only `leaveGroup` for `Group` chats).
`GET /api/v1/accounts/relationships`, `POST .../unfollow` (real),
`POST .../follow` (422, points at invite links), and a real
`GET /api/v1/accounts/:id/statuses` (backed by a new
`Transport.timelineFrom(contactId, query)`, special-cased for our own
contact id to read our own feed) are all in `daemon/src/server.ts`.
`contactToAccount` gained an optional `relationship` param
(`daemon/src/mastodon/entities.ts`) folded into `pleroma.relationship`.

Previously-open finding — **now integration-tested and confirmed**: the
assumption that an InBroadcast chat's `getFullChatById(...).contactIds`
contains exactly the feed owner as the only non-SELF contact was verified
against a real joined broadcast in `tests/integration/federation.test.ts`
(the pre-existing test, and the new re-follow test below both rely on it
and pass).

## Update (2026-07-06): re-follow-after-unfollow bug found and fixed

Live testing surfaced a real bug in the `unfollow()`/`follow()` pair above:
`unfollow()`'s `blockChat` correctly hid the feed, but re-`follow()`-ing the
same feed afterward silently failed — `secureJoin` returned the same
(still-blocked) chat id, and `follow()`'s `acceptChat(...).catch(() =>
undefined)` swallowed whatever error `acceptChat` threw, so the feed stayed
invisible even though `POST /api/deltanet/follow` returned 200.

Root cause: `acceptChat` does not undo `blockChat` — blocking is a
*contact*-level operation (`Contact.isBlocked`; neither `BasicChat` nor
`FullChat` expose a chat-level blocked flag), and the only way back is
`unblockContact`, there is no "unblock chat" RPC. Fixed in
`daemon/src/transport/deltachat.ts`: `follow()` now looks up the re-joined
chat's contacts, unblocks any that are blocked (via a new pure
`blockedContactIds` helper, unit-tested in `daemon/tests/deltachat.test.ts`),
then calls `acceptChat` — with both calls' errors logged instead of
swallowed. Proven end-to-end by a new integration test,
`lets a follower re-follow a feed after unfollowing it`
(`tests/integration/federation.test.ts`), using two freshly-registered
chatmail accounts and fresh `data/int-alice`/`data/int-bob` dirs (never
touching `data/it-*`, `data/main`, `data/demo`, or `accounts.local.json`'s
credentials, all of which are used by other tests or live daemons). Full
write-up, including the `acceptChat`/blocking-model finding, in
`../../DEVLOG.md`. `pnpm test` (343 tests) and `pnpm test:integration`
(2/2) both green.

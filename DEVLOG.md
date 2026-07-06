# deltanet devlog

## 2026-07-06 — project start

Goal: Pleroma-like single-user backend, Mastodon client API in front,
Delta Chat/chatmail federation behind. Test frontend: PleromaNet.

### Decisions

- **Transport via `@deltachat/stdio-rpc-server` + `@deltachat/jsonrpc-client`
  (v2.53.0)** — prebuilt core binary, typed JSON-RPC client. We don't touch
  SMTP/IMAP/Autocrypt ourselves at all.
- **Feed = broadcast channel, follow = securejoin invite link.** Verified by
  integration test: `createBroadcast` + `getChatSecurejoinQrCode` +
  `secureJoin` works on core 2.53 — followers get a read-only `InBroadcast`
  chat. (Original plan was symmetric group chats as fallback; not needed.)
- **IDs**: Mastodon status id = DC message id (per-account integer, decimal
  string; monotonic so max_id/min_id pagination works). Account id = DC
  contact id. Fine for single-user; revisit if multi-account.
- **OAuth is auto-granted**: `/oauth/authorize` immediately redirects back
  with a static code; any Bearer token is accepted. The daemon is
  single-user and binds to localhost — authenticating yourself to yourself
  adds nothing yet.
- Accounts registered on nine.testrun.org (chatmail testing relay) via
  `POST /new`. Credentials live in gitignored `accounts.local.json`.

### Findings

- Full federation round-trip (register → invite → securejoin → post →
  E2E-encrypted delivery) over nine.testrun.org takes ~9s end to end.
  Securejoin handshake itself completes in a few seconds when both sides
  are online.
- The transport layer has no unit tests (network-bound by nature); it is
  covered by `tests/integration/federation.test.ts` instead. TDD applies to
  the mapping + API layers, which take the transport behind an interface.
- First `IncomingMsg` after a join can be a securejoin system message, not
  the followed feed's post — consumers should filter/poll, not assume.

### End-to-end result (same day!)

PleromaNet signs in against the daemon (OAuth auto-grant → token →
verify_credentials), renders the home timeline, and posting from the
composer delivers over chatmail to followers. Ran two daemons (alice :4030,
bob :4031, separate testrun.org accounts), followed each other via
`/api/deltanet/invite` + `/api/deltanet/follow`, posts flow both ways.

Surprises / follow-ups:

- **Followers received posts made *before* they followed** — the core seems
  to re-deliver recent broadcast history to new members. That's the backfill
  problem solved for free; verify the mechanism and its limits.
- `parentId` is sometimes set on plain broadcast messages (saw a post with
  `in_reply_to_id` pointing at a securejoin system message). May need to
  suppress in mapping unless it's a real reply.
- SELF contact's `displayName` is a placeholder ("Me") — worked around by
  reading the `displayname` config in `transport.self()`. The UI shows "Me"
  as the account name otherwise.
- PleromaNet requires node 24 (mise); run it with `mise exec -- pnpm dev`.

### PleromaNet API surface (from code survey)

Hard requirements: `POST /api/v1/apps`, `GET /oauth/authorize`,
`POST /oauth/token`, `verify_credentials`, `GET /api/v1/timelines/home`
(+`Link` pagination header), `GET /api/v2/instance`, `POST /api/v1/statuses`
(form-encoded). CORS for the vite origin. Streaming websocket is optional —
frontend falls back to 60s polling. `http://localhost` is accepted by the
sign-in form. Statuses should carry a `pleroma` object (emoji_reactions etc.)
but empty defaults are fine.

## 2026-07-06 — zero-config boot + signup + real stats

The daemon can now start with no `accounts.local.json` at all: `createApp`
takes an `AppContext` (`getTransport()` / `signup()`) instead of a bare
`Transport`, so Mastodon endpoints that need chatmail 401 with
`{"error": "not configured"}` until an account exists, while
`/api/deltanet/status`, instance metadata, oauth, and the stub endpoints
keep working. `POST /api/deltanet/signup` registers a fresh chatmail account
against a relay's `/new` endpoint (factored into an injectable
`registerAccount()` in `src/signup.ts` so tests never touch the network),
persists it to `accounts.local.json`, and opens the transport in place —
no restart needed. Also wired real follower/following/status counts
(`Transport.stats()`, backed by the feed broadcast's contacts/chat list) into
`verify_credentials`, and added static SPA serving (`DELTANET_STATIC`,
default `../frontend/build`) with an index.html fallback for client-side
routes. All new behavior was driven top-down from `tests/server.test.ts`.

## 2026-07-06 — experiment findings: broadcasts are stricter than hoped

Ran controlled experiments (fresh accounts, scratch script) against core 2.53:

- **Cross-chat `quotedMessageId` is rejected at send time** ("Quote of message
  from Chat#X cannot be sent to Chat#Y"). Native quotes can't implement
  replies/boosts across feeds.
- **Read-only broadcast members cannot `sendReaction`** ("Broadcast channel is
  read-only"). Native reactions can't implement likes on others' posts.
- Same-chat quotes DO resolve cross-node (receiver gets `WithMessage` with a
  locally fetchable messageId — References-based linking works), empty-text
  quotes are accepted, and image messages round-trip fine.
- `MessageData.quotedText` (freeform) has no chat restriction, and every
  message's global email Message-ID is available via
  `getMessageInfoObject().rfc724Mid`. No reverse mid→msgId RPC exists, so the
  daemon must keep its own index.

### deltanet wire convention v0 (consequence)

Replies, boosts, and reactions become an application-layer convention over
message text, with the rfc724 Message-ID as the global post reference:

- **Reply**: post to OWN feed, text ends with marker line `↳re <mid> <addr>`;
  `quotedText` carries "<author>: <excerpt>" so vanilla Delta Chat renders a
  quote bubble. A copy goes as DM to the original author (thread + notify
  even without a follow-back).
- **Boost**: post to own feed, text = `♻ <mid> <addr>`, `quotedText` = the
  original text (embedded, SSB-style, so non-followers can render it).
- **Like/reaction**: DM to the author: `<emoji> ↳ <mid>`; retraction
  `✖ ↳ <mid> <emoji>`. DMs never appear in timelines, so these stay out of
  feeds; vanilla DC users see a readable "❤ ↳ …" message.
- Daemon keeps a persistent store per account (mid⇄msgId index, reply
  children, reaction tallies, notifications), fed by an idempotent ingest
  pass over timeline loads + incoming-message events.
- Honest limitations: reaction counts are only authoritative on your own
  posts; markers are visible (if unobtrusive) to vanilla DC readers.

## 2026-07-06 — default images, image attachments, self display name

Closed three small daemon issues via TDD (`tests/entities.test.ts` +
`tests/server.test.ts` first, then implementation). `GET /deltanet/header.png`
now serves a generated SVG gradient banner (kept the `.png` path from the
account entity mapping; browsers render SVG regardless of extension), and the
avatar placeholder (`entities.avatarPlaceholderSvg` + `initialOf`) uses the
contact's first grapheme and `color` field instead of a fixed glyph — added
`Transport.contactBadge(contactId)` for this, with a neutral fallback so the
avatar route never 404s for an unknown contact while configured. Added
`POST /api/v1/media` (multipart upload, 422 on non-image mime) backed by a new
`src/media.ts` in-memory registry over an OS-tmpdir upload dir, and extended
`POST /api/v1/statuses` to accept `media_ids[]`/`media_ids`, allow image-only
posts, and pass `{file}` through `Transport.post()` — the deltachat impl uses
`rpc.sendMsg(..., {viewtype: 'Image', file, ...})` instead of
`miscSendTextMessage` when a file is present. Alt text round-trips into the
posted status's `media_attachments[0].description` and into later timeline/
status reads via a msgId-keyed lookup in the same registry. Own posts (DC
contact id 1) now get the configured `displayname` substituted onto
`msg.sender` inside the deltachat transport's `loadMessages`, same trick as
`self()`, with the config read cached per transport instance rather than
per message.

## 2026-07-06 — replies/threads + reposts (deltanet wire convention v0, implemented)

Implemented both `meta/issues/replies-and-threads.md` and
`meta/issues/reposts.md` against the wire convention recorded above, TDD
throughout (new unit tests written and shown red before each implementation).

- **New `src/protocol.ts`** — pure functions, no transport/store
  dependencies: `buildReplyText`/`buildBoostText` produce the marker text;
  `parseMarkers` recovers it tolerantly (a reply marker must be the *final*
  line preceded by a blank line, a boost marker must be the *entire* text —
  anything else, including marker-shaped text embedded elsewhere or with a
  missing addr, is treated as plain body, so we never misfire on ordinary
  vanilla-DC messages). `buildQuotedText`/`parseQuotedAuthor` handle the
  freeform `"<author>: <excerpt>"` quote bubble, best-effort on parse (falls
  back to a null author if there's no `": "` separator). All round-trip via
  `tests/protocol.test.ts`.
- **New `src/store.ts`** — per-account JSON-file-backed index:
  mid⇄msgId, reply children (parent mid → child msgIds), boost tallies
  (boosted mid → booster msgIds), and which of those boosts are our own
  (for unreblog). `ingestMessage(msg, mid)` is idempotent (tracks ingested
  msgIds) and derives edges by running the message text through
  `parseMarkers`. Lazy-loaded, saved synchronously on every mutation (kept
  simple per the plan — the indices are small). `ephemeralStorePath()`
  gives callers (tests, `createApp`'s default) a scratch file so nothing
  needs a real data dir to exercise the API layer.
- **Transport** (`src/transport/types.ts` + `deltachat.ts`): `post()` gained
  `opts.quotedText`, threaded into `MessageData.quotedText` via `sendMsg`
  (switched off `miscSendTextMessage` whenever a file *or* quotedText is
  present, since that RPC has no quote parameter). Added `messageMid`
  (wraps `getMessageInfoObject(...).rfc724Mid`, in-memory cached — there's
  no reverse RPC), `sendControlDm` (resolves/creates the 1:1 chat via
  `getChatIdByContactId`/`createChatByContactId`, then `sendMsg`), and
  `deleteMessage` (`deleteMessagesForAll`). `openTransport` gained an
  `onMessage` option: every message `loadMessages` returns is handed to it,
  and a core `IncomingMsg` subscription also feeds it (so DM-only messages
  that never render in a timeline still get ingested) — failures are
  caught and logged, never fatal.
- **Server** (`src/server.ts`): the store lives in `createApp` (or is
  injected via a new `ServerOptions.store`, so `main.ts` can share one
  instance between the transport's `onMessage` hook and the API layer).
  `POST /api/v1/statuses` with `in_reply_to_id` resolves the target's mid,
  builds the reply marker + quotedText, posts to the own feed, and
  `sendControlDm`s the same text to the original author (skipped for
  self-replies) — the DM failing is logged but doesn't fail the request.
  `POST /api/v1/statuses/:id/reblog` builds the boost marker + a
  500-char-capped quotedText and posts to the own feed; the response
  wraps the new boost message with `reblog` embedding the original and
  `reblogged: true` (matches real Mastodon's asymmetric reblog/unreblog
  shapes: reblog returns a *new* status wrapping the original,
  unreblog returns the *original* status with `reblogged: false`).
  `unreblog` looks up our own boost msgId for that mid
  (`store.ownBoostMsgId`) and deletes it via the transport; the store
  doesn't track retractions itself; the endpoint just reports
  `reblogged: false` directly since we know we just deleted it.
  `GET /api/v1/statuses/:id/context` walks ancestors by following reply
  markers upward (cap 20) and descendants breadth-first over
  `store.replyChildren` (cap 100), both re-ingesting messages they touch
  along the way in case they weren't in the store yet.
- **Entities** (`src/mastodon/entities.ts`): `messageToStatus` now takes an
  optional `StatusResolver` (`resolveMid`, `childrenCount`, `boostCount`,
  `isOwnBoost`, `midForMsgId`) plus a `resolveMessage(msgId)` callback for
  recursively mapping an embedded boost; both default to no-ops/null so
  every old call site and test keeps working unchanged. Content is the
  marker-stripped body (parsed *before* html-ification); `in_reply_to_id`
  prefers the resolved mid, falling back to the legacy `parentId` field.
  A boost marker sets `status.reblog`: resolved mid → recursively mapped
  real status; unresolved → a synthesized minimal status/account built
  from `parseQuotedAuthor(msg.quote?.text)` + the marker's addr (account id
  `"0"`, `acct` = the addr, avatar/header point at neutral placeholders).
  Had to give `messageToStatus` an explicit `MastodonStatus` return-type
  annotation (was `ReturnType<typeof messageToStatus>`) since the
  self-referential `reblog: MastodonStatus | null` field made TS's
  circular-inference check choke otherwise.
- Deviations from the plan: none structural. One judgment call not spelled
  out in the issues — real Mastodon's `/reblog` and `/unreblog` responses
  are asymmetric (new wrapper status vs. original status), which the
  reposts issue's "return a status with reblog embedded" wording didn't
  fully disambiguate; implemented to match real Mastodon since PleromaNet
  is a Mastodon-API client.
- `pnpm test` (171 tests, all passing) and `pnpm check` (`tsc --noEmit`,
  clean) both green. Did not touch `tests/integration/federation.test.ts`
  or run `pnpm test:integration`, per instructions — `openTransport`'s
  new third parameter is optional so that test's existing two-arg calls
  still typecheck.

## 2026-07-06 — likes/favourites, emoji reactions, follow/unfollow, notifications

Implemented all four remaining wire-convention-adjacent issues
(`meta/issues/likes-favourites.md`, `emoji-reactions.md`,
`follow-unfollow-profiles.md`, `notifications.md`) together, TDD throughout
(protocol/store/derivation tests written and shown red before each piece of
implementation, then endpoint tests against extended fakes).

- **`src/protocol.ts`**: `buildReactionText(emoji, mid)` →
  `"<emoji> ↳ <mid>"`; `buildUnreactionText(emoji, mid)` →
  `"✖ ↳ <mid> <emoji>"`; `parseReaction(text)` recognizes both, single-line
  only (a reaction/unreaction with a trailing newline, or missing
  mid/emoji, is not recognized — same "never misfire on vanilla DC
  messages" tolerance as `parseMarkers`).
- **`src/store.ts`** gained:
  - `ownMids` — tracked directly off `msg.fromId === 1` inside the existing
    `ingestMessage` (no signature change was needed: `T.Message` already
    carries `fromId`).
  - Reactions: `Record<mid, Record<reactorAddr, emoji[]>>` (a reactor can
    apply several distinct emoji to the same mid — required by the emoji
    reactions issue). `applyReaction`/`retractReaction`/`reactionTallies`.
  - Notifications: append-only `Notification[]` + a monotonic string id
    counter, persisted like everything else. `addNotification` dedupes via
    an explicit `dedupeMid`(`+dedupeEmoji`) input rather than overloading
    the stored `emoji` field — a favourite notification stores no `emoji`
    field at all (matches real Mastodon) but still needs the emoji folded
    into its dedupe key so a ❤ and a 🎉 from the same reactor on the same
    post don't collide. `listNotifications({limit, maxId, sinceId})` is
    newest-first with strict `<`/`>` pagination bounds (Mastodon semantics).
- **New `src/ingest.ts`** (`deriveOnIngest(store, msg, mid)`): the
  notification/reaction-application pass, deliberately separate from
  `Store.ingestMessage` (which only maintains mid/msgId/reply/boost
  indices) so it's testable with a plain store + fake messages. SELF
  messages are skipped entirely — not just "no notification" but also "no
  reaction applied" — because the favourite/reaction endpoints apply our
  own reaction to the store directly and DM the author; relying on
  ingesting our own outgoing control DM would make the response depend on
  IncomingMsg delivery timing. Wired into both `server.ts`'s `ingest()`
  helper and `main.ts`'s `ingestOnMessage` (same call site as
  `store.ingestMessage`, right after it, same mid).
- **Transport** (`src/transport/types.ts` + `deltachat.ts`) gained
  `following()`, `unfollow(contactId)`, `timelineFrom(contactId, query)`,
  `onFollower(handler) => unsubscribe`.
  - **InBroadcast contact shape** (finding, since this wasn't verified by
    an integration test — no RPC docs spell it out either): a chat we
    joined via `secureJoin` shows up in `getChatlistEntries` as
    `chatType: 'InBroadcast'`, and `getFullChatById(...).contactIds` for
    that chat contains the feed owner (the QR code's issuer) as the only
    non-SELF contact. `following()` and `unfollow()`/`timelineFrom()`'s
    `inBroadcastChatFor()` helper both rely on "first non-SELF id in
    `contactIds`" — flagged in-code as based on this reasoning, not an
    integration-tested fact, since `pnpm test:integration` was off-limits
    for this task. `getFullChatById` was used over `getChatContacts`
    because it also gives `name`, needed for `following()`'s return shape,
    in the same call.
  - **leave vs. block decision**: grepped `client.d.ts` for a broadcast
    "leave" RPC — none exists; `leaveGroup` is documented as being for
    `Group` chats only. Between `deleteChat` and `blockChat`, `deleteChat`'s
    own doc comment says explicitly that it does *not* block the contact,
    so a later broadcast delivery would silently resurrect the chat as a
    contact request — the "unfollow" would be undone by the next post from
    that account. `blockChat` was used instead: it actually stops delivery
    and matches user intent ("stop following this account").
  - `timelineFrom(1, ...)` (our own contact id) is special-cased to read
    our own feed broadcast chat instead of hunting for an InBroadcast chat
    for ourselves (we don't have one) — needed so
    `GET /api/v1/accounts/:id/statuses` also works on our own profile.
  - `onFollower` is a thin pub/sub over the `SecurejoinInviterProgress`
    core event; per its own doc comment in `types.d.ts`, `progress` on that
    event is *always* 1000 (there's no intermediate-progress variant for
    the inviter side, unlike the joiner-side event) — the `progress !==
    1000` guard is defensive rather than load-bearing today. `contactId` on
    the event is the joiner, i.e. the new follower.
- **`src/mastodon/entities.ts`**: `contactToAccount` gained an optional
  `relationship: MastodonRelationship` param folded into
  `pleroma.relationship` (full Mastodon relationship shape; only
  `following`/`showing_reblogs` ever go true — the rest are honest
  `false`s, no blocking/muting/endorsement features exist yet).
  `StatusResolver` gained `reactionTallies(mid)` and `ownAddr()` (both
  default to empty/null so every old call site keeps working);
  `messageToStatus` now computes `favourites_count`/`favourited` from the
  ❤ tally and `pleroma.emoji_reactions` (`{name, count, me}`) from every
  *other* tally, `me` computed by checking `ownAddr()` against each
  emoji's reactor list. Exported the existing (previously module-private)
  `synthesizeAccount` helper for reuse by the notifications endpoint.
- **Server** (`src/server.ts`):
  - `POST/DELETE` favourite and `PUT/DELETE
    /api/v1/pleroma/statuses/:id/reactions/:emoji` share one
    `reactToStatus(c, emoji, action)` helper: resolves the target + its
    mid, applies our own reaction to the store immediately (so the
    response reflects it without waiting for DM round-trip delivery), and
    — unless the target is our own post — sends the reaction/unreaction
    control DM with a quoted excerpt. The emoji route param is
    `decodeURIComponent`'d per the issue's instruction. ❤ stays
    favourite-only in the mapping (excluded from `pleroma.emoji_reactions`)
    purely as an entities-layer mapping rule; the store treats it as just
    another emoji.
  - `GET /api/v1/accounts/relationships` (registered before the `:id` GET
    so Hono's static-route-first matching wins — verified via the test
    suite) reads `transport.following()` and returns the full relationship
    shape per requested id. `GET /api/v1/accounts/:id` now also includes
    `pleroma.relationship`. `POST .../unfollow` calls `transport.unfollow`
    and returns the post-unfollow relationship (idempotent: reports
    `following:false` even if we weren't following). `POST .../follow`
    always 422s with an error pointing at invite links, per the issue.
  - `GET /api/v1/accounts/:id/statuses` replaced the `[]` stub with a real
    implementation over `transport.timelineFrom`.
  - `GET /api/v1/notifications` replaced the empty-list stub with a real
    mapping over `store.listNotifications`, respecting `limit`/`max_id`/
    `since_id`; account is the real contact when `accountContactId` is
    known, else `synthesizeAccount` from the stored address; status is
    `resolveMessage` + the shared `toStatus` mapper when `statusMsgId` is
    present.
  - New-follower wiring (`transport.onFollower` →
    `store.addNotification({type: 'follow', ...})`) lives in `main.ts`, not
    `server.ts`, matching the issue's instruction — it needs the live
    transport instance from `openTransport`, which `server.ts`'s
    request-scoped code doesn't have direct access to outside a request.
- Deviations from the plan: none structural. Two things worth flagging:
  (1) the InBroadcast "owner = first non-self contact" assumption above is
  reasoned from RPC semantics + doc comments, not confirmed by
  `pnpm test:integration` (off-limits for this task) — worth a follow-up
  integration-test pass; (2) follow notifications have no natural
  `dedupeMid`, so repeated joins-by-the-same-contact (e.g. rejoining after
  an unfollow) will currently produce a second `follow` notification each
  time — not addressed since the issue's dedupe requirement was specific to
  reply-seen-twice, but flagged here in case it's surprising later.
- `pnpm test` (279 tests, all passing) and `pnpm check` (`tsc --noEmit`,
  clean) both green. Did not touch `tests/integration/federation.test.ts`
  or run `pnpm test:integration`, `../frontend`, or `data/`, per
  instructions.

## 2026-07-06 — bug fix: reaction/reply DMs from contact-request chats never ingested

Bug found in live testing: reaction/reply control DMs from another node
land in the recipient's Delta Chat database (in a 1:1 chat with
`isContactRequest=true`) but were never ingested. Feed/broadcast messages
ingested fine; only messages arriving in a *pending* 1:1 (contact-request)
chat were silently dropped. Root cause: `dc.on('IncomingMsg', ...)` in
`src/transport/deltachat.ts` never fired for those messages — apparently
core suppresses `IncomingMsg` for contact-request chats, even though it
still updates the database and (per live testing) still emits
`MsgsChanged`. Consequence: reactions/likes from remote nodes we hadn't yet
accepted a chat with never registered — store stayed empty, no
favourite/emoji_reaction notifications ever fired.

Checked `node_modules/@deltachat/jsonrpc-client/dist/generated/types.d.ts`
for the exact event semantics before touching anything:
- `IncomingMsg { chatId, msgId }`: doc comment says "there is no extra
  MsgsChanged event sent together with this event" — describing the
  *normal* case (one or the other, not both). It says nothing about
  contact-request chats specifically; live testing is what showed those
  chats get `MsgsChanged` only, never `IncomingMsg`.
- `MsgsChanged { chatId, msgId }`: msgId is 0 "if only a single chat is
  affected" is inverted in the actual field doc — reread: chatId/msgId are
  each "set if only a single [chat/message] is affected... otherwise 0".
  So `msgId === 0` means a chat-level change (multiple messages/chats
  affected, e.g. a draft) with nothing specific to load — skipped.
- `IncomingMsgBunch`: no payload beyond `kind` (a "stop spamming
  notifications, batch them" hint for UIs) — carries no chatId/msgId, so
  it's useless for ingestion and wasn't subscribed to.
- No other event kind in the file documents contact-request-specific
  delivery semantics.

Fix (`src/transport/deltachat.ts`), three parts:
1. Subscribed to `MsgsChanged` alongside `IncomingMsg`, routed through the
   same `notifyOnMessage` funnel (via a new shared `loadAndNotify(msgId,
   eventKind)` helper). Skips `msgId === 0`. Downstream ingestion
   (`Store.ingestMessage`) already dedupes via `ingestedMsgIds`, so
   double-delivery from both events firing for the same message is a
   harmless no-op.
2. Startup backfill: a fire-and-forget `backfill()` runs after `startIo`
   (not awaited in the main `openTransport` path, so it never delays
   daemon startup) — walks every chat via `getChatlistEntries` →
   `getMessageIds` → `getMessages` in batches of 50, sequentially, each
   message run through `notifyOnMessage`. Catches messages that arrived
   while the daemon was down *and* anything both events missed. Per-chat
   try/catch so one bad chat doesn't abort the sweep.
3. Accept contact-request chats on first sight: `notifyOnMessage` now
   calls a new `acceptIfContactRequest(chatId)` before handing off to
   `options.onMessage` — checks `getBasicChatInfo(...).isContactRequest`
   and calls `acceptChat` (best-effort, caught and logged) so the 1:1 stops
   being a pending request and future deliveries flow through normal
   events instead of relying on the `MsgsChanged` safety net forever.

Extracted the filtering logic all three paths need (skip info messages,
skip messages with no sender (`fromId === 0`), skip messages with neither
text nor a file) into a pure, exported `shouldIngest(msg)` predicate in
`src/transport/deltachat.ts` — the one piece of transport-layer logic
worth unit-testing per the project's "transport has no unit tests, it's
network-bound" convention. Added `tests/deltachat.test.ts` (6 cases: plain
text accepted, info message rejected, sender-id-0 rejected, no-text/no-file
rejected, file-only accepted, text-only accepted).

`src/main.ts` needed no changes — `ingestOnMessage`'s signature
(`(msg: T.Message) => Promise<void>`) is unchanged; it's still just
`options.onMessage` under the hood, now fed from three call sites
(`IncomingMsg`, `MsgsChanged`, backfill) instead of one.

TDD note: skipped red→green for the transport wiring itself per the
project's existing convention (transport is network-bound / no unit
tests) — only `shouldIngest` got the full TDD treatment (test file written
against the not-yet-exported predicate first, confirmed failing via
missing-export error, then extracted and exported).

`pnpm test` (315 tests, all passing) and `pnpm check` (`tsc --noEmit`,
clean) both green.

Fixed double-counted replies/boosts: a reply is delivered twice by design
(feed broadcast + DM copy to the author, different rfc724Mids), and both
copies registered in `replyChildren`/`boostsByMid`. `Store.ingestMessage`
now takes `isFeedMessage` (default `true`) gating edge registration only —
mid mapping/`ownMids` still record for every message; `deltachat.ts` reuses
its existing `getBasicChatInfo` call (no extra RPC) via a new pure
`isFeedChat(chatType)` predicate to classify each message, passed as
`onMessage`'s 2nd arg through `main.ts`/`server.ts`. `deriveOnIngest` is
unchanged, so DM reactions and mention-dedupe still work. `pnpm test`
(325 tests) and `pnpm check` both green.

Two more live-testing fixes: (1) profile pages 404ed — added
`GET /api/v1/accounts/lookup?acct=` backed by a new
`Transport.contactIdByAddr` (`rpc.lookupContactIdByAddr`; SELF matched
first via pure `matchesSelfAddr`, tolerating "@"-prefix and bare own
username). (2) self avatar placeholder showed "M" — `contactBadge` now
applies the cached configured-displayname override via pure `badgeOf`
instead of the raw SELF contact's "Me". `pnpm test` (340) + `pnpm check`
green.

## 2026-07-06 — bug fixes: re-follow after unfollow silently failed; startup backfill silently dropped

**Bug 1: re-following a previously-unfollowed feed didn't work.**
`unfollow()` calls `blockChat` on the InBroadcast chat, which correctly
hides it from `getChatlistEntries`/the timeline. But `follow()`, called
again on the same invite/contact, got back the *same* (still-blocked) chat
id from `secureJoin`, and its `acceptChat(...).catch(() => undefined)` call
swallowed whatever error `acceptChat` threw on a blocked chat — so the feed
stayed invisible while `POST /api/deltanet/follow` still returned 200.

Root cause / what `acceptChat` actually does: **nothing relevant to
blocking**. It has no doc comment in the generated client at all (unlike
e.g. `deleteChat`, which spells out exactly what it does and doesn't do),
and empirically it does not undo a `blockChat`. Blocking in `@deltachat`'s
model is a *contact*-level operation, not a chat-level one: neither
`BasicChat` nor `FullChat` expose a `blocked`/`isBlocked` field at all —
the only place blocked-ness is observable is `Contact.isBlocked`. There is
also no "unblock chat" RPC, only `unblockContact(accountId, contactId)`.
So `blockChat(chatId)` blocks the chat's underlying contact(s), and the
only way back is to find those contacts and call `unblockContact` on them.

**Fix** (`daemon/src/transport/deltachat.ts`): added a pure predicate
`blockedContactIds(contacts: T.Contact[]): number[]` (filters
`contact.isBlocked`, unit-tested in `tests/deltachat.test.ts` against
`makeContact({ isBlocked })`). `follow()` now, after `secureJoin`, calls
`getChatContacts` + `getContactsByIds` on the returned chat id, runs the
result through `blockedContactIds`, and `unblockContact`s each one before
calling `acceptChat` — and neither call swallows its error silently
anymore (both are logged via `console.error`, matching the project's
existing "log, don't swallow" convention for best-effort RPC calls
elsewhere in this file). Confirmed live via a real unfollow→re-follow
cycle (see integration test below): after the fix, the re-joined
InBroadcast chat shows `isBlocked: false` on the owner contact and reappears
in `getChatlistEntries`, and alice's next post reaches bob's timeline again.

Proven end-to-end by a new integration test in
`tests/integration/federation.test.ts`: `lets a follower re-follow a feed
after unfollowing it`. Runs against two **freshly registered** chatmail
accounts (via `registerAccount`, not `accounts.local.json`) in fresh
`data/int-alice`/`data/int-bob` dirs (renamed from an initial `data/int-*`
attempt's sibling `it-*` naming specifically to avoid any collision with
`data/it-alice`/`data/it-bob`, which the pre-existing test also uses, and
with `data/main`/`data/demo`, which live daemon processes hold open) —
follow, confirm delivery, unfollow, confirm the next post is *not*
delivered, re-follow via a fresh invite, confirm a new post *is* delivered
again. One wrinkle: the second `secureJoin` reuses an already-verified
key-contact relationship between the two test accounts, and unlike the
first join, alice's side does not reliably re-emit
`SecurejoinInviterPropgress` (progress===1000) for it — so the test treats
that wait as best-effort (`.catch(() => undefined)`, 60s) and falls through
to polling `bob.timeline()`, which is what the regression actually cares
about. Full run: 2 tests passed in ~97s.

**Bug 2: startup backfill (and any event delivered before `openTransport`
returns) was a silent no-op.** `openTransport` fires its startup `backfill()`
sweep fire-and-forget *before* it returns (`void backfill()...`, deliberately
not awaited so it doesn't delay startup) and can independently deliver live
core events (`IncomingMsg`/`MsgsChanged`) in the same window. But
`main.ts`'s `ingestOnMessage` read a module-level `transport` variable —
`let transport: Transport | null = null;` — that's only assigned *after*
`await openTransport(...)` resolves:
```
const ingestOnMessage = async (msg, isFeedMessage) => {
  const t = transport;
  if (!t) return;         // <- backfilled messages hit this and vanish
  const mid = await t.messageMid(msg.id);
  ...
};
...
transport = await openTransport(DATA_DIR, creds, { onMessage: ingestOnMessage });
```
Every message the hook saw before that assignment landed — which, for a
fire-and-forget sweep racing the outer `await`, is not a rare edge case —
hit the null guard and was dropped. Live symptom: a rebuilt
`deltanet-store.json` after restart had `ingestedMsgIds` covering only
live-event messages (count 3), `ownBoosts`/`boostsByMid` empty, and
`POST /statuses/:id/unreblog` 404ing because `store.ownBoostMsgId` had
nothing to find. It "mostly worked" only because core happens to re-emit
`MsgsChanged`/`IncomingMsg` for some messages after startup anyway, masking
the gap.

**Fix**: removed the outer-variable dependency structurally rather than
just avoiding it. `OpenTransportOptions.onMessage`'s signature grew a third
argument, `mid: string | null` — the transport now resolves each ingested
message's `rfc724Mid` itself (reusing the same `resolveMid`/`midCache`
machinery `messageMid()` already exposed, just called a step earlier,
inside `notifyOnMessage`) and passes it straight through. `main.ts`'s
`ingestOnMessage` no longer reads `transport` at all — it just uses the
`mid` argument — so there is no window where the hook can be called before
the data it needs is available; the race is impossible by construction, not
just unlikely. (`notifyFollower` in `main.ts` was checked too: it's
registered via `transport.onFollower(...)` *after* `openTransport` resolves,
so no equivalent race exists there — left as-is.)

Files changed: `daemon/src/transport/deltachat.ts` (`blockedContactIds`,
`follow()` unblock logic, `onMessage` signature + `notifyOnMessage`
resolving `mid` before calling it, `midCache`/`resolveMid` moved earlier in
the closure), `daemon/src/main.ts` (`ingestOnMessage` takes `mid` directly),
`daemon/tests/deltachat.test.ts` (`blockedContactIds` unit tests, TDD
red→green: written against the not-yet-exported function first, confirmed
failing via `TypeError: blockedContactIds is not a function`, then
implemented), `daemon/tests/integration/federation.test.ts` (new
re-follow-after-unfollow test). `pnpm test` (343 tests) and `pnpm check`
both green throughout; `pnpm test:integration` green (2/2, ~97s) after the
fix (first attempt, before the best-effort event-wait change above, failed
only on the flaky `SecurejoinInviterProgress` wait for the second join —
state inspection confirmed the unblock itself had already succeeded even
in that failing run).

## 2026-07-06 — incident: integration suite wiped a live daemon's database; startup backfill was order-dependent

**Incident: running the integration suite wiped a live daemon's data.**
`tests/integration/federation.test.ts`'s original test (`delivers a post from
alice to her follower bob`) predates the `data/int-*`-per-test convention
established by the re-follow regression test above. It still opened
`data/it-alice`/`data/it-bob` with long-lived credentials read out of
`accounts.local.json` (`accounts['main']`/`accounts['peer']`), and began with
`rmSync('data/it-alice', ...)` / `rmSync('data/it-bob', ...)`. Both of those —
the data dir names *and* the `accounts.local.json` entries — are shared with
long-running daemon processes (this repo runs `data/main`, `data/demo`,
`data/it-bob` as live daemons against real chatmail accounts). Running the
suite today `rmSync`'d a live daemon's DeltaChat database out from under it
mid-run. Nothing caught this beforehand because the old test was never
migrated when the isolation convention was introduced — it just kept
quietly reusing shared state next to a newer sibling test that had already
solved this exact problem correctly.

**Fix**: reworked the old test to the same pattern as its newer sibling —
its own fresh, test-only data dirs (`data/int-basic-alice`,
`data/int-basic-bob`, `rmSync`'d at start) and two freshly registered
chatmail accounts via `registerAccount(relay)`, instead of
`accounts.local.json`. No test in this file touches `data/it-*` or
`accounts.local.json` anymore, and no test's data dir/account can collide
with another test's or with a live daemon's. `readAccounts` is no longer
imported by this file at all. Only `tests/integration/federation.test.ts`
changed; nothing outside `tests/integration` was touched, and the live
daemons' data was not further touched by this fix (out of scope — this task
only stops the *test suite* from being able to do it again).

**Bug: startup backfill's notification derivation was sweep-order-dependent.**
`deltachat.ts`'s `backfill()` walked `getChatlistEntries` (recency order, not
dependency order) and called `notifyOnMessage` inline per message, which —
via `main.ts`'s `ingestOnMessage` — ran `store.ingestMessage` (mid/msgId
indexing, `ownMids` bookkeeping) *and* `deriveOnIngest` (notification/
reaction-store side effects) back to back for that one message before moving
to the next. If a DM chat holding a reaction/reply control message happened
to be swept *before* the chat holding the mid it targets (e.g. our own feed
chat with the original post), `deriveOnIngest` ran while `store.isOwnMid`
still read `false` for that mid — `ownMids` for the target message hadn't
been populated yet, because indexing *that* message hadn't happened yet.
Net effect: the reaction was still tallied (`applyReaction` isn't gated on
`isOwnMid`), but the corresponding favourite/`pleroma:emoji_reaction`
notification was silently never derived, purely because of which chat the
core happened to list first.

**Fix**: split ingestion into two explicit phases. `OpenTransportOptions.
onMessage` grew a fourth argument, `phase: 'combined' | 'index' | 'derive'`
(new exported type `IngestPhase`). Every existing call site — live
`IncomingMsg`/`MsgsChanged` events, and ordinary timeline/message loads via
`loadMessages`/`notifyOnMessage`'s default — passes `'combined'`, meaning
"do both halves for this one message," exactly the behavior before this
argument existed. Only `backfill()` uses the split: it now first collects
every message from every chat (unchanged sweep/batch/error-handling logic,
just pushed into an array instead of notifying inline), then runs a first
pass calling `notifyOnMessage(msg, 'index')` for every collected message,
then a second pass calling `notifyOnMessage(msg, 'derive')` for every one of
them again. `main.ts`'s `ingestOnMessage` switches on `phase`: `'combined'`
or `'index'` runs `store.ingestMessage`; `'combined'` or `'derive'` runs
`deriveOnIngest`. By the time any message reaches the `'derive'` pass, every
backfilled message — regardless of source chat or sweep order — has already
been indexed, so `store.isOwnMid` is fully populated store-wide before
derivation ever runs. This deliberately does **not** give the transport a
`Store` dependency: `deltachat.ts` still only knows about `phase` as an
opaque tag it passes through, all store semantics stay in `main.ts`.

Checked the interaction with `Store.ingestMessage`'s own dedupe
(`ingestedMsgIds`) carefully, since backfill's `'index'` pass now runs before
`'derive'` ever touches the same msgId: the dedupe guard
(`if (ingestedSet().has(msg.id)) return;`) only lives inside `ingestMessage`
itself, so it can only ever make a repeated `'index'` call a no-op — it has
no way to suppress a `'derive'` call, because `deriveOnIngest` is a
different function with its own, separate dedupe
(`notificationDedupeKeys`). So `ingestOnMessage`'s `'combined'`/`'index'`
branch calling `store.ingestMessage` first and its `'combined'`/`'derive'`
branch calling `deriveOnIngest` unconditionally (never behind an
"already ingested?" check) was exactly the right shape — no adjustment to
`store.ts` was needed.

Added `acceptIfContactRequest` skip on the `'derive'` phase in
`notifyOnMessage` (it's redundant work, not a correctness issue: the
`'index'` pass for the same message already accepted the chat moments
earlier if needed).

New unit tests in `daemon/tests/ingest.test.ts` (`backfill
order-independence (two-pass ingest/derive)`): one test simulates the
two-pass backfill directly — an `'index'` pass over `[reaction message, own
post]` in that (bug-triggering) order, confirming `isOwnMid` is populated
for the own post's mid before any derivation runs, then a `'derive'` pass
over the same order — and asserts the favourite notification *is* produced.
A companion "contrast" test runs the old inline-per-message behavior in the
same order and asserts the notification is *not* produced (reaction tally
still applies), to document the bug the fix closes and guard against a
future regression back to single-pass ingestion.

Files changed: `daemon/src/transport/deltachat.ts` (`IngestPhase` type,
`onMessage` signature, `notifyOnMessage` phase plumbing, `backfill()`
rewritten to collect-then-two-pass), `daemon/src/main.ts` (`ingestOnMessage`
switches on `phase`), `daemon/tests/ingest.test.ts` (two new tests),
`daemon/tests/integration/federation.test.ts` (old test reworked to fresh
`data/int-basic-*` dirs + `registerAccount`, no more `accounts.local.json`/
`data/it-*`). `pnpm test` (345 tests) and `pnpm check` green. Did not run
`pnpm test:integration` this round (several minutes, and live daemons are
running against real chatmail data — out of scope for this fix, and exactly
the risk this task closes off).

## 2026-07-06 — Mastodon streaming websocket (live updates/notifications)

Implemented `meta/issues/streaming-websocket.md`: `GET /api/v1/streaming`
(+ trailing-slash) upgrades to a websocket and streams `update`/
`notification` frames for live feed activity, matching the frontend's
existing (already-wired, previously dark) streaming client exactly.

**Read the frontend first (read-only, no changes)**:
`frontend/src/lib/pleroma/streaming.ts`. Connects to
`new URL('/api/v1/streaming/', origin)` (note: trailing slash) with
`?stream=<user|public|public:local>&access_token=<token>` (`URLSearchParams`
percent-encodes the `:` in `public:local`). `parsePleromaStreamingMessage`
does `JSON.parse` on the raw frame expecting a top-level `{event, payload}`
object, then `JSON.parse`s `payload` a *second time* (it's a JSON string,
not an object) to get the actual status/notification. Only `event ===
'update'` (mapped to `.status`, gated by a structural `isPleromaStatusPayload`
type guard) and `event === 'notification'` (`.status` optional) are ever
acted on; anything else is parsed but silently ignored by the page. The
client reads no top-level `stream` field at all — so the Mastodon-standard
`{"stream":[...], "event", "payload"}` shape the issue asks for is a strict
superset of what this frontend needs, and matching it exactly costs nothing
extra. No ping/pong or reconnect logic lives in the client itself (that's in
the page, flat 60s-interval reconnect) — this only matters for how
aggressively the server needs to keep the connection alive, not for frame
shape.

**`src/streaming.ts` (new)**: `createStreamingHub()` — `register(socket,
streams)` (returns an unregister fn), `unregister(socket)`,
`broadcastUpdate(statusJson, msgId)` (to `user`+`public`+`public:local`
subscribers, deduped: a bounded FIFO of the last 1000 streamed msgIds so a
`MsgsChanged` re-fire for the same message — see `deltachat.ts`'s
`IncomingMsg`+`MsgsChanged` double-subscription — never streams a status
twice), `broadcastNotification(notificationJson)` (`user` subscribers only).
Sockets are accepted through a minimal structural `StreamingSocket` type
(`{send(data: string), readyState?: number}`) — no `ws` import anywhere in
this file, so the hub is fully unit-testable with plain object fakes.
Frames: `JSON.stringify({stream: [<stream>], event, payload:
JSON.stringify(payloadObj)})`, matching the frontend's double-JSON-decode
exactly.

Also in this file (not `server.ts`): `resolveStreamName` (pure `stream`
query-param -> `StreamName` mapping, default `'user'`) and
`createStreamingEvents(hub, streamParam)`, which builds the
`{onOpen, onClose, onError}` triple `hono/ws`'s `upgradeWebSocket` helper
wants — including the ws-level keepalive ping (`setInterval` every 30s on
`ws.raw.ping()`, best-effort/try-catched, cleared on close/error alongside
unregistering from the hub). Pulled these out of `server.ts`'s route
registration deliberately: Hono's `app.request()` fetch-based test helper
cannot drive a real `Upgrade: websocket` handshake (confirmed by reading
`@hono/node-server`'s `upgradeWebSocket` implementation — it gates on
`env[WAIT_FOR_WEBSOCKET_SYMBOL]`, only ever populated by a real
`http.Server`'s `'upgrade'` event), so anything left inside the route
handler closure would be untestable without a real HTTP+ws round trip.
Keeping `server.ts`'s handler a one-line adapter
(`upgradeWebSocket((c) => createStreamingEvents(hub, c.req.query('stream')))`)
means the actual registration/keepalive/cleanup behavior is unit-tested
directly against `createStreamingEvents` with a fake socket instead.

**`src/mapping.ts` (new)**: factored `server.ts`'s inline `resolver`/
`ownAddr`/`toStatus` closures out into `createStatusMapper(store, baseUrl)`,
and the `GET /api/v1/notifications` handler's inline notification-JSON
builder out into `mapNotification(n, transport, mapper, baseUrl,
mediaDescriptionFor)`. `server.ts` now calls both instead of defining its
own copies — required so `main.ts`'s live-ingestion path can map a freshly
ingested message/notification to the *exact* same JSON shape the REST
endpoints return, per the issue's "no divergent JSON shapes" requirement,
without duplicating the mapping logic. One known small gap: live-streamed
statuses for a freshly-uploaded image never carry alt-text
(`mediaDescriptionFor` is `() => null` in `main.ts`), because `mediaStore`
lives inside `createApp`'s closure and isn't plumbed out (would mean
changing `createApp`'s return shape, touching all 36 existing call sites).
Self-heals on the client's next REST poll, which does have `mediaStore`
access — acceptable for a best-effort live nicety.

**`src/ingest.ts`**: `deriveOnIngest` now returns `Notification[]` — the
notifications actually created (not dedupe no-ops), by collecting
`Store.addNotification`'s existing `| null` per-call return instead of
discarding it. Chosen (per the issue) as the least invasive way for
`main.ts` to know exactly which notifications are new after a live ingest,
without a separate before/after diff against `listNotifications`. Existing
callers (`server.ts`'s `ingest()`, `main.ts`'s old `ingestOnMessage`, all of
`ingest.test.ts`) call it as a bare statement and are unaffected by the
signature change.

**`src/main.ts`**: `ingestOnMessage` now branches on `phase === 'combined'`
(live events + ordinary timeline/message loads) to additionally map+broadcast
after the existing store/derive bookkeeping — never for the `'index'`/
`'derive'` startup-backfill phases, so backfill stays silent as required.
For a feed message (`isFeedMessage`), maps it via the shared `mapper.toStatus`
and calls `hub.broadcastUpdate`. For each notification `deriveOnIngest`
returns, maps it via `mapNotification` and calls `hub.broadcastNotification`.
`notifyFollower` (the `SecurejoinInviterProgress` handler) does the same for
follow notifications. All of this is wrapped in try/catch — streaming is
best-effort and must never make ingestion itself fail. If `transport` hasn't
been assigned yet (the same startup-backfill race `mid`-passing already
works around for indexing, see the fix above) a live event during that
narrow window is simply not streamed rather than crashing — acceptable,
since indexing/derivation (the load-bearing half) still happens
unconditionally.

**Websocket transport wiring**: added `ws`+`@types/ws` as dependencies. The
issue's writeup mentioned `@hono/node-server/ws`/`createNodeWebSocket`
(the *old*, `@hono/node-server`-v1-era API, which lives in a *separate*
package, `@hono/node-ws`, whose peer dependency pins `@hono/node-server
^1.19.11` — incompatible with this repo's `^2.0.8`). Checked
`node_modules/@hono/node-server`'s actual shipped `.d.mts`: v2 exports
`upgradeWebSocket` directly from its root, no `injectWebSocket` step at all
— just `serve({fetch, websocket: {server}})` with a `ws.WebSocketServer({
noServer: true})` (confirmed against the package's own README). No
`pnpm-workspace.yaml` build-approval changes were needed (`ws` has no
postinstall script). `server.ts`'s `ServerOptions` grew optional
`upgradeWebSocket`/`hub` fields; the streaming route (both `/api/v1/streaming`
and the trailing-slash form) is only registered when both are present, so
`createApp`'s existing 36 call sites (none of which pass these) are
unaffected. `main.ts` wires real ones in and calls
`serve({..., websocket: {server: wss}})`.

Manually smoke-tested end to end: booted `main.ts` unconfigured (no account)
and confirmed via `curl` with real `Upgrade: websocket` handshake headers
that `GET /api/v1/streaming?stream=user&access_token=x` returns a genuine
`HTTP/1.1 101 Switching Protocols` with matching `Sec-WebSocket-Accept` —
proving the `upgradeWebSocket`/`WebSocketServer`/`serve` wiring is correct
end-to-end, not just type-checked.

New unit tests: `tests/streaming.test.ts` (26 tests — frame format/double-
JSON-encoding, stream filtering including "one frame per socket even when
subscribed to multiple matching streams", dedupe by msgId including the
1000-id eviction boundary, register/unregister lifecycle including
readyState-gated sends, `resolveStreamName`, and `createStreamingEvents`'s
onOpen/onClose/onError + ping-interval + ping-failure-triggers-cleanup
behavior via fake timers), plus additions to `tests/ingest.test.ts`
(`deriveOnIngest`'s new return value: created/empty/dedupe/SELF/retraction
cases) and `tests/server.test.ts` (streaming route registration: absent
without `upgradeWebSocket`+`hub`, both path variants present when wired,
correct stream-name wiring — via a fake `UpgradeWebSocket` that invokes
`createEvents(c)` directly, since Hono's `app.request()` can't drive a real
websocket upgrade).

Files changed: `daemon/src/streaming.ts` (new), `daemon/src/mapping.ts`
(new), `daemon/src/ingest.ts` (`deriveOnIngest` return type), `daemon/src/
server.ts` (extracted mapping usage, streaming route registration),
`daemon/src/main.ts` (hub/mapper wiring, `ingestOnMessage`/`notifyFollower`
broadcasting, `serve()`/`WebSocketServer` wiring), `daemon/package.json`
(`ws` dependency, `@types/ws` devDependency), `daemon/tests/streaming.test.ts`
(new), `daemon/tests/ingest.test.ts`, `daemon/tests/server.test.ts`. `pnpm
test` (382 tests) and `pnpm check` green. Did not run `pnpm test:integration`
(per task instructions).

## Reply mentions metadata (`meta/issues/reply-mentions-metadata.md`)

`messageToStatus` now fills `in_reply_to_account_id`/`mentions` from the
reply marker's resolved parent (via the existing `resolveMessage` callback,
already used for boost embedding), instead of always `null`/`[]`. Added a
`contactToMention` helper (same id/username/acct/url shape as
`contactToAccount`) and a `MastodonMention` type. `mapping.ts`'s `toStatus`
now fetches the reply parent alongside the boosted message, deduped through
one `resolvedById` map so `resolveMessage` serves both call sites without
double-fetching (recursive reblog-of-a-reply embedding is bounded: it just
sees an empty map for the inner message's own parent, no extra fetch).
Decision: self-replies still get a mention (diverges from upstream Mastodon,
which drops the author's own mention on self-replies) — simpler and the
frontend doesn't special-case it. Files: `daemon/src/mastodon/entities.ts`,
`daemon/src/mapping.ts`, `daemon/tests/entities.test.ts`,
`daemon/tests/server.test.ts`. `pnpm test` (403 tests) and `pnpm check`
green.

## Profile editing (`meta/issues/profile-editing.md`)

Implemented `PATCH /api/v1/accounts/update_credentials`, backed by Delta Chat
self-config. `display_name` → `displayname`, `note` → `selfstatus` (both
federate in outgoing message headers), `avatar` file → `selfavatar`. Header
uploads are stored locally and served for SELF only (no DC equivalent — they
don't federate).

**Frontend contract (read-only inspection of `../frontend`).** The settings
save (`updateAccountProfile` in `src/lib/pleroma/client.ts`) submits **JSON**
(`Content-Type: application/json`), not multipart: `profileUpdateBody` sends
`display_name`, `note`, `locked`, `bot`, `discoverable`,
`hide_followers_count`, `fields_attributes`. It reads back the full
`PleromaAccount` (`display_name`, `source.note`, `note`, `discoverable`,
`pleroma.hide_followers_count`, `fields`). The "Choose avatar"/"Choose banner"
buttons exist in the settings UI (`routes/app/[...path]/+page.svelte`) but are
**not yet wired** to any upload. So the endpoint accepts JSON *and* multipart
form-data (hono `parseBody` yields `File` objects for `avatar`/`header`, same
as `/api/v1/media`) — the avatar/header paths are forward-looking for when the
frontend wires those buttons.

**Does DC copy selfavatar into blobs?** Yes. Delta Chat core imports the
avatar file into its blob store on `setConfig('selfavatar', path)` (the config
docs and `SelfavatarChanged`/`AccountsItemChanged` events confirm selfavatar is
a managed asset, and `Contact.profileImage` for SELF resolves to the imported
blob). A temp source file would therefore suffice — but per the issue we still
persist the uploaded avatar under the account data dir (not os tmpdir) so it
survives a restart as a stable on-disk artifact. `avatarPath(SELF)` special-
cases contact id 1 to read the `selfavatar` config directly (authoritative,
avoids any lag in the raw contact's `profileImage`).

**Cache invalidation.** `openTransport`'s `cachedDisplayName` (read by
`self()`/timeline mapping/`contactBadge`) is dropped via a new
`invalidateSelfDisplayName()` at the end of `updateProfile`, so a name change
is visible on the very next read.

**Header route.** Replaced the single global `/deltanet/header.png` with
per-contact `/deltanet/header/:contactId`: SELF (id 1) serves the stored
`<dataDir>/header.png` if present, else the generated gradient; every other id
gets the gradient. `contactToAccount` now points `header`/`header_static` at
`/deltanet/header/:id`. Kept `/deltanet/header.png` as a gradient alias so old
URLs / `synthesizeAccount` (still references it) don't break. `dataDir` is
threaded through `ServerOptions` from `main.ts` (which knows `DATA_DIR`,
resolved absolute); tests fall back to a per-process scratch dir.

Validation: blank `display_name` → 422; empty `note` is allowed (clears bio);
non-image `avatar`/`header` → 422 (same mime check as `media.ts`).

Files: `daemon/src/transport/types.ts` (`ProfileUpdate` type +
`updateProfile`), `daemon/src/transport/deltachat.ts` (`updateProfile`,
`invalidateSelfDisplayName`, SELF-aware `avatarPath`),
`daemon/src/mastodon/entities.ts` (header URLs), `daemon/src/server.ts`
(endpoint, `selfAccountJson` helper, per-contact header route, `dataDir`
option, avatar/header persistence), `daemon/src/main.ts` (`dataDir` wiring),
`daemon/tests/server.test.ts` (fake transport `updateProfile` + recorder, new
update_credentials/header suites). `pnpm test` (413 tests) and `pnpm check`
green. Did not run `pnpm test:integration` (per task instructions).

## 2026-07-06 — profile federation findings (live verification)

- Display name and avatar federate on ANY outgoing message (encrypted
  headers) — verified: bob's node showed "Carol Sparkle" + her avatar file
  after one broadcast post.
- **Bio (`selfstatus`) federates only via 1:1 messages**, not broadcasts —
  verified empirically: two broadcast posts left bob's copy empty; a single
  reaction control DM delivered it. In practice bios spread to anyone you
  interact with (reply DM copies, reactions). Broadcast-only followers keep
  an empty bio until first direct interaction. Documented limitation.
- Headers/banners are local-only (no DC equivalent), as designed.

## 2026-07-06 — two live-found bug fixes

- `transport.post()` (`daemon/src/transport/deltachat.ts`) returned raw
  `rpc.getMessage(...)`, so the just-posted status echoed back with the SELF
  placeholder display name "Me". Now wraps both send paths in a `loadOwn`
  helper applying the same `withSelfDisplayName` override `loadMessages`/`self()`
  use. Audited the file: `post()` was the only single-raw-message returner;
  `message()` already routes through `loadMessages`, `blobPath()` only reads
  `msg.file`. No transport-layer unit test by convention (openTransport is only
  exercised by the integration suite, not run here) — the `server.test.ts` fake
  doesn't model the "Me" placeholder so it can't cover this.
- `serveFile` (`daemon/src/server.ts`) served avatars/blobs/headers with no
  Content-Type (defaulted to text/plain). Added `contentTypeForPath` sniffing
  the extension (png/jpg/jpeg/webp/gif/svg → image/*; else
  application/octet-stream); no new RPC calls. Covered by new
  `served-file content types` suite in `daemon/tests/server.test.ts`.

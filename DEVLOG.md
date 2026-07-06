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

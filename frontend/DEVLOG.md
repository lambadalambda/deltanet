## 2026-07-10 - local daemon enrollment and stream tickets

- The landing flow requires the daemon's one-use enrollment code only when this
  browser has no reusable client registration. OAuth client credentials are
  persisted per normalized daemon instance and exact callback/full-scope tuple;
  signup and restore discard stale client state and request the fresh code the
  daemon prints after account binding.
- User streams obtain a one-use short-lived ticket over bearer-authenticated REST
  before constructing the WebSocket URL. Long-lived access tokens are never put
  in WebSocket query strings, and closing during ticket acquisition aborts the
  request without opening a late socket.
- Explicit sign-out closes both stream lifecycles and immediately removes the
  local session plus the persisted per-instance OAuth client before starting a
  best-effort client-wide server revoke bounded to two seconds. The menu states
  that this forgets the browser and the next sign-in needs the daemon's fresh
  terminal enrollment code. OAuth callback parameters are removed from the
  address bar/history immediately after parsing.

## 2026-07-07 — Honest timeline labels: remove Local/Federated tabs (issue 66)

Daemon-verified root cause: `/api/v1/timelines/home` and `/api/v1/timelines/public`
are the SAME Hono handler; the `local` query param the client sent was ignored.
So Home, Local, and Federated all rendered byte-identical data. "Federated" is a
fediverse concept deltanet (a chatmail feed) does not have; "Local" (own-instance
public) is equally meaningless — there is only your feed.

Chose removal over rename for honesty: a renamed duplicate tab would still be a
second surface showing the same posts as Home. Deleted both nav items and the
entire `appPublicTimeline*` machinery from `src/routes/app/[...path]/+page.svelte`
(types, state, request-id/loaded-key/stream vars, load/loadMore/retry/stream
helpers, route-derivation branches, heading map, template tab-lists, and the
`{:else if route === 'local' || route === 'federated'}` block). The signed-out
`/public` route was collapsed from a Local/Federated tab split to one honest
public feed (single `getFederatedTimelinePage()` call — same endpoint). Landing
copy "The federated timeline, right now." → "The public feed, right now."

Client methods `getLocalTimelinePage`/`getFederatedTimelinePage` kept (the latter
powers `/public`; both still covered by client.e2e.ts). Tests: trimmed
app-routes nav-label/deep-link assertions, deleted app-public-timelines.e2e.ts
(355 lines, wholly about the removed in-app feature), rewrote public-timeline.e2e
for the single feed, repointed app-trends deep-links to /app/home. Full test
(315) + check green. Issue 66 archived. Frontend half of the root
`hygiene-core-pin-timeline-labels` issue; the core-pin half is handled in the
daemon repo.

## 2026-07-07 — Profile deep links resolve for all typed forms (issue 65)

Bug: typing a profile URL directly — `/app/profiles/12` (numeric id) or
`/app/profiles/@user@relay` (raw or percent-encoded) — showed "Record not found",
while in-app profile links worked.

Root cause: `resolveProfileAccount` routed every typed form through the same
order (cache → `accounts/search?q=` → `accounts/lookup?acct=` → an unconditional
`getAccount(handle)` fallthrough). But the daemon's two endpoints answer
different shapes: `GET /accounts/:id` does `Number(id)` (numeric only; anything
else → NaN → "Record not found"), and `GET /accounts/lookup?acct=<address>`
resolves an address (tolerating a leading `@`). The code never branched on shape,
so an address that missed search/lookup fell through to `getAccount("@user@relay")`
→ NaN → not found, and numeric ids depended on search succeeding first.

Fix: branch on handle shape up front — numeric (`/^\d+$/`) → `getAccount`
(`accounts/:id`); address (contains `@`, raw/`@`-prefixed, route-decoded) →
`lookupAccount` (`accounts/lookup?acct=`), falling back to account search on a
miss; only the ambiguous bare-name case still starts from search. Cache-first
short-circuit for in-app navigation preserved. TDD: 3 new Playwright cases in
app-profile.e2e.ts (numeric, raw `@handle@domain`, percent-encoded) that assert
resolution WITHOUT relying on `accounts/search`. Full test (315) + check green.
Issue 65 archived.

## 2026-07-06 — Thread ancestor/descendant reaction chips (issue 64)

Bug (daemon-verified): thread ancestor rows never rendered emoji-reaction chips
even when `pleroma.emoji_reactions` was non-empty; only reply/boost/star counts
showed. Descendant (reply/nested) rows had the same gap.

Root cause: `Post.svelte` (timeline) and `FocusedPost.svelte` (thread main)
render `<PostReactions>` above `<PostActions>`, but `AncestorPost.svelte` and
`ReplyPost.svelte` rendered only `<PostActions>` — they never imported or
rendered `PostReactions`. The `reactions` data already flows onto the post
objects (`threadPostForRebuild` → `postForRebuild`), and the thread
`onAction`/`onReact` handlers already process `reaction:${name}` toggles and the
add-reaction anchor, so the fix was purely presentational.

Fix: added `PostReactions` (reusing the timeline component) to both
`AncestorPost.svelte` and `ReplyPost.svelte`, wired identically to the timeline
row (`onToggle` → `onAction(id, 'reaction:'+name)`, `onAdd` → `onReact(id,
anchor)`), plus the `reactions?: PleromaReactionView[]` prop type on each.

TDD: new Playwright case in app-thread.e2e.ts mocks `/statuses/:id/context` with
reactions on an ancestor and a descendant, asserts chips + me-state on both, and
toggles an ancestor reaction. Full test (320) + check green. Issue 64 archived.

## 2026-07-06 — Avatar/banner upload wiring (settings)

Wired the settings page "Choose avatar"/"Choose banner" buttons to real file
pickers (accept png/jpeg/webp/gif). Selecting a file shows an object-URL
preview in the upload row (replacing the current image) with a Discard button;
size-guarded by `COMPOSER_MAX_UPLOAD_BYTES` (40 MB) with the standard toast.

`updateAccountProfile(profile, images?)` now branches: when an avatar/header
File is pending it sends ONE multipart `PATCH update_credentials` carrying the
files plus display_name/note/fields as form fields; otherwise the existing JSON
path is untouched. Same http layer (auth header + error normalization). On
success the returned account's avatar/header URLs get a `?_cb=<ts>` param
appended (avatar URL is stable per contact id, so an in-place swap wouldn't
repaint otherwise), then session/cache state updates as before. TDD: 5 new
Playwright cases in app-settings.e2e.ts (avatar+banner multipart, discard,
JSON-only unchanged, oversized rejected). Full test (319) + check green. Issue
`profile-avatar-banner-upload-ui` archived.

## 2026-07-06 — DeltaNet release package

Retooled the PleromaNet fork as **DeltaNet** (frontend/) and verified the
full release story end to end in a real browser: unconfigured daemon serves
the built SPA → Create-account tab (status-driven) → display name "carol" →
daemon registers 7u9tuk5xt@nine.testrun.org on the relay → auto OAuth →
post from composer → paste bob's invite into search → "Follow this feed" →
securejoin → bob's post appears in carol's home timeline (including
pre-follow history, again). Bob's daemon reports followers/following/post
counts from real broadcast member lists now.

Coding was done by sonnet subagents (daemon + frontend in parallel; the
frontend agent stalled once mid-run and was resumed via message with
context intact — worked fine).

Known nits for later:
- Timeline statuses show "Me" for your own posts (the displayname override
  only patches `transport.self()`, not `message.sender`).
- Sidebar profile stats don't refresh after following (cached session
  account); the daemon reports correct numbers on verify_credentials.
- The OAuth redirect page's auto-redirect doesn't fire under browser
  automation; the manual link works. Investigate the meta-refresh/JS timer.

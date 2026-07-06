
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

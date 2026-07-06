
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

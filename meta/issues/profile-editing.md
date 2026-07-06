# Profile editing (name, bio, avatar)

## Summary

Users can't set a display name (after signup), bio, or avatar. Delta Chat
supports all three as self-config (`displayname`, `selfstatus`,
`selfavatar`) and propagates them to contacts in encrypted headers of
outgoing messages — so profile changes federate to followers automatically.
The frontend's existing settings page speaks
`PATCH /api/v1/accounts/update_credentials`; the daemon must implement it.

## Requirements

- `PATCH /api/v1/accounts/update_credentials` (multipart and/or form-encoded
  — match what the frontend actually sends; read its settings code
  read-only): `display_name` → `displayname` config, `note` → `selfstatus`
  config, `avatar` (image upload) → saved to the account data dir and set as
  `selfavatar`. Returns the updated account JSON (with stats, fresh values).
- The transport's cached self display name must be invalidated on update
  (timeline mapping + contactBadge use the cache).
- Avatar propagation: incoming contacts' `profileImage` is already served by
  the avatar route — verify a remote node shows the new avatar after the
  next message arrives from us.
- `header` upload: no DC equivalent — accept and store locally (data dir),
  serve for SELF via a per-contact header route (`/deltanet/header/:id`,
  default gradient for everyone else); account mapping points there.
  Document that headers don't federate.
- Bio federates as `selfstatus` → remote `contact.status` → account `note`
  (mapping exists) — verify.

## Acceptance Criteria

- Changing name/bio/avatar in the settings UI persists (survives daemon
  restart), is reflected in verify_credentials and own timeline posts, and
  after posting once, shows up on a follower's node (name, avatar, bio).
- Unit tests: update_credentials happy path (fields + avatar file),
  cache invalidation, header stored/served for self.

## Current Status (2026-07-06)

Implemented in the daemon. `PATCH /api/v1/accounts/update_credentials` accepts
both JSON (what the frontend currently sends: `display_name`, `note`) and
multipart form-data (`avatar`, `header` File uploads — forward-looking, the
frontend's "Choose avatar"/"Choose banner" buttons aren't wired to uploads
yet). `display_name`→`displayname`, `note`→`selfstatus` (federate),
`avatar`→`selfavatar` (DC imports into blobs; also persisted under the data
dir), `header` stored locally + served for SELF via `/deltanet/header/:id`
(non-self ids get the default gradient; headers don't federate). Cached self
display name is invalidated on update. Blank `display_name`→422, empty
`note`→clears bio, non-image avatar/header→422.

Unit-tested (`daemon/tests/server.test.ts`): happy path (name+note), avatar
upload sets transport path + serves via avatar route, header stored+served for
self, 422 cases, cache invalidation via verify_credentials, account mapping
points at the per-contact header route. `pnpm test` + `pnpm check` green.

Not done here: frontend wiring of the avatar/header file inputs; live
federation verification (avatar/bio appearing on a follower's node after a
post) — acceptance criteria to confirm via integration/manual once the
frontend uploads land. Not archived.

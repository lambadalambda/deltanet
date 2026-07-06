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

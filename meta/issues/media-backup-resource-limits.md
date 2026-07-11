# Enforce media and backup resource limits

## Summary

Media upload and backup restore accept files without daemon-side size limits and
materialize their full contents in memory. Uploaded media records and temporary
files also have no explicit lifetime or cleanup path. Large or abandoned inputs
can exhaust process memory or disk, especially while the API security boundary
remains permissive.

## Requirements

- Define and enforce server-side limits for request bodies, media files, backup
  imports, and generated backup exports. Client-side validation is not enough.
- Reject oversized input before fully buffering or persisting it where the
  runtime APIs permit.
- Stream backup and media data where practical; otherwise account explicitly
  for worst-case peak memory use.
- Remove staged media after successful posting, cancellation, expiration, or
  failure, without deleting files still needed by an in-flight post.
- Bound the in-memory media metadata maps and preserve required alt text through
  the durable message/envelope path.
- Return stable, user-readable errors for limit violations.

## Acceptance Criteria

- Oversized media and restore requests fail with a documented 4xx response and
  do not leave files or registry entries behind.
- Abandoned and consumed staged uploads are removed according to a documented
  lifetime policy.
- Backup export/restore and media upload have bounded, tested memory/disk use.
- Unit tests cover boundary sizes, cleanup on success/failure, expiration, and
  concurrent in-flight uploads; frontend tests cover the returned error state.

## Notes

- Current references: `daemon/src/server.ts:694-754`,
  `daemon/src/server.ts:1443-1453`, and `daemon/src/media.ts:28-48`.
- Implemented limits: 1 MiB ordinary request bodies, 40 MiB media/profile files,
  256 MiB restore containers, 2 MiB backup sidecars, 253 MiB core backups,
  256 MiB final exports, and a 600 MiB process request-memory budget. The Hono
  multipart parser remains bounded-but-buffered; the budget reserves two body
  copies before reading. Core restore/export bytes stream outside that parser.
- Staged uploads are capped at eight records and one hour. They use mode-0600
  files, startup orphan sweeping, explicit DELETE cancellation, and leases that
  defer cleanup while concurrent sends are active. Success, failure,
  cancellation, and expiry all remove records and files.
- The one-file transport capability is enforced in both daemon and frontend.
  Alt text is limited to 4 KiB, updated server-side, retained in signed
  envelopes, and held in a 1,024-entry transient cache.
- Backup generation is serialized, stale attempts are deleted before retry,
  accepted exports stream from scratch, imports stream their core slice to
  scratch, and failed limits do not update `last_backup_at`.
- Independent review found no merge blockers after request-budget, streaming,
  cancellation, alt-text, profile rollback, and backup-finalization fixes.
- Final verification: 1,441 daemon unit tests, daemon and frontend checks, 136
  affected frontend Playwright tests, `git diff --check`, and the real relay
  export-wipe-restore integration pass.

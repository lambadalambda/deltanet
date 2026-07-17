# Include daemon-local profile assets in backups

## Summary

Make `.dnbk` coverage match the documented profile state by including the
daemon-local custom header, or deliberately redesigning/removing that local-only
state before public desktop release.

## Requirements

- Add a versioned, authenticated sidecar representation for the custom
  `header.png` with explicit MIME, size, and resource limits, or document and
  implement a different authoritative storage model.
- Preserve read compatibility with existing DNBK1 containers that have no
  header field.
- Restore the asset transactionally with the signing key, store, credentials,
  and restore journal; rollback or crash recovery must not publish a mixed
  profile state.
- Validate decoded bytes rather than trusting a filename or declared MIME type,
  and preserve restrictive filesystem handling in the target data directory.
- Keep browser/OAuth state excluded and freshly enrolled as currently designed.

## Acceptance Criteria

- Export-wipe-restore tests recover avatar/core state and the exact custom header
  while retaining identity, history, store, credentials, and attestation key.
- Legacy containers restore successfully with the documented default/no-header
  behavior.
- Wrong passphrase, malformed/oversized header, write failure, and interrupted
  restore tests leave the prior profile and identity roots consistent.
- README and backup UI state the exact included and excluded data after the
  format decision lands.

## Notes

- This daemon/backup issue is a public-desktop-release blocker but can be
  implemented and tested independently of Electron.

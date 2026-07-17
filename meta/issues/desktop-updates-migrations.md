# Implement signed desktop updates and data migrations

## Summary

Define and test the supported upgrade path for application binaries, daemon
state, Chromium state, and desktop settings, including tamper rejection,
interrupted-update recovery, and platform-specific update delivery.

## Requirements

- Publish signed update metadata and artifacts through an authenticated update
  channel. Embed/pin the update trust root, define key rotation/revocation, and
  reject modified, stale, replayed, rollback, or incorrectly sequenced metadata,
  checksums, signatures, and binaries.
- Define update discovery/install behavior separately for macOS, Windows, and
  each supported Linux package format rather than assuming one Electron updater
  mechanism works everywhere.
- Version desktop settings and every application-owned data schema. Define the
  first supported source version, migration sequence, backup point, and
  unsupported downgrade behavior.
- Resolve the alpha-data policy before public release: migrate the alpha
  application ID/user-data directory, or keep it deliberately isolated and
  provide a documented migration path using the legacy-compatible `.dnbk`
  backup format.
- Coordinate update shutdown with daemon graceful close, prevent concurrent
  application instances during replacement, and recover from interruption
  before, during, and after binary swap/migration.
- Preserve identity, credentials, OAuth state, store state, desktop settings,
  and backup availability across every supported upgrade path. Never partially
  publish migrated state as current.

## Acceptance Criteria

- Per-platform end-to-end tests update from every declared supported source
  version, restart successfully, and retain the complete documented state
  contract. The first public release uses a frozen signed pre-release fixture
  when no prior public version exists.
- Tests reject tampered metadata/artifacts and recover from interrupted download,
  replacement, migration, and restart phases.
- Unsupported downgrade fails safely with an actionable message and without
  modifying newer data.
- The release and rollback policy documents update cadence, platform mechanism,
  supported source versions, backups, and recovery steps.

## Notes

- Depends on `electron-desktop-alpha.md` and
  `desktop-platform-packaging.md`; updater tests consume actual packaged
  artifacts and the matrix/package formats defined there.

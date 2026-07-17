# Epic: Build cross-platform desktop release infrastructure

## Summary

Coordinate the independently deliverable packaging, updater/migration,
diagnostics/resilience, and backup-fidelity work needed to turn the one-platform
Electron alpha into a supportable public release.

## Requirements

- Complete [Package and sign desktop applications across platforms](desktop-platform-packaging.md).
- Complete [Implement signed desktop updates and data migrations](desktop-updates-migrations.md).
- Complete [Add desktop diagnostics and operational resilience](desktop-diagnostics-resilience.md).
- Complete [Include daemon-local profile assets in backups](backup-profile-assets.md).
- Keep the supported matrix, data compatibility contract, release identity,
  update policy, and user documentation consistent across all children.

## Acceptance Criteria

- All child issues satisfy their acceptance criteria and are archived.
- Signed artifacts for every supported target install, update, recover, and run
  with the matching native helper while preserving the documented identity and
  data contract.
- Release documentation states supported platforms, data locations, background
  behavior, backup boundaries, update policy, diagnostics contents, and known
  architecture exclusions.

## Notes

- Depends on `electron-desktop-alpha.md` and
  `daemon-production-runtime.md`.
- This is a coordination issue. Concrete work belongs in the narrowest child.
- Signing certificates, notarization credentials, and reputation lead time are
  external release prerequisites, not reasons to weaken local smoke coverage.

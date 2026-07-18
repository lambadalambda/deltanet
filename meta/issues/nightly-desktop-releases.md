# Publish unsigned nightly desktop builds

## Summary

Build native desktop artifacts on every push to `main` and publish them to a
rolling GitHub prerelease named `nightly`, without representing these unsigned
artifacts as production releases.

## Requirements

- Build on native GitHub runners for Linux x64, Windows x64, and macOS arm64.
- Bundle the matching compiled daemon, static frontend, and Delta Chat helper in
  every artifact.
- Produce Flatpak and AppImage variants for Linux, an installer executable for
  Windows, and a DMG for macOS.
- Publish versioned artifact names and SHA-256 checksums to a rolling `nightly`
  GitHub prerelease after all platform builds succeed.
- Keep the workflow free of signing/notarization credentials; clearly label the
  outputs as unsigned development builds.
- Explain when to use each artifact, how to install or run it, its architecture
  and sandbox/update limitations, and where it stores persistent application
  data.

## Acceptance Criteria

- A push to `main` runs checks/builds and uploads one `.flatpak`, one `.AppImage`,
  one `.exe`, and one `.dmg` plus checksums to the `nightly` prerelease.
- Each native job verifies that the expected staged helper and packaged output
  exist before upload.
- Pull requests do not publish releases, and concurrent pushes cannot mix
  artifacts from different commits.
- The production packaging/signing issue remains open.

## Notes

- Child slice of `desktop-platform-packaging.md`; signing, notarization, hardened
  fuses, updates, and installed-artifact acceptance remain there.
- Native CI has verified the Windows installer, final DMG, packaged macOS smoke,
  checksums, and rolling prerelease publication. Keep this issue open until the
  Linux AppImage and expanded release guidance are published successfully.

# Package and sign desktop applications across platforms

## Summary

Produce hardened, signed, natively built installers and packages for the
declared desktop support matrix, with installed-artifact and process-containment
tests on each target.

## Requirements

- Define the supported matrix, initially considering macOS arm64/x64, Windows
  x64, and Linux x64. Mark Windows arm64 unsupported while Delta Chat core
  2.53.0 has no matching helper rather than shipping an untested artifact.
- Add stable application identity, icons, installer metadata, application
  license, privacy/update policy, and third-party notices for Electron,
  Chromium, Delta Chat core, and bundled fonts.
- Pin Electron and packaging dependencies and document the security-update
  policy for Electron/Chromium releases.
- Build natively per target architecture, package the exact native helper
  outside ASAR, preserve executable permissions, and smoke-test installed
  artifacts rather than only unpacked development builds.
- Configure production Electron fuses to disable Run-as-Node, `NODE_OPTIONS`,
  and CLI inspect arguments and to require ASAR loading/integrity where the
  selected Electron version supports it. Assert fuse state in packaged tests.
- Sign Windows and macOS application/helper binaries, enable the macOS hardened
  runtime, notarize and staple macOS artifacts, and publish checksums.
- Keep signing/notarization credentials unavailable to pull-request and fork
  jobs. Restrict release credential access to protected release contexts,
  minimize token scope/lifetime, and document key rotation and revocation.
- Add native CI/release workflows and test install, launch, explicit shutdown,
  uninstall, quarantine/Gatekeeper, Windows signature/antivirus behavior, and
  Linux baseline compatibility.
- Contain and reap the Electron, daemon, and native-helper process tree. Abrupt
  main-process death must not leave a listener or helper running on any target,
  and the next launch must recover any stale lock safely.
- Exercise packaged create-account/enrollment and legacy-compatible `.dnbk`
  export-wipe-restore
  through native dialogs on every supported target, not only the alpha platform.

## Acceptance Criteria

- Every supported artifact installs and launches the matching bundled helper,
  passes packaged UI/API/WebSocket/restart/shutdown smoke tests, and exposes the
  expected hardened fuse state.
- macOS artifacts pass Gatekeeper after notarization, Windows artifacts validate
  their signatures, and Linux artifacts run on the documented baseline.
- Per-platform abrupt-death tests leave no live listener/helper and prove the
  next launch safely recovers the data lock.
- Per-platform packaged onboarding and native backup/restore tests preserve the
  same identity and attestation key without exposing enrollment or passphrase
  secrets.
- Published artifacts include verifiable checksums and complete application and
  third-party licensing material.

## Notes

- Depends on `electron-desktop-alpha.md`.

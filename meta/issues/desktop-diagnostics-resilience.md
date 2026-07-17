# Add desktop diagnostics and operational resilience

## Summary

Make background operation supportable through bounded redacted logs, explicit
health/recovery UI, diagnostics export, and platform-tested behavior under
network, power, process, and filesystem failures.

## Requirements

- Add bounded rotating logs and structured health/crash/restart events for
  Electron main, daemon, and the native helper.
- Exclude credentials, enrollment/bootstrap proofs, OAuth secrets, bearer and
  stream tokens, signing keys, backup passphrases, and message bodies from logs
  and diagnostics by default.
- Provide a user-controlled diagnostics export with a manifest describing every
  included file/value and an explicit confirmation before collection.
- Provide actionable UI for startup, occupied-port, live/stale data-lock,
  native-core startup/connectivity, relay/network, corrupt/read-only/full data,
  crash-loop, and failed-shutdown states.
- Define bounded restart/backoff and terminal-failure behavior. Preserve the
  renderer security boundary and never continue issuing bearer requests to a
  dead/replaced daemon origin.
- Test sleep/wake, offline startup, network changes, forced termination, full
  disk, locked/read-only/corrupt data, and user cancellation of recovery/export
  flows on every supported platform.
- Test tray/menu status, close/reopen policy, explicit Quit, launch-at-login, and
  start-hidden behavior in installed artifacts on every supported platform.

## Acceptance Criteria

- Failure-injection UI tests assert the documented diagnosis and recovery action
  for every listed state.
- Diagnostics redaction tests seed every secret class plus representative message
  content and prove none appears in logs or the default export.
- Sleep/wake, offline/reconnect, crash-loop, full-disk, and locked/corrupt-data
  scenarios preserve identity and terminate or recover within documented bounds.
- Per-platform installed tests prove tray/window behavior, explicit Quit, and
  enabling/disabling launch-at-login follow the documented policy without
  spawning duplicate daemon instances.
- Log rotation and diagnostics export remain within configured size/resource
  limits and clean up cancelled/failed exports.

## Notes

- Builds on the alpha's initial failure UI; this issue completes and validates
  it across the release matrix.
- Depends on `desktop-platform-packaging.md` for the supported matrix and
  installed artifacts.

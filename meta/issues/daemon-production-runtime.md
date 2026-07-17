# Build a production daemon runtime and lifecycle

## Summary

Turn the current top-level `tsx` development executable into a compiled,
embeddable production service with explicit configuration, readiness, failure,
and graceful shutdown boundaries. Keep the existing CLI as a thin adapter.

## Requirements

- Extract startup into a typed function that accepts absolute listener, static,
  data, credential, auth, relay, and native-helper configuration instead of
  reading paths from `process.cwd()` throughout module initialization.
- Return a lifecycle handle containing the actual bound origin, a readiness
  result, and an idempotent asynchronous `close()` operation.
- Retain and close the HTTP server and WebSocket server, stop accepting work,
  close live streams, stop Delta Chat I/O/core, and release the process lock in
  a bounded order.
- Expose structured events for enrollment-code replacement, readiness,
  recoverable diagnostics, and fatal startup/runtime failure. Do not require a
  desktop parent to parse console output.
- Add a production JavaScript build and start command that does not ship `tsx`,
  TypeScript sources, or development-only compiler binaries as runtime
  dependencies.
- Preserve the current standalone CLI behavior, including environment settings,
  signal handling, loopback defaults, enrollment logging, and API contracts.

## Acceptance Criteria

- Unit tests drive startup, readiness, startup failure, repeated shutdown,
  signal shutdown, occupied-port failure, and native-core exit behavior.
- The compiled daemon serves the static SPA plus authenticated REST/WebSocket
  API with the existing daemon and relay integration suites passing.
- Explicit shutdown leaves no HTTP listener, WebSocket, daemon lock, or
  `deltachat-rpc-server` process behind and completes within a documented bound.
- Both absolute Electron-managed paths and the existing CLI defaults survive a
  restart with the same identity and auth state.
- The production artifact runs under the repository's pinned Node 24 contract
  without loading TypeScript or development dependencies.

## Notes

- This issue is useful independently of Electron and should land first.
- Prefer a functional `startDaemon(config)` boundary over an application class.

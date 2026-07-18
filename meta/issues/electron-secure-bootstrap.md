# Bootstrap the secure macOS Electron host

## Summary

Create the first independently shippable slice of the Electron alpha: a pinned
`desktop/` package whose sandboxed renderer is shown only after a supervised
Headwater daemon utility process reports readiness. Establish the narrow typed
main/preload/utility-process boundary without implementing tray behavior,
native backup dialogs, launch-at-login, or signed packaging yet.

## Requirements

- Add an independent `desktop/` package with exact Electron and packager pins,
  TypeScript checks, deterministic tests, and build output excluded from Git.
- Enforce context isolation, renderer sandboxing, disabled Node integration,
  denied permissions, blocked unexpected navigation/windows, and validated
  external HTTP(S) links.
- Launch the compiled daemon through Electron `utilityProcess`, pass absolute
  user-data/resource paths, and wait for a typed readiness message before
  creating the browser window.
- Carry structured daemon events and fatal/closed states over the private parent
  port. Validate every message at both ends; do not place enrollment secrets in
  argv, logs, renderer globals, or persistent files.
- Expose only a narrow, frozen preload status API. Do not expose raw IPC,
  filesystem, shell, process, or daemon credentials to the renderer.
- Enforce one application instance and show a visible startup failure rather
  than loading the privileged renderer when the daemon cannot become ready.

## Acceptance Criteria

- Unit tests cover message validation, secure BrowserWindow preferences,
  permission/navigation/window policy, sender validation, duplicate readiness,
  fatal-before-ready, and idempotent utility shutdown.
- A development smoke on macOS arm64 starts the compiled daemon in a utility
  process, receives its actual origin, loads the static SPA only afterward, and
  quits without leaving the listener, utility process, native helper, or lock.
- `pnpm check`, package tests, desktop build, root build, and existing daemon
  lifecycle/artifact tests pass.
- The parent Electron-alpha issue remains open for bootstrap proof/onboarding,
  tray/background policy, native backup dialogs, launch-at-login, packaging,
  abrupt-main process containment, and full alpha acceptance.

## Notes

- First platform is macOS arm64, following `electron-desktop-alpha.md`.
- Reuse `startDaemon(config)` and the loopback HTTP/WebSocket API. Do not move
  ordinary application traffic onto IPC.
- Implementation is complete through unit/type/build verification. The
  development smoke harness assembles and launches an ephemeral app bundle, but
  this restricted session cannot start Electron GUI processes: direct launch is
  denied at Mach-service registration and LaunchServices never enters app code.
  Run `pnpm --dir desktop test:smoke` from an unrestricted macOS login session
  before closing this issue.

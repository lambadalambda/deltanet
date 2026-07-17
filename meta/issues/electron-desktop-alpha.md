# Ship a one-platform Electron desktop alpha

## Summary

Build the smallest secure, usable desktop application on one development
platform first. It should supervise the production daemon, remove the terminal
from onboarding, preserve identity/session state, and support set-and-forget
background operation without yet solving the full release matrix.

## Requirements

- Add a separate `desktop/` package with a secure Electron main process and a
  narrow preload API. Disable renderer Node integration, enable context
  isolation and sandboxing, deny permissions by default, and validate the sender
  and payload of every IPC operation.
- Pin Electron and the packager. Run the exact compiled daemon artifact in an
  Electron `utilityProcess` so a core crash cannot terminate Electron main. A
  different child-process host requires a documented incompatibility plus an
  explicitly bundled/pinned Node runtime; never depend on an ambient Node.
  Wait for structured readiness before showing the application and use bounded
  restart backoff with a terminal failure state.
- Store mutable daemon state under `app.getPath('userData')`; load the static SPA
  and native helper from read-only application resources.
- Package the matching `deltachat-rpc-server` executable outside ASAR, preserve
  executable permissions, and provide its absolute path through
  `DELTA_CHAT_RPC_SERVER`.
- Persist a randomly selected loopback port after first successful bind, enforce
  one application instance, and fail visibly rather than silently changing the
  origin on a later conflict. Suspend/destroy the renderer if the daemon exits
  so another process cannot claim the origin and receive bearer requests.
- Keep the privileged renderer local-node-only. Block unexpected navigation and
  windows, open validated external HTTP(S) links in the system browser, add a
  restrictive CSP/security headers, and self-host fonts.
- Deliver enrollment codes through private daemon-to-main events and a narrow
  renderer operation. Require a main-generated bootstrap proof for desktop
  signup, restore, and initial OAuth registration so another local process
  cannot race an unconfigured node. The proof must be high-entropy, scoped to
  onboarding, single-use or short-lived, rotated on restart, and delivered over
  inherited private IPC rather than argv, logs, or a persistent file.
- Define close-window versus Quit behavior, add tray/menu status and an opt-in
  launch-at-login/start-hidden setting, and perform graceful daemon shutdown on
  explicit Quit.
- Use native open/save dialogs for the legacy-compatible `.dnbk` backup format
  and provide actionable UI for startup,
  data-lock, core-connectivity, and port-conflict failures.
- Contain the Electron-main, daemon, and `deltachat-rpc-server` process tree so
  abrupt main-process death cannot leave a listener, native helper, or live lock
  behind on the alpha platform.
- Version desktop-owned settings and choose an explicit alpha-data policy:
  either preserve this application ID/user-data directory through the first
  supported release with a tested migration, or use an isolated disposable
  alpha identity and say so before users create accounts.

## Acceptance Criteria

- An unpackaged development app and an unsigned package on the selected first
  platform can create or restore an account without a terminal, authenticate,
  post, stream updates, export a backup, restart with the same identity/session,
  and quit without orphan processes.
- Security tests cover preload exposure, sender validation, navigation,
  `window.open`, permissions, CSP, stable-origin handling, renderer teardown
  after daemon failure, and rejection of missing, wrong, expired, or replayed
  bootstrap proofs.
- Closing and reopening the window follows the documented background policy;
  launch-at-login can be enabled and disabled; explicit Quit shuts down within
  the daemon's documented bound.
- A packaged smoke test launches the bundled native helper and verifies the
  static UI, status endpoint, authenticated API, WebSocket, restart persistence,
  and clean shutdown.
- Alpha-platform tests kill Electron main abruptly and prove the daemon listener,
  lock, utility process, and native helper are reaped or recoverable on the next
  launch. Startup, lock, core-connectivity, and port-conflict failures each have
  an asserted user-visible recovery path.
- The selected Electron utility runtime executes the same production daemon
  artifact verified under Node 24, or the documented runtime incompatibility is
  resolved before the alpha is accepted.

## Notes

- Target macOS arm64 first unless the product owner selects another development
  platform. Cross-platform signing, updates, and broad installer coverage belong
  to the release-infrastructure issue.
- Depends on `daemon-production-runtime.md`.

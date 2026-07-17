# Epic: Package Headwater as a desktop application

## Summary

Coordinate the work required to ship Headwater as an installable Electron
application that owns the daemon lifecycle, requires no terminal, and can
remain running in the background. Keep the existing same-origin loopback
HTTP/WebSocket boundary between the static SvelteKit frontend and daemon rather
than replacing the tested API with broad renderer IPC.

## Requirements

- Complete [Build a production daemon runtime and lifecycle](daemon-production-runtime.md).
- Complete [Ship a one-platform Electron desktop alpha](electron-desktop-alpha.md).
- Complete [Build cross-platform desktop release infrastructure](desktop-release-engineering.md).
- Keep security and persistence decisions consistent across the three child
  issues; do not duplicate the daemon or replace its tested HTTP API in the
  renderer.

## Acceptance Criteria

- All three child issues satisfy their acceptance criteria and are archived.
- A nontechnical user can install Headwater on every supported platform, create
  or restore an identity without a terminal, leave it running according to the
  documented background policy, receive updates, and recover actionable
  diagnostics when startup fails.

## Notes

- This is a coordination issue, not an implementation bucket. New concrete work
  should be added to the narrowest child issue or split again when independently
  deliverable.
- The static SPA, loopback API, durable daemon state, local OAuth boundary, and
  Delta Chat transport abstraction are reusable. This is primarily lifecycle,
  packaging, desktop security, and release engineering.

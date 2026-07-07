# Hygiene: pin core exactly; honest timeline labels

## Summary

Two small items from the substrate audit.

## Requirements

- Pin `@deltachat/stdio-rpc-server` + `@deltachat/jsonrpc-client` to exact
  versions (no `^`) with a comment: broadcast channels are the
  least-stable, spec-less part of core and the wire format changed
  recently — upgrades are deliberate events (re-run integration suite).
- Frontend: the "Federated" tab renders home-timeline data — rename or
  remove; audit "Local" semantics at the same time (own posts?). Copy
  change only, keep tests green.

## Acceptance Criteria

- Lockfile-independent exact pins; note in DEVLOG.
- No timeline tab whose label promises fediverse semantics we don't have.

## Current Status (2026-07-07)

Frontend half done (frontend tracker issue 66); the core-pin half is separate.
Confirmed daemon-side that `/api/v1/timelines/home` and `/timelines/public`
share the same handler and ignore the `local` param, so Home, Local, and
Federated all served identical data. Chose removal over rename for both: a
renamed duplicate tab would still be a second surface showing the same posts as
Home. Removed the Local and Federated nav items plus all in-app
`appPublicTimeline*` machinery, collapsed the signed-out `/public` route to a
single honest public feed (no Local/Federated split), and softened landing copy
("The federated timeline, right now." → "The public feed, right now."). Only
"Home" remains as a timeline. Affected Playwright tests updated
(app-public-timelines.e2e.ts deleted, public-timeline/app-routes/app-trends
adjusted); frontend `pnpm test` (315) + `pnpm check` green.

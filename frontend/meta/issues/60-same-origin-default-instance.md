# 60 Default to same-origin instance

## Summary

The daemon serves this frontend's build output on the same origin (e.g. `http://localhost:4030`). Since deltanet is single-user, the instance/home-server field should default to the page's own origin instead of requiring the user to type a server domain.

## Requirements

- Default the instance/home-server value to `window.location.origin`, falling back to `PUBLIC_PLEROMA_INSTANCE_URL`, then `http://localhost:4030`, for dev contexts where `window` origin isn't meaningful.
- The "Your home server" input should be prefilled with that default value.
- De-emphasize the instance field behind an "advanced" affordance (e.g. collapsed by default) — most users never need to change it.

## Acceptance Criteria

- Landing sign-in/sign-up defaults to same-origin without user input.
- Advanced/instance override still works for dev/testing against a different origin.
- Playwright coverage for the default-origin behavior (mocked `window.location.origin`).
- `pnpm run check` and the full test suite pass.

## Notes

- Part of the larger deltanet frontend pivot.

## Current Status

Done (2026-07-06, pending orchestrator commit). Added `defaultDeltanetInstanceUrl` in `src/lib/pleroma/deltanet.ts` (window origin → PUBLIC_PLEROMA_INSTANCE_URL → http://localhost:4030). The landing page initializes the instance value from it on mount; the "Your home server" input now lives behind an "Advanced" toggle on both tabs, prefilled with the default. The multi-server "Recent servers" picker and server cards were removed (single-user node model). Covered by landing.e2e.ts ("home server field defaults to the current origin..." and the redirect test asserting pending OAuth targets the page origin).

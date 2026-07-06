# 61 DeltaNet signup flow

## Summary

Rework the "Create account" tab to register a chatmail account on the daemon (`POST /api/deltanet/signup`) instead of picking a Pleroma server. On landing load, default to the tab that matches whether the daemon already has an account configured.

## API (daemon-provided, contract fixed, implemented by a parallel agent)

- `GET /api/deltanet/status` → `{"configured": boolean, "address": string | null}`
- `POST /api/deltanet/signup` JSON `{"display_name": string, "relay"?: string}` → 200 `{"account": {...}}` | 409 (already configured) | 422 (bad display_name)

## Requirements

- Create-account tab: a required display-name field, plus a relay URL field that is advanced/collapsed with default `https://nine.testrun.org` and a one-line explanation that this is the mail relay hosting the user's address.
- Submit → `POST /api/deltanet/signup`. On success, show the assigned address (from `account.acct`) and automatically continue into the existing OAuth sign-in flow so the user lands in the app signed in.
- Map 409 to a message like "this node already has an account — sign in instead" and switch to the sign-in tab.
- On landing load, `GET /api/deltanet/status` (same-origin): if `configured: false`, default to the Create-account tab; if `true`, default to Sign in.
- Map 422 to a validation error surfaced on the display-name field.

## Acceptance Criteria

- Playwright coverage (mocked `/api/deltanet/*`): signup happy path continuing into OAuth, 409 path switching to sign-in with the right message, status-driven default tab selection (both configured states).
- `pnpm run check` and the full test suite pass.

## Notes

- Part of the larger deltanet frontend pivot. Depends on issue 60 (same-origin default) for the instance used to call these endpoints.

## Current Status

Done (2026-07-06, pending orchestrator commit). `src/lib/pleroma/deltanet.ts` gained `fetchDeltanetStatus` and `signupDeltanet` (typed 409/422/network error mapping). The landing "Create account" tab is a display-name field plus an advanced-collapsed relay field defaulting to https://nine.testrun.org with a one-line relay explanation. Submit posts `{display_name, relay}`; success shows the assigned address from `account.acct` for ~0.9s, then auto-continues into the existing OAuth redirect flow on the same origin. 409 switches to the Sign in tab with "This node already has an account — sign in instead."; 422 surfaces the server validation message inline. On landing load, GET /api/deltanet/status picks the default tab (configured:false → Create account, true → Sign in; errors fall back to Sign in). Landing hero copy rewritten for the encrypted-email federation model. 9 landing tests cover happy path, 409, 422, status-driven tabs, advanced relay, and mobile.

# Profile deep links fail outside in-app navigation

## Summary

Typing a profile URL directly (e.g. `/app/profiles/12` or
`/app/profiles/@user@relay`) shows "Record not found"; profiles only load
via in-app links (which percent-encode the handle). Found during follow-back
verification. Likely the route-param decode/lookup path in the frontend
differs from what the daemon's lookup endpoint expects for hand-typed forms.

## Acceptance Criteria

- `/app/profiles/<contact-id>` and `/app/profiles/@user@relay` (typed into
  the address bar) both render the profile.

## Current Status (2026-07-07)

Frontend half done (frontend tracker issue 65). Root cause: the frontend's
`resolveProfileAccount` routed every typed form through the same
search → lookup → unconditional `getAccount(handle)` order, but the daemon's
two endpoints answer different shapes — `GET /accounts/:id` does `Number(id)`
(numeric only) and `GET /accounts/lookup?acct=` resolves an address (leading
`@` tolerated). An address that missed search/lookup fell through to
`getAccount("@user@relay")` → NaN → "Record not found". Fixed by branching on
handle shape up front: numeric → `accounts/:id`; address (raw or encoded) →
`accounts/lookup` (with search fallback); bare-name still starts from search.
All three typed forms now render. Playwright coverage added for each; frontend
`pnpm test` + `pnpm check` green.

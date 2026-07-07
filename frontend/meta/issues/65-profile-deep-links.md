# 65 Profile deep links resolve for all typed forms (done)

## Summary

Typing a profile URL directly into the address bar fails while in-app profile
links work. `/app/profiles/12` (numeric contact id) and
`/app/profiles/@user@relay.tld` (raw or percent-encoded) both render
"Pleroma request failed / Record not found". In-app links only work because
they hand `resolveProfileAccount` a handle the cache/search path already
resolves. Root-tracker: `../meta/issues/profile-deep-links.md`.

## Root Cause

`resolveProfileAccount` in `src/routes/app/[...path]/+page.svelte` resolved
every typed form through the same order: cache -> `accounts/search?q=` ->
`accounts/lookup?acct=` -> a final unconditional `getAccount(handle)`
fallthrough (`GET /api/v1/accounts/:id`).

The daemon exposes two distinct account endpoints:

- `GET /api/v1/accounts/:id` does `Number(id)` — a numeric contact id resolves,
  anything else becomes `NaN` -> "Record not found".
- `GET /api/v1/accounts/lookup?acct=<address>` resolves an address, tolerating a
  leading `@`; a bare number is not an address -> 404.

So the shape of the handle determines which endpoint can answer, but the code
did not branch on it:

- Numeric `12`: `accounts/search?q=12` is not guaranteed to return a match
  (search is address/name fuzzy, not id lookup); `lookupAccount("12")` 404s;
  and although the `getAccount("12")` fallthrough *would* work, any earlier
  throw (e.g. a search endpoint that errors rather than returning `[]`) surfaces
  as the error instead of reaching it.
- `@user@relay` / `user@relay`: when the search/lookup match check misses, the
  final fallthrough calls `getAccount("@user@relay")` -> `Number(...)` = `NaN`
  -> "Record not found", instead of routing the address to `lookupAccount`.

The fix branches on handle shape first: a purely numeric handle goes straight to
`getAccount` (`accounts/:id`); an address (contains `@`, raw or `@`-prefixed,
percent-decoded by the route) goes to `lookupAccount` (`accounts/lookup?acct=`).
The cache/search path is kept as an optimization for in-app navigation but is no
longer the only resolution route, and `getAccount` is no longer used as a
catch-all for non-numeric handles.

## Requirements

- `/app/profiles/<numeric-id>` resolves via `accounts/:id`.
- `/app/profiles/@user@relay`, `/app/profiles/user@relay`, and their
  percent-encoded forms resolve via `accounts/lookup?acct=` (leading `@`
  tolerated).
- In-app links (cached/searched handles) keep working.

## Acceptance Criteria

- Playwright coverage for all three typed forms without relying on
  `accounts/search` to resolve them.
- `pnpm test` and `pnpm check` are green.

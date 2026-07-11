# Validate and constrain signup relay requests

## Summary

The signup API accepts a caller-provided relay string and performs a server-side
POST to `${relay}/new` without URL validation or a timeout. Before a node is
configured, this can be abused as an arbitrary-request/SSRF primitive. Custom
and self-hosted chatmail relays remain a legitimate use case, so the trust policy
must be explicit rather than hard-coding only the default relay.

## Requirements

- Parse relay input as a URL and reject unsupported schemes, credentials,
  malformed hosts, fragments, and ambiguous path construction.
- Treat custom relay selection as a privileged operation protected by the local
  API security boundary.
- Define how private, loopback, and self-signed development relays are enabled
  without making them available to arbitrary unauthenticated callers.
- Apply connection and response timeouts, a bounded response size, and clear
  error handling to registration requests.
- Validate the registration response before persisting or opening an account.

## Acceptance Criteria

- Invalid schemes and malformed relay values fail before any network request.
- Untrusted callers cannot make the daemon contact an arbitrary internal or
  external URL through signup.
- The default public relay, explicitly configured custom relays, and the local
  integration-test relay continue to work.
- Tests cover URL normalization, blocked inputs, timeout, oversized/invalid
  responses, and the explicit development/private-relay path.

## Notes

- Current references: `daemon/src/server.ts:676-684` and
  `daemon/src/signup.ts:10-18`.

## Implementation

- Relay input is lexically constrained to a bare HTTPS authority and then
  canonicalized to an origin. Redirect following is disabled.
- The default relay is always allowed. Additional origins require both an
  operator `DELTANET_SIGNUP_RELAYS` entry and the current unexpired terminal
  enrollment proof; unsafe/no-auth server mode fails closed for custom relays.
- Registration has a 10-second whole-request timeout and a 16 KiB response cap.
  Failure, oversize, and timeout paths abort or cancel active response work and
  never expose upstream response bodies.
- Registration JSON and mailbox/password syntax are validated before the
  account context can persist or open the returned credentials.
- The frontend requests enrollment proof only for non-default relay selection,
  including canonical default-origin variants.

## Verification

- Two independent review rounds completed; final code review found no merge
  blockers, and the final threat-model finding on mailbox dot-atom validation
  was addressed.
- All 1,501 daemon unit tests pass serially.
- All 350 frontend Playwright tests pass with one worker.
- All 18 tests in the 16-file local podman relay integration suite pass,
  including registration through the self-signed development relay.
- Daemon TypeScript, frontend Svelte/TypeScript, and `git diff --check` pass.

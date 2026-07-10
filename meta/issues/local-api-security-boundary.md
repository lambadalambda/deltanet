# Harden the local daemon API security boundary

## Summary

The daemon currently treats an initialized transport as authorization,
returns fixed OAuth credentials, permits every CORS origin, and starts the
HTTP server without an explicit loopback hostname. A website or network peer
that can reach the daemon may therefore be able to read private state or invoke
mutating APIs, including posting, following, profile changes, and backup export.

Relevant code: `daemon/src/server.ts` (`cors`, `requireTransport`, OAuth and
streaming routes) and `daemon/src/main.ts` (HTTP server startup).

## Requirements

- Bind to a loopback address by default. Any non-loopback listener must require
  an explicit configuration choice and a documented security model.
- Replace the fixed/unchecked bearer-token behavior with an unguessable local
  session or token that is validated on every private REST and WebSocket route.
- Define the small set of intentionally unauthenticated onboarding and metadata
  routes; all other routes must fail closed.
- Restrict CORS to trusted frontend origins. Preserve the two-node development
  workflow through explicit configuration rather than a wildcard origin.
- Validate OAuth redirect, code, client, and token inputs, or replace the OAuth
  compatibility shim with an equivalently protected local sign-in flow.
- Document token storage, rotation/revocation, and the expected reauthentication
  behavior for existing browser sessions.
- Persist rebuildable positive feed-message provenance and require it for every
  locally resolved node in anonymous public status/boost trees.
- Treat explicit browser signout as client unpairing: revoke the authenticated
  OAuth client and all of its sessions, codes, and stream tickets, then forget
  the browser's persisted client registration.
- Bound authorization-code state to one outstanding code per client and a
  finite global maximum, and prevent caching of OAuth credentials/codes/tokens.
- Remove callback credentials from browser history after parsing and document
  the short residual lifetime of already-issued signed blob capabilities.

## Acceptance Criteria

- Missing, malformed, expired, and incorrect credentials receive `401` or
  `403` on every private HTTP and streaming endpoint.
- A valid local session can use all supported API and streaming functionality.
- Requests from an untrusted browser origin do not receive permissive CORS
  headers and cannot read credentialed responses.
- A default daemon is reachable only through loopback; an automated test covers
  the listener configuration.
- OAuth redirects and token exchanges reject unregistered or invalid values.
- Daemon unit tests cover public-route exceptions and the private-route auth
  matrix; frontend authentication tests cover the resulting sign-in flow.
- Anonymous timelines and profiles never project a DM-only local message through
  a feed boost, while a fully feed-backed public boost remains visible.
- Successful signout makes retained client credentials unable to authorize or
  exchange, closes every socket for that client, and requires fresh terminal
  enrollment on the next browser sign-in.
- OAuth app/token/code responses are non-cacheable, callback URLs are scrubbed,
  and authorization-code storage remains bounded under repeated issuance.

## Notes

- Current references: `daemon/src/server.ts:645-665`,
  `daemon/src/server.ts:811-849`, and `daemon/src/main.ts:377`.
- The daemon is designed as a local single-user node, but localhost alone is not
  an authorization boundary when arbitrary websites can send browser requests.

# Refresh README and project status documentation

## Summary

Bring the root README and related status documents into line with the current
wire-v2 daemon, implemented capability contract, integration topology, backup
contents, and release state.

## Requirements

- Correct the two-node curl example to use separate bearer tokens for the two
  independent auth stores.
- Describe relay privacy precisely: message bodies are encrypted, while relays
  temporarily store ciphertext and observe delivery metadata such as addresses,
  timing, and sizes.
- Replace the inaccurate per-follower encryption description with the current
  per-channel symmetric encryption and recipient-envelope fan-out model.
- Scope backup claims to the state actually carried by core plus the encrypted
  sidecar. Document that browser/OAuth pairing is intentionally reset and that
  the daemon-local custom profile header is not currently included.
- Distinguish the cryptographic identity data directory from the complete live
  node configuration, whose credentials and auth state live beside it by
  default.
- Replace the stale Model v0 feature summary with an implemented/deferred table
  matching `meta/frontend-daemon-capabilities.md`, including the distinction
  between direct-visibility statuses and unavailable human chat threads.
- Correct CI wording: push CI is restricted to `main`, and the current Podman
  preflight checks for `systemctl` rather than proving systemd runs as PID 1.
- Update repository layout and integration-suite wording to include `docs/`,
  `meta/`, the relay test environment, orchestration, and the multi-file
  integration suite.
- Document that custom signup-relay allowlisting does not replace Delta Chat
  mail-domain autoconfiguration and valid production transport TLS.
- Qualify restart/offline claims with finite relay retention and the distinction
  between re-derived indices and durable non-derivable store state.
- Remove or update stale status claims in related architecture, design-sketch,
  and frontend README documents.

## Acceptance Criteria

- Every command and API example in the root README works as written against the
  current daemon security model.
- Product, privacy, encryption, backup, CI, and feature-status descriptions are
  consistent with code, tests, `docs/decisions.md`, and the capability contract.
- Implemented features are not described as future or generically partial, and
  unavailable features are not implied to work with the bundled daemon.
- A documentation review finds no material contradiction among the root README,
  frontend README, architecture/status documents, and current open issue index.

## Notes

- Quick-start commands, toolchain pins, enrollment, local OAuth, CORS,
  non-loopback protection, signup URL validation, and the Podman relay workflow
  are substantially accurate today.

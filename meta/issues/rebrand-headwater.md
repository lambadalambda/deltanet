# Rebrand DeltaNet to Headwater

## Summary

Rename the product, packages, active documentation, user-facing APIs, runtime
configuration, browser state, and operational identifiers from DeltaNet to
Headwater. Integrate the supplied neon-green/navy Headwater mark throughout the
frontend while preserving existing identities, signed history, sessions, and
backup readability.

## Requirements

- Replace product-visible DeltaNet naming with Headwater in the landing page,
  authenticated shell, public/auth routes, design system, metadata, errors,
  accessibility labels, fixtures, documentation, and test assertions.
- Replace the spark brand mark with a faithful hand-authored SVG version of the
  supplied Headwater logo and use it for the favicon, landing/header marks,
  mobile surfaces, OAuth transition, and design-system examples.
- Rename package metadata, active TypeScript symbols/modules, temporary paths,
  relay test infrastructure, fake domains, logs, and new backup filenames to
  Headwater equivalents.
- Prefer `/api/headwater/*`, `/headwater/*`, `configuration.headwater`,
  `pleroma.headwater`, `HEADWATER_*`, and `headwater.*` browser keys in all new
  code and responses.
- Preserve existing nodes through explicit compatibility: accept legacy API and
  resource routes, environment variables, JSON namespaces, browser keys, auth
  hash domains, persisted filenames/core config keys, and legacy `.dnbk`
  backups during migration. New state must not generate a replacement signing
  key or feed channel when legacy state exists.
- Keep `dn: 2`, `dn2`, and `dn3` as immutable protocol/signature identifiers;
  keep v0/v1 read-side parsing and the `DNBK1` decoder. These bytes identify
  deployed formats and are not user-facing branding.
- Document legacy identifiers as compatibility names and distinguish them from
  current Headwater-facing names rather than silently rewriting protocol
  history.

## Acceptance Criteria

- No user-visible DeltaNet naming or old spark mark remains in the built app.
- Fresh installs use Headwater package/config/API/storage/resource names, while
  an existing DeltaNet-era node starts with the same identity, feed channels,
  store, auth sessions, signing key, and browser pairing.
- Existing signed wire-v2/dn2/dn3 messages still verify and render; legacy
  `.dnbk` files restore; newly exported backups have a Headwater filename.
- Old and new API routes, environment aliases, and JSON namespaces have focused
  compatibility tests; new frontend requests and metadata prefer Headwater.
- Type checks, daemon unit tests, frontend Playwright tests, builds, and relay
  integration tests pass.

## Notes

- Delta Chat, `@deltachat/*`, invite URLs, and transport terminology name the
  upstream substrate and must not be renamed.
- Repository-directory and remote-slug changes require coordination outside the
  source tree after this code change lands.

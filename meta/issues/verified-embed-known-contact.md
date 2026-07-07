# Verified boost embeds ignore known contacts (renders "?" shell for people you've met)

## Summary

Live QA (lain's node): bob boosts carol's post; lain follows bob but not
carol — the verified-embed ladder fires correctly and renders carol's
attested text/addr. But lain HAS met carol (she replied to one of lain's
posts before), so lain holds a real DC contact row for her — display name
"Carol Sparkle", avatar — and none of it is used: the embed is attributed
via the bare `addrToAccount` shell (account id `0`, `?` fallback avatar,
local-part-as-display-name).

`verifiedEmbedToStatus` (`daemon/src/mastodon/entities.ts`, account
field) calls `addrToAccount(addr, baseUrl)` unconditionally. The
notification path (`daemon/src/mapping.ts` ~line 170) already implements
the correct pattern: resolve a real contact first, shell only as
fallback.

This is NOT a 0002 violation to fix: contact profile data (name/avatar)
arrived over the core-PGP-verified transport from the author herself; the
shell was only ever meant for addresses we've truly never seen.

## Requirements

1. When rendering a verified embed, resolve the author addr via
   `transport.lookupContactIdByAddr` + `transport.contact`; if a contact
   exists, attribute via `contactToAccount` (real contact id, display
   name, avatar route). Fall back to the addr shell only when no contact
   resolves.
2. The nested status identity does NOT change: `orig-<uuid>` id, orig.ts
   created_at, counts stay 0 — we still don't hold the post, only the
   author's profile. Only the `account` object enriches.
3. The verification ladder itself is untouched: sig + pin-consistency +
   media-hash gating decide WHETHER to render; this issue only changes
   the attribution used when it renders.
4. The per-msgId verification cache in mapping.ts must not cache a
   shell-attributed status forever if the contact appears later — either
   exclude the account object from the cache, cache the contact lookup
   separately with the same freshness as other contact renders, or drop
   caching of the account portion (pick the simplest correct option and
   note it).

## Acceptance Criteria

- Unit: verified embed with a resolvable contact renders that contact's
  display name/avatar/id; with no contact, the existing shell (current
  boost-embed tests keep passing).
- The A/B/C integration topology still passes: C truly never met A →
  shell attribution (unchanged); no new integration test required.
- `pnpm test` + `pnpm check` green in daemon/.

## Current Status

DONE (2026-07-07).

- `entities.ts`: `verifiedEmbedToStatus` takes an optional pre-resolved
  `account` (`account ?? addrToAccount(addr, baseUrl)`); `messageToStatus`
  threads it via a new `embedAccount` param. Stays pure / transport-unaware.
  Verification ladder untouched; only the `account` enriches — nested identity
  (`orig-<uuid>` id, `orig.ts` created_at, zero counts) unchanged.
- `mapping.ts`: `toStatus` resolves the embed author via `contactIdByAddr` +
  `contact` (contact-first, addr-shell fallback, mirroring `mapNotification`).
- Cache: the per-msgId `embedCache` caches ONLY the verification verdict; the
  account is resolved FRESH each render, so a shell rendered before the contact
  existed is never pinned forever (documented in a code comment). Simplest
  correct option — no invalidation logic, contact freshness matches every other
  contact render.
- Tests: unit 726 (was 725), new `boost-embed.test.ts` case asserting
  contact-backed name/avatar/id + unchanged nested identity; existing shell +
  tamper cases still green. `pnpm test` + `pnpm check` green. Integration suite
  not run (C-never-met-A shell path unaffected).

# 59 Rebrand PleromaNet to DeltaNet

## Summary

This frontend no longer talks to Pleroma instances directly. It is the UI for "deltanet" — a single-user daemon on localhost that speaks the Mastodon/Pleroma client API but federates over encrypted email (chatmail / Delta Chat) instead of ActivityPub. Rebrand all user-visible strings and storage keys from PleromaNet to DeltaNet, and rewrite the landing marketing copy to describe what the product actually is.

## Requirements

- Update all user-visible strings: app name, page titles, header wordmark, landing page copy.
- Rewrite the landing hero/marketing copy to describe: your own single-user node; federation over encrypted email; your identity is an email address on a chatmail relay; posts are delivered e2e-encrypted; follows are invite links; servers only ever see ciphertext.
- Keep the visual design and `/design-system` route intact — do not rename CSS tokens/classes.
- Update `package.json` name, `README.md` intro, and test assertions referencing the old name.
- Rename localStorage/sessionStorage key prefixes from `pleromanet.*` to `deltanet.*`.
- Leave internal type names like `PleromaStatus` alone — they describe the wire format, which is still Pleroma-flavored.

## Acceptance Criteria

- No user-visible "PleromaNet" strings remain (grep clean outside of internal Pleroma-wire-format type names/comments).
- `deltanet.session` / `deltanet.oauth.pending` storage keys used everywhere; no remaining `pleromanet.*` storage keys.
- Existing/updated Playwright tests assert DeltaNet branding.
- `pnpm run check` and the full test suite pass.

## Notes

- Part of the larger deltanet frontend pivot (rebrand, same-origin default, signup, invite/follow UI).

## Current Status

Done (2026-07-06, pending orchestrator commit). All user-visible "PleromaNet" strings renamed to "DeltaNet": page titles, header/drawer wordmarks, landing header, aria-labels, search labels/placeholders, error/toast copy, OAuth client_name, design-system branding samples, favicon title, package.json name, README/AGENTS/docs intros. Storage keys renamed: `deltanet.session`, `deltanet.oauth.pending`, `deltanet.notifications.lastSeenAt.*`; events `deltanet:poll-notifications` and `deltanet:check-home-timeline`. Fixture fake domain `pleromanet.social`/`pleromanet.test` became `deltanet.example` across fixtures/tests/design-system mock data. Internal Pleroma wire-format identifiers (PleromaStatus, createPleromaClient, $lib/pleroma, PLEROMA_SESSION_KEY constant name) deliberately kept, as were the dockerized integration-infra names (out of scope). Full suite and svelte-check pass.

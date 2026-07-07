# Wire format v2: structured JSON bodies

## Summary

Per decision 0001 (docs/decisions.md), deltanet drops vanilla-DC rendering
compatibility. Replace the text-marker grammar with a versioned JSON
envelope as the entire message body for all statuses and control messages.

## Requirements

- Envelope: `{"dn":2,"type":...,...}` — explicit type (`post`, `reply`,
  `boost`, `react`, `unreact`, `invite-request`, `invite-grant`, ...),
  human text as a field, uuid as a field, refs as fields (uuid-first,
  legacy mid fallback values allowed), room for future fields
  (must-ignore-unknown discipline; never repurpose keys; `dn` version
  gates parsing).
- Emit v2 only. Parse v2 first, fall back to the v0/v1 marker parsers
  read-side for existing histories (do not delete them yet).
- Drop compatibility-only behaviors: quotedText bubbles on replies/
  reactions, human-phrased control DM texts. DM copies of replies carry
  the same JSON envelope as the feed copy (same uuid).
- Store/schema: refs and post keys unchanged conceptually (uuid-first);
  bump store schema so re-index parses mixed-era data consistently.
- Per decision 0002: REMOVE synthesizeStatus/synthesizeAccount — a boost
  whose target is not locally held renders an explicit placeholder status
  (type-distinguishable by the frontend), never synthesized content.
- Reserve envelope field names `pubkey`/`sig` for post attestations
  (docs/design-sketches.md #6) — not implemented in v2, never repurposed.
- Update DEVLOG + the wire-convention documentation to describe v2 as
  the format, v0/v1 as read-only legacy.

## Acceptance Criteria

- Full existing test suites pass with v2 emission (unit + the three
  integration topologies), including mixed-era threads (legacy parent,
  v2 reply).
- No code path can render content attributed to an author without a
  locally-verified source (grep-level absence of synthesize*).
- A post whose text starts with legacy marker glyphs (e.g. "♻ hello")
  round-trips as plain content — the in-band ambiguity class is gone.
- No emitted message contains marker lines or quotedText compat text.

## Current Status

**DONE (2026-07-07).** Implemented in full; see DEVLOG "wire convention v2".

- Envelope: `src/envelope.ts` — `{"dn":2,"type":...}` as the whole body, strict
  `dn===2` gate, unknown-fields-ignored, malformed→plain-text. Typed refs
  (`{u,addr}` / `{mid,addr}`), `media.description` (federated alt text,
  replaces the in-memory mediaStore hack — registry kept for upload staging
  only), reserved `pubkey`/`sig` (never emitted). Read seam: `src/wire.ts`
  (v2-first, then v0/v1 markers read-side, then plain).
- Emission v2-only across posts/replies (incl. byte-identical DM copy, same
  uuid)/boosts/react-unreact/invite-request-grant. No quotedText anywhere.
  Boost = `type:"boost"` + ref, no embedded content (0002).
- `synthesizeStatus`/`synthesizeAccount` REMOVED (grep-clean). Unresolvable
  boost → booster's own status with `[boosted post unavailable]`, `reblog:null`,
  `pleroma.deltanet:{placeholder:"boost",ref}`.
- Store `schemaVersion=5`; v4→v5 dedupe continuity proven (no re-notify).
- Also (this issue's item 6, overlaps the hygiene issue's core-pin half):
  `@deltachat/*` pinned to exact `2.53.0` with a package.json comment.
- Tests: 643 unit (was 580) all green; 7 integration green against the local
  podman relay (extended to assert DM/feed copies share one uuid + cross-node
  v2 reply→v2 parent resolution). `pnpm check` clean.

Follow-ups (out of scope here): drop read-side v0/v1 parsers once test-era data
stops mattering; `pubkey`/`sig` attestations (sketch #6) upgrade placeholder
boosts to verified embeds. The transport still exposes an unused `quotedText`
passthrough (`PostOptions`/`sendControlDm`) — nothing populates it; removable
later.

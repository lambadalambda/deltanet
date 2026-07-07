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
- Reserve envelope field names `pubkey`/`sig` for post attestations
  (docs/design-sketches.md #6) — not implemented in v2, never repurposed.
- Update DEVLOG + the wire-convention documentation to describe v2 as
  the format, v0/v1 as read-only legacy.

## Acceptance Criteria

- Full existing test suites pass with v2 emission (unit + the three
  integration topologies), including mixed-era threads (legacy parent,
  v2 reply).
- A post whose text starts with legacy marker glyphs (e.g. "♻ hello")
  round-trips as plain content — the in-band ambiguity class is gone.
- No emitted message contains marker lines or quotedText compat text.

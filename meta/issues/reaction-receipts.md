# Verifiable reaction receipts (the last trust-by-default surface)

## Summary

Design sketch #2. After key confirmation landed, reaction tallies are the
ONLY remaining trust-by-default data in the system: a reaction control DM
is unsigned, and tallies rendered from relayed/republished context could
be inflated by a peer. Upgrade each reaction to a self-contained SIGNED
assertion ("addr X reacts ❤ to u:<uuid>", attested with the reactor's
existing ed25519 key), so a tally is a set of receipts, not bare counts.

## Design notes (from the sketch, updated to current machinery)

- React/unreact envelopes gain the standard attestation fields (`ts`,
  `pubkey`, `sig`) over a canonical payload covering emoji + target ref.
  The reactor's key is the SAME per-account signing key posts use — pins
  and key confirmation apply as-is.
- Own-post tallies (the authoritative case: the author receives reaction
  DMs directly over PGP) are ALREADY sound — receipts matter when tallies
  travel: aggregates republished to thread channels, backfill bundles,
  future gossip digests.
- Verification: a receipt verifies offline against the reactor's pin (or
  self-certifies + can be key-confirmed like any stranger content — the
  whole key-confirmation ladder is reusable).
- Large counts: count + sampled receipts, rest fetchable on demand.
- Honest limit (documented): receipts prevent COUNT FORGERY by a relayer
  or author, not sybil inflation — free instant signup means real
  accounts with real signatures remain mintable. Different layer.

## Acceptance Criteria

- New reactions are signed; legacy unsigned reactions still tally (marked
  or grandfathered — decide) on the author's own node.
- A relayed tally only counts receipts that verify; unverifiable ones are
  excluded or rendered as unconfirmed.
- Canonical-payload addition documented with the same downgrade analysis
  rigor as the immutable compatibility signature identifier `dn3` (reaction
  envelopes are a NEW signed surface, so no
  legacy-fallback trap: absent sig = legacy reaction).

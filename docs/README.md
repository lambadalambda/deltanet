# Headwater docs

- [development.md](development.md) - source setup, production containers, local
  API security, multi-node testing, backup/restore, CI, repository layout, and
  DeltaNet migration compatibility.

- [decisions.md](decisions.md) — standing design decisions (0001: hard cut from vanilla
  Delta Chat compatibility, wire v2 = JSON bodies; 0002: no synthesized
  statuses — rendered content must verify).

- [substrate-audit.md](substrate-audit.md) — hard facts about chatmail
  relays + Delta Chat core (limits, retention, encryption model, contact
  model), source-verified 2026-07-06 against relay@filtermail-v0.7.4 and
  core@v2.53.0.
- [federation-comparison.md](federation-comparison.md) — the exploration:
  chatmail federation vs the fediverse — matches, clashes, UX
  consequences, and what Headwater can do that ActivityPub can't.

- [design-sketches.md](design-sketches.md) — design rationale and current
  status for channel-based visibility, directory ideas, verifiable reaction
  receipts, thread backfill/subscriptions, expanded join history, wire-v2
  payloads, and post attestations. Several sketches are implemented; each
  section says what remains.

Design history and day-by-day findings live in the repo-root DEVLOG.md;
standing wire decisions live in `decisions.md`, while the current wire-v2/dn3
implementation is defined by `daemon/src/envelope.ts`, `daemon/src/wire.ts`,
and `daemon/src/attest.ts`.

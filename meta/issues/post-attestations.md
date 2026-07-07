# Post attestations: signed envelopes, verifiable boosts

## Summary

Implements design sketch #6 under decision 0002. Every content envelope
(post/reply/boost) is signed with a per-account ed25519 key; boosts embed
the original's complete signed envelope (+ re-attached media verified by
content hash), so recipients who don't hold the original can verify it —
republishers can omit, never alter or fabricate. This replaces the interim
boost placeholder for attested content; unattested/unverifiable embeds
still render placeholders (0002).

## Requirements

1. **Keys**: per-account ed25519 keypair (node:crypto, no new deps),
   generated lazily, private key persisted in the account data dir
   (e.g. `deltanet-signing-key.json`; data/ is gitignored). Public key
   embedded in every signed envelope (`pubkey`, base64).
2. **Signing**: envelopes gain `ts` (author-declared ms epoch, emitted on
   all content envelopes) and `sig` (base64 ed25519). The signature covers
   a **canonical payload reconstructed from fields** (NOT raw JSON): a
   documented fixed-order, versioned format (e.g. NUL-separated
   `dn2\0<type>\0<uuid>\0<addr>\0<ts>\0<text>\0<ref-token>\0<media-sha256>`,
   empty strings for absent parts) so re-serialization of the JSON can
   never break verification. Media: envelope `media.sha256` of the
   attached file, inside the signed payload.
3. **Key binding (TOFU + pinning)**: store gains `pinnedKeys:
   Record<addr, pubkey>` (additive, no schema bump needed). Pin on first
   verified sighting: any DIRECT delivery from an addr (core-PGP-verified
   transport) whose envelope carries a pubkey pins it — for followed
   accounts this rides the securejoin-verified channel, the strong
   binding. A signature that verifies against its embedded pubkey but
   CONFLICTS with a pinned key for that addr → treat as unverified.
4. **Boost embedding**: boost envelopes gain `orig`: the complete signed
   envelope object of the boosted post (the booster holds the original
   message, whose body IS that envelope), plus the original's media file
   re-attached to the boost message when present. Rendering order on
   receive: (a) ref resolves locally → recipient's own verified copy (as
   today); (b) `orig` present and its sig verifies (and pin-consistent,
   and attached-media hash matches when media declared) → render the
   original as a real status attributed via an addr-based account shell
   (addrToAccount precedent — attested content, honest shell; NOT
   synthesis); (c) anything else → the existing 0002 placeholder.
5. **Verification failures are placeholders, never partial renders**:
   bad sig, pin conflict, media hash mismatch → placeholder with a
   distinguishable flag (`pleroma.deltanet.placeholder: "boost-unverified"`
   vs existing `"boost"`).
6. Reactions/receipts and thread republication are OUT of scope (next
   issues); but keep the signing/verify helpers generic (they'll sign
   receipt payloads later).
7. Mixed-era: legacy and unsigned-v2 messages keep working (no sig → no
   change to direct-delivery rendering; only republication admission
   cares).

## Acceptance Criteria

- Integration (local relay), third-party topology: A posts (with an
  image); B follows A and boosts; C follows only B. C renders the boost
  with A's original text AND image, attributed to A's address, via the
  verified embed (C has never met A). Tamper unit tests: altered text,
  wrong pubkey, pin conflict, media hash mismatch → placeholder.
- Direct deliveries and legacy content render exactly as before.
- Unit: canonical payload round-trip/stability, sign/verify, TOFU pin +
  conflict, boost embed build (orig envelope verbatim from the held
  message), media hashing.

## Current Status

**DONE (2026-07-07).** Implemented in full; see DEVLOG "post attestations".

- Keys/signing: NEW `src/attest.ts` — per-account ed25519 (`generateKeyPairSync`,
  no new deps), persisted `deltanet-signing-key.json` (path injected like the
  store; 0600; never logged). `canonicalPayload` = fixed-order, per-field
  LENGTH-PREFIXED, version-prefixed:
  `lp(dn2) lp(type) lp(uuid) lp(addr) lp(ts) lp(text) lp(refToken) lp(mediaSha256)`
  concatenated with no separator, where `lp(x) = <utf8ByteLength(x)>:<x>`
  (reconstructed from FIELDS, not raw JSON; empty parts frame as `0:`).
  Length-prefixing instead of the spec's suggested NUL-join: `text`/`refToken`
  are attacker-controlled and may contain NUL, so a bare separator was
  ambiguous across field boundaries — one signature could verify two
  different envelopes (re-split attack); the length prefix makes each field
  self-delimiting with no rejected-content class. `sign(env,addr)→
  {ts,pubkey,sig}`, pure `verify(env,addr)`, streaming `sha256File`. Envelope
  gains real `ts`/`pubkey`/`sig`, `media.sha256`, and boost `orig`
  (`src/envelope.ts`).
- Signing lives in the send paths (`server.ts`): post/reply/boost envelopes are
  signed as the daemon's own addr (`mapper.ownAddr`); media posts carry a signed
  `media.sha256`.
- TOFU pinning: `store.pinnedKeys` (additive, no schema bump; survives
  `migrate`). Hook in `deriveOnIngest` — pins from a non-SELF DIRECT delivery's
  OUTER envelope only, first-wins; NEVER from an embedded `orig`. Pin conflict →
  unverified → placeholder.
- Boost embed: `server.ts` reblog parses the held target's envelope, embeds it
  VERBATIM as `orig` (only if signed), re-attaches the same file when the orig
  declares `media.sha256`; unsigned/legacy or unattestable media → ref-only.
- Rendering ladder (`entities.ts`/`mapping.ts`): own-copy → verified-orig (sig +
  pin-consistency + media hash of the boost's own attached file) → placeholder
  (`'boost'` absent/legacy, `'boost-unverified'` failed). Verified embed =
  addr-based account shell, nested `reblog.id` = `orig-<uuid>` (synthetic-free,
  frontend tolerates non-numeric string ids). Per-msgId verification cache.
- Tests: 725 unit (was 672) all green (NEW `attest.test.ts` — incl. framing-
  ambiguity probes: NUL re-split must not cross-verify, NUL-bearing text
  round-trips, framing-mimicry non-collision — and `boost-embed.test.ts` with
  the full tamper matrix; store/ingest/server extended). Integration: NEW
  `boost-attestation.test.ts` — exact A/B/C topology with an image; C renders
  B's boost with A's text/addr/image, blob hash matches the original. Full
  suite 8/8 green (~152s). `pnpm check` clean.

Out of scope (next issues, per the spec): reactions/receipts, thread
republication — the sign/verify helpers are kept generic for them.

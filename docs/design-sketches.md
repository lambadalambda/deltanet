# Design sketches (not scheduled)

Ideas explored 2026-07-07, downstream of the
[federation comparison](federation-comparison.md). None scheduled; captured
so the reasoning isn't lost. Common pattern across all three: **the party
that already has the data becomes a publisher** — the substrate's native
substitute for the fediverse's global fetchability.

## 1. Visibility tiers via multiple channels (not multiple accounts)

> Issued: meta/issues/visibility-channels.md (2026-07-07). Directory node
> part remains a sketch.

One account can own many broadcast channels; invites are per-channel and
multi-use (with withdraw/revive support in core). So:

- **public channel** — invite auto-granted to anyone (existing
  invite-request convention), link published in bio/QR/directory.
- **locked channel** — approval-gated grants (locked-mode hook).
- Mastodon visibility dropdown maps natively: `public` → public channel,
  `private` → locked channel. Today the selector is decorative; this makes
  it real. Do NOT model this as two accounts: splits identity, doubles key
  management, forces followers to manage two contacts.

Discovery ("announce the invite somewhere") = a **directory node**: a
well-known deltanet account that auto-grants follows, accepts listing
submissions as DMs (profile card + public-channel invite), republishes the
directory as a feed — and, being an ordinary server, can also serve an
HTTPS listing site (web presence without violating the relay's
no-cleartext rule).

## 2. Verifiable reaction gossip: portable receipts

Reaction gossip (author publishes tally digests to followers) is trusted
by default — the author could lie. Upgrade: make each reaction DM a
self-contained **signed assertion** ("addr X reacts ❤ to u:<uuid>"); the
author's digest then republishes receipts, not bare counts. Followers who
hold the reactor's key (Autocrypt gossip spreads keys anyway) verify
offline. Large counts: count + sampled receipts + rest on demand.
Fallback for unverifiable receipts: automated challenge-response
(`⁇ attest u:<uuid> ❤` → signed confirm/deny from the reactor's daemon)
— trust by default, verify when curious.

Honest limit: receipts prevent **author forgery**, not **sybil
inflation** — instant free signup means a liar can mint real accounts
with real signatures. Different layer, not solvable here.

## 3. Threads: auto-backfill + explicit subscribe

> Revised 2026-07-07 after attestations (sketch 6) landed and QA hit the
> concrete case: A and B talk a long thread; C follows only B, so C holds
> B's half (his feed) full of reply refs that dangle at A's posts. Issued:
> meta/issues/{wire-thread-root-ref,thread-auto-backfill,thread-subscribe}.md.

**Correction to the original premise**: the root author does NOT receive
every reply today — reply DM copies go to the PARENT author, not the
root. Two-party threads happen to be complete on both sides; a third
party replying deep in the thread never reaches the root. Prerequisite
wire extension: reply envelopes carry a signed `root` ref, and the reply
convention DM-copies the root author as well as the parent author. Root
becomes complete BY CONSTRUCTION (so it can host), and any single message
identifies its thread's root + owner.

Attestations dissolve the trust half of "who owns the thread": every v2
post/reply is an author-signed envelope, so a thread is a set of
self-verifying documents — ANY holder can serve it (omission possible,
alteration/fabrication not), and the 90-day account expiry makes
any-holder serving a resilience property, not just a convenience. Three
layers:

- **Auto-backfill (transparent, daemon-driven).** Invariant: a dangling
  reply/boost ref always identifies a peer who holds the target — you
  cannot reference a message you never held, so the SENDER of the message
  carrying the dangling ref can always serve it. On ingest, queue
  dangling refs per peer, batch into one request control DM (60 msgs/min
  budget → batching mandatory; dedupe + negative-cache with backoff for
  dead peers), answer = bundle of signed envelopes, verified through the
  boost-embed ladder (never TOFU-pin from relayed content). In the A/B/C
  case this is transitively complete with NO thread request: every A
  message is the parent of a B message C already holds. Needs the one
  real architecture piece: a **held-envelope store class** (verified
  foreign envelopes not backed by a local DC message; the orig-<uuid>
  thread-view fix was the first step).
- **Subscribe to thread (explicit, UI).** For "keep me updated even when
  no followee is active in it anymore": a thread-view button → scoped
  invite-request to the root author, who lazily creates a per-thread
  broadcast channel and republishes replies it receives as signed
  envelopes. New subscribers get a "thread so far" bundle (same format as
  backfill responses). Keeps **reply control**: the root declining to
  republish = thread moderation the fediverse can't cleanly do.
- **Root-directed thread request.** Opening a thread you only partially
  hold may still miss branches no peer of yours touched (stranger
  replying to stranger); a one-shot thread request to the root (same
  bundle format) fills those on view. Subscription covers them going
  forward.

Long-term: thread-as-webxdc gives full update-replay history and is
probably webxdc's first natural use here.

## 4. Expanding the join backfill (10 → N)

The 10-message backfill lives in CORE on the channel owner's device
(`resend_last_msgs()`, `N_MSGS_TO_NEW_BROADCAST_MEMBER` in constants.rs),
not on the relay — i.e. inside our own daemon process. Expansion paths,
ranked: (1) upstream a config knob (feature is new, PR #8151-era, active
area); (2) app-layer backfill bundles: on SecurejoinInviterProgress our
daemon DMs older posts to the joiner — original text carries `⚑` uuids so
the joiner's store unifies them; requires admitting author-verified
DM-carried posts into timelines + bundling for rate limits; (3) patched
core binary (fork maintenance — avoid). Long-term structural answer is
webxdc update-replay (full history for late joiners). Note: any expanded
backfill is real re-transmission on the owner's node (bandwidth, 60/min
budget), not a free outbox read like AP.

## 5. Structured payloads: JSON as extension channel, not body

> **SUPERSEDED by decision 0001** (docs/decisions.md): vanilla-DC rendering
> compatibility was dropped; JSON becomes the whole body (wire v2), not a
> sidecar. Kept for the carrier analysis.

Posts stay human-readable text (the vanilla-Delta-Chat interop property is
load-bearing: followers don't need deltanet, and every post degrades to a
legible message). But line-grammar markers don't scale to polls, CWs, alt
text, receipts, thread directives — so add ONE versioned JSON envelope
alongside the text rather than converting bodies:

- Carrier v1: a final `⚙ {"v":1,...}` marker line (tolerant parse like the
  other markers; keeps posts editable and quote/forward-safe).
- Carrier considered and deferred: `MessageData.html`
  (multipart/alternative — invisible to vanilla users, but HTML messages
  cannot be edited via Chat-Edit, and "show full message" chrome).
- Carrier endgame: a protected header (`Chat-Deltanet:`-style), pending
  upstream RPC support for custom headers — idiomatic per chatmail spec.

Schema discipline regardless of carrier: version field, unknown fields
must-ignore, keys never repurposed — so moving carriers is a transport
swap, not a redesign. Existing verbs (`↳re`, `♻`, `⚑`, reactions) stay as
compact human-visible markers; the envelope is for structure that doesn't
fit a line.

## 6. Post attestations (republication veracity)

Direct deliveries are PGP-signed and verified by core; REPUBLISHED content
(boost embeds, thread-channel republication per sketch 3) is only attested
by the republisher — a thread host could fabricate or alter embedded
posts. No RPC path exists to carry the original PGP signature along.

Fix at the deltanet layer, enabled by wire v2 (decision 0001): per-account
ed25519 signing key (daemon-held); every post envelope carries
`{pubkey, sig}` over canonical fields (uuid, author addr, text, refs,
timestamp). Republished posts become offline-verifiable by anyone holding
the author's pubkey; hosts can only omit (reply control), never alter.
Key distribution: followers receive the pubkey over the
securejoin-verified channel (strong binding); strangers get
TOFU-with-pinning + automated DM challenge ("did you write u:X?") — the
same machinery as reaction-receipt verification (sketch 2); attestations
generalize receipts from "I reacted" to "I said".

Decision 0002 hardens this sketch: verification is not optional — 
unverifiable republished content renders as a placeholder, never as an
attributed status. Attestations are the ADMISSION rule for republished
content, not an overlay.

Boosts are the same case: today a boost carries a 500-char quotedText
copy (synthesized for non-followers of the author — fabricatable,
truncated, no media). In v2 a boost embeds the original COMPLETE signed
envelope; recipients verify offline, boosters choose whether, never what.
The attestation must also cover attachment CONTENT-HASHES so republishers
can re-attach media bytes that recipients verify against the author-signed
hash — verifiable images across boost/thread hops.

Residual: proves keyholder authorship, not identity-behind-key — a host
can invent fake strangers, not impersonate known/queryable contacts
(sybil floor, not solvable here). Wire v2 envelope should reserve
`pubkey`/`sig` field names even before signing lands.

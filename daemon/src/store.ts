import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { T } from '@deltachat/jsonrpc-client';
import { parseCanonicalMid, parseMarkers } from './protocol.js';
import { parseWire, parseWireUuid } from './wire.js';
import type { Envelope } from './envelope.js';

const DC_CONTACT_ID_SELF = 1;

/**
 * Store JSON schema version. Bumped when the *derivable* index shape changes so
 * a daemon restart can re-index cleanly without touching the Delta Chat
 * databases (see ../meta/issues/canonical-mid-unification.md migration section):
 * on load with an older/missing version, the derived indices are dropped and
 * the startup backfill re-derives them (now with canonical-mid aliasing), while
 * notifications + dedupe keys + pending requests are preserved so re-derivation
 * can never duplicate-notify. Version 1 introduced canonical-mid aliasing.
 * Version 2 changed `replyChildren` values from child msgIds to child CANONICAL
 * mids (so a reply's DM copy and feed copy collapse to one child edge, and a
 * non-follower's DM-only reply renders in the thread — see
 * ../meta/issues/non-follower-thread-rendering.md); the `migrate` drop covers
 * `replyChildren`, so a v1 store re-indexes into the new value shape on restart.
 * Version 3 generalized historical text-twin aliasing from SELF-only to
 * per-author: a v2 re-index registered BOTH copies of another author's
 * pre-canonical (marker-less) reply as children — double-rendered threads and
 * inflated replies_count on follower nodes — so already-migrated v2 stores
 * must re-index once more with the generalized aliasing.
 * Version 4 introduced the POST-KEY keyspace (wire convention v1 — author-minted
 * logical-post UUIDs, see ../DEVLOG.md): every derived index is now keyed by
 * `postKey(msg) = parsed uuid ?? canonicalize(mid)`, and a new uuid->msgId index
 * (preferring feed copies) backs `resolveKey`. The `migrate` drop covers the new
 * uuid index too, so a v3 store re-indexes into the post-key shape on restart.
 * Version 5 introduced wire convention v2 (JSON envelopes, see ../DEVLOG.md +
 * docs/decisions.md 0001): every ingest now parses through `parseWire`/
 * `parseWireUuid` (v2 envelope first, then the v0/v1 markers for existing
 * histories), so a re-index parses mixed-era data consistently. The post-key
 * keyspace is unchanged conceptually — a v2 message's `uuid` field feeds
 * `postKey` exactly as the v1 `⚑` marker did — so dedupe keys are continuous:
 * legacy messages still derive the same `type:addr:mid[:emoji]` keys (they
 * carry no uuid, so `postKey` falls back to the canonical mid, as before).
 * Version 6 introduced thread auto-backfill state (see
 * ../meta/issues/thread-auto-backfill.md): a HELD-ENVELOPE section (verified
 * foreign envelopes not backed by a local DC message, keyed by post uuid) plus a
 * backfill ATTEMPT-STATE section (negative cache: per-ref attempt count +
 * last-attempt ts for exponential backoff). BOTH are trust/cache roots, NOT
 * derivable indices — like notifications/pinnedKeys they SURVIVE a `migrate`
 * re-index (a held envelope came from a peer bundle we cannot re-derive from a
 * local sweep; the attempt state records network history a sweep cannot know).
 * They are additive fields (the `{...emptyData(), ...raw}` load defaults them to
 * `{}` for pre-v6 stores), so an existing v5 store gains them on load without
 * losing anything; the version bump itself is what forces the derived-index
 * re-index that seeds the backfill queue from pre-existing dangling refs.
 * Version 7 introduced thread-subscription state (see
 * ../meta/issues/thread-subscribe.md): `hostedThreads` (root uuid -> the
 * broadcast chatId we host that thread's channel on, host side) and
 * `threadSubscriptions` (root uuid -> the chatId we joined for a thread we
 * subscribe to, subscriber side). BOTH are non-derivable roots — a hosted
 * channel's chatId and a subscribed channel's chatId cannot be reconstructed
 * from a message sweep (they name DC chats created/joined out-of-band) — so,
 * like pins/held envelopes, they SURVIVE a `migrate` re-index. Additive fields,
 * defaulted to `{}` for pre-v7 stores.
 * Version 8 carries NO shape change: it forces the derived-index re-index
 * after the trailing-junk-tolerant `parseEnvelope` fix. Messages that arrived
 * while DC core's transient download placeholder was appended to their text
 * (`{...} [Image – 137.37 KiB]`) were mis-keyed under their canonical MID
 * instead of their uuid (the uuid parse failed); the persisted text is clean,
 * so re-indexing with the tolerant parser re-keys them and their reaction
 * tallies line up again.
 */
export const STORE_SCHEMA_VERSION = 8;

/**
 * Upper bound on stored held envelopes (thread auto-backfill). Held content is
 * NOT request-gated — a met contact can push unsolicited envelope-bundles, and
 * thread-so-far / channel bundles arrive proactively — so without a cap the
 * store grows unbounded from hostile or merely chatty peers. On overflow the
 * OLDEST (by receivedAt) is evicted; a thread re-opened later simply
 * re-backfills what was dropped. Generous so real threads are never pinched.
 */
export const HELD_ENVELOPE_CAP = 5000;

export type NotificationType =
  | 'follow'
  | 'mention'
  | 'reblog'
  | 'favourite'
  | 'pleroma:emoji_reaction';

export type Notification = {
  id: string;
  type: NotificationType;
  createdAt: string;
  accountAddr: string;
  accountContactId?: number;
  emoji?: string;
  statusMsgId?: number;
};

/** Input to `addNotification`: everything but the id/createdAt, plus an optional dedupe key source. */
export type NotificationInput = {
  type: NotificationType;
  accountAddr: string;
  accountContactId?: number;
  emoji?: string;
  statusMsgId?: number;
  /**
   * The mid this notification is "about" (the replied-to/boosted/reacted-to
   * message), used to build the dedupe key `type:addr:mid[:emoji]`. Optional
   * because follow notifications have no associated mid.
   */
  dedupeMid?: string;
  /**
   * Emoji to fold into the dedupe key, if different from (or absent from)
   * the stored `emoji` field — e.g. a favourite notification stores no
   * `emoji` field but still dedupes per-emoji against
   * `pleroma:emoji_reaction`s on the same mid/reactor. Defaults to `emoji`.
   */
  dedupeEmoji?: string;
};

type StoredReactions = Record<string, Record<string, string[]>>;

/**
 * A held foreign envelope (thread auto-backfill): the RAW envelope object a peer
 * bundled to us, plus provenance. NEVER trusted at ingest — verification runs at
 * RENDER time (pins can change; a bundle is relayed content), so we store the
 * envelope verbatim and decide validity later (see heldenvelopes.ts / mapping).
 */
export type HeldEnvelope = {
  /** The verbatim envelope object as the peer bundled it (a signed message body). */
  env: Envelope;
  /** The addr of the peer who served this bundle item (provenance, not attribution). */
  from: string;
  /**
   * The serving peer's MESSAGE-DERIVED DC contact id (the bundle DM's
   * `msg.fromId`). Persisted so the startup seed can address transitive
   * follow-up requests to the peer's KEY-contact — an addr lookup would land on
   * the keyless address-contact row and fail to encrypt (see backfill.ts
   * `QueuedRef.peerContactId`).
   */
  fromContactId: number;
  /**
   * The ORIGINAL author's address, as attributed by the ref that surfaced this
   * uuid (a reply/root ref carries the author's addr). A signed envelope does not
   * carry its own author addr as a top-level field — `verify()` needs it — so we
   * capture it here at store time. This is what render-time verification + status
   * attribution check the signature against (contact-first attribution then falls
   * back to this addr's shell, exactly like a verified boost embed).
   */
  authorAddr: string;
  /** ms epoch we received it. */
  receivedAt: number;
};

/**
 * Negative-cache attempt state for one backfill ref (thread auto-backfill): how
 * many times we've asked for this uuid and when we last tried, so the auto-fetch
 * loop can apply exponential backoff and give up after N attempts (peers go
 * offline; accounts expire). Persisted so a restart doesn't reset the backoff.
 */
export type BackfillAttempt = {
  /** Number of request DMs sent targeting this ref so far. */
  attempts: number;
  /** ms epoch of the last attempt. */
  lastAttemptAt: number;
};

type StoreData = {
  /** Store schema version; absent/older triggers a derived-index re-index on load. */
  schemaVersion: number;
  /**
   * Canonical-mid alias map: dmMid -> feedMid. The feed broadcast copy's mid is
   * a post's canonical identity; DM copies (and interactions that only ever
   * reference them) normalize to it via `canonicalize`. Populated on our own
   * reply sends, on ingesting a DM carrying the `⚓` canonical marker, and
   * during (re)index for historical self-authored text-twin copies.
   */
  canonicalByMid: Record<string, string>;
  /**
   * Historical text-twin aliasing bookkeeping (see canonical-mid issue point 3,
   * generalized per-author in schema v3). Pre-fix reply copies are exact text
   * twins (feed + DM carry identical reply-marked text, no canonical marker) —
   * and that's true for EVERY author, not just SELF: on a follower's node the
   * other party's reply arrives as both a feed copy and a marker-less DM copy.
   * During (re)index we build (author-addr + text) -> feedMid for reply-marked
   * FEED messages, and the same key -> dmMid for DM (Single-chat) messages
   * still awaiting their feed twin — so whichever copy the sweep encounters
   * second resolves the alias, order-independently. Keyed by
   * `senderAddr + '\0' + fullText` (NUL can't appear in an address).
   */
  feedTextToMid: Record<string, string>;
  dmPendingText: Record<string, string>;
  midToMsgId: Record<string, number>;
  msgIdToMid: Record<number, string>;
  /**
   * msgId -> that message's own POST KEY (its uuid, or its canonical mid),
   * recorded at ingest. `midForMsgId` returns this so the status mapper looks up
   * a post's reply/boost/reaction tallies under the same key the edges/tallies
   * are stored under (a v1 post's edges are uuid-keyed, not mid-keyed).
   */
  msgIdToKey: Record<number, string>;
  /**
   * Logical-post UUID -> the msgIds of every LOCAL copy carrying that uuid (wire
   * convention v1). One logical post can have several copies (a reply's feed
   * broadcast copy + its DM copy share ONE uuid), so this is a list.
   * `resolveKey` prefers the FEED copy (see `uuidFeedMsgId`) when several
   * copies are local, since timelines/threads render feed copies.
   */
  uuidToMsgIds: Record<string, number[]>;
  /**
   * Logical-post UUID -> the msgId of its FEED copy, when a feed-chat copy of
   * that uuid has been ingested. Recorded from `ingestMessage`'s
   * `isFeedMessage` flag (the store doesn't know DC chat types itself). Lets
   * `resolveKey` prefer the feed copy over a DM copy for the same logical post.
   */
  uuidFeedMsgId: Record<string, number>;
  /**
   * Reply thread edges: parent POST-KEY -> child POST-KEYs. A post key is
   * `postKey(msg) = parsed uuid ?? canonicalize(mid)` (wire convention v1), so
   * the feed broadcast copy and DM copy of one logical reply — which share ONE
   * uuid — collapse to a single child entry (set semantics), and a node holding
   * only the DM copy still gets a thread edge (its post key resolves to whatever
   * copy it holds via `resolveKey`). Registered from BOTH feed and Single-chat
   * reply-marker messages. Read paths resolve each child key to a msgId
   * (feed-copy preferred), skipping unresolvable ones; `childrenCount` counts
   * ALL entries (the logical reply count).
   */
  replyChildren: Record<string, string[]>;
  /** msgIds boosting a post, keyed by the boosted post's POST-KEY. */
  boostsByMid: Record<string, number[]>;
  /** msgIds (this account's own boosts) keyed by the boosted post's POST-KEY. */
  ownBoosts: Record<string, number>;
  /** msgIds already ingested, so re-ingesting the same message is a no-op. */
  ingestedMsgIds: number[];
  /** POST-KEYs authored by SELF (DC contact id 1). */
  ownMids: string[];
  /** POST-KEY -> reactor address -> emoji[] (a reactor may use several distinct emoji per post). */
  reactions: StoredReactions;
  notifications: Notification[];
  /** Dedupe keys already recorded, so re-adding the same notification is a no-op. */
  notificationDedupeKeys: string[];
  nextNotificationId: number;
  /**
   * Follow-back gating: outgoing invite-requests we've sent and are still
   * awaiting a grant for, keyed by the contact's address -> requested-at ms.
   * An incoming `⇋ invite <link>` grant is only auto-joined if its sender has
   * an entry here (see ../meta/issues/follow-back-invite-request.md); this is
   * what stops an *unsolicited* grant from silently joining us to a feed.
   */
  pendingFollowRequests: Record<string, number>;
  /**
   * TOFU key pins (post-attestations, sketch #6 / decision 0002): sender
   * address -> the ed25519 pubkey (base64) first seen on a DIRECT delivery from
   * that address. First-wins: once pinned, a later signed envelope whose pubkey
   * CONFLICTS with the pin is treated as unverified (renders a placeholder).
   * Additive field (no schema bump): the `{...emptyData(), ...raw}` load pattern
   * defaults it to `{}` for pre-attestation stores, and it survives `migrate`
   * (like notifications/pending) so hard-won pins are never dropped by a
   * derived-index re-index. Pinned ONLY from direct deliveries (core-PGP
   * verified) — NEVER from an embedded boost `orig` (a booster could seed a fake
   * pin).
   */
  pinnedKeys: Record<string, string>;
  /**
   * Held foreign envelopes (thread auto-backfill), keyed by post uuid: verified-
   * at-render foreign content a peer bundled to us, not backed by a local DC
   * message. Persisted; survives restart + migrate (not derivable from a local
   * sweep). NEVER TOFU-pinned from — bundles are relayed content, so no pubkey
   * here ever seeds `pinnedKeys`.
   */
  heldEnvelopes: Record<string, HeldEnvelope>;
  /**
   * Backfill negative-cache attempt state (thread auto-backfill), keyed by the
   * ref uuid we've been asking peers for. Drives exponential backoff + give-up.
   * Persisted; survives migrate (records network history a re-index can't know).
   */
  backfillAttempts: Record<string, BackfillAttempt>;
  /**
   * HOST side (thread-subscribe): thread ROOT uuid -> the broadcast chatId we
   * created to host that thread's channel. Lazily created on the first granted
   * subscriber; republished replies for the thread are posted here. Non-derivable
   * (the chatId names an out-of-band DC broadcast); survives migrate.
   */
  hostedThreads: Record<string, number>;
  /**
   * SUBSCRIBER side (thread-subscribe): thread ROOT uuid -> the chatId we joined
   * for a thread channel we subscribe to. Distinguishes a thread-channel chat
   * from a followed FEED so `following()`/home timeline can EXCLUDE it (a thread
   * subscription must never surface as a followed feed). Non-derivable; survives
   * migrate.
   */
  threadSubscriptions: Record<string, number>;
  /**
   * HOST side (thread-subscribe): reply uuids we've already republished into a
   * thread channel, so a reply delivered twice (feed + DM copy) or re-ingested
   * on restart is never double-posted. A record of what we SENT — network
   * history a message sweep can't reconstruct — so it survives migrate. Stored
   * as a map (uuid -> true) for O(1) membership + stable JSON.
   */
  republishedUuids: Record<string, boolean>;
  /**
   * SUBSCRIBER side (thread-subscribe): outstanding thread invite-requests we've
   * sent and are awaiting a grant for, keyed by thread ROOT uuid -> requested-at
   * ms. A scoped invite-grant is only auto-joined when its rootUuid has an entry
   * here — the same anti-unsolicited-join gate `pendingFollowRequests` provides
   * for feed follow-backs. Cleared on join (or abandon). Survives migrate.
   */
  pendingThreadRequests: Record<string, number>;
};

const emptyData = (): StoreData => ({
  schemaVersion: STORE_SCHEMA_VERSION,
  canonicalByMid: {},
  feedTextToMid: {},
  dmPendingText: {},
  midToMsgId: {},
  msgIdToMid: {},
  msgIdToKey: {},
  uuidToMsgIds: {},
  uuidFeedMsgId: {},
  replyChildren: {},
  boostsByMid: {},
  ownBoosts: {},
  ingestedMsgIds: [],
  ownMids: [],
  reactions: {},
  notifications: [],
  notificationDedupeKeys: [],
  nextNotificationId: 1,
  pendingFollowRequests: {},
  pinnedKeys: {},
  heldEnvelopes: {},
  backfillAttempts: {},
  hostedThreads: {},
  threadSubscriptions: {},
  pendingThreadRequests: {},
  republishedUuids: {},
});

/**
 * Migrate an older/versionless store to the current schema: DROP every
 * derivable index (mid maps, the uuid->msgId index, edges — including
 * `replyChildren`, now keyed by post keys — tallies, ingestedMsgIds, ownMids,
 * alias map) so the startup backfill re-derives them fresh, but KEEP
 * notifications + dedupe keys + pending requests + the next notification id — so
 * re-derivation can never duplicate-notify and no user-visible history is lost.
 *
 * DEDUPE SAFETY across the post-key switches (v3->v4 uuid markers, v4->v5 JSON
 * envelopes): legacy messages carry no uuid at all (neither a `⚑` marker nor a
 * v2 `uuid` field), so `postKey` falls back to the canonical mid for them —
 * exactly the key era-3 dedupe keys were computed under. Re-deriving
 * notifications for pre-v1 events therefore recomputes the SAME
 * `type:addr:mid[:emoji]` dedupe keys, which are preserved here, so a re-index
 * never re-notifies for historical events. A v2 message keys by its `uuid`
 * field exactly as a v1 message keyed by its `⚑` marker — same keyspace, so
 * uuid-keyed dedupe is likewise continuous. Never touches any Delta Chat
 * database; a QA node heals on a plain restart. Pure.
 */
const migrate = (old: StoreData): StoreData => ({
  ...emptyData(),
  notifications: old.notifications ?? [],
  notificationDedupeKeys: old.notificationDedupeKeys ?? [],
  nextNotificationId: old.nextNotificationId ?? 1,
  pendingFollowRequests: old.pendingFollowRequests ?? {},
  // Key pins are a TOFU trust root, not a derivable index — preserve them across
  // a re-index exactly like notifications/pending (never re-derivable from a
  // sweep: pinning happens only on live direct delivery, first-wins).
  pinnedKeys: old.pinnedKeys ?? {},
  // Held envelopes + backfill attempt state are ALSO non-derivable roots: a held
  // envelope arrived in a peer's bundle (no local message to re-derive it from),
  // and the attempt state records request history a local sweep cannot know.
  // Preserve both across a re-index exactly like pins/notifications.
  heldEnvelopes: old.heldEnvelopes ?? {},
  backfillAttempts: old.backfillAttempts ?? {},
  // Thread channel bindings (host + subscriber) name out-of-band DC chats a
  // message sweep can't reconstruct — preserve across a re-index like pins.
  hostedThreads: old.hostedThreads ?? {},
  threadSubscriptions: old.threadSubscriptions ?? {},
  pendingThreadRequests: old.pendingThreadRequests ?? {},
  republishedUuids: old.republishedUuids ?? {},
});

export type ReactionTally = { emoji: string; count: number; reactors: string[] };

export type Store = {
  /**
   * `isFeedMessage` (default `true`, for back-compat with existing callers)
   * gates BOOST edge registration: only messages delivered in a FEED chat
   * (Group/OutBroadcast/InBroadcast) may register `boostsByMid` entries (boosts
   * have no DM copy). REPLY edges register from BOTH feed copies and DM reply
   * copies — the child's CANONICAL mid is stored, so the two copies of one
   * logical reply collapse to a single child entry (set semantics), and a
   * non-follower who only holds the DM copy still gets a thread edge (see
   * ../meta/issues/non-follower-thread-rendering.md). DM copies always get their
   * mid <-> msgId mapping and `ownMids` bookkeeping recorded regardless.
   *
   * Returns `true` iff this msgId was *freshly* ingested (first time seen),
   * `false` for the already-ingested no-op case. A single live message can
   * reach the ingest hook several times (IncomingMsg + the MsgsChanged
   * safety net + repeat MsgsChanged on state changes — see deltachat.ts),
   * so callers gate execute-once side effects (e.g. follow-back
   * grant/accept actions in main.ts) on this return value.
   */
  ingestMessage(msg: T.Message, mid: string, isFeedMessage?: boolean): boolean;
  /**
   * Resolve a mid to its canonical (feed-copy) mid via the alias map, or return
   * it unchanged if no alias is known. The store owns the alias map, so this is
   * the single place normalization happens — applied at WRITE time for edges/
   * tallies and at READ time for lookups (belt and braces).
   */
  canonicalize(mid: string): string;
  /**
   * Resolve a POST KEY (a logical-post uuid OR a canonical/raw mid) to a locally
   * held msgId, or null. UUID-shaped keys resolve via the uuid index (preferring
   * the FEED copy when several copies are local); mid-shaped keys fall through
   * the existing canonical-mid resolve chain. This is the single resolution
   * entry point for the post-key keyspace (wire convention v1). `resolveMid` is
   * kept as a synonym (a mid is a valid post key) for existing call sites.
   */
  resolveKey(key: string): number | null;
  /**
   * Learn that `dmMid` is a DM copy of the feed post `feedMid`. Records the
   * alias and RE-KEYS any edges/tallies/mappings already registered against
   * `dmMid` onto `feedMid` (covers interactions applied before the alias was
   * learned — the DM twin scenario). No-op if the two are equal.
   */
  aliasMid(dmMid: string, feedMid: string): void;
  resolveMid(mid: string): number | null;
  midForMsgId(msgId: number): string | null;
  /**
   * The child msgIds of `mid`'s replies: each stored child CANONICAL mid
   * resolved to a msgId via `resolveMid` (canonical-first, DM copy as fallback),
   * with unresolvable children skipped. So a child we hold locally (in either
   * copy) renders; one we've only heard referenced but never received is
   * omitted from the rendered list — but still contributes to `childrenCount`.
   */
  replyChildren(mid: string): number[];
  /**
   * The child CANONICAL mids of `mid`'s replies (canonicalized defensively at
   * read time, deduped). Used by the context descendants BFS to recurse into a
   * child's own subtree without a msgId round-trip.
   */
  replyChildMids(mid: string): string[];
  /** Count of ALL reply children (resolvable or not) — the logical reply count. */
  childrenCount(mid: string): number;
  boostsByMid(mid: string): number[];
  boostCount(mid: string): number;
  isOwnBoost(mid: string): boolean;
  ownBoostMsgId(mid: string): number | null;
  /** Was this mid authored by SELF (DC contact id 1)? */
  isOwnMid(mid: string): boolean;
  applyReaction(mid: string, addr: string, emoji: string): void;
  retractReaction(mid: string, addr: string, emoji: string): void;
  reactionTallies(mid: string): ReactionTally[];
  /** Returns the stored notification, or null if it was a dedupe no-op. */
  addNotification(input: NotificationInput): Notification | null;
  listNotifications(query: { limit?: number; maxId?: string; sinceId?: string }): Notification[];
  /**
   * Record that we've sent an invite-request to `addr` and are awaiting a
   * grant. `requestedAtMs` is passed in by the caller (daemon code uses
   * `Date.now()`; tests pass a fixed value).
   */
  addPendingFollowRequest(addr: string, requestedAtMs: number): void;
  /** Clear a pending request (on grant received, or when we abandon it). No-op if absent. */
  clearPendingFollowRequest(addr: string): void;
  /** Is there an outstanding invite-request awaiting a grant from `addr`? */
  hasPendingFollowRequest(addr: string): boolean;
  /** All pending invite-requests: addr -> requested-at ms. */
  pendingFollowRequests(): Record<string, number>;
  /**
   * TOFU-pin `pubkey` for `addr` on FIRST sighting (first-wins): records the pin
   * iff none exists for `addr`. A later call with a different pubkey is a no-op
   * (the pin is immutable) — the conflict surfaces at verify time via
   * `pinnedKey`. Returns the currently-pinned key (the newly-set one on first
   * pin, or the pre-existing one). MUST only be called for direct deliveries.
   */
  pinKey(addr: string, pubkey: string): string;
  /** The pinned pubkey for `addr`, or null if none pinned yet. */
  pinnedKey(addr: string): string | null;

  // --- thread auto-backfill: held envelopes + negative cache ---

  /**
   * Store a held foreign envelope (thread auto-backfill) under its uuid, unless a
   * LOCAL message already resolves that uuid OR a held entry already exists —
   * neither is overwritten (a live delivery and an existing held copy both win
   * over a fresh bundle item, so we never regress a stronger source). No-op (and
   * returns false) when the envelope carries no uuid or is already superseded;
   * returns true iff it was freshly stored. NEVER TOFU-pins from `env.pubkey`
   * (bundles are relayed content). Verification happens at render, not here.
   */
  addHeldEnvelope(env: Envelope, from: string, fromContactId: number, authorAddr: string, receivedAt: number): boolean;
  /** The held envelope for a uuid (verbatim), or null. Verification is the caller's (render-time) job. */
  heldEnvelope(uuid: string): HeldEnvelope | null;
  /** Drop a held envelope (e.g. when render-time verification fails hard). No-op if absent. */
  dropHeldEnvelope(uuid: string): void;
  /** Every held-envelope uuid currently stored (for startup queue seeding / thread traversal). */
  heldEnvelopeUuids(): string[];
  /**
   * The uuids of held envelopes that are REPLIES to `parentUuid` (their `ref`
   * points at it). Computed by scanning held envelopes — held content carries no
   * `replyChildren` edge (that index is derived from local messages and dropped
   * on migrate; held content survives migrate but has no local message to
   * re-derive from), so the thread descendant walk reads the held reply graph
   * straight off the stored envelopes' own refs. Deduped, insertion-ordered.
   */
  heldChildrenOf(parentUuid: string): string[];
  /**
   * Record a backfill attempt for `refUuid` at `nowMs`: increments the attempt
   * count and stamps the time (negative cache / backoff bookkeeping). Persisted.
   */
  recordBackfillAttempt(refUuid: string, nowMs: number): void;
  /** The attempt state for a ref (attempts + lastAttemptAt), or null if never attempted. */
  backfillAttempt(refUuid: string): BackfillAttempt | null;
  /** Clear a ref's attempt state (e.g. once it resolves). No-op if absent. */
  clearBackfillAttempt(refUuid: string): void;

  // --- thread-subscribe: hosted threads (host side) + subscriptions (subscriber side) ---

  /** Record that we HOST thread `rootUuid`'s channel on broadcast `chatId`. Overwrites. */
  addHostedThread(rootUuid: string, chatId: number): void;
  /** The broadcast chatId hosting thread `rootUuid`, or null if we don't host it. */
  hostedThreadChatId(rootUuid: string): number | null;
  /** Every hosted thread's root uuid (for republication lookup / pruning). */
  hostedThreadUuids(): string[];
  /** Drop a hosted-thread binding (channel gone). No-op if absent. */
  removeHostedThread(rootUuid: string): void;
  /** Have we already republished reply `uuid` into a thread channel? */
  wasRepublished(uuid: string): boolean;
  /** Mark reply `uuid` as republished (dedupe; idempotent). */
  markRepublished(uuid: string): void;

  /**
   * Drop the in-memory cache and re-read the store file — the backup-restore
   * seam: a restore writes the restored store file to disk under a live
   * daemon, and without this every module holding this store object would
   * keep serving the pre-restore (empty) state. Runs migration exactly like
   * a fresh load if the restored file is an older schema.
   */
  reload(): void;
  /** The JSON file backing this store — backup export reads it, restore overwrites it (then `reload()`s). */
  readonly filePath: string;

  /** Record that we SUBSCRIBE to thread `rootUuid` via joined chat `chatId`. Overwrites. */
  addThreadSubscription(rootUuid: string, chatId: number): void;
  /** The chatId we joined for thread `rootUuid`, or null if not subscribed. */
  threadSubscriptionChatId(rootUuid: string): number | null;
  /** Are we subscribed to thread `rootUuid`? */
  isSubscribedToThread(rootUuid: string): boolean;
  /** Is `chatId` a chat we joined for a thread subscription? (excludes it from following()/home). */
  isThreadSubscriptionChat(chatId: number): boolean;
  /** All subscribed thread chat ids (for the following()/timeline exclusion set). */
  threadSubscriptionChatIds(): number[];
  /** Every subscribed thread's root uuid. */
  threadSubscriptionUuids(): string[];
  /** Drop a thread subscription (unsubscribe). No-op if absent. */
  removeThreadSubscription(rootUuid: string): void;

  /** Record an outstanding thread invite-request for `rootUuid` at `requestedAtMs`. */
  addPendingThreadRequest(rootUuid: string, requestedAtMs: number): void;
  /** Is there an outstanding thread invite-request awaiting a grant for `rootUuid`? */
  hasPendingThreadRequest(rootUuid: string): boolean;
  /** Clear a pending thread request (on grant/join, or abandon). No-op if absent. */
  clearPendingThreadRequest(rootUuid: string): void;
};

/** A fresh scratch path for callers (tests, `createApp` defaults) that don't need cross-restart persistence. */
export const ephemeralStorePath = (): string =>
  join(tmpdir(), `deltanet-store-${randomUUID()}.json`);

const dedupeKey = (input: NotificationInput): string | null => {
  if (!input.dedupeMid) return null;
  const parts = [input.type, input.accountAddr, input.dedupeMid];
  const emoji = input.dedupeEmoji ?? input.emoji;
  if (emoji) parts.push(emoji);
  return parts.join(':');
};

/**
 * Per-account persistent index over the deltanet wire convention: mid <->
 * msgId, reply children, boost tallies, reactions, and notifications.
 * Loaded lazily from `filePath` (a JSON file whose path is injected — one
 * per account data dir) and saved synchronously on every mutation; the data
 * here is small (indices over message ids/mids), so this stays simple
 * rather than debounced.
 */
export const createStore = (
  filePath: string,
  opts?: { heldEnvelopeCap?: number },
): Store => {
  const heldCap = opts?.heldEnvelopeCap ?? HELD_ENVELOPE_CAP;
  let data: StoreData | null = null;

  const load = (): StoreData => {
    if (data) return data;
    let loaded: StoreData = emptyData();
    let needsSave = false;
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        loaded = { ...emptyData(), ...raw };
        if ((raw.schemaVersion ?? 0) < STORE_SCHEMA_VERSION) {
          loaded = migrate(loaded);
          needsSave = true;
        }
      } catch {
        loaded = emptyData();
      }
    }
    data = loaded;
    // Persist a migrated store immediately so the version bump/drop is durable
    // even if no mutation follows this load.
    if (needsSave) save();
    return data;
  };

  const save = (): void => {
    if (!data) return;
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  };

  const ingestedSet = (): Set<number> => new Set(load().ingestedMsgIds);

  /** dmMid -> feedMid, or the mid itself if unaliased. Pure over the loaded data. */
  const canon = (mid: string): string => load().canonicalByMid[mid] ?? mid;

  /**
   * The POST KEY for an ingested message (wire convention v1): its own logical
   * UUID marker if present, else its canonicalized mid. This is the single
   * keyspace all derived indices (edges, tallies, boosts, ownMids) key by.
   * Pure: `mid` is this message's own rfc724 Message-ID.
   */
  const postKey = (text: string, mid: string): string => parseWireUuid(text) ?? canon(mid);

  /**
   * The post key a reply/boost/reaction ref points at: a uuid ref targets that
   * uuid directly; a mid ref canonicalizes (legacy targets, aliased DM copies).
   * `keyString` is either a uuid (uuid ref) or a mid (mid ref) — we discriminate
   * on shape (uuids have no '@'; mids in this deployment always do), matching
   * the wire ref-token discrimination. Pure.
   */
  const refKey = (keyString: string): string =>
    keyString.includes('@') ? canon(keyString) : keyString;

  /**
   * Resolve a POST KEY (uuid or mid) to a locally-held msgId, or null.
   *  - A uuid key resolves via the uuid index, PREFERRING the feed copy
   *    (`uuidFeedMsgId`) when several local copies share the uuid — timelines/
   *    threads render feed copies. Falls back to any copy if no feed copy is held.
   *  - A mid key resolves canonical-first: the canonical (feed) copy when held,
   *    else the raw mid, else a REVERSE-alias lookup for any dmMid that aliases
   *    to this feed mid and is itself indexed (a DM-only reply whose thread edge
   *    is keyed by a feed mid the node never received).
   */
  const resolve = (d: StoreData, key: string): number | null => {
    // UUID key: prefer the feed copy, else any local copy carrying the uuid.
    const feedCopy = d.uuidFeedMsgId[key];
    if (feedCopy !== undefined) return feedCopy;
    const copies = d.uuidToMsgIds[key];
    if (copies !== undefined && copies.length > 0) return copies[0]!;

    // Mid key: canonical-first with the reverse-alias fallback.
    const c = canon(key);
    const direct = d.midToMsgId[c] ?? d.midToMsgId[key];
    if (direct !== undefined) return direct;
    for (const [dmMid, feedMid] of Object.entries(d.canonicalByMid)) {
      if (feedMid === c && d.midToMsgId[dmMid] !== undefined) return d.midToMsgId[dmMid];
    }
    return null;
  };

  /**
   * Record `dmMid` -> `feedMid` and re-key any edges/tallies/mappings already
   * under `dmMid` onto `feedMid`. In-place mutation of `d`; caller saves.
   */
  const applyAlias = (d: StoreData, dmMid: string, feedMid: string): void => {
    if (dmMid === feedMid) return;
    if (d.canonicalByMid[dmMid] === feedMid) return; // already aliased
    d.canonicalByMid[dmMid] = feedMid;

    // Re-key any children registered under the dmMid onto the feedMid (KEY
    // re-key), then sweep EVERY value list to map this dmMid -> feedMid (VALUE
    // re-key) — a child edge may have been registered against the DM copy's mid
    // before its alias was learned. Both merges dedupe (set semantics): the two
    // copies of one logical reply must collapse to a single child entry.
    const addChild = (parentMid: string, childMid: string): void => {
      const list = d.replyChildren[parentMid] ?? [];
      if (!list.includes(childMid)) list.push(childMid);
      d.replyChildren[parentMid] = list;
    };
    if (d.replyChildren[dmMid]) {
      for (const child of d.replyChildren[dmMid]) addChild(feedMid, child);
      delete d.replyChildren[dmMid];
    }
    for (const parentMid of Object.keys(d.replyChildren)) {
      const list = d.replyChildren[parentMid]!;
      if (!list.includes(dmMid)) continue;
      d.replyChildren[parentMid] = list.filter((c) => c !== dmMid);
      addChild(parentMid, feedMid);
    }
    if (d.boostsByMid[dmMid]) {
      d.boostsByMid[feedMid] = [...(d.boostsByMid[feedMid] ?? []), ...d.boostsByMid[dmMid]];
      delete d.boostsByMid[dmMid];
    }
    if (d.ownBoosts[dmMid] !== undefined) {
      d.ownBoosts[feedMid] = d.ownBoosts[feedMid] ?? d.ownBoosts[dmMid];
      delete d.ownBoosts[dmMid];
    }
    if (d.reactions[dmMid]) {
      const target = d.reactions[feedMid] ?? {};
      for (const [addr, emojis] of Object.entries(d.reactions[dmMid])) {
        const merged = target[addr] ?? [];
        for (const e of emojis) if (!merged.includes(e)) merged.push(e);
        target[addr] = merged;
      }
      d.reactions[feedMid] = target;
      delete d.reactions[dmMid];
    }
  };

  /**
   * Learn a canonical alias for a just-ingested message, if any applies:
   *  - a DM (Single-chat) message carrying an explicit `⚓` canonical marker
   *    -> alias straight to it (any author; a stated fact).
   *  - historical text-twin matching, PER-AUTHOR (schema v3): a reply-marked
   *    FEED message records (senderAddr + text) -> its mid and settles a DM
   *    twin already pending under the same key; a marker-less reply-marked DM
   *    message matches an already-seen feed twin or is stashed pending. Both
   *    sweep orders resolve the alias (order-independent).
   *
   * Twin condition: same sender ADDRESS + byte-identical text (which includes
   * the reply marker), one copy in a feed chat and one in a Single chat. This
   * is safe beyond SELF because a false positive would require an author to
   * send the exact same reply-marked text as both a feed post and a separate
   * DM — which is, by construction, the dual-copy pattern itself. Plain
   * (non-reply-marked) identical texts never twin-match: only replies are ever
   * sent as dual copies, and e.g. an author posting "lol" to their feed and
   * separately DMing "lol" must not be equated.
   *
   * In-place mutation of `d`; caller saves.
   */
  const learnAlias = (d: StoreData, msg: T.Message, mid: string, isFeedMessage: boolean): void => {
    const text = msg.text;
    if (!text) return;

    // An explicit `⚓` canonical marker is a stated fact regardless of author —
    // a non-follower's DM copy (the only copy we hold) declares its feed mid
    // this way. DM copies only (feed copies never carry the marker).
    if (!isFeedMessage) {
      const explicit = parseCanonicalMid(text);
      if (explicit && explicit !== mid) {
        applyAlias(d, mid, explicit);
        return;
      }
    }

    // Historical text-twin matching: reply-marked texts only (the safety gate —
    // see the doc comment above) and keyed per-author.
    if (!parseMarkers(text).reply) return;
    const senderAddr = msg.sender?.address;
    if (!senderAddr) return;
    const key = `${senderAddr}\u0000${text}`;

    if (isFeedMessage) {
      // Record (addr + text) -> feedMid and settle a pending DM twin if that
      // copy arrived first.
      d.feedTextToMid[key] = mid;
      const pendingDm = d.dmPendingText[key];
      if (pendingDm !== undefined && pendingDm !== mid) {
        applyAlias(d, pendingDm, mid);
        delete d.dmPendingText[key];
      }
      return;
    }

    // Marker-less DM copy: match an already-seen feed twin from the same
    // author, else stash pending under the key to await a feed twin swept later.
    const feedMid = d.feedTextToMid[key];
    if (feedMid !== undefined && feedMid !== mid) {
      applyAlias(d, mid, feedMid);
      return;
    }
    d.dmPendingText[key] = mid;
  };

  return {
    filePath,

    ingestMessage: (msg, mid, isFeedMessage = true) => {
      const d = load();
      if (ingestedSet().has(msg.id)) return false;

      d.midToMsgId[mid] = msg.id;
      d.msgIdToMid[msg.id] = mid;

      // Learn a canonical alias for this message (explicit `⚓` legacy marker or
      // historical text-twin) BEFORE computing keys, so a mid-shaped post key
      // canonicalizes correctly.
      learnAlias(d, msg, mid, isFeedMessage);

      const parsed = parseWire(msg.text);

      // Register the uuid->msgId index for every copy carrying a `⚑` marker.
      // Record the feed copy specially so `resolveKey` can prefer it when
      // several copies of one logical post (feed + DM) are held locally — the
      // store can't see DC chat types itself, so it relies on `isFeedMessage`.
      if (parsed.uuid) {
        const copies = d.uuidToMsgIds[parsed.uuid] ?? [];
        if (!copies.includes(msg.id)) copies.push(msg.id);
        d.uuidToMsgIds[parsed.uuid] = copies;
        if (isFeedMessage) d.uuidFeedMsgId[parsed.uuid] = msg.id;
      }

      // The message's own POST KEY: its uuid if it minted one, else its
      // canonical mid (legacy). ownMids + msgIdToKey are keyed by post key too.
      const ownKey = postKey(msg.text, mid);
      d.msgIdToKey[msg.id] = ownKey;
      if (msg.fromId === DC_CONTACT_ID_SELF && !d.ownMids.includes(ownKey)) {
        d.ownMids.push(ownKey);
      }

      // Reply edges register from BOTH feed copies AND Single-chat DM reply
      // copies — a non-follower who only holds the DM copy of a reply must still
      // get a thread edge, or the reply is invisible in the thread. The VALUE
      // stored is the child's POST KEY: both copies of one logical reply share
      // one uuid (or canonicalize to one mid), so set-add dedupe collapses them
      // to a single child entry. The parent key is the ref's post key (its uuid,
      // or its canonical mid).
      if (parsed.reply) {
        const key = refKey(parsed.reply.keyString);
        const childKey = ownKey;
        const children = d.replyChildren[key] ?? [];
        if (!children.includes(childKey)) children.push(childKey);
        d.replyChildren[key] = children;
      }

      // Boost edges stay FEED-only: boosts have no DM copy (unlike replies), so
      // there's nothing to unify — registering from a DM would be spurious.
      if (isFeedMessage && parsed.boost) {
        const key = refKey(parsed.boost.keyString);
        const boosters = d.boostsByMid[key] ?? [];
        boosters.push(msg.id);
        d.boostsByMid[key] = boosters;
        if (msg.fromId === DC_CONTACT_ID_SELF) {
          d.ownBoosts[key] = msg.id;
        }
      }

      d.ingestedMsgIds.push(msg.id);
      save();
      return true;
    },

    canonicalize: (mid) => canon(mid),

    aliasMid: (dmMid, feedMid) => {
      const d = load();
      applyAlias(d, dmMid, feedMid);
      save();
    },

    resolveMid: (mid) => resolve(load(), mid),
    resolveKey: (key) => resolve(load(), key),
    // The message's own POST KEY (canonicalized at read for a mid-shaped key
    // whose alias was learned after ingest; a uuid key passes through). Used by
    // the mapper to look up this post's reply/boost/reaction tallies.
    midForMsgId: (msgId) => {
      const d = load();
      const key = d.msgIdToKey[msgId];
      return key !== undefined ? canon(key) : (d.msgIdToMid[msgId] ?? null);
    },
    replyChildren: (mid) => {
      const d = load();
      const resolved: number[] = [];
      const seen = new Set<number>();
      for (const childMid of d.replyChildren[canon(mid)] ?? []) {
        // Resolve each stored child CANONICAL mid to a msgId (canonical-first,
        // then the reverse-alias DM copy — same as `resolveMid`), skipping
        // children we don't hold locally and deduping resolved msgIds.
        const msgId = resolve(d, childMid);
        if (msgId !== null && !seen.has(msgId)) {
          seen.add(msgId);
          resolved.push(msgId);
        }
      }
      return resolved;
    },
    replyChildMids: (mid) => {
      const seen: string[] = [];
      for (const childMid of load().replyChildren[canon(mid)] ?? []) {
        const c = canon(childMid);
        if (!seen.includes(c)) seen.push(c);
      }
      return seen;
    },
    // ALL children count (resolvable or not): the logical reply count, deduped
    // by canonical child mid (an alias learned late could leave a dm/feed pair
    // in the raw list until the next write-time sweep, so dedupe here too).
    childrenCount: (mid) => {
      const seen = new Set<string>();
      for (const childMid of load().replyChildren[canon(mid)] ?? []) seen.add(canon(childMid));
      return seen.size;
    },
    boostsByMid: (mid) => load().boostsByMid[canon(mid)] ?? [],
    boostCount: (mid) => (load().boostsByMid[canon(mid)] ?? []).length,
    isOwnBoost: (mid) => load().ownBoosts[canon(mid)] !== undefined,
    ownBoostMsgId: (mid) => load().ownBoosts[canon(mid)] ?? null,
    isOwnMid: (mid) => {
      const d = load();
      return d.ownMids.includes(mid) || d.ownMids.includes(canon(mid));
    },

    applyReaction: (mid, addr, emoji) => {
      const d = load();
      const key = canon(mid);
      const byReactor = d.reactions[key] ?? {};
      const emojis = byReactor[addr] ?? [];
      if (!emojis.includes(emoji)) emojis.push(emoji);
      byReactor[addr] = emojis;
      d.reactions[key] = byReactor;
      save();
    },

    retractReaction: (mid, addr, emoji) => {
      const d = load();
      const byReactor = d.reactions[canon(mid)];
      if (!byReactor) return;
      const emojis = byReactor[addr];
      if (!emojis) return;
      const idx = emojis.indexOf(emoji);
      if (idx === -1) return;
      emojis.splice(idx, 1);
      if (emojis.length === 0) delete byReactor[addr];
      else byReactor[addr] = emojis;
      save();
    },

    reactionTallies: (mid) => {
      const byReactor = load().reactions[canon(mid)] ?? {};
      const tallies = new Map<string, string[]>();
      for (const [addr, emojis] of Object.entries(byReactor)) {
        for (const emoji of emojis) {
          const reactors = tallies.get(emoji) ?? [];
          reactors.push(addr);
          tallies.set(emoji, reactors);
        }
      }
      return [...tallies.entries()].map(([emoji, reactors]) => ({
        emoji,
        count: reactors.length,
        reactors,
      }));
    },

    addNotification: (input) => {
      const d = load();
      const key = dedupeKey(input);
      if (key && d.notificationDedupeKeys.includes(key)) return null;

      const notification: Notification = {
        id: String(d.nextNotificationId++),
        type: input.type,
        createdAt: new Date().toISOString(),
        accountAddr: input.accountAddr,
        ...(input.accountContactId !== undefined ? { accountContactId: input.accountContactId } : {}),
        ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
        ...(input.statusMsgId !== undefined ? { statusMsgId: input.statusMsgId } : {}),
      };
      d.notifications.push(notification);
      if (key) d.notificationDedupeKeys.push(key);
      save();
      return notification;
    },

    listNotifications: ({ limit, maxId, sinceId }) => {
      const all = load().notifications;
      const maxIdNum = maxId !== undefined ? Number(maxId) : undefined;
      const sinceIdNum = sinceId !== undefined ? Number(sinceId) : undefined;
      const filtered = all.filter((n) => {
        const idNum = Number(n.id);
        if (maxIdNum !== undefined && !(idNum < maxIdNum)) return false;
        if (sinceIdNum !== undefined && !(idNum > sinceIdNum)) return false;
        return true;
      });
      const sorted = filtered.slice().sort((a, b) => Number(b.id) - Number(a.id));
      return limit !== undefined ? sorted.slice(0, limit) : sorted;
    },

    addPendingFollowRequest: (addr, requestedAtMs) => {
      const d = load();
      d.pendingFollowRequests[addr] = requestedAtMs;
      save();
    },

    clearPendingFollowRequest: (addr) => {
      const d = load();
      if (!(addr in d.pendingFollowRequests)) return;
      delete d.pendingFollowRequests[addr];
      save();
    },

    hasPendingFollowRequest: (addr) => addr in load().pendingFollowRequests,

    pendingFollowRequests: () => ({ ...load().pendingFollowRequests }),

    pinKey: (addr, pubkey) => {
      const d = load();
      const existing = d.pinnedKeys[addr];
      if (existing !== undefined) return existing; // first-wins: never overwrite
      d.pinnedKeys[addr] = pubkey;
      save();
      return pubkey;
    },

    pinnedKey: (addr) => load().pinnedKeys[addr] ?? null,

    // --- thread auto-backfill ---

    addHeldEnvelope: (env, from, fromContactId, authorAddr, receivedAt) => {
      const uuid = env.uuid;
      if (!uuid) return false;
      const d = load();
      // Never overwrite a stronger source: a locally-held copy of this uuid (we
      // received the real message) always wins, and an existing held entry is
      // kept (first bundle wins; re-serving is a no-op — no churn, stable render).
      if (resolve(d, uuid) !== null) return false;
      if (d.heldEnvelopes[uuid] !== undefined) return false;
      // Store verbatim. Deliberately NO pinKey call: bundle content is relayed,
      // never a direct delivery, so it must never seed a TOFU pin.
      d.heldEnvelopes[uuid] = { env, from, fromContactId, authorAddr, receivedAt };
      // BOUND the held store: a met contact can send unsolicited envelope-bundles
      // of signed junk, and thread-so-far / channel bundles arrive proactively —
      // so held growth is not request-gated. Evict the OLDEST by receivedAt when
      // over the cap (FIFO; a re-viewed thread re-backfills anything evicted).
      const keys = Object.keys(d.heldEnvelopes);
      if (keys.length > heldCap) {
        let oldestKey = keys[0]!;
        let oldestAt = d.heldEnvelopes[oldestKey]!.receivedAt;
        for (const k of keys) {
          const at = d.heldEnvelopes[k]!.receivedAt;
          if (at < oldestAt) {
            oldestAt = at;
            oldestKey = k;
          }
        }
        if (oldestKey !== uuid) delete d.heldEnvelopes[oldestKey];
      }
      save();
      return true;
    },
    heldEnvelope: (uuid) => load().heldEnvelopes[uuid] ?? null,
    dropHeldEnvelope: (uuid) => {
      const d = load();
      if (d.heldEnvelopes[uuid] === undefined) return;
      delete d.heldEnvelopes[uuid];
      save();
    },
    heldEnvelopeUuids: () => Object.keys(load().heldEnvelopes),
    heldChildrenOf: (parentUuid) => {
      const out: string[] = [];
      for (const [uuid, held] of Object.entries(load().heldEnvelopes)) {
        const ref = held.env.ref;
        // Only uuid refs participate in the held reply graph (legacy mid refs
        // aren't backfillable and can't key by uuid).
        if (ref && 'u' in ref && ref.u === parentUuid && !out.includes(uuid)) out.push(uuid);
      }
      return out;
    },

    recordBackfillAttempt: (refUuid, nowMs) => {
      const d = load();
      const prev = d.backfillAttempts[refUuid];
      d.backfillAttempts[refUuid] = {
        attempts: (prev?.attempts ?? 0) + 1,
        lastAttemptAt: nowMs,
      };
      save();
    },
    backfillAttempt: (refUuid) => load().backfillAttempts[refUuid] ?? null,
    clearBackfillAttempt: (refUuid) => {
      const d = load();
      if (d.backfillAttempts[refUuid] === undefined) return;
      delete d.backfillAttempts[refUuid];
      save();
    },

    // --- thread-subscribe ---

    addHostedThread: (rootUuid, chatId) => {
      const d = load();
      d.hostedThreads[rootUuid] = chatId;
      save();
    },
    hostedThreadChatId: (rootUuid) => load().hostedThreads[rootUuid] ?? null,
    hostedThreadUuids: () => Object.keys(load().hostedThreads),
    removeHostedThread: (rootUuid) => {
      const d = load();
      if (d.hostedThreads[rootUuid] === undefined) return;
      delete d.hostedThreads[rootUuid];
      save();
    },
    wasRepublished: (uuid) => load().republishedUuids[uuid] === true,
    markRepublished: (uuid) => {
      const d = load();
      if (d.republishedUuids[uuid] === true) return;
      d.republishedUuids[uuid] = true;
      save();
    },

    reload: () => {
      data = null;
      load();
    },

    addThreadSubscription: (rootUuid, chatId) => {
      const d = load();
      d.threadSubscriptions[rootUuid] = chatId;
      save();
    },
    threadSubscriptionChatId: (rootUuid) => load().threadSubscriptions[rootUuid] ?? null,
    isSubscribedToThread: (rootUuid) => rootUuid in load().threadSubscriptions,
    isThreadSubscriptionChat: (chatId) =>
      Object.values(load().threadSubscriptions).includes(chatId),
    threadSubscriptionChatIds: () => Object.values(load().threadSubscriptions),
    threadSubscriptionUuids: () => Object.keys(load().threadSubscriptions),
    removeThreadSubscription: (rootUuid) => {
      const d = load();
      if (d.threadSubscriptions[rootUuid] === undefined) return;
      delete d.threadSubscriptions[rootUuid];
      save();
    },

    addPendingThreadRequest: (rootUuid, requestedAtMs) => {
      const d = load();
      d.pendingThreadRequests[rootUuid] = requestedAtMs;
      save();
    },
    hasPendingThreadRequest: (rootUuid) => rootUuid in load().pendingThreadRequests,
    clearPendingThreadRequest: (rootUuid) => {
      const d = load();
      if (!(rootUuid in d.pendingThreadRequests)) return;
      delete d.pendingThreadRequests[rootUuid];
      save();
    },
  };
};

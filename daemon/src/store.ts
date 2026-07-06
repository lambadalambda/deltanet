import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { T } from '@deltachat/jsonrpc-client';
import { parseCanonicalMid, parseMarkers, parsePostUuid } from './protocol.js';

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
 */
export const STORE_SCHEMA_VERSION = 4;

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
});

/**
 * Migrate an older/versionless store to the current schema: DROP every
 * derivable index (mid maps, the uuid->msgId index, edges — including
 * `replyChildren`, now keyed by post keys — tallies, ingestedMsgIds, ownMids,
 * alias map) so the startup backfill re-derives them fresh, but KEEP
 * notifications + dedupe keys + pending requests + the next notification id — so
 * re-derivation can never duplicate-notify and no user-visible history is lost.
 *
 * DEDUPE SAFETY across the v3->v4 post-key switch: legacy messages carry no `⚑`
 * uuid marker, so `postKey` falls back to the canonical mid for them — exactly
 * the key era-3 dedupe keys were computed under. Re-deriving notifications for
 * pre-v1 events therefore recomputes the SAME `type:addr:mid[:emoji]` dedupe
 * keys, which are preserved here, so a v3->v4 re-index never re-notifies for
 * historical events. (Only v1 messages, which never existed in a v3 store, key
 * by uuid.) Never touches any Delta Chat database; a QA node heals on a plain
 * restart. Pure.
 */
const migrate = (old: StoreData): StoreData => ({
  ...emptyData(),
  notifications: old.notifications ?? [],
  notificationDedupeKeys: old.notificationDedupeKeys ?? [],
  nextNotificationId: old.nextNotificationId ?? 1,
  pendingFollowRequests: old.pendingFollowRequests ?? {},
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
export const createStore = (filePath: string): Store => {
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
  const postKey = (text: string, mid: string): string => parsePostUuid(text) ?? canon(mid);

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
    ingestMessage: (msg, mid, isFeedMessage = true) => {
      const d = load();
      if (ingestedSet().has(msg.id)) return false;

      d.midToMsgId[mid] = msg.id;
      d.msgIdToMid[msg.id] = mid;

      // Learn a canonical alias for this message (explicit `⚓` legacy marker or
      // historical text-twin) BEFORE computing keys, so a mid-shaped post key
      // canonicalizes correctly.
      learnAlias(d, msg, mid, isFeedMessage);

      const parsed = parseMarkers(msg.text);

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
  };
};

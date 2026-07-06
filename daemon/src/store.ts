import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { T } from '@deltachat/jsonrpc-client';
import { parseCanonicalMid, parseMarkers } from './protocol.js';

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
 */
export const STORE_SCHEMA_VERSION = 2;

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
   * Historical text-twin aliasing bookkeeping (see canonical-mid issue point 3).
   * Pre-fix reply copies are exact text twins (feed + DM carry identical text,
   * no canonical marker). During (re)index we build text -> feedMid for
   * SELF-authored FEED messages, and text -> dmMid for SELF-authored DM
   * (Single-chat) messages still awaiting their feed twin — so whichever copy
   * the sweep encounters second resolves the alias, order-independently. Keyed
   * by the full message text.
   */
  selfFeedTextToMid: Record<string, string>;
  selfDmPendingText: Record<string, string>;
  midToMsgId: Record<string, number>;
  msgIdToMid: Record<number, string>;
  /**
   * Reply thread edges: parent CANONICAL mid -> child CANONICAL mids. Values are
   * mids (not msgIds) so a reply delivered twice — the feed broadcast copy and
   * the DM copy to the parent author, under two different rfc724 Message-IDs —
   * collapses to ONE child entry once their alias is known (set semantics), and
   * a non-follower who only holds the DM copy still gets a thread edge (the DM
   * copy's mid resolves to the DM msgId via `resolveMid`). Registered from BOTH
   * feed and Single-chat reply-marker messages (see `ingestMessage`). Read paths
   * resolve each child mid canonical-first to a msgId, skipping unresolvable
   * ones; `childrenCount` counts ALL entries (the logical reply count).
   */
  replyChildren: Record<string, string[]>;
  boostsByMid: Record<string, number[]>;
  /** msgIds (this account's own boosts) keyed by the mid they boosted. */
  ownBoosts: Record<string, number>;
  /** msgIds already ingested, so re-ingesting the same message is a no-op. */
  ingestedMsgIds: number[];
  /** mids authored by SELF (DC contact id 1). */
  ownMids: string[];
  /** mid -> reactor address -> emoji[] (a reactor may use several distinct emoji per mid). */
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
  selfFeedTextToMid: {},
  selfDmPendingText: {},
  midToMsgId: {},
  msgIdToMid: {},
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
 * derivable index (mid maps, edges — including `replyChildren`, whose value
 * shape changed from msgIds to child canonical mids in v2 — tallies,
 * ingestedMsgIds, ownMids, alias map) so the startup backfill re-derives them
 * fresh with canonical-mid aliasing, but KEEP notifications + dedupe keys +
 * pending requests + the next
 * notification id — so re-derivation can never duplicate-notify (the dedupe
 * keys still match) and no user-visible history is lost. Never touches any
 * Delta Chat database; a QA node heals on a plain restart. Pure.
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
   * Resolve a mid to a locally-held msgId, canonical-first: the canonical (feed)
   * copy when we hold it, else the raw mid, else — for a non-follower who only
   * ever received the DM copy but stored the child edge under the CANONICAL
   * (feed) mid — a REVERSE-alias lookup for any dmMid that aliases to this feed
   * mid and is itself indexed. That last fallback is what lets a DM-only reply
   * (whose thread edge is keyed by the feed mid it will never receive) still
   * render from the DM copy A actually holds.
   */
  const resolve = (d: StoreData, mid: string): number | null => {
    const c = canon(mid);
    const direct = d.midToMsgId[c] ?? d.midToMsgId[mid];
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
   *  - a SELF FEED message records text -> its mid, and resolves a DM twin that
   *    was already pending under the same text.
   *  - a SELF DM (Single-chat) message either (a) carries an explicit `⚓`
   *    canonical marker -> alias straight to it, (b) matches an already-seen
   *    SELF feed text -> alias to that feed mid, or (c) is stashed pending under
   *    its text to await a feed twin swept later.
   * In-place mutation of `d`; caller saves.
   */
  const learnAlias = (d: StoreData, msg: T.Message, mid: string, isFeedMessage: boolean): void => {
    const text = msg.text;
    if (!text) return;

    // An explicit `⚓` canonical marker is a stated fact regardless of author —
    // a non-follower's DM copy (the only copy we hold) declares its feed mid
    // this way, so this must NOT be gated on SELF. DM copies only.
    if (!isFeedMessage) {
      const explicit = parseCanonicalMid(text);
      if (explicit && explicit !== mid) {
        applyAlias(d, mid, explicit);
        return;
      }
    }

    // Historical text-twin aliasing is SELF-only: pre-fix copies carried no
    // marker, and only our own feed+DM reply copies are guaranteed exact text
    // twins we can safely equate (see canonical-mid issue point 3).
    if (msg.fromId !== DC_CONTACT_ID_SELF) return;

    if (isFeedMessage) {
      // A canonical marker never appears on a feed copy. Record text -> feedMid
      // and settle a pending DM twin if one arrived first.
      d.selfFeedTextToMid[text] = mid;
      const pendingDm = d.selfDmPendingText[text];
      if (pendingDm !== undefined && pendingDm !== mid) {
        applyAlias(d, pendingDm, mid);
        delete d.selfDmPendingText[text];
      }
      return;
    }

    // SELF DM copy without an explicit marker: match an already-seen SELF feed
    // text, else stash pending under its text to await a feed twin swept later.
    const feedMid = d.selfFeedTextToMid[text];
    if (feedMid !== undefined && feedMid !== mid) {
      applyAlias(d, mid, feedMid);
      return;
    }
    d.selfDmPendingText[text] = mid;
  };

  return {
    ingestMessage: (msg, mid, isFeedMessage = true) => {
      const d = load();
      if (ingestedSet().has(msg.id)) return false;

      d.midToMsgId[mid] = msg.id;
      d.msgIdToMid[msg.id] = mid;

      if (msg.fromId === DC_CONTACT_ID_SELF && !d.ownMids.includes(mid)) {
        d.ownMids.push(mid);
      }

      // Learn a canonical alias for this message (explicit marker or historical
      // text-twin) BEFORE registering edges, so edge keys canonicalize correctly.
      learnAlias(d, msg, mid, isFeedMessage);

      const parsed = parseMarkers(msg.text);

      // Reply edges register from BOTH feed copies AND Single-chat DM reply
      // copies — a non-follower who only holds the DM copy of a reply must still
      // get a thread edge, or the reply is invisible in the thread (see
      // ../meta/issues/non-follower-thread-rendering.md). The VALUE stored is
      // the child's CANONICAL mid, not its msgId: both copies of one logical
      // reply canonicalize to the same feed mid, so set-add dedupe collapses
      // them to a single child entry. Parent mid is canonicalized at write time
      // so an interaction referencing a DM copy's mid lands on the feed copy
      // (belt: read-time canonicalization too).
      if (parsed.reply) {
        const key = canon(parsed.reply.mid);
        const childMid = canon(mid);
        const children = d.replyChildren[key] ?? [];
        if (!children.includes(childMid)) children.push(childMid);
        d.replyChildren[key] = children;
      }

      // Boost edges stay FEED-only: boosts have no DM copy (unlike replies), so
      // there's nothing to unify — registering from a DM would be spurious.
      if (isFeedMessage && parsed.boost) {
        const key = canon(parsed.boost.mid);
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
    midForMsgId: (msgId) => load().msgIdToMid[msgId] ?? null,
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

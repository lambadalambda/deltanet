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
 */
export const STORE_SCHEMA_VERSION = 1;

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
  replyChildren: Record<string, number[]>;
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
 * derivable index (mid maps, edges, tallies, ingestedMsgIds, ownMids, alias
 * map) so the startup backfill re-derives them fresh with canonical-mid
 * aliasing, but KEEP notifications + dedupe keys + pending requests + the next
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
   * gates reply/boost edge registration: only messages delivered in a FEED
   * chat (Group/OutBroadcast/InBroadcast) may register `replyChildren` /
   * `boostsByMid` entries. DM copies of the same reply/boost (e.g. the
   * reply-notify control DM to the original author) still get their mid
   * <-> msgId mapping and `ownMids` bookkeeping recorded — just not the
   * edge — so the same logical reply delivered twice (once via feed, once
   * via DM) registers only once. See DEVLOG for the double-count bug this
   * fixes.
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
  replyChildren(mid: string): number[];
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
   * Record `dmMid` -> `feedMid` and re-key any edges/tallies/mappings already
   * under `dmMid` onto `feedMid`. In-place mutation of `d`; caller saves.
   */
  const applyAlias = (d: StoreData, dmMid: string, feedMid: string): void => {
    if (dmMid === feedMid) return;
    if (d.canonicalByMid[dmMid] === feedMid) return; // already aliased
    d.canonicalByMid[dmMid] = feedMid;

    if (d.replyChildren[dmMid]) {
      d.replyChildren[feedMid] = [...(d.replyChildren[feedMid] ?? []), ...d.replyChildren[dmMid]];
      delete d.replyChildren[dmMid];
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

      // Reply/boost edges are only registered from FEED chats (Group/
      // OutBroadcast/InBroadcast). DM copies of the same reply/boost
      // (delivered under a different rfc724Mid) must not also register an
      // edge, or context/reply-count would double-count a single logical
      // reply/boost delivered both ways. The parent/boosted mid is
      // canonicalized at write time so an interaction referencing a DM copy's
      // mid lands on the feed copy (belt: read-time canonicalization too).
      if (isFeedMessage) {
        const parsed = parseMarkers(msg.text);
        if (parsed.reply) {
          const key = canon(parsed.reply.mid);
          const children = d.replyChildren[key] ?? [];
          children.push(msg.id);
          d.replyChildren[key] = children;
        }
        if (parsed.boost) {
          const key = canon(parsed.boost.mid);
          const boosters = d.boostsByMid[key] ?? [];
          boosters.push(msg.id);
          d.boostsByMid[key] = boosters;
          if (msg.fromId === DC_CONTACT_ID_SELF) {
            d.ownBoosts[key] = msg.id;
          }
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

    resolveMid: (mid) => {
      const d = load();
      // Canonical FIRST: a historical ref pointing at a DM copy's mid (pre-fix
      // data) must resolve to the FEED copy when we hold it, or context
      // ancestors on migrated stores would still route through the Single-chat
      // twin. Raw is the fallback for the legitimate case where the canonical
      // feed copy simply doesn't exist locally (e.g. a non-follower's node
      // only ever received the DM copy).
      return d.midToMsgId[canon(mid)] ?? d.midToMsgId[mid] ?? null;
    },
    midForMsgId: (msgId) => load().msgIdToMid[msgId] ?? null,
    replyChildren: (mid) => load().replyChildren[canon(mid)] ?? [],
    childrenCount: (mid) => (load().replyChildren[canon(mid)] ?? []).length,
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

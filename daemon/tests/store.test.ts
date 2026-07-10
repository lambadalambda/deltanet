import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { writeFileSync } from 'node:fs';
import { createStore, STORE_SCHEMA_VERSION } from '../src/store.js';
import {
  buildBoostText,
  buildPostText,
  buildReplyText,
  mintPostUuid,
  refFromToken,
  type RefToken,
} from '../src/protocol.js';
import {
  buildBoostEnvelope,
  buildPostEnvelope,
  buildReplyEnvelope,
} from '../src/envelope.js';
import { makeMessage } from './entities.test.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deltanet-store-'));
  filePath = join(dir, 'store.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A mid-targeting MsgRef (legacy targets keyed by mid). */
const midRef = (mid: string, addr = 'author@example.org') => refFromToken({ kind: 'mid', mid }, addr);
/**
 * A LEGACY reply text: pre-v1 format with NO `⚑` uuid marker, so its post key
 * is the canonical mid. Used by the canonical-mid alias tests, whose behavior
 * (aliasMid re-key, reverse-alias resolution) only applies to legacy mid-keyed
 * posts (v1 posts unify via their shared uuid instead).
 */
const legacyReply = (body: string, mid: string, addr = 'author@example.org') =>
  `${body}\n\n↳re ${mid} ${addr}`;

describe('createStore: mid <-> msgId index', () => {
  it('records a plain message with no markers', () => {
    const store = createStore(filePath);
    const msg = makeMessage({ id: 10, text: 'hello' });
    store.ingestMessage(msg, 'mid-10@example.org');

    expect(store.resolveMid('mid-10@example.org')).toBe(10);
    expect(store.midForMsgId(10)).toBe('mid-10@example.org');
  });

  it('returns null for an unknown mid', () => {
    const store = createStore(filePath);
    expect(store.resolveMid('nope@example.org')).toBeNull();
  });

  it('returns null for an unknown msgId', () => {
    const store = createStore(filePath);
    expect(store.midForMsgId(999)).toBeNull();
  });
});

describe('createStore: reply edges', () => {
  it('records a reply child under the parent mid (feed message, default)', () => {
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    const replyMsg = makeMessage({ id: 20, text: buildReplyText('a reply', parentRef, mintPostUuid()) });
    store.ingestMessage(replyMsg, 'child-mid@example.org', true);

    expect(store.replyChildren(parentRef.keyString)).toEqual([20]);
    expect(store.childrenCount(parentRef.keyString)).toBe(1);
  });

  it('accumulates multiple children in order ingested', () => {
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    store.ingestMessage(makeMessage({ id: 21, text: buildReplyText('r1', parentRef, mintPostUuid()) }), 'c1@example.org', true);
    store.ingestMessage(makeMessage({ id: 22, text: buildReplyText('r2', parentRef, mintPostUuid()) }), 'c2@example.org', true);

    expect(store.replyChildren(parentRef.keyString)).toEqual([21, 22]);
  });

  it('returns an empty array for a mid with no children', () => {
    const store = createStore(filePath);
    expect(store.replyChildren('nothing@example.org')).toEqual([]);
    expect(store.childrenCount('nothing@example.org')).toBe(0);
  });

  it('does not record a reply edge for a plain, non-reply message', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 30, text: 'just a post' }), 'mid-30@example.org', true);
    expect(store.replyChildren('mid-30@example.org')).toEqual([]);
  });

  it('records a reply edge even when isFeedMessage is false (DM-only reply copy)', () => {
    // Non-follower-thread-rendering: a DM reply copy now DOES register a thread
    // edge (its child mid), so a non-follower who only holds the DM copy still
    // sees the reply in the thread. Boosts stay feed-only (see boost tests).
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    const replyMsg = makeMessage({ id: 23, text: buildReplyText('a DM copy of a reply', parentRef, mintPostUuid()) });
    store.ingestMessage(replyMsg, 'dm-child-mid@example.org', false);

    // The child renders (resolves to its DM msgId).
    expect(store.replyChildren(parentRef.keyString)).toEqual([23]);
    expect(store.childrenCount(parentRef.keyString)).toBe(1);
    // And the mid <-> msgId mapping is recorded for all messages.
    expect(store.resolveMid('dm-child-mid@example.org')).toBe(23);
  });

  it('defaults isFeedMessage to true when the third argument is omitted (backward compatible)', () => {
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    const replyMsg = makeMessage({ id: 24, text: buildReplyText('a reply', parentRef, mintPostUuid()) });
    store.ingestMessage(replyMsg, 'default-child-mid@example.org');

    expect(store.replyChildren(parentRef.keyString)).toEqual([24]);
  });

  it('a feed reply and its DM copy together register only one child (the fix for the double-count bug)', () => {
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    const uuid = mintPostUuid();
    const replyText = buildReplyText('a reply', parentRef, uuid);
    // Same logical reply, delivered twice: once via feed broadcast, once as a DM copy — different rfc724Mids.
    store.ingestMessage(makeMessage({ id: 29, text: replyText }), 'feed-copy-mid@example.org', true);
    store.ingestMessage(makeMessage({ id: 30, text: replyText }), 'dm-copy-mid@example.org', false);

    expect(store.replyChildren(parentRef.keyString)).toEqual([29]);
    expect(store.childrenCount(parentRef.keyString)).toBe(1);
  });
});

describe('createStore: boost edges', () => {
  it('records a booster msgId under the boosted mid', () => {
    const store = createStore(filePath);
    const ref = midRef('orig-mid@example.org');
    const boostMsg = makeMessage({ id: 40, text: buildBoostText(ref, mintPostUuid()) });
    store.ingestMessage(boostMsg, 'boost-mid@example.org', true);

    expect(store.boostsByMid(ref.keyString)).toEqual([40]);
    expect(store.boostCount(ref.keyString)).toBe(1);
  });

  it('reports isOwnBoost for a boost message sent from our own account (fromId 1)', () => {
    const store = createStore(filePath);
    const ref = midRef('orig-mid@example.org');
    const boostMsg = makeMessage({ id: 41, text: buildBoostText(ref, mintPostUuid()), fromId: 1 });
    store.ingestMessage(boostMsg, 'boost-mid-2@example.org', true);

    expect(store.isOwnBoost(ref.keyString)).toBe(true);
  });

  it('reports isOwnBoost false when no boost from self is known', () => {
    const store = createStore(filePath);
    expect(store.isOwnBoost('orig-mid@example.org')).toBe(false);
  });

  it('finds our own boost msgId for a given mid (for unreblog)', () => {
    const store = createStore(filePath);
    const ref = midRef('orig-mid@example.org');
    store.ingestMessage(makeMessage({ id: 42, text: buildBoostText(ref, mintPostUuid()), fromId: 1 }), 'b@example.org', true);
    expect(store.ownBoostMsgId(ref.keyString)).toBe(42);
  });

  it('ownBoostMsgId is null when we have not boosted', () => {
    const store = createStore(filePath);
    expect(store.ownBoostMsgId('orig-mid@example.org')).toBeNull();
  });

  it('does not record a boost edge when isFeedMessage is false (DM boost-notify copy)', () => {
    const store = createStore(filePath);
    const ref = midRef('orig-mid@example.org');
    const boostMsg = makeMessage({ id: 43, text: buildBoostText(ref, mintPostUuid()) });
    store.ingestMessage(boostMsg, 'dm-boost-mid@example.org', false);

    expect(store.boostsByMid(ref.keyString)).toEqual([]);
    expect(store.boostCount(ref.keyString)).toBe(0);
  });

  it('does not record ownBoosts when isFeedMessage is false, even from self', () => {
    const store = createStore(filePath);
    const ref = midRef('orig-mid@example.org');
    const boostMsg = makeMessage({ id: 44, text: buildBoostText(ref, mintPostUuid()), fromId: 1 });
    store.ingestMessage(boostMsg, 'dm-own-boost-mid@example.org', false);

    expect(store.isOwnBoost(ref.keyString)).toBe(false);
    expect(store.ownBoostMsgId(ref.keyString)).toBeNull();
  });
});

describe('createStore: idempotent ingest', () => {
  it('ingesting the same msgId twice does not duplicate reply/boost edges', () => {
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    const replyMsg = makeMessage({ id: 50, text: buildReplyText('a reply', parentRef, mintPostUuid()) });
    store.ingestMessage(replyMsg, 'child-mid@example.org');
    store.ingestMessage(replyMsg, 'child-mid@example.org');

    expect(store.replyChildren(parentRef.keyString)).toEqual([50]);
  });

  it('ingesting the same boost msgId twice does not duplicate boost edges', () => {
    const store = createStore(filePath);
    const ref = midRef('orig-mid@example.org');
    const boostMsg = makeMessage({ id: 60, text: buildBoostText(ref, mintPostUuid()) });
    store.ingestMessage(boostMsg, 'boost-mid@example.org');
    store.ingestMessage(boostMsg, 'boost-mid@example.org');

    expect(store.boostsByMid(ref.keyString)).toEqual([60]);
  });

  it('reports freshness: true on first ingest of a msgId, false on re-ingest', () => {
    const store = createStore(filePath);
    const msg = makeMessage({ id: 61, text: 'hello' });
    // One live DM can be delivered via both IncomingMsg and MsgsChanged (and
    // repeat MsgsChanged on state changes); callers gate execute-once side
    // effects (follow-back grant/accept) on this return value.
    expect(store.ingestMessage(msg, 'fresh-mid@example.org')).toBe(true);
    expect(store.ingestMessage(msg, 'fresh-mid@example.org')).toBe(false);
    expect(store.ingestMessage(msg, 'fresh-mid@example.org')).toBe(false);
  });
});

describe('createStore: persistence', () => {
  it('persists ingested state to the json file and reloads it in a new store instance', () => {
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    store.ingestMessage(makeMessage({ id: 70, text: buildReplyText('hi', parentRef, mintPostUuid()) }), 'child-mid@example.org');

    const raw = readFileSync(filePath, 'utf8');
    expect(JSON.parse(raw)).toBeTruthy();

    const reloaded = createStore(filePath);
    expect(reloaded.resolveMid('child-mid@example.org')).toBe(70);
    expect(reloaded.replyChildren(parentRef.keyString)).toEqual([70]);
  });

  it('lazily loads: creating a store for a nonexistent file does not throw and starts empty', () => {
    const store = createStore(join(dir, 'does-not-exist-yet.json'));
    expect(store.resolveMid('anything@example.org')).toBeNull();
  });

  it('persists only positive feed-message provenance across reloads', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 71, text: 'feed post' }), 'feed@example.org', true);
    store.ingestMessage(makeMessage({ id: 72, text: 'DM-only post' }), 'dm@example.org', false);

    expect(store.isFeedMessage(71)).toBe(true);
    expect(store.isFeedMessage(72)).toBe(false);

    const reloaded = createStore(filePath);
    expect(reloaded.isFeedMessage(71)).toBe(true);
    expect(reloaded.isFeedMessage(72)).toBe(false);
  });
});

describe('createStore: resolver shape used by entities mapping', () => {
  it('exposes resolveMid, childrenCount, boostCount, isOwnBoost together', () => {
    const store = createStore(filePath);
    const parentRef = midRef('parent-mid@example.org');
    store.ingestMessage(makeMessage({ id: 80, text: buildReplyText('hi', parentRef, mintPostUuid()) }), 'child-mid@example.org');

    expect(store.resolveMid('child-mid@example.org')).toBe(80);
    expect(store.childrenCount(parentRef.keyString)).toBe(1);
    expect(store.childrenCount('child-mid@example.org')).toBe(0);
    expect(store.boostCount('child-mid@example.org')).toBe(0);
    expect(store.isOwnBoost('child-mid@example.org')).toBe(false);
  });
});

describe('createStore: ownMids', () => {
  it('records a mid as own when ingested with sender = SELF (contact id 1)', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 90, fromId: 1, text: 'mine' }), 'own-mid@example.org');
    expect(store.isOwnMid('own-mid@example.org')).toBe(true);
  });

  it('does not record a mid as own when ingested from another contact', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 91, fromId: 11, text: 'not mine' }), 'their-mid@example.org');
    expect(store.isOwnMid('their-mid@example.org')).toBe(false);
  });

  it('reports false for an unknown mid', () => {
    const store = createStore(filePath);
    expect(store.isOwnMid('nope@example.org')).toBe(false);
  });
});

describe('createStore: reactions', () => {
  it('applies a reaction and tallies it', () => {
    const store = createStore(filePath);
    store.applyReaction('mid-1@example.org', 'bob@example.org', '❤');
    expect(store.reactionTallies('mid-1@example.org')).toEqual([
      { emoji: '❤', count: 1, reactors: ['bob@example.org'] },
    ]);
  });

  it('groups multiple reactors under the same emoji', () => {
    const store = createStore(filePath);
    store.applyReaction('mid-1@example.org', 'bob@example.org', '❤');
    store.applyReaction('mid-1@example.org', 'carol@example.org', '❤');
    expect(store.reactionTallies('mid-1@example.org')).toEqual([
      { emoji: '❤', count: 2, reactors: ['bob@example.org', 'carol@example.org'] },
    ]);
  });

  it('supports multiple distinct emoji per reactor per mid', () => {
    const store = createStore(filePath);
    store.applyReaction('mid-1@example.org', 'bob@example.org', '❤');
    store.applyReaction('mid-1@example.org', 'bob@example.org', '🎉');
    const tallies = store.reactionTallies('mid-1@example.org');
    expect(tallies).toHaveLength(2);
    expect(tallies.find((t) => t.emoji === '❤')).toEqual({ emoji: '❤', count: 1, reactors: ['bob@example.org'] });
    expect(tallies.find((t) => t.emoji === '🎉')).toEqual({ emoji: '🎉', count: 1, reactors: ['bob@example.org'] });
  });

  it('applying the same reactor+emoji twice does not double count', () => {
    const store = createStore(filePath);
    store.applyReaction('mid-1@example.org', 'bob@example.org', '❤');
    store.applyReaction('mid-1@example.org', 'bob@example.org', '❤');
    expect(store.reactionTallies('mid-1@example.org')).toEqual([
      { emoji: '❤', count: 1, reactors: ['bob@example.org'] },
    ]);
  });

  it('retracts a reaction', () => {
    const store = createStore(filePath);
    store.applyReaction('mid-1@example.org', 'bob@example.org', '❤');
    store.retractReaction('mid-1@example.org', 'bob@example.org', '❤');
    expect(store.reactionTallies('mid-1@example.org')).toEqual([]);
  });

  it('retracting one emoji leaves other reactions from the same reactor intact', () => {
    const store = createStore(filePath);
    store.applyReaction('mid-1@example.org', 'bob@example.org', '❤');
    store.applyReaction('mid-1@example.org', 'bob@example.org', '🎉');
    store.retractReaction('mid-1@example.org', 'bob@example.org', '❤');
    expect(store.reactionTallies('mid-1@example.org')).toEqual([
      { emoji: '🎉', count: 1, reactors: ['bob@example.org'] },
    ]);
  });

  it('retracting a reaction that was never applied is a no-op', () => {
    const store = createStore(filePath);
    store.retractReaction('mid-1@example.org', 'bob@example.org', '❤');
    expect(store.reactionTallies('mid-1@example.org')).toEqual([]);
  });

  it('returns an empty array for a mid with no reactions', () => {
    const store = createStore(filePath);
    expect(store.reactionTallies('nothing@example.org')).toEqual([]);
  });
});

describe('createStore: notifications', () => {
  it('appends a notification with a monotonic string id', () => {
    const store = createStore(filePath);
    const n1 = store.addNotification({ type: 'follow', accountAddr: 'bob@example.org' });
    const n2 = store.addNotification({ type: 'follow', accountAddr: 'carol@example.org' });
    expect(Number(n2!.id)).toBeGreaterThan(Number(n1!.id));
  });

  it('lists notifications newest first', () => {
    const store = createStore(filePath);
    store.addNotification({ type: 'follow', accountAddr: 'bob@example.org' });
    store.addNotification({ type: 'follow', accountAddr: 'carol@example.org' });
    const list = store.listNotifications({});
    expect(list.map((n) => n.accountAddr)).toEqual(['carol@example.org', 'bob@example.org']);
  });

  it('dedupes on type:addr:mid[:emoji]', () => {
    const store = createStore(filePath);
    store.addNotification({
      type: 'mention',
      accountAddr: 'bob@example.org',
      statusMsgId: 5,
      dedupeMid: 'reply-mid@example.org',
    });
    const second = store.addNotification({
      type: 'mention',
      accountAddr: 'bob@example.org',
      statusMsgId: 5,
      dedupeMid: 'reply-mid@example.org',
    });
    expect(second).toBeNull();
    expect(store.listNotifications({})).toHaveLength(1);
  });

  it('does not dedupe distinct emoji reactions from the same reactor on the same mid', () => {
    const store = createStore(filePath);
    store.addNotification({
      type: 'pleroma:emoji_reaction',
      accountAddr: 'bob@example.org',
      dedupeMid: 'mid-1@example.org',
      emoji: '❤',
    });
    store.addNotification({
      type: 'pleroma:emoji_reaction',
      accountAddr: 'bob@example.org',
      dedupeMid: 'mid-1@example.org',
      emoji: '🎉',
    });
    expect(store.listNotifications({})).toHaveLength(2);
  });

  it('a favourite notification omits the emoji field but still dedupes per dedupeEmoji', () => {
    const store = createStore(filePath);
    const n = store.addNotification({
      type: 'favourite',
      accountAddr: 'bob@example.org',
      dedupeMid: 'mid-1@example.org',
      dedupeEmoji: '❤',
    });
    expect(n).not.toHaveProperty('emoji');

    // A distinct emoji reaction from the same reactor on the same mid is not deduped away.
    const other = store.addNotification({
      type: 'pleroma:emoji_reaction',
      accountAddr: 'bob@example.org',
      emoji: '🎉',
      dedupeMid: 'mid-1@example.org',
      dedupeEmoji: '🎉',
    });
    expect(other).not.toBeNull();
    expect(store.listNotifications({})).toHaveLength(2);

    // Re-adding the same favourite is deduped.
    const dupe = store.addNotification({
      type: 'favourite',
      accountAddr: 'bob@example.org',
      dedupeMid: 'mid-1@example.org',
      dedupeEmoji: '❤',
    });
    expect(dupe).toBeNull();
  });

  it('paginates with limit', () => {
    const store = createStore(filePath);
    for (let i = 0; i < 5; i++) {
      store.addNotification({ type: 'follow', accountAddr: `user${i}@example.org` });
    }
    expect(store.listNotifications({ limit: 2 })).toHaveLength(2);
  });

  it('paginates with max_id (strictly older than)', () => {
    const store = createStore(filePath);
    const ids = [0, 1, 2].map(
      (i) => store.addNotification({ type: 'follow', accountAddr: `user${i}@example.org` })!.id,
    );
    const page = store.listNotifications({ maxId: ids[2] });
    expect(page.map((n) => n.id)).toEqual([ids[1], ids[0]]);
  });

  it('paginates with since_id (strictly newer than)', () => {
    const store = createStore(filePath);
    const ids = [0, 1, 2].map(
      (i) => store.addNotification({ type: 'follow', accountAddr: `user${i}@example.org` })!.id,
    );
    const page = store.listNotifications({ sinceId: ids[0] });
    expect(page.map((n) => n.id)).toEqual([ids[2], ids[1]]);
  });

  it('persists notifications across store reloads', () => {
    const store = createStore(filePath);
    store.addNotification({ type: 'follow', accountAddr: 'bob@example.org' });
    const reloaded = createStore(filePath);
    expect(reloaded.listNotifications({})).toHaveLength(1);
  });
});

describe('createStore: canonical-mid aliasing', () => {
  const DM = 'dm-copy-mid@example.org';
  const FEED = 'feed-copy-mid@example.org';
  const PARENT = 'parent-mid@example.org';

  it('canonicalize returns the mid unchanged when no alias is known', () => {
    const store = createStore(filePath);
    expect(store.canonicalize(DM)).toBe(DM);
  });

  it('canonicalize maps an aliased dm-mid to its feed-mid', () => {
    const store = createStore(filePath);
    store.aliasMid(DM, FEED);
    expect(store.canonicalize(DM)).toBe(FEED);
    // The feed mid canonicalizes to itself.
    expect(store.canonicalize(FEED)).toBe(FEED);
  });

  it('reply edges registered against a dm-mid resolve under the feed-mid once aliased (re-key on alias insertion)', () => {
    const store = createStore(filePath);
    const ref = midRef(DM);
    // A child reply arrives referencing the DM copy's mid, before we learn the alias.
    store.ingestMessage(makeMessage({ id: 10, text: legacyReply('child', ref.keyString, ref.addr) }), 'child@example.org', true);
    expect(store.childrenCount(DM)).toBe(1);

    // Now the alias is learned (e.g. an ingested canonical marker). The edge
    // re-keys so the feed copy carries the child.
    store.aliasMid(DM, FEED);
    expect(store.childrenCount(FEED)).toBe(1);
    expect(store.replyChildren(FEED)).toEqual([10]);
  });

  it('reply edges registered against a dm-mid AFTER the alias is known land on the feed-mid (write-time canonicalize)', () => {
    const store = createStore(filePath);
    store.aliasMid(DM, FEED);
    const ref = midRef(DM);
    store.ingestMessage(makeMessage({ id: 11, text: legacyReply('child', ref.keyString, ref.addr) }), 'child2@example.org', true);
    expect(store.childrenCount(FEED)).toBe(1);
    expect(store.childrenCount(DM)).toBe(1); // read-time union covers the dm-mid too
  });

  it('reactions applied to a dm-mid re-key to the feed-mid on alias insertion', () => {
    const store = createStore(filePath);
    store.applyReaction(DM, 'bob@example.org', '❤');
    expect(store.reactionTallies(DM)).toEqual([{ emoji: '❤', count: 1, reactors: ['bob@example.org'] }]);

    store.aliasMid(DM, FEED);
    expect(store.reactionTallies(FEED)).toEqual([{ emoji: '❤', count: 1, reactors: ['bob@example.org'] }]);
  });

  it('reactions applied to a dm-mid after aliasing tally under the feed-mid, read-visible under both', () => {
    const store = createStore(filePath);
    store.aliasMid(DM, FEED);
    store.applyReaction(DM, 'bob@example.org', '❤');
    expect(store.reactionTallies(FEED)).toEqual([{ emoji: '❤', count: 1, reactors: ['bob@example.org'] }]);
    expect(store.reactionTallies(DM)).toEqual([{ emoji: '❤', count: 1, reactors: ['bob@example.org'] }]);
  });

  it('resolveMid on an aliased dm-mid resolves the feed message when present locally', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 20, fromId: 1, text: 'the feed copy' }), FEED, true);
    store.aliasMid(DM, FEED);
    expect(store.resolveMid(DM)).toBe(20);
  });

  it('resolveMid prefers the FEED copy when BOTH copies are ingested and the alias is known (canonical-first)', () => {
    const store = createStore(filePath);
    // Both twins indexed — e.g. a migrated store re-indexed by the backfill.
    // A historical ref pointing at the DM copy's mid must resolve to the FEED
    // copy's msgId, or context ancestors would still route through the
    // Single-chat twin.
    store.ingestMessage(makeMessage({ id: 30, fromId: 1, text: 'the feed copy' }), FEED, true);
    store.ingestMessage(makeMessage({ id: 31, fromId: 1, text: 'the dm copy' }), DM, false);
    store.aliasMid(DM, FEED);
    expect(store.resolveMid(DM)).toBe(30);
    expect(store.resolveMid(FEED)).toBe(30);
  });

  it('resolveMid falls back to the DM copy when the alias is known but the canonical feed copy is absent locally', () => {
    const store = createStore(filePath);
    // A non-follower's node only ever received the DM copy; its `⚓` marker
    // taught the alias, but the feed copy never arrived. The DM copy is the
    // only renderable message — resolve it rather than nothing.
    store.ingestMessage(makeMessage({ id: 40, fromId: 11, text: 'the dm copy' }), DM, false);
    store.aliasMid(DM, FEED);
    expect(store.resolveMid(DM)).toBe(40);
  });

  it('isOwnMid follows the alias to the feed copy', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 21, fromId: 1, text: 'mine' }), FEED, true);
    store.aliasMid(DM, FEED);
    expect(store.isOwnMid(DM)).toBe(true);
  });

  it('merges reaction tallies when both dm-mid and feed-mid carried reactions before aliasing', () => {
    const store = createStore(filePath);
    store.applyReaction(FEED, 'carol@example.org', '❤');
    store.applyReaction(DM, 'bob@example.org', '❤');
    store.aliasMid(DM, FEED);
    const tally = store.reactionTallies(FEED);
    expect(tally).toEqual([{ emoji: '❤', count: 2, reactors: ['carol@example.org', 'bob@example.org'] }]);
  });

  it('aliasing is a no-op when dm-mid equals feed-mid', () => {
    const store = createStore(filePath);
    store.applyReaction(PARENT, 'bob@example.org', '❤');
    store.aliasMid(PARENT, PARENT);
    expect(store.reactionTallies(PARENT)).toEqual([{ emoji: '❤', count: 1, reactors: ['bob@example.org'] }]);
  });

  it('persists the alias map across reloads', () => {
    const store = createStore(filePath);
    store.aliasMid(DM, FEED);
    const reloaded = createStore(filePath);
    expect(reloaded.canonicalize(DM)).toBe(FEED);
  });
});

describe('createStore: non-follower thread edges (canonical-mid reply children)', () => {
  // The reply child stored is its CANONICAL mid, registered from BOTH a feed
  // copy and a DM copy, so the two copies of one logical reply collapse to a
  // single child entry and a DM-only reply still renders in the thread.
  const PARENT_DM = 'parent-dm@example.org';
  const PARENT_FEED = 'parent-feed@example.org';
  const CHILD_DM = 'child-dm@example.org';
  const CHILD_FEED = 'child-feed@example.org';

  it('registers a child edge from a DM-only reply (non-follower parent holds only the DM copy)', () => {
    const store = createStore(filePath);
    const ref = midRef(PARENT_FEED);
    // A non-follower node received the reply only as a DM copy carrying the
    // parent's feed mid via its `⚓` marker (parsed into the reply ref here).
    store.ingestMessage(makeMessage({ id: 10, fromId: 11, text: legacyReply('hi', ref.keyString, ref.addr) }), CHILD_DM, false);
    expect(store.childrenCount(PARENT_FEED)).toBe(1);
    expect(store.replyChildMids(PARENT_FEED)).toEqual([CHILD_DM]);
    expect(store.replyChildren(PARENT_FEED)).toEqual([10]); // resolves to the DM msgId
  });

  it('resolves a child stored under the FEED mid back to its DM copy via reverse alias (feed copy absent)', () => {
    const store = createStore(filePath);
    const ref = midRef(PARENT_FEED);
    // The DM copy carries a `⚓` marker, so it aliases CHILD_DM -> CHILD_FEED and
    // the child edge is stored under CHILD_FEED — but the FEED copy never
    // arrived (non-follower). resolveMid(CHILD_FEED) must reverse-resolve to the
    // DM copy A actually holds, so the reply still renders in the thread.
    const dmText = `hi\n\n↳re ${ref.keyString} ${ref.addr}\n⚓ ${CHILD_FEED}`;
    store.ingestMessage(makeMessage({ id: 15, fromId: 11, text: dmText }), CHILD_DM, false);
    expect(store.canonicalize(CHILD_DM)).toBe(CHILD_FEED);
    expect(store.replyChildMids(PARENT_FEED)).toEqual([CHILD_FEED]);
    expect(store.resolveMid(CHILD_FEED)).toBe(15); // reverse-alias to the DM copy
    expect(store.replyChildren(PARENT_FEED)).toEqual([15]);
  });

  it('collapses a feed copy and a DM copy of the same reply to one child once aliased (dedupe)', () => {
    const store = createStore(filePath);
    const ref = midRef(PARENT_FEED);
    // Two child entries whose alias is learned only LATER (differing bodies, so
    // the per-author text-twin heuristic doesn't fire at ingest — this test
    // exercises the aliasMid VALUE sweep in isolation).
    store.ingestMessage(makeMessage({ id: 20, fromId: 11, text: legacyReply('r1', ref.keyString, ref.addr) }), CHILD_FEED, true);
    store.ingestMessage(makeMessage({ id: 21, fromId: 11, text: legacyReply('r2', ref.keyString, ref.addr) }), CHILD_DM, false);
    expect(store.childrenCount(PARENT_FEED)).toBe(2);

    // Learning the child alias sweeps the VALUE list: the two collapse to one,
    // resolving to the FEED copy (canonical-first).
    store.aliasMid(CHILD_DM, CHILD_FEED);
    expect(store.childrenCount(PARENT_FEED)).toBe(1);
    expect(store.replyChildMids(PARENT_FEED)).toEqual([CHILD_FEED]);
    expect(store.replyChildren(PARENT_FEED)).toEqual([20]);
  });

  it('re-keys BOTH parent key and child value when the parent alias is learned late', () => {
    const store = createStore(filePath);
    const ref = midRef(PARENT_DM);
    // A DM-only reply registered under the parent's DM mid, before the parent
    // alias (parent's own dm->feed) is known.
    store.ingestMessage(makeMessage({ id: 30, fromId: 11, text: legacyReply('c', ref.keyString, ref.addr) }), CHILD_DM, false);
    expect(store.childrenCount(PARENT_DM)).toBe(1);

    store.aliasMid(PARENT_DM, PARENT_FEED);
    // The edge moved onto the feed parent (KEY re-key).
    expect(store.childrenCount(PARENT_FEED)).toBe(1);
    expect(store.replyChildMids(PARENT_FEED)).toEqual([CHILD_DM]);
  });

  it('dedupes on the child VALUE re-key when both the feed child and a not-yet-aliased dm child are present under one parent', () => {
    const store = createStore(filePath);
    // Feed child already registered under the (feed) parent. Differing bodies
    // keep the per-author text-twin heuristic out of the way (see above); the
    // alias arrives late via aliasMid, exercising the VALUE sweep + dedupe.
    const ref = midRef(PARENT_FEED);
    store.ingestMessage(makeMessage({ id: 40, fromId: 11, text: legacyReply('r1', ref.keyString, ref.addr) }), CHILD_FEED, true);
    // The DM copy of that same reply registers a second entry (alias unknown).
    store.ingestMessage(makeMessage({ id: 41, fromId: 11, text: legacyReply('r2', ref.keyString, ref.addr) }), CHILD_DM, false);
    expect(store.childrenCount(PARENT_FEED)).toBe(2);

    // Alias insertion sweeps the value list, mapping CHILD_DM -> CHILD_FEED and
    // deduping against the already-present feed entry.
    store.aliasMid(CHILD_DM, CHILD_FEED);
    expect(store.replyChildMids(PARENT_FEED)).toEqual([CHILD_FEED]);
    expect(store.childrenCount(PARENT_FEED)).toBe(1);
  });

  it('childrenCount counts ALL logical children including one not held locally', () => {
    const store = createStore(filePath);
    const ref = midRef(PARENT_FEED);
    // One child we hold (renderable) and one we only heard referenced.
    store.ingestMessage(makeMessage({ id: 50, fromId: 11, text: legacyReply('held', ref.keyString, ref.addr) }), CHILD_FEED, true);
    store.ingestMessage(
      makeMessage({ id: 51, fromId: 11, text: legacyReply('grandchild ref', midRef(CHILD_DM, 'x@x').keyString, 'x@x') }),
      'grandchild@example.org',
      true,
    );
    // CHILD_DM is referenced as a parent by the grandchild but never itself
    // ingested — it contributes to CHILD_DM's own children, not PARENT_FEED's.
    expect(store.childrenCount(PARENT_FEED)).toBe(1);
    expect(store.replyChildren(PARENT_FEED)).toEqual([50]);
    // The grandchild is a child of the (unheld) CHILD_DM: counted, not rendered.
    expect(store.childrenCount(CHILD_DM)).toBe(1);
    expect(store.replyChildren(CHILD_DM)).toEqual(['grandchild@example.org'].map(() => 51));
  });
});

describe('createStore: historical text-twin aliasing during (re)index', () => {
  const ref = midRef('orig@example.org');
  // Pre-fix copies are exact text twins: the feed copy and DM copy of a reply
  // carry identical text (no canonical marker existed yet).
  const replyText = legacyReply('nice pic', ref.keyString, ref.addr);

  it('aliases a SELF DM reply copy to a SELF feed reply copy with identical text (feed swept first)', () => {
    const store = createStore(filePath);
    // Feed copy encountered first.
    store.ingestMessage(makeMessage({ id: 86, fromId: 1, text: replyText }), 'feed86@example.org', true);
    // DM copy encountered second, identical text.
    store.ingestMessage(makeMessage({ id: 87, fromId: 1, text: replyText }), 'dm87@example.org', false);

    expect(store.canonicalize('dm87@example.org')).toBe('feed86@example.org');
  });

  it('aliases order-independently when the DM copy is swept BEFORE the feed copy', () => {
    const store = createStore(filePath);
    // DM copy encountered first.
    store.ingestMessage(makeMessage({ id: 87, fromId: 1, text: replyText }), 'dm87@example.org', false);
    // Feed copy encountered second.
    store.ingestMessage(makeMessage({ id: 86, fromId: 1, text: replyText }), 'feed86@example.org', true);

    expect(store.canonicalize('dm87@example.org')).toBe('feed86@example.org');
  });

  it('re-keys an interaction referencing the dm-mid onto the feed-mid via the identical-text alias', () => {
    const store = createStore(filePath);
    // A third party reacted to the DM copy's mid before we ever knew the alias.
    store.applyReaction('dm87@example.org', 'lain@example.org', '❤');

    // (Re)index sweeps both twins.
    store.ingestMessage(makeMessage({ id: 87, fromId: 1, text: replyText }), 'dm87@example.org', false);
    store.ingestMessage(makeMessage({ id: 86, fromId: 1, text: replyText }), 'feed86@example.org', true);

    // The reaction now shows under the feed copy's mid.
    expect(store.reactionTallies('feed86@example.org')).toEqual([
      { emoji: '❤', count: 1, reactors: ['lain@example.org'] },
    ]);
  });

  // --- per-author generalization (schema v3): OTHER authors' historical
  // twins alias too. On a follower's node, another party's pre-canonical reply
  // exists as a feed copy AND a marker-less DM copy (live regression: both
  // registered as children and the reply rendered twice). Twin condition: same
  // sender ADDRESS + byte-identical reply-marked text, one feed + one Single.

  const carol = { id: 11, address: 'carol@example.org' } as any;

  it('aliases an OTHER author\'s DM reply copy to their feed twin (feed swept first)', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 88, fromId: 11, sender: carol, text: replyText }), 'feed88@example.org', true);
    store.ingestMessage(makeMessage({ id: 89, fromId: 11, sender: carol, text: replyText }), 'dm89@example.org', false);
    expect(store.canonicalize('dm89@example.org')).toBe('feed88@example.org');
  });

  it('aliases an OTHER author\'s twins order-independently (DM swept first)', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 89, fromId: 11, sender: carol, text: replyText }), 'dm89@example.org', false);
    store.ingestMessage(makeMessage({ id: 88, fromId: 11, sender: carol, text: replyText }), 'feed88@example.org', true);
    expect(store.canonicalize('dm89@example.org')).toBe('feed88@example.org');
  });

  it('does not alias identical text from DIFFERENT sender addresses', () => {
    const store = createStore(filePath);
    const dave = { id: 12, address: 'dave@example.org' } as any;
    store.ingestMessage(makeMessage({ id: 88, fromId: 11, sender: carol, text: replyText }), 'feed88@example.org', true);
    store.ingestMessage(makeMessage({ id: 89, fromId: 12, sender: dave, text: replyText }), 'dm89@example.org', false);
    expect(store.canonicalize('dm89@example.org')).toBe('dm89@example.org');
  });

  it('does not alias identical PLAIN (non-reply-marked) text — the safety gate', () => {
    // Only reply-marked texts twin-match: a dual copy only ever exists for
    // replies, and requiring the marker is what makes a false positive
    // implausible (an author would have to send the exact same reply-marked
    // text as both a feed post and a separate DM — i.e. the pattern itself).
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 88, fromId: 11, sender: carol, text: 'lol' }), 'feed88@example.org', true);
    store.ingestMessage(makeMessage({ id: 89, fromId: 11, sender: carol, text: 'lol' }), 'dm89@example.org', false);
    expect(store.canonicalize('dm89@example.org')).toBe('dm89@example.org');
  });

  it('follower no-double-count: a pre-canonical other-author feed+DM reply pair registers ONE child', () => {
    // The live v2 regression: on the follower's node the other party's reply
    // exists as feed copy (88) AND marker-less DM copy (89). Both now register
    // child edges, so without the per-author twin alias the thread shows the
    // reply twice and replies_count doubles.
    const store = createStore(filePath);
    const parent = midRef('own-post@example.org', 'me@example.org');
    const historicalReply = legacyReply('nice pic', parent.keyString, parent.addr);
    store.ingestMessage(makeMessage({ id: 1, fromId: 1, text: 'my post' }), parent.keyString, true);
    store.ingestMessage(makeMessage({ id: 88, fromId: 11, sender: carol, text: historicalReply }), 'feed88@example.org', true);
    store.ingestMessage(makeMessage({ id: 89, fromId: 11, sender: carol, text: historicalReply }), 'dm89@example.org', false);

    expect(store.childrenCount(parent.keyString)).toBe(1);
    expect(store.replyChildren(parent.keyString)).toEqual([88]); // the FEED copy renders
    expect(store.replyChildMids(parent.keyString)).toEqual(['feed88@example.org']);
  });

  it('follower no-double-count holds in the opposite sweep order (DM copy first)', () => {
    const store = createStore(filePath);
    const parent = midRef('own-post@example.org', 'me@example.org');
    const historicalReply = legacyReply('nice pic', parent.keyString, parent.addr);
    store.ingestMessage(makeMessage({ id: 1, fromId: 1, text: 'my post' }), parent.keyString, true);
    store.ingestMessage(makeMessage({ id: 89, fromId: 11, sender: carol, text: historicalReply }), 'dm89@example.org', false);
    store.ingestMessage(makeMessage({ id: 88, fromId: 11, sender: carol, text: historicalReply }), 'feed88@example.org', true);

    expect(store.childrenCount(parent.keyString)).toBe(1);
    expect(store.replyChildren(parent.keyString)).toEqual([88]);
    expect(store.replyChildMids(parent.keyString)).toEqual(['feed88@example.org']);
  });

  it('prefers an explicit canonical marker over text-twin matching for a DM copy', () => {
    const store = createStore(filePath);
    // A post-fix DM copy carries the marker directly; no text-twin needed.
    const canonicalText = replyText + '\n⚓ explicit-feed@example.org';
    store.ingestMessage(makeMessage({ id: 87, fromId: 1, text: canonicalText }), 'dm87@example.org', false);
    expect(store.canonicalize('dm87@example.org')).toBe('explicit-feed@example.org');
  });
});

describe('createStore: schema migration / re-index', () => {
  it('writes the current schema version on a fresh store', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 1, text: 'hi' }), 'm1@example.org');
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('drops derived indices but keeps notifications/dedupe/pending on an older-version load', () => {
    // A pre-fix store: no schemaVersion, populated derived indices + notifications.
    const legacy = {
      midToMsgId: { 'a@x': 1 },
      msgIdToMid: { 1: 'a@x' },
      replyChildren: { 'p@x': [2] },
      boostsByMid: { 'p@x': [3] },
      ownBoosts: { 'p@x': 3 },
      ingestedMsgIds: [1, 2, 3],
      ownMids: ['a@x'],
      reactions: { 'p@x': { 'bob@x': ['❤'] } },
      notifications: [
        { id: '1', type: 'favourite', createdAt: '2020-01-01T00:00:00.000Z', accountAddr: 'bob@x' },
      ],
      notificationDedupeKeys: ['favourite:bob@x:p@x:❤'],
      nextNotificationId: 2,
      pendingFollowRequests: { 'alice@x': 999 },
    };
    writeFileSync(filePath, JSON.stringify(legacy));

    const store = createStore(filePath);

    // Derived indices dropped (will be re-derived by the startup backfill).
    expect(store.resolveMid('a@x')).toBeNull();
    expect(store.childrenCount('p@x')).toBe(0);
    expect(store.boostCount('p@x')).toBe(0);
    expect(store.isOwnMid('a@x')).toBe(false);
    expect(store.reactionTallies('p@x')).toEqual([]);

    // Preserved: notifications, dedupe keys, pending requests, next id.
    expect(store.listNotifications({})).toHaveLength(1);
    expect(store.hasPendingFollowRequest('alice@x')).toBe(true);

    // The dedupe key survived, so re-deriving the same favourite is a no-op.
    const dupe = store.addNotification({
      type: 'favourite',
      accountAddr: 'bob@x',
      dedupeMid: 'p@x',
      dedupeEmoji: '❤',
    });
    expect(dupe).toBeNull();

    // nextNotificationId preserved: a genuinely new notification gets id 2.
    const fresh = store.addNotification({ type: 'follow', accountAddr: 'zoe@x' });
    expect(fresh!.id).toBe('2');

    // Version is bumped on disk after the migrating load.
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('a current-version store is loaded as-is (no index drop)', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 5, text: 'hi' }), 'keep@example.org');
    const reloaded = createStore(filePath);
    expect(reloaded.resolveMid('keep@example.org')).toBe(5);
  });

  it('drops feed provenance from an older schema so the startup sweep rebuilds it', () => {
    writeFileSync(filePath, JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION - 1,
      feedMsgIds: [7],
      ingestedMsgIds: [7],
    }));

    const store = createStore(filePath);
    expect(store.isFeedMessage(7)).toBe(false);

    store.ingestMessage(makeMessage({ id: 7, text: 'rebuilt feed post' }), 'rebuilt@example.org', true);
    expect(store.isFeedMessage(7)).toBe(true);
  });

  it('drops a v1 store\'s replyChildren (msgId value shape) so a re-index rebuilds canonical-mid values', () => {
    // A v1 store carried replyChildren as parentMid -> child msgIds. The
    // current value shape is parentMid -> child CANONICAL mids, so migration
    // must DROP replyChildren (like every other derived index) for the backfill
    // to re-derive it; a stale msgId list would otherwise be misread as mids.
    const v1 = {
      schemaVersion: 1,
      midToMsgId: { 'p@x': 1 },
      msgIdToMid: { 1: 'p@x' },
      replyChildren: { 'p@x': [2, 3] }, // v1: child MSGIDS
      boostsByMid: {},
      ownBoosts: {},
      ingestedMsgIds: [1],
      ownMids: ['p@x'],
      reactions: {},
      canonicalByMid: {},
      notifications: [{ id: '1', type: 'follow', createdAt: '2020-01-01T00:00:00.000Z', accountAddr: 'z@x' }],
      notificationDedupeKeys: [],
      nextNotificationId: 2,
      pendingFollowRequests: {},
    };
    writeFileSync(filePath, JSON.stringify(v1));

    const store = createStore(filePath);
    // replyChildren dropped (re-index rebuilds it); notifications preserved.
    expect(store.childrenCount('p@x')).toBe(0);
    expect(store.replyChildren('p@x')).toEqual([]);
    expect(store.replyChildMids('p@x')).toEqual([]);
    expect(store.listNotifications({})).toHaveLength(1);

    // Version bumped on disk.
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('migrates a v2 store to v3: derived indices dropped so re-index applies per-author twin aliasing', () => {
    // v2 stores exist in the wild (migrated tonight) whose re-index ran with
    // SELF-only text-twin aliasing — historical other-author feed+DM reply
    // pairs registered TWO children (the live double-count regression). v3's
    // re-index heals them, so a v2 load must drop the derived indices again.
    const v2 = {
      schemaVersion: 2,
      midToMsgId: { 'feed88@x': 88, 'dm89@x': 89, 'p@x': 1 },
      msgIdToMid: { 1: 'p@x', 88: 'feed88@x', 89: 'dm89@x' },
      // The regression's footprint: both copies of one logical reply as children.
      replyChildren: { 'p@x': ['feed88@x', 'dm89@x'] },
      boostsByMid: {},
      ownBoosts: {},
      ingestedMsgIds: [1, 88, 89],
      ownMids: ['p@x'],
      reactions: {},
      canonicalByMid: {},
      notifications: [{ id: '1', type: 'follow', createdAt: '2020-01-01T00:00:00.000Z', accountAddr: 'z@x' }],
      notificationDedupeKeys: [],
      nextNotificationId: 2,
      pendingFollowRequests: {},
    };
    writeFileSync(filePath, JSON.stringify(v2));

    const store = createStore(filePath);
    expect(store.childrenCount('p@x')).toBe(0); // dropped; backfill re-derives with twin aliasing
    expect(store.listNotifications({})).toHaveLength(1);

    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('v3 -> v4 migration does not duplicate notifications (mid-based dedupe keys survive the post-key switch)', () => {
    // The v3->v4 concern: era-3 notification dedupe keys were computed under the
    // canonical-MID keyspace. Legacy messages carry no `⚑` uuid, so `postKey`
    // falls back to the canonical mid for them — the SAME key era 3 used. A
    // v3->v4 re-index therefore recomputes the identical `type:addr:mid[:emoji]`
    // dedupe key, which migration preserves, so the same historical event never
    // re-notifies. (Only v1 messages key by uuid, and none exist in a v3 store.)
    const v3 = {
      schemaVersion: 3,
      midToMsgId: { 'reply@x': 5, 'p@x': 1 },
      msgIdToMid: { 1: 'p@x', 5: 'reply@x' },
      replyChildren: { 'p@x': ['reply@x'] },
      boostsByMid: {},
      ownBoosts: {},
      ingestedMsgIds: [1, 5],
      ownMids: ['p@x'],
      reactions: { 'p@x': { 'bob@x': ['❤'] } },
      canonicalByMid: {},
      feedTextToMid: {},
      dmPendingText: {},
      notifications: [
        { id: '1', type: 'mention', createdAt: '2020-01-01T00:00:00.000Z', accountAddr: 'bob@x', statusMsgId: 5 },
        { id: '2', type: 'favourite', createdAt: '2020-01-01T00:00:00.000Z', accountAddr: 'bob@x' },
      ],
      // The dedupe keys as era-3 computed them: keyed by the parent's CANONICAL mid.
      notificationDedupeKeys: ['mention:bob@x:p@x', 'favourite:bob@x:p@x:❤'],
      nextNotificationId: 3,
      pendingFollowRequests: {},
    };
    writeFileSync(filePath, JSON.stringify(v3));

    const store = createStore(filePath);
    // Both historical notifications preserved (nothing lost).
    expect(store.listNotifications({})).toHaveLength(2);

    // Re-deriving the SAME two legacy events (post key = canonical mid, since
    // these messages have no uuid) is a dedupe no-op — no re-notification.
    const dupeMention = store.addNotification({
      type: 'mention',
      accountAddr: 'bob@x',
      statusMsgId: 5,
      dedupeMid: 'p@x',
    });
    const dupeFav = store.addNotification({
      type: 'favourite',
      accountAddr: 'bob@x',
      dedupeMid: 'p@x',
      dedupeEmoji: '❤',
    });
    expect(dupeMention).toBeNull();
    expect(dupeFav).toBeNull();
    expect(store.listNotifications({})).toHaveLength(2);

    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('v4 -> v5 migration does not re-notify for legacy events (dedupe continuity across the JSON-envelope switch)', () => {
    // v4->v5 concern: wire v2 (JSON envelopes) changes how a message's uuid is
    // read, but NOT the keyspace. Legacy messages carry no uuid at all (neither
    // a `⚑` marker nor a v2 `uuid` field), so `postKey` falls back to the
    // canonical mid — the SAME key era-3/era-4 dedupe used. A v4->v5 re-index
    // therefore recomputes identical `type:addr:mid[:emoji]` keys, preserved by
    // migration, so a historical event never re-notifies.
    const v4 = {
      schemaVersion: 4,
      midToMsgId: { 'reply@x': 5, 'p@x': 1 },
      msgIdToMid: { 1: 'p@x', 5: 'reply@x' },
      msgIdToKey: { 1: 'p@x', 5: 'reply@x' },
      uuidToMsgIds: {},
      uuidFeedMsgId: {},
      replyChildren: { 'p@x': ['reply@x'] },
      boostsByMid: {},
      ownBoosts: {},
      ingestedMsgIds: [1, 5],
      ownMids: ['p@x'],
      reactions: { 'p@x': { 'bob@x': ['❤'] } },
      canonicalByMid: {},
      feedTextToMid: {},
      dmPendingText: {},
      notifications: [
        { id: '1', type: 'mention', createdAt: '2020-01-01T00:00:00.000Z', accountAddr: 'bob@x', statusMsgId: 5 },
        { id: '2', type: 'favourite', createdAt: '2020-01-01T00:00:00.000Z', accountAddr: 'bob@x' },
      ],
      notificationDedupeKeys: ['mention:bob@x:p@x', 'favourite:bob@x:p@x:❤'],
      nextNotificationId: 3,
      pendingFollowRequests: {},
    };
    writeFileSync(filePath, JSON.stringify(v4));

    const store = createStore(filePath);
    // Both historical notifications preserved.
    expect(store.listNotifications({})).toHaveLength(2);

    // Re-deriving the SAME legacy events (post key = canonical mid) dedupes.
    const dupeMention = store.addNotification({
      type: 'mention',
      accountAddr: 'bob@x',
      statusMsgId: 5,
      dedupeMid: 'p@x',
    });
    const dupeFav = store.addNotification({
      type: 'favourite',
      accountAddr: 'bob@x',
      dedupeMid: 'p@x',
      dedupeEmoji: '❤',
    });
    expect(dupeMention).toBeNull();
    expect(dupeFav).toBeNull();
    expect(store.listNotifications({})).toHaveLength(2);

    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });
});

describe('createStore: mixed-era threads (v1 legacy parent + v2 reply/boost)', () => {
  const PARENT_UUID = '11111111-2222-4333-8444-555555555555';
  const REPLY_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const BOOST_UUID = 'cccccccc-dddd-4eee-8fff-000000000000';
  const AUTHOR = 'author@example.org';

  it('a v2 reply targeting a legacy v1 parent uuid forms a thread edge', () => {
    const store = createStore(filePath);
    // Legacy v1 parent: `⚑` marker feeds postKey = PARENT_UUID.
    store.ingestMessage(makeMessage({ id: 1, text: buildPostText('legacy parent', PARENT_UUID) }), 'parent@x', true);
    // v2 reply targeting the parent's uuid.
    const replyText = buildReplyEnvelope('a v2 reply', REPLY_UUID, { u: PARENT_UUID, addr: AUTHOR });
    store.ingestMessage(makeMessage({ id: 2, text: replyText }), 'reply@x', true);

    expect(store.childrenCount(PARENT_UUID)).toBe(1);
    expect(store.replyChildren(PARENT_UUID)).toEqual([2]);
    expect(store.resolveKey(REPLY_UUID)).toBe(2);
  });

  it('a v2 boost of a legacy v1 parent uuid registers a boost edge', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 1, text: buildPostText('legacy parent', PARENT_UUID), fromId: 1 }), 'parent@x', true);
    const boostText = buildBoostEnvelope(BOOST_UUID, { u: PARENT_UUID, addr: AUTHOR });
    store.ingestMessage(makeMessage({ id: 3, text: boostText }), 'boost@x', true);

    expect(store.boostCount(PARENT_UUID)).toBe(1);
    expect(store.boostsByMid(PARENT_UUID)).toEqual([3]);
  });

  it('a legacy v1 reply targeting a v2 parent uuid also forms a thread edge (symmetric)', () => {
    const store = createStore(filePath);
    // v2 parent.
    store.ingestMessage(makeMessage({ id: 1, text: buildPostEnvelope('v2 parent', PARENT_UUID) }), 'parent@x', true);
    // Legacy v1 reply targeting the parent uuid.
    const replyText = buildReplyText('legacy re', refFromToken({ kind: 'uuid', uuid: PARENT_UUID }, AUTHOR), REPLY_UUID);
    store.ingestMessage(makeMessage({ id: 2, text: replyText }), 'reply@x', true);

    expect(store.childrenCount(PARENT_UUID)).toBe(1);
    expect(store.replyChildren(PARENT_UUID)).toEqual([2]);
  });
});

describe('createStore: post-uuid keyspace (wire convention v1)', () => {
  it('resolveKey resolves a post uuid to its msgId', () => {
    const UUID = '11111111-2222-4333-8444-555555555555';
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 100, text: buildReplyText('r', midRef('p@x'), UUID) }), 'c@x', true);

    expect(store.resolveKey(UUID)).toBe(100);
    expect(store.resolveMid(UUID)).toBe(100);
  });

  it('keys by uuid even when DC appended its transient download placeholder to the text', () => {
    // Live-QA regression: a v2 post ingested while its attachment was still
    // downloading carried `{...} [Image – 137.37 KiB]` as text — the uuid parse
    // failed and the message got mis-keyed under its canonical MID, so its
    // reaction tallies (keyed by uuid) never rendered. The tolerant envelope
    // parse must keep the uuid keying regardless of the suffix.
    const UUID = 'aaaabbbb-2222-4333-8444-555555555555';
    const wire = JSON.stringify({ dn: 2, type: 'post', uuid: UUID, text: '', media: { sha256: 'ab'.repeat(32) } });
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 110, text: `${wire} [Image – 137.37 KiB]` }), 'c@x', true);

    expect(store.resolveKey(UUID)).toBe(110);
    expect(store.midForMsgId(110)).toBe(UUID);
  });

  it('resolveKey prefers the FEED copy when both copies of one uuid are local', () => {
    const UUID = '22222222-3333-4444-8555-666666666666';
    const store = createStore(filePath);
    const text = buildReplyText('r', midRef('p@x'), UUID);
    store.ingestMessage(makeMessage({ id: 200, text }), 'feed@x', true);
    store.ingestMessage(makeMessage({ id: 201, text }), 'dm@x', false);

    expect(store.resolveKey(UUID)).toBe(200);
  });

  it('a reply targeting a post by uuid registers the child edge under that uuid', () => {
    const PARENT_UUID = '33333333-4444-4555-8666-777777777777';
    const CHILD_UUID = '44444444-5555-4666-8777-888888888888';
    const store = createStore(filePath);
    const parentRef: RefToken = { kind: 'uuid', uuid: PARENT_UUID };
    store.ingestMessage(
      makeMessage({ id: 300, text: buildReplyText('child', refFromToken(parentRef, 'a@x'), CHILD_UUID) }),
      'c@x',
      true,
    );

    expect(store.childrenCount(PARENT_UUID)).toBe(1);
    expect(store.replyChildren(PARENT_UUID)).toEqual([300]);
  });

  it('childrenCount/replies count via midForMsgId returns the post uuid key', () => {
    const UUID = '55555555-6666-4777-8888-999999999999';
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 400, text: buildReplyText('r', midRef('p@x'), UUID) }), 'c@x', true);

    expect(store.midForMsgId(400)).toBe(UUID);
  });

  it('two replies sharing NO uuid are two children', () => {
    const PARENT_UUID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const store = createStore(filePath);
    const parentRef = refFromToken({ kind: 'uuid', uuid: PARENT_UUID }, 'a@x');
    store.ingestMessage(makeMessage({ id: 500, text: buildReplyText('r1', parentRef, mintPostUuid()) }), 'c1@x', true);
    store.ingestMessage(makeMessage({ id: 501, text: buildReplyText('r2', parentRef, mintPostUuid()) }), 'c2@x', true);

    expect(store.childrenCount(PARENT_UUID)).toBe(2);
  });
});

describe('createStore: pending follow requests', () => {
  const ALICE = 'alice@example.org';
  const BOB = 'bob@example.org';

  it('records a pending follow request with its requested-at timestamp', () => {
    const store = createStore(filePath);
    expect(store.hasPendingFollowRequest(ALICE)).toBe(false);
    store.addPendingFollowRequest(ALICE, 1000);
    expect(store.hasPendingFollowRequest(ALICE)).toBe(true);
    expect(store.pendingFollowRequests()).toEqual({ [ALICE]: 1000 });
  });

  it('clears a pending follow request', () => {
    const store = createStore(filePath);
    store.addPendingFollowRequest(ALICE, 1000);
    store.clearPendingFollowRequest(ALICE);
    expect(store.hasPendingFollowRequest(ALICE)).toBe(false);
    expect(store.pendingFollowRequests()).toEqual({});
  });

  it('clearing an unknown addr is a harmless no-op', () => {
    const store = createStore(filePath);
    expect(() => store.clearPendingFollowRequest(BOB)).not.toThrow();
    expect(store.hasPendingFollowRequest(BOB)).toBe(false);
  });

  it('tracks pending requests to several contacts independently', () => {
    const store = createStore(filePath);
    store.addPendingFollowRequest(ALICE, 1000);
    store.addPendingFollowRequest(BOB, 2000);
    store.clearPendingFollowRequest(ALICE);
    expect(store.hasPendingFollowRequest(ALICE)).toBe(false);
    expect(store.hasPendingFollowRequest(BOB)).toBe(true);
    expect(store.pendingFollowRequests()).toEqual({ [BOB]: 2000 });
  });

  it('persists pending follow requests across store reloads', () => {
    const store = createStore(filePath);
    store.addPendingFollowRequest(ALICE, 1234);
    const reloaded = createStore(filePath);
    expect(reloaded.hasPendingFollowRequest(ALICE)).toBe(true);
    expect(reloaded.pendingFollowRequests()).toEqual({ [ALICE]: 1234 });
  });
});

describe('createStore: TOFU key pins', () => {
  const ALICE = 'alice@example.org';

  it('pins a key on first sighting and reads it back', () => {
    const store = createStore(filePath);
    expect(store.pinnedKey(ALICE)).toBeNull();
    expect(store.pinKey(ALICE, 'KEY_A')).toBe('KEY_A');
    expect(store.pinnedKey(ALICE)).toBe('KEY_A');
  });

  it('is first-wins: a conflicting later pin is a no-op and returns the original', () => {
    const store = createStore(filePath);
    store.pinKey(ALICE, 'KEY_A');
    expect(store.pinKey(ALICE, 'KEY_B')).toBe('KEY_A');
    expect(store.pinnedKey(ALICE)).toBe('KEY_A');
  });

  it('re-pinning the same key is idempotent', () => {
    const store = createStore(filePath);
    store.pinKey(ALICE, 'KEY_A');
    expect(store.pinKey(ALICE, 'KEY_A')).toBe('KEY_A');
    expect(store.pinnedKey(ALICE)).toBe('KEY_A');
  });

  it('persists pins across store reloads', () => {
    const store = createStore(filePath);
    store.pinKey(ALICE, 'KEY_A');
    expect(createStore(filePath).pinnedKey(ALICE)).toBe('KEY_A');
  });

  it('survives a schema re-index (migrate) like notifications/pending', () => {
    // Seed an old-version store on disk with a pin, force a migrate on load.
    const store = createStore(filePath);
    store.pinKey(ALICE, 'KEY_A');
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    raw.schemaVersion = 0; // pre-current → triggers migrate on next load
    writeFileSync(filePath, JSON.stringify(raw));
    expect(createStore(filePath).pinnedKey(ALICE)).toBe('KEY_A');
  });
});

describe('reload (backup restore seam)', () => {
  it('drops the in-memory cache and re-reads the file on next access', () => {
    const store = createStore(filePath);
    store.markRepublished('uuid-before');
    expect(store.wasRepublished('uuid-before')).toBe(true);

    // Simulate a restore: a different store file lands at the same path.
    const otherPath = join(dir, 'restored.json');
    const other = createStore(otherPath);
    other.markRepublished('uuid-restored');
    writeFileSync(filePath, readFileSync(otherPath));

    store.reload();
    expect(store.wasRepublished('uuid-restored')).toBe(true);
    expect(store.wasRepublished('uuid-before')).toBe(false);
  });

  it('runs migration on reload when the restored file is an older schema', () => {
    const store = createStore(filePath);
    store.markRepublished('uuid-x');
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    raw.schemaVersion = 0;
    writeFileSync(filePath, JSON.stringify(raw));
    store.reload();
    // Non-derivable state survives the migrate re-index, same as a fresh load.
    expect(store.wasRepublished('uuid-x')).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });
});

describe('locked posts (visibility channels)', () => {
  it('marks and reports locked post uuids', () => {
    const store = createStore(filePath);
    const uuid = mintPostUuid();
    expect(store.isLockedPost(uuid)).toBe(false);
    store.markLockedPost(uuid);
    expect(store.isLockedPost(uuid)).toBe(true);
  });

  it('locked markers survive a schema re-index (non-derivable root)', () => {
    const store = createStore(filePath);
    const uuid = mintPostUuid();
    store.markLockedPost(uuid);
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    raw.schemaVersion = 0;
    writeFileSync(filePath, JSON.stringify(raw));
    expect(createStore(filePath).isLockedPost(uuid)).toBe(true);
  });
});

describe('direct posts (mentioned-people-only visibility)', () => {
  it('marks and reports direct post uuids', () => {
    const store = createStore(filePath);
    const uuid = mintPostUuid();
    expect(store.isDirectPost(uuid)).toBe(false);
    store.markDirectPost(uuid);
    expect(store.isDirectPost(uuid)).toBe(true);
  });

  it('direct markers survive a schema re-index (non-derivable root)', () => {
    const store = createStore(filePath);
    const uuid = mintPostUuid();
    store.markDirectPost(uuid);
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    raw.schemaVersion = 0;
    writeFileSync(filePath, JSON.stringify(raw));
    expect(createStore(filePath).isDirectPost(uuid)).toBe(true);
  });
});

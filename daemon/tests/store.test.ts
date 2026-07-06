import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { writeFileSync } from 'node:fs';
import { createStore, STORE_SCHEMA_VERSION } from '../src/store.js';
import { buildBoostText, buildReplyText } from '../src/protocol.js';
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
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    const replyMsg = makeMessage({ id: 20, text: buildReplyText('a reply', parentRef) });
    store.ingestMessage(replyMsg, 'child-mid@example.org', true);

    expect(store.replyChildren(parentRef.mid)).toEqual([20]);
    expect(store.childrenCount(parentRef.mid)).toBe(1);
  });

  it('accumulates multiple children in order ingested', () => {
    const store = createStore(filePath);
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    store.ingestMessage(makeMessage({ id: 21, text: buildReplyText('r1', parentRef) }), 'c1@example.org', true);
    store.ingestMessage(makeMessage({ id: 22, text: buildReplyText('r2', parentRef) }), 'c2@example.org', true);

    expect(store.replyChildren(parentRef.mid)).toEqual([21, 22]);
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

  it('does not record a reply edge when isFeedMessage is false (DM reply-notify copy)', () => {
    const store = createStore(filePath);
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    const replyMsg = makeMessage({ id: 23, text: buildReplyText('a DM copy of a reply', parentRef) });
    store.ingestMessage(replyMsg, 'dm-child-mid@example.org', false);

    expect(store.replyChildren(parentRef.mid)).toEqual([]);
    expect(store.childrenCount(parentRef.mid)).toBe(0);
    // But the mid <-> msgId mapping is still recorded for all messages.
    expect(store.resolveMid('dm-child-mid@example.org')).toBe(23);
  });

  it('defaults isFeedMessage to true when the third argument is omitted (backward compatible)', () => {
    const store = createStore(filePath);
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    const replyMsg = makeMessage({ id: 24, text: buildReplyText('a reply', parentRef) });
    store.ingestMessage(replyMsg, 'default-child-mid@example.org');

    expect(store.replyChildren(parentRef.mid)).toEqual([24]);
  });

  it('a feed reply and its DM copy together register only one child (the fix for the double-count bug)', () => {
    const store = createStore(filePath);
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    const replyText = buildReplyText('a reply', parentRef);
    // Same logical reply, delivered twice: once via feed broadcast, once as a DM copy — different rfc724Mids.
    store.ingestMessage(makeMessage({ id: 29, text: replyText }), 'feed-copy-mid@example.org', true);
    store.ingestMessage(makeMessage({ id: 30, text: replyText }), 'dm-copy-mid@example.org', false);

    expect(store.replyChildren(parentRef.mid)).toEqual([29]);
    expect(store.childrenCount(parentRef.mid)).toBe(1);
  });
});

describe('createStore: boost edges', () => {
  it('records a booster msgId under the boosted mid', () => {
    const store = createStore(filePath);
    const ref = { mid: 'orig-mid@example.org', addr: 'author@example.org' };
    const boostMsg = makeMessage({ id: 40, text: buildBoostText(ref) });
    store.ingestMessage(boostMsg, 'boost-mid@example.org', true);

    expect(store.boostsByMid(ref.mid)).toEqual([40]);
    expect(store.boostCount(ref.mid)).toBe(1);
  });

  it('reports isOwnBoost for a boost message sent from our own account (fromId 1)', () => {
    const store = createStore(filePath);
    const ref = { mid: 'orig-mid@example.org', addr: 'author@example.org' };
    const boostMsg = makeMessage({ id: 41, text: buildBoostText(ref), fromId: 1 });
    store.ingestMessage(boostMsg, 'boost-mid-2@example.org', true);

    expect(store.isOwnBoost(ref.mid)).toBe(true);
  });

  it('reports isOwnBoost false when no boost from self is known', () => {
    const store = createStore(filePath);
    expect(store.isOwnBoost('orig-mid@example.org')).toBe(false);
  });

  it('finds our own boost msgId for a given mid (for unreblog)', () => {
    const store = createStore(filePath);
    const ref = { mid: 'orig-mid@example.org', addr: 'author@example.org' };
    store.ingestMessage(makeMessage({ id: 42, text: buildBoostText(ref), fromId: 1 }), 'b@example.org', true);
    expect(store.ownBoostMsgId(ref.mid)).toBe(42);
  });

  it('ownBoostMsgId is null when we have not boosted', () => {
    const store = createStore(filePath);
    expect(store.ownBoostMsgId('orig-mid@example.org')).toBeNull();
  });

  it('does not record a boost edge when isFeedMessage is false (DM boost-notify copy)', () => {
    const store = createStore(filePath);
    const ref = { mid: 'orig-mid@example.org', addr: 'author@example.org' };
    const boostMsg = makeMessage({ id: 43, text: buildBoostText(ref) });
    store.ingestMessage(boostMsg, 'dm-boost-mid@example.org', false);

    expect(store.boostsByMid(ref.mid)).toEqual([]);
    expect(store.boostCount(ref.mid)).toBe(0);
  });

  it('does not record ownBoosts when isFeedMessage is false, even from self', () => {
    const store = createStore(filePath);
    const ref = { mid: 'orig-mid@example.org', addr: 'author@example.org' };
    const boostMsg = makeMessage({ id: 44, text: buildBoostText(ref), fromId: 1 });
    store.ingestMessage(boostMsg, 'dm-own-boost-mid@example.org', false);

    expect(store.isOwnBoost(ref.mid)).toBe(false);
    expect(store.ownBoostMsgId(ref.mid)).toBeNull();
  });
});

describe('createStore: idempotent ingest', () => {
  it('ingesting the same msgId twice does not duplicate reply/boost edges', () => {
    const store = createStore(filePath);
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    const replyMsg = makeMessage({ id: 50, text: buildReplyText('a reply', parentRef) });
    store.ingestMessage(replyMsg, 'child-mid@example.org');
    store.ingestMessage(replyMsg, 'child-mid@example.org');

    expect(store.replyChildren(parentRef.mid)).toEqual([50]);
  });

  it('ingesting the same boost msgId twice does not duplicate boost edges', () => {
    const store = createStore(filePath);
    const ref = { mid: 'orig-mid@example.org', addr: 'author@example.org' };
    const boostMsg = makeMessage({ id: 60, text: buildBoostText(ref) });
    store.ingestMessage(boostMsg, 'boost-mid@example.org');
    store.ingestMessage(boostMsg, 'boost-mid@example.org');

    expect(store.boostsByMid(ref.mid)).toEqual([60]);
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
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    store.ingestMessage(makeMessage({ id: 70, text: buildReplyText('hi', parentRef) }), 'child-mid@example.org');

    const raw = readFileSync(filePath, 'utf8');
    expect(JSON.parse(raw)).toBeTruthy();

    const reloaded = createStore(filePath);
    expect(reloaded.resolveMid('child-mid@example.org')).toBe(70);
    expect(reloaded.replyChildren(parentRef.mid)).toEqual([70]);
  });

  it('lazily loads: creating a store for a nonexistent file does not throw and starts empty', () => {
    const store = createStore(join(dir, 'does-not-exist-yet.json'));
    expect(store.resolveMid('anything@example.org')).toBeNull();
  });
});

describe('createStore: resolver shape used by entities mapping', () => {
  it('exposes resolveMid, childrenCount, boostCount, isOwnBoost together', () => {
    const store = createStore(filePath);
    const parentRef = { mid: 'parent-mid@example.org', addr: 'author@example.org' };
    store.ingestMessage(makeMessage({ id: 80, text: buildReplyText('hi', parentRef) }), 'child-mid@example.org');

    expect(store.resolveMid('child-mid@example.org')).toBe(80);
    expect(store.childrenCount(parentRef.mid)).toBe(1);
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
    const ref = { mid: DM, addr: 'author@example.org' };
    // A child reply arrives referencing the DM copy's mid, before we learn the alias.
    store.ingestMessage(makeMessage({ id: 10, text: buildReplyText('child', ref) }), 'child@example.org', true);
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
    const ref = { mid: DM, addr: 'author@example.org' };
    store.ingestMessage(makeMessage({ id: 11, text: buildReplyText('child', ref) }), 'child2@example.org', true);
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

describe('createStore: historical text-twin aliasing during (re)index', () => {
  const ref = { mid: 'orig@example.org', addr: 'author@example.org' };
  // Pre-fix copies are exact text twins: the feed copy and DM copy of a reply
  // carry identical text (no canonical marker existed yet).
  const replyText = buildReplyText('nice pic', ref);

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

  it('does not alias a DM copy to a NON-self feed message with identical text', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 86, fromId: 11, text: replyText }), 'feed86@example.org', true);
    store.ingestMessage(makeMessage({ id: 87, fromId: 1, text: replyText }), 'dm87@example.org', false);
    expect(store.canonicalize('dm87@example.org')).toBe('dm87@example.org');
  });

  it('does not alias a non-self DM copy even to a self feed twin', () => {
    const store = createStore(filePath);
    store.ingestMessage(makeMessage({ id: 86, fromId: 1, text: replyText }), 'feed86@example.org', true);
    store.ingestMessage(makeMessage({ id: 87, fromId: 11, text: replyText }), 'dm87@example.org', false);
    expect(store.canonicalize('dm87@example.org')).toBe('dm87@example.org');
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

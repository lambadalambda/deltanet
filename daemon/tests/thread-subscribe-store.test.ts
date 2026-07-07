import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORE_SCHEMA_VERSION, createStore } from '../src/store.js';

const ROOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ROOT2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

describe('thread-subscribe store state', () => {
  let dir: string;
  let filePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deltanet-thread-store-'));
    filePath = join(dir, 'store.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hosted-thread bindings round-trip + survive restart', () => {
    const store = createStore(filePath);
    store.addHostedThread(ROOT, 42);
    expect(store.hostedThreadChatId(ROOT)).toBe(42);
    expect(store.hostedThreadUuids()).toEqual([ROOT]);

    const reloaded = createStore(filePath);
    expect(reloaded.hostedThreadChatId(ROOT)).toBe(42);
    reloaded.removeHostedThread(ROOT);
    expect(reloaded.hostedThreadChatId(ROOT)).toBeNull();
  });

  it('republished-uuid dedupe is idempotent + persisted', () => {
    const store = createStore(filePath);
    expect(store.wasRepublished(ROOT)).toBe(false);
    store.markRepublished(ROOT);
    store.markRepublished(ROOT); // idempotent
    expect(store.wasRepublished(ROOT)).toBe(true);
    expect(createStore(filePath).wasRepublished(ROOT)).toBe(true);
  });

  it('thread subscriptions round-trip + distinguish channel chats', () => {
    const store = createStore(filePath);
    store.addThreadSubscription(ROOT, 100);
    store.addThreadSubscription(ROOT2, 101);
    expect(store.threadSubscriptionChatId(ROOT)).toBe(100);
    expect(store.isSubscribedToThread(ROOT)).toBe(true);
    expect(store.isThreadSubscriptionChat(100)).toBe(true);
    expect(store.isThreadSubscriptionChat(999)).toBe(false);
    expect(new Set(store.threadSubscriptionChatIds())).toEqual(new Set([100, 101]));
    expect(new Set(store.threadSubscriptionUuids())).toEqual(new Set([ROOT, ROOT2]));

    const reloaded = createStore(filePath);
    expect(reloaded.isThreadSubscriptionChat(101)).toBe(true);
    reloaded.removeThreadSubscription(ROOT);
    expect(reloaded.isSubscribedToThread(ROOT)).toBe(false);
    expect(reloaded.isThreadSubscriptionChat(100)).toBe(false);
  });

  it('pending thread requests gate grants + round-trip', () => {
    const store = createStore(filePath);
    expect(store.hasPendingThreadRequest(ROOT)).toBe(false);
    store.addPendingThreadRequest(ROOT, 123);
    expect(store.hasPendingThreadRequest(ROOT)).toBe(true);
    expect(createStore(filePath).hasPendingThreadRequest(ROOT)).toBe(true);
    store.clearPendingThreadRequest(ROOT);
    expect(store.hasPendingThreadRequest(ROOT)).toBe(false);
  });
});

describe('thread-subscribe store migration', () => {
  it('a pre-v7 store gains thread state and survives migrate without losing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deltanet-thread-migrate-'));
    const filePath = join(dir, 'store.json');
    try {
      // A v6 store that ALREADY carries thread state (as if written by a newer
      // build) — migration must NOT drop it (it is a non-derivable root).
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 6,
          hostedThreads: { [ROOT]: 7 },
          threadSubscriptions: { [ROOT2]: 8 },
          pendingThreadRequests: { [ROOT]: 111 },
          republishedUuids: { [ROOT]: true },
        }),
      );
      const store = createStore(filePath);
      // Access forces the lazy load → migrate → persist.
      expect(store.hostedThreadChatId(ROOT)).toBe(7);
      // Migrated (version bumped), state preserved on disk.
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
      expect(store.threadSubscriptionChatId(ROOT2)).toBe(8);
      expect(store.hasPendingThreadRequest(ROOT)).toBe(true);
      expect(store.wasRepublished(ROOT)).toBe(true);
      expect(existsSync(filePath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, STORE_SCHEMA_VERSION } from '../src/store.js';
import { buildPostObject, type Envelope } from '../src/envelope.js';
import { makeMessage } from './entities.test.js';

const UUID = 'aaaa1111-2222-4333-8444-555555555555';
const UUID2 = 'bbbb2222-3333-4444-8555-666666666666';
const ALICE = 'alice@relay.example';
const BOB = 'bob@relay.example';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backfill-store-'));
  filePath = join(dir, 'store.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signedPost = (uuid: string, text = 'held'): Envelope => ({
  ...buildPostObject(text, uuid),
  ts: 1,
  pubkey: 'PK',
  sig: 'SIG',
});

describe('held-envelope store', () => {
  it('stores and retrieves a held envelope keyed by uuid', () => {
    const store = createStore(filePath);
    expect(store.addHeldEnvelope(signedPost(UUID), BOB, 22, ALICE, 1000)).toBe(true);
    const held = store.heldEnvelope(UUID);
    expect(held?.env.uuid).toBe(UUID);
    expect(held?.from).toBe(BOB);
    expect(held?.fromContactId).toBe(22); // the message-derived (key-)contact id
    expect(held?.authorAddr).toBe(ALICE);
    expect(held?.receivedAt).toBe(1000);
    expect(store.heldEnvelopeUuids()).toEqual([UUID]);
  });

  it('does not overwrite an existing held entry (first bundle wins)', () => {
    const store = createStore(filePath);
    store.addHeldEnvelope(signedPost(UUID, 'first'), BOB, 22, ALICE, 1);
    expect(store.addHeldEnvelope(signedPost(UUID, 'second'), 'carol@x', 33, ALICE, 2)).toBe(false);
    expect(store.heldEnvelope(UUID)?.env.text).toBe('first');
  });

  it('does not store a held envelope when a LOCAL copy already resolves the uuid', () => {
    const store = createStore(filePath);
    // Ingest a local message carrying UUID (its own post key).
    store.ingestMessage(makeMessage({ id: 7, text: JSON.stringify(buildPostObject('local', UUID)) }), 'mid-7@x', true);
    expect(store.resolveKey(UUID)).toBe(7);
    expect(store.addHeldEnvelope(signedPost(UUID), BOB, 22, ALICE, 1)).toBe(false);
    expect(store.heldEnvelope(UUID)).toBeNull();
  });

  it('drops a held envelope (verification-failed path)', () => {
    const store = createStore(filePath);
    store.addHeldEnvelope(signedPost(UUID), BOB, 22, ALICE, 1);
    store.dropHeldEnvelope(UUID);
    expect(store.heldEnvelope(UUID)).toBeNull();
    expect(store.heldEnvelopeUuids()).toEqual([]);
  });

  it('never TOFU-pins from a held envelope (bundles are relayed content)', () => {
    const store = createStore(filePath);
    store.addHeldEnvelope(signedPost(UUID), BOB, 22, ALICE, 1);
    // No pin was recorded for the author from bundle content.
    expect(store.pinnedKey(ALICE)).toBeNull();
  });

  it('computes held children of a parent uuid from stored refs', () => {
    const store = createStore(filePath);
    const reply: Envelope = {
      dn: 2,
      type: 'reply',
      uuid: UUID2,
      text: 'a held reply',
      ref: { u: UUID, addr: ALICE },
      ts: 1,
      pubkey: 'PK',
      sig: 'SIG',
    };
    store.addHeldEnvelope(reply, BOB, 22, BOB, 1);
    expect(store.heldChildrenOf(UUID)).toEqual([UUID2]);
    expect(store.heldChildrenOf('no-such-uuid')).toEqual([]);
  });
});

describe('backfill negative-cache attempt state', () => {
  it('records + reads + clears attempts', () => {
    const store = createStore(filePath);
    expect(store.backfillAttempt(UUID)).toBeNull();
    store.recordBackfillAttempt(UUID, 1000);
    store.recordBackfillAttempt(UUID, 2000);
    expect(store.backfillAttempt(UUID)).toEqual({ attempts: 2, lastAttemptAt: 2000 });
    store.clearBackfillAttempt(UUID);
    expect(store.backfillAttempt(UUID)).toBeNull();
  });
});

describe('held envelopes + attempts survive restart and migrate', () => {
  it('round-trips across a fresh store instance (restart)', () => {
    const store = createStore(filePath);
    store.addHeldEnvelope(signedPost(UUID), BOB, 22, ALICE, 1);
    store.recordBackfillAttempt(UUID2, 5);

    const reloaded = createStore(filePath);
    expect(reloaded.heldEnvelope(UUID)?.env.uuid).toBe(UUID);
    expect(reloaded.backfillAttempt(UUID2)).toEqual({ attempts: 1, lastAttemptAt: 5 });
  });

  it('preserves held envelopes + attempts across a schema migration (like pins/notifications)', () => {
    // A pre-v6 store that ALSO carries the additive held/attempt fields must keep
    // them across the derived-index re-index (they are non-derivable roots).
    const old = {
      schemaVersion: 5,
      midToMsgId: {},
      msgIdToMid: {},
      replyChildren: {},
      boostsByMid: {},
      ownBoosts: {},
      ingestedMsgIds: [],
      ownMids: [],
      reactions: {},
      canonicalByMid: {},
      notifications: [],
      notificationDedupeKeys: [],
      nextNotificationId: 1,
      pendingFollowRequests: {},
      pinnedKeys: {},
      heldEnvelopes: { [UUID]: { env: signedPost(UUID), from: BOB, fromContactId: 22, authorAddr: ALICE, receivedAt: 9 } },
      backfillAttempts: { [UUID2]: { attempts: 3, lastAttemptAt: 42 } },
    };
    writeFileSync(filePath, JSON.stringify(old));

    const store = createStore(filePath);
    expect(store.heldEnvelope(UUID)?.authorAddr).toBe(ALICE);
    expect(store.backfillAttempt(UUID2)).toEqual({ attempts: 3, lastAttemptAt: 42 });

    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });
});

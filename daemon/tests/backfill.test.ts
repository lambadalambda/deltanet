import { describe, expect, it } from 'vitest';
import {
  createBackfiller,
  nextEligibleAt,
  isEligible,
  chunkRefs,
  remainingBudget,
  DEFAULT_BACKFILL_CONFIG,
  type BackfillStore,
} from '../src/backfill.js';
import type { BackfillAttempt } from '../src/store.js';
import type { EnvelopeRef } from '../src/envelope.js';

const PEER = 'bob@relay.example';
const AUTHOR = 'alice@relay.example';
const uuidN = (n: number) => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;

/** A minimal in-memory negative-cache store for the scheduler. */
const fakeStore = (): BackfillStore & { attempts: Map<string, BackfillAttempt> } => {
  const attempts = new Map<string, BackfillAttempt>();
  return {
    attempts,
    backfillAttempt: (u) => attempts.get(u) ?? null,
    recordBackfillAttempt: (u, now) => {
      const prev = attempts.get(u);
      attempts.set(u, { attempts: (prev?.attempts ?? 0) + 1, lastAttemptAt: now });
    },
    clearBackfillAttempt: (u) => attempts.delete(u),
  };
};

/** A backfiller whose timer is a no-op (tests drive flush() directly) + a clock. */
const makeBackfiller = (over: Parameters<typeof createBackfiller>[0]['config'] = {}, now = () => 0) => {
  const store = fakeStore();
  const sent: { peer: string; contactId: number; refs: EnvelopeRef[] }[] = [];
  const bf = createBackfiller({
    store,
    send: async (peer, contactId, refs) => {
      sent.push({ peer, contactId, refs });
    },
    config: over,
    now,
    schedule: () => null,
    cancel: () => {},
  });
  return { bf, store, sent };
};

describe('pure scheduling helpers', () => {
  it('nextEligibleAt applies exponential backoff', () => {
    const cfg = { backoffBaseMs: 100, backoffFactor: 2 };
    expect(nextEligibleAt(null, cfg)).toBe(0);
    expect(nextEligibleAt({ attempts: 1, lastAttemptAt: 1000 }, cfg)).toBe(1100); // 100 * 2^0
    expect(nextEligibleAt({ attempts: 2, lastAttemptAt: 1000 }, cfg)).toBe(1200); // 100 * 2^1
    expect(nextEligibleAt({ attempts: 3, lastAttemptAt: 1000 }, cfg)).toBe(1400); // 100 * 2^2
  });

  it('isEligible gives up after maxAttempts and respects backoff', () => {
    const cfg = { maxAttempts: 3, backoffBaseMs: 100, backoffFactor: 2 };
    expect(isEligible(null, 0, cfg)).toBe(true);
    expect(isEligible({ attempts: 3, lastAttemptAt: 0 }, 1e9, cfg)).toBe(false); // given up
    expect(isEligible({ attempts: 1, lastAttemptAt: 1000 }, 1050, cfg)).toBe(false); // still backing off
    expect(isEligible({ attempts: 1, lastAttemptAt: 1000 }, 1100, cfg)).toBe(true); // window elapsed
  });

  it('chunkRefs batches uuids into request-sized ref arrays', () => {
    const batches = chunkRefs([uuidN(1), uuidN(2), uuidN(3)], PEER, 2);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([{ u: uuidN(1), addr: PEER }, { u: uuidN(2), addr: PEER }]);
    expect(batches[1]).toEqual([{ u: uuidN(3), addr: PEER }]);
  });

  it('remainingBudget is a trailing-minute sliding window', () => {
    expect(remainingBudget([], 100_000, 4)).toBe(4);
    expect(remainingBudget([100_000, 100_000], 100_000, 4)).toBe(2);
    expect(remainingBudget([0, 0], 100_000, 4)).toBe(4); // old timestamps drop out
  });
});

describe('enqueue + flush', () => {
  it('batches multiple refs to one peer into a single request DM', async () => {
    const { bf, sent } = makeBackfiller();
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    bf.enqueue({ uuid: uuidN(2), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    expect(await bf.flush()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.refs.map((r) => (r as any).u)).toEqual([uuidN(1), uuidN(2)]);
    // The send targets the peer's MESSAGE-DERIVED contact id (key-contact), never
    // an addr lookup (which would land on a keyless address-contact row).
    expect(sent[0]!.contactId).toBe(22);
  });

  it('dedupes an already-queued ref', async () => {
    const { bf } = makeBackfiller();
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    expect(bf.pendingFor(PEER)).toEqual([uuidN(1)]);
  });

  it('does not re-request an in-flight ref (dedupe across enqueues)', async () => {
    const { bf, sent } = makeBackfiller();
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    await bf.flush();
    expect(bf.isInFlight(uuidN(1))).toBe(true);
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    expect(await bf.flush()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('respects the global rate cap across peers', async () => {
    const { bf, sent } = makeBackfiller({ maxRequestsPerMinute: 2, maxRefsPerRequest: 1 });
    for (let i = 1; i <= 5; i++) bf.enqueue({ uuid: uuidN(i), peer: `peer${i}@x`, peerContactId: 100 + i, authorAddr: AUTHOR });
    expect(await bf.flush()).toBe(2); // only 2 request DMs this minute
    expect(sent).toHaveLength(2);
  });

  it('records a backfill attempt (negative cache) on send', async () => {
    const { bf, store } = makeBackfiller({}, () => 1234);
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    await bf.flush();
    expect(store.attempts.get(uuidN(1))).toEqual({ attempts: 1, lastAttemptAt: 1234 });
  });

  it('never re-queues a ref that already exhausted its attempts', () => {
    const { bf, store } = makeBackfiller({ maxAttempts: 2 });
    store.attempts.set(uuidN(1), { attempts: 2, lastAttemptAt: 0 });
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    expect(bf.pendingFor(PEER)).toEqual([]);
  });

  it('onResolved clears in-flight lock + negative cache', async () => {
    const { bf, store } = makeBackfiller();
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    await bf.flush();
    bf.onResolved(uuidN(1));
    expect(bf.isInFlight(uuidN(1))).toBe(false);
    expect(store.attempts.get(uuidN(1))).toBeUndefined();
  });

  it('tracks the attributed author addr for a uuid until resolved', () => {
    const { bf } = makeBackfiller();
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    expect(bf.attributedAddr(uuidN(1))).toBe(AUTHOR);
    bf.onResolved(uuidN(1));
    expect(bf.attributedAddr(uuidN(1))).toBeNull();
  });

  it('bounds transitive rounds per peer', async () => {
    const { bf, sent } = makeBackfiller({ maxRounds: 2, maxRefsPerRequest: 1, maxRequestsPerMinute: 100 });
    // Round 1
    bf.enqueue({ uuid: uuidN(1), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    await bf.flush();
    // Round 2
    bf.enqueue({ uuid: uuidN(2), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    await bf.flush();
    // Round 3 enqueue must be dropped (peer hit maxRounds).
    bf.enqueue({ uuid: uuidN(3), peer: PEER, peerContactId: 22, authorAddr: AUTHOR });
    expect(bf.pendingFor(PEER)).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('DEFAULT config caps at 4 req/min, 5 attempts, 10 rounds', () => {
    expect(DEFAULT_BACKFILL_CONFIG.maxRequestsPerMinute).toBe(4);
    expect(DEFAULT_BACKFILL_CONFIG.maxAttempts).toBe(5);
    expect(DEFAULT_BACKFILL_CONFIG.maxRounds).toBe(10);
  });
});

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { type DeltaChatTransport, type IngestPhase } from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { createUnsafeTestApp, type AppContext } from '../../src/server.js';
import { deriveOnIngest } from '../../src/ingest.js';
import { createBackfiller, type Backfiller, type SendRequest } from '../../src/backfill.js';
import { buildEnvelopeRequest, type EnvelopeRef } from '../../src/envelope.js';
import {
  enqueueDangling,
  handleBackfillControlDm,
  MAX_SERVE_RESPONSES_PER_MINUTE,
} from '../../src/backfill-ingest.js';
import { parseWire, parseWireUuid } from '../../src/wire.js';

/** The human body of a wire message. */
const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Acceptance scenario from ../../meta/issues/thread-auto-backfill.md:
 *
 *   A and B mutual-follow and build an alternating thread (>=4 messages).
 *   C follows only B, NEVER meets A. WITHOUT any boost, C's daemon backfills
 *   A's half by asking B (transitively — every A message is the parent of a B
 *   message C already holds).
 *
 * Assert:
 *  - C's context for the thread ROOT shows the COMPLETE thread with A's posts
 *    attributed to A's addr and verified.
 *  - C has NO new notifications from the backfill.
 *  - C's home timeline does NOT contain A's posts.
 *
 * Fresh accounts + own data/int-tab-* dirs; never touches live daemon data.
 */
describe('thread auto-backfill: C heals A\'s half by asking B (no boost)', () => {
  const transports: DeltaChatTransport[] = [];

  afterAll(() => {
    for (const t of transports) t.close();
  });

  /**
   * main.ts-style ingest wiring WITH the full backfill pipeline: index/derive as
   * usual, plus dangling-ref enqueue, serve `envelope-request`, and process
   * `envelope-bundle` — all suppressed (no notifications/streaming/timeline).
   */
  const wireIngest = (
    store: Store,
    transportRef: () => Transport | null,
    backfillerRef: () => Backfiller | null,
    serveGuard: (peer: string) => boolean,
  ) =>
    async (msg: T.Message, isFeedMessage: boolean, mid: string | null, phase: IngestPhase): Promise<void> => {
      if (!mid) return;
      let fresh = false;
      if (phase === 'combined' || phase === 'index') fresh = store.ingestMessage(msg, mid, isFeedMessage);
      if (phase === 'combined' || phase === 'derive') {
        const t = transportRef();
        const ownAddr = t ? (await t.self()).address : msg.fromId === 1 ? msg.sender.address : undefined;
        deriveOnIngest(store, msg, mid, ownAddr);
      }
      const bf = backfillerRef();
      if (bf && (phase === 'combined' || phase === 'index') && fresh) enqueueDangling(store, bf, msg);
      const t = transportRef();
      if (bf && t && phase === 'combined') {
        const handled = await handleBackfillControlDm(
          store,
          bf,
          t,
          msg,
          isFeedMessage,
          Date.now(),
          serveGuard,
        ).catch(() => false);
        if (handled) void bf.flush();
      }
    };

  const serveGuardFor = () => {
    const seen = new Map<string, number[]>();
    return (peer: string): boolean => {
      const now = Date.now();
      const recent = (seen.get(peer) ?? []).filter((t) => t > now - 60_000);
      if (recent.length >= MAX_SERVE_RESPONSES_PER_MINUTE) return false;
      recent.push(now);
      seen.set(peer, recent);
      return true;
    };
  };

  const ctxFor = (t: Transport): AppContext => ({
    getTransport: () => t,
    signup: async () => {
      throw new Error('already configured');
    },
  });

  const waitFor = async (transport: Transport, pred: (m: T.Message) => boolean, ms = 180_000): Promise<T.Message> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = (await transport.timeline({ limit: 40 })).find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('timed out waiting for feed message');
  };

  it('backfills A\'s posts into C\'s thread view, suppressed from timeline + notifications', async () => {
    const A_DATA = 'data/int-tab-a';
    const B_DATA = 'data/int-tab-b';
    const C_DATA = 'data/int-tab-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));
    const cStore = createStore(join(C_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = { a: null, b: null, c: null };
    const bfRefs: { a: Backfiller | null; b: Backfiller | null; c: Backfiller | null } = { a: null, b: null, c: null };

    const a = await openRelayTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-tab-a' },
      { onMessage: wireIngest(aStore, () => refs.a, () => bfRefs.a, serveGuardFor()) },
    );
    const b = await openRelayTransport(
      B_DATA,
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-tab-b' },
      { onMessage: wireIngest(bStore, () => refs.b, () => bfRefs.b, serveGuardFor()) },
    );
    const c = await openRelayTransport(
      C_DATA,
      { addr: cCreds.addr, password: cCreds.password, displayName: 'int-tab-c' },
      { onMessage: wireIngest(cStore, () => refs.c, () => bfRefs.c, serveGuardFor()) },
    );
    refs.a = a;
    refs.b = b;
    refs.c = c;
    transports.push(a, b, c);

    // A backfiller per node whose `send` addresses the peer by its MESSAGE-DERIVED
    // contact id (the KEY-contact; main.ts wiring is identical). An addr lookup
    // would land on DC core's keyless address-contact row and fail to encrypt.
    const sendFor = (t: () => Transport | null): SendRequest =>
      async (_peer: string, peerContactId: number, reqRefs: EnvelopeRef[]) => {
        const transport = t();
        if (!transport) throw new Error('no transport');
        await transport.sendControlDm(peerContactId, buildEnvelopeRequest(reqRefs));
      };
    // No internal timer (tests drive flush explicitly) so enqueues don't
    // auto-flush mid-loop and hide queued refs behind the in-flight lock.
    const noTimer = { schedule: () => null, cancel: () => {} };
    bfRefs.a = createBackfiller({ store: aStore, send: sendFor(() => refs.a), ...noTimer });
    bfRefs.b = createBackfiller({ store: bStore, send: sendFor(() => refs.b), ...noTimer });
    bfRefs.c = createBackfiller({ store: cStore, send: sendFor(() => refs.c), ...noTimer });

    const aApp = createUnsafeTestApp(ctxFor(a), { baseUrl: 'http://localhost:4030', store: aStore });
    const bApp = createUnsafeTestApp(ctxFor(b), { baseUrl: 'http://localhost:4031', store: bStore });
    const cApp = createUnsafeTestApp(ctxFor(c), { baseUrl: 'http://localhost:4032', store: cStore });

    // --- A and B mutual-follow (invite links both ways) ---
    const aInvite = await a.feedInvite();
    const bJoinsA = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(aInvite);
    await bJoinsA;

    const bInvite = await b.feedInvite();
    const aJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await a.follow(bInvite);
    await aJoinsB;

    // --- C follows B only (C never meets A) ---
    const bInvite2 = await b.feedInvite();
    const cJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await c.follow(bInvite2);
    await cJoinsB;

    // --- Build an alternating thread A <- B <- A <- B (>=4 messages) ---
    const post = async (app: ReturnType<typeof createUnsafeTestApp>, status: string, inReplyToId?: string): Promise<string> => {
      const res = await app.request('/api/v1/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(inReplyToId ? { in_reply_to_id: inReplyToId } : {}) }),
      });
      expect(res.status).toBe(200);
      return String(((await res.json()) as any).id);
    };

    const stamp = Date.now();
    const aRootText = `A root ${stamp}`;
    const aRootId = await post(aApp, aRootText);
    const aRoot = (await a.message(Number(aRootId)))!;
    const aRootUuid = parseWireUuid(aRoot.text)!;
    expect(aRootUuid).not.toBeNull();

    // B replies to A's root (B holds A's root from A's feed).
    const aRootOnB = await waitFor(b, (m) => bodyOf(m) === aRootText);
    const b1Text = `B reply1 ${stamp}`;
    await post(bApp, b1Text, String(aRootOnB.id));

    // A replies to B's reply (A holds B's reply from B's feed).
    const b1OnA = await waitFor(a, (m) => bodyOf(m) === b1Text);
    const a2Text = `A reply2 ${stamp}`;
    const a2Id = await post(aApp, a2Text, String(b1OnA.id));
    const a2Uuid = parseWireUuid((await a.message(Number(a2Id)))!.text)!;
    expect(a2Uuid).not.toBeNull();

    // B replies again to A's second post.
    const a2OnB = await waitFor(b, (m) => bodyOf(m) === a2Text);
    const b2Text = `B reply2 ${stamp}`;
    await post(bApp, b2Text, String(a2OnB.id));

    // C, following only B, receives B's two replies on its feed (NOT A's posts).
    await waitFor(c, (m) => bodyOf(m) === b1Text);
    await waitFor(c, (m) => bodyOf(m) === b2Text);

    // Seed C's backfill queue from its already-held feed messages. In the live
    // daemon this is the startup re-index's 'index' pass running `enqueueDangling`
    // on every message; here we replay it explicitly over C's feed (the live
    // onMessage hook saw these before the backfiller existed). This is the
    // dangling-ref detection that queues A's uuids against B.
    await cApp.request('/api/v1/timelines/home');
    for (const m of await c.timeline({ limit: 40 })) enqueueDangling(cStore, bfRefs.c!, m);
    // C now has BOTH of A's posts (the parents of B's two replies) queued against
    // B — the load-bearing DETECTION half. reply1's ref/root name A's root;
    // reply2's ref names A's second post, its root names A's root.
    const cPending = bfRefs.c!.pendingFor(bCreds.addr);
    expect(cPending, "C queued A's dangling posts against B").toContain(aRootUuid);
    expect(cStore.resolveKey(aRootUuid), "C does not hold A's root locally").toBeNull();
    expect(bStore.resolveKey(aRootUuid), 'B holds A\'s root (it can serve)').not.toBeNull();

    // --- The request → serve → bundle → held round-trip, OVER THE REAL RELAY ---
    // C's flush sends the envelope-request DM to B addressed by B's MESSAGE-
    // DERIVED contact id (the key-contact; an addr lookup would land on DC core's
    // keyless address-contact row and fail with "e2e encryption unavailable" —
    // the bug this send path had originally). B's live ingest hook serves the
    // bundle back via the request DM's own `fromId`. Everything below rides real
    // SMTP/IMAP delivery — the test FAILS if delivery fails.
    const requestsSent = await bfRefs.c!.flush();
    expect(requestsSent, "C's request DM to B was actually sent").toBeGreaterThan(0);

    // Wait for B's bundle to arrive + be processed by C's live ingest hook. The
    // request may need retries (backoff-gated flush; e.g. the very first send
    // racing IMAP warm-up), so keep flushing while polling.
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (cStore.heldEnvelope(aRootUuid) !== null && cStore.heldEnvelope(a2Uuid) !== null) break;
      await bfRefs.c!.flush();
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(
      cStore.heldEnvelope(aRootUuid),
      "C holds A's root as a held envelope, delivered by B's bundle over the relay",
    ).not.toBeNull();
    expect(
      cStore.heldEnvelope(a2Uuid),
      "C holds A's mid-thread reply too (both of A's posts backfilled)",
    ).not.toBeNull();

    // --- ASSERT: C's context for the thread ROOT shows the complete thread ---
    const ctxRes = await cApp.request(`/api/v1/statuses/orig-${aRootUuid}/context`);
    expect(ctxRes.status).toBe(200);
    const ctx = (await ctxRes.json()) as any;
    const descContents: string[] = ctx.descendants.map((s: any) => s.content);
    // A's reply2 (backfilled) AND B's replies (local) are all present + threaded.
    expect(descContents.some((h) => h.includes(b1Text))).toBe(true);
    expect(descContents.some((h) => h.includes(b2Text))).toBe(true);
    expect(descContents.some((h) => h.includes(a2Text)), "A's backfilled reply is in C's thread").toBe(true);
    // A's backfilled statuses are attributed to A's addr + verified (orig ids).
    const aStatus = ctx.descendants.find((s: any) => s.content.includes(a2Text));
    expect(aStatus.account.acct).toBe(aCreds.addr);
    expect(String(aStatus.id).startsWith('orig-')).toBe(true);

    // --- ASSERT: C has NO new notifications from the backfill ---
    const notifs = (await (await cApp.request('/api/v1/notifications')).json()) as any[];
    expect(notifs.every((n) => n.type !== 'mention'), 'no backfill-induced notifications').toBe(true);

    // --- ASSERT: C's home timeline does NOT contain A's posts ---
    const home = (await (await cApp.request('/api/v1/timelines/home')).json()) as any[];
    for (const s of home) {
      expect(s.content.includes(aRootText)).toBe(false);
      expect(s.content.includes(a2Text)).toBe(false);
      expect(String(s.id).startsWith('orig-')).toBe(false);
    }
  }, 900_000);
});

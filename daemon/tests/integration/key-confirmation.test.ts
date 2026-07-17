import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { type DeltaChatTransport, type IngestPhase } from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { createUnsafeTestApp, type AppContext } from '../../src/server.js';
import { deriveOnIngest, runFollowbackOnIngest } from '../../src/ingest.js';
import { createBackfiller, type Backfiller, type SendRequest } from '../../src/backfill.js';
import { buildEnvelopeRequest, parseEnvelope, type EnvelopeRef } from '../../src/envelope.js';
import {
  enqueueDangling,
  handleBackfillControlDm,
  MAX_SERVE_RESPONSES_PER_MINUTE,
} from '../../src/backfill-ingest.js';
import { parseWire, parseWireUuid } from '../../src/wire.js';

const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Acceptance scenario from ../../meta/issues/key-confirmation.md: C holds A's
 * post ONLY via backfill (never met A, no pin) — it renders marked
 * `author_unconfirmed`, and the thread view triggers the background
 * confirmation: introduce via the held invite, envelope-request the post from
 * A directly, A serves their own signed copy, and the self-served-bundle rule
 * pins A on C. The next render drops the mark.
 */
describe('key confirmation over the relay', () => {
  const transports: DeltaChatTransport[] = [];
  afterAll(() => {
    for (const t of transports) t.close();
  });

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

  /** Full ingest wiring: index/derive + follow-back + backfill serve/receive. */
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
      await runFollowbackOnIngest(store, transportRef(), msg, isFeedMessage, phase, fresh);
      const bf = backfillerRef();
      if (bf && (phase === 'combined' || phase === 'index') && fresh) enqueueDangling(store, bf, msg);
      const t = transportRef();
      if (bf && t && phase === 'combined') {
        const handled = await handleBackfillControlDm(store, bf, t, msg, isFeedMessage, Date.now(), serveGuard).catch(() => false);
        if (handled) void bf.flush();
      }
    };

  it('a backfilled stranger post renders unconfirmed, then pins after the thread-view confirmation', async () => {
    const A_DATA = 'data/int-kc-a';
    const B_DATA = 'data/int-kc-b';
    const C_DATA = 'data/int-kc-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));
    const cStore = createStore(join(C_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = { a: null, b: null, c: null };
    const bfRefs: { a: Backfiller | null; b: Backfiller | null; c: Backfiller | null } = { a: null, b: null, c: null };

    const a = await openRelayTransport(A_DATA, { addr: aCreds.addr, password: aCreds.password, displayName: 'int-kc-a' }, { onMessage: wireIngest(aStore, () => refs.a, () => bfRefs.a, serveGuardFor()) });
    const b = await openRelayTransport(B_DATA, { addr: bCreds.addr, password: bCreds.password, displayName: 'int-kc-b' }, { onMessage: wireIngest(bStore, () => refs.b, () => bfRefs.b, serveGuardFor()) });
    const c = await openRelayTransport(C_DATA, { addr: cCreds.addr, password: cCreds.password, displayName: 'int-kc-c' }, { onMessage: wireIngest(cStore, () => refs.c, () => bfRefs.c, serveGuardFor()) });
    refs.a = a;
    refs.b = b;
    refs.c = c;
    transports.push(a, b, c);

    const sendFor = (t: () => Transport | null): SendRequest =>
      async (_peer: string, peerContactId: number, reqRefs: EnvelopeRef[]) => {
        const transport = t();
        if (!transport) throw new Error('no transport');
        await transport.sendControlDm(peerContactId, buildEnvelopeRequest(reqRefs));
      };
    const noTimer = { schedule: () => null, cancel: () => {} };
    bfRefs.a = createBackfiller({ store: aStore, send: sendFor(() => refs.a), ...noTimer });
    bfRefs.b = createBackfiller({ store: bStore, send: sendFor(() => refs.b), ...noTimer });
    bfRefs.c = createBackfiller({ store: cStore, send: sendFor(() => refs.c), ...noTimer });

    const ctxFor = (t: Transport): AppContext => ({
      getTransport: () => t,
      signup: async () => {
        throw new Error('already configured');
      },
    });
    const aApp = createUnsafeTestApp(ctxFor(a), { baseUrl: 'http://localhost:4030', store: aStore, dataDir: A_DATA });
    const bApp = createUnsafeTestApp(ctxFor(b), { baseUrl: 'http://localhost:4031', store: bStore, dataDir: B_DATA });
    const cApp = createUnsafeTestApp(ctxFor(c), { baseUrl: 'http://localhost:4032', store: cStore, dataDir: C_DATA });

    // A<->B mutual; C follows B only — C NEVER meets A.
    const bJoinsA = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(await a.feedInvite());
    await bJoinsA;
    const aJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await a.follow(await b.feedInvite());
    await aJoinsB;
    const cJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await c.follow(await b.feedInvite());
    await cJoinsB;

    const post = async (app: ReturnType<typeof createUnsafeTestApp>, status: string, inReplyToId?: string): Promise<string> => {
      const res = await app.request('/api/v1/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(inReplyToId ? { in_reply_to_id: inReplyToId } : {}) }),
      });
      expect(res.status).toBe(200);
      return String(((await res.json()) as any).id);
    };

    const waitFor = async (transport: Transport, pred: (m: T.Message) => boolean, ms = 180_000): Promise<T.Message> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = (await transport.timeline({ limit: 60 })).find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error('timed out waiting for feed message');
    };

    // A posts a root; B replies; C backfills A's root (held, not local).
    const stamp = Date.now();
    const rootText = `stranger root ${stamp}`;
    const aRootId = await post(aApp, rootText);
    const aRoot = (await a.message(Number(aRootId)))!;
    const rootUuid = parseWireUuid(aRoot.text)!;

    const rootOnB = await waitFor(b, (m) => bodyOf(m) === rootText);
    const replyText = `b reply ${stamp}`;
    await post(bApp, replyText, String(rootOnB.id));

    await waitFor(c, (m) => bodyOf(m) === replyText);
    for (const m of await c.timeline({ limit: 60 })) enqueueDangling(cStore, bfRefs.c!, m);
    let deadline = Date.now() + 240_000;
    while (Date.now() < deadline && cStore.heldEnvelope(rootUuid) === null) {
      await bfRefs.c!.flush();
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(cStore.heldEnvelope(rootUuid), "C backfilled A's root").not.toBeNull();
    expect(cStore.pinnedKey(aCreds.addr), 'C has no pin for A yet').toBeNull();

    // The thread view renders the held root MARKED and triggers the
    // background confirmation.
    const view = await cApp.request(`/api/v1/statuses/orig-${rootUuid}`);
    expect(view.status).toBe(200);
    expect(((await view.json()) as any).pleroma.headwater?.author_unconfirmed).toBe(true);

    // Confirmation completes: C introduces itself to A via the held invite,
    // requests the post, A serves its own signed copy → the self-served
    // bundle pins A on C.
    deadline = Date.now() + 300_000;
    while (Date.now() < deadline && cStore.pinnedKey(aCreds.addr) === null) {
      await new Promise((r) => setTimeout(r, 4000));
    }
    const heldPubkey = cStore.heldEnvelope(rootUuid)?.env.pubkey;
    expect(cStore.pinnedKey(aCreds.addr), "A's key pinned on C via confirmation").toBe(heldPubkey);

    // The next render drops the mark.
    const confirmed = (await (await cApp.request(`/api/v1/statuses/orig-${rootUuid}`)).json()) as any;
    expect(confirmed.pleroma.headwater?.author_unconfirmed).toBeUndefined();
  }, 1_800_000);
});

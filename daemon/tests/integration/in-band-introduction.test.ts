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
import {
  handleThreadChannelBundle,
  handleThreadInviteGrant,
  handleThreadInviteRequest,
  republishReplyToThread,
} from '../../src/thread-subscribe.js';
import { parseWire, parseWireUuid } from '../../src/wire.js';

/** The human body of a wire message. */
const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Acceptance scenario from ../../meta/issues/in-band-introduction.md:
 *
 *   A and B mutual-follow and thread; C follows B only and NEVER meets A — no
 *   pre-established key path of any kind. C backfills A's half via B; the held
 *   root envelope carries A's contact invite (stamped by A's send path). C's
 *   subscribe then INTRODUCES ITSELF in-band: securejoin on the held invite +
 *   the key-contact-for-A success criterion (= post-join addr check), then the
 *   scoped request → grant → channel. Additionally, C's deep reply root-copies
 *   to A — the cold-DM gap documented in wire-thread-root-ref heals.
 */
describe('in-band introduction: a total stranger subscribes and root-copies', () => {
  const transports: DeltaChatTransport[] = [];
  afterAll(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
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

  /** Full main.ts-style ingest wiring: index/derive + follow-back + backfill + thread-subscribe. */
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
        if (handled) {
          void bf.flush();
          return;
        }
        if (handleThreadChannelBundle(store, bf, msg, Date.now())) {
          void bf.flush();
          return;
        }
        if (await handleThreadInviteRequest(store, t, msg, isFeedMessage).catch(() => false)) return;
        if (await handleThreadInviteGrant(store, t, msg, isFeedMessage).catch(() => false)) return;
        if (fresh) await republishReplyToThread(store, t, msg, isFeedMessage).catch(() => undefined);
      }
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
      const found = (await transport.timeline({ limit: 60 })).find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('timed out waiting for feed message');
  };

  it('C (never met A) introduces itself via the held root invite and subscribes', async () => {
    const A_DATA = 'data/int-ibi-a';
    const B_DATA = 'data/int-ibi-b';
    const C_DATA = 'data/int-ibi-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));
    const cStore = createStore(join(C_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = { a: null, b: null, c: null };
    const bfRefs: { a: Backfiller | null; b: Backfiller | null; c: Backfiller | null } = { a: null, b: null, c: null };

    const a = await openRelayTransport(A_DATA, { addr: aCreds.addr, password: aCreds.password, displayName: 'int-ibi-a' }, { onMessage: wireIngest(aStore, () => refs.a, () => bfRefs.a, serveGuardFor()) });
    const b = await openRelayTransport(B_DATA, { addr: bCreds.addr, password: bCreds.password, displayName: 'int-ibi-b' }, { onMessage: wireIngest(bStore, () => refs.b, () => bfRefs.b, serveGuardFor()) });
    const c = await openRelayTransport(C_DATA, { addr: cCreds.addr, password: cCreds.password, displayName: 'int-ibi-c' }, { onMessage: wireIngest(cStore, () => refs.c, () => bfRefs.c, serveGuardFor()) });
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

    const aApp = createUnsafeTestApp(ctxFor(a), { baseUrl: 'http://localhost:4030', store: aStore });
    const bApp = createUnsafeTestApp(ctxFor(b), { baseUrl: 'http://localhost:4031', store: bStore });
    const cApp = createUnsafeTestApp(ctxFor(c), { baseUrl: 'http://localhost:4032', store: cStore });

    // --- A and B mutual-follow; C follows B ONLY. C never meets A: no follow,
    //     no reverse follow, no DM — nothing. ---
    const bJoinsA = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(await a.feedInvite());
    await bJoinsA;
    const aJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await a.follow(await b.feedInvite());
    await aJoinsB;
    const cJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await c.follow(await b.feedInvite());
    await cJoinsB;

    // --- Thread: A root <- B reply ---
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
    // A's send path stamped its contact invite (the introduction payload).
    expect(parseEnvelope(aRoot.text)?.invite, "A's root carries A's contact invite").toBeTruthy();

    const aRootOnB = await waitFor(b, (m) => bodyOf(m) === aRootText);
    const b1Text = `B reply1 ${stamp}`;
    await post(bApp, b1Text, String(aRootOnB.id));

    // --- C receives B's reply, backfills A's root via B (held, WITH invite) ---
    const b1OnC = await waitFor(c, (m) => bodyOf(m) === b1Text);
    await cApp.request('/api/v1/timelines/home');
    for (const m of await c.timeline({ limit: 60 })) enqueueDangling(cStore, bfRefs.c!, m);
    let deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (cStore.heldEnvelope(aRootUuid) !== null) break;
      await bfRefs.c!.flush();
      await new Promise((r) => setTimeout(r, 4000));
    }
    const heldRoot = cStore.heldEnvelope(aRootUuid);
    expect(heldRoot, "C backfilled A's root (held, not local)").not.toBeNull();
    expect(heldRoot!.env.invite, 'the held root still carries the in-band invite').toBeTruthy();

    // --- C SUBSCRIBES with NO pre-existing key path: the endpoint introduces
    //     C to A via the held invite (securejoin + addr check), then requests. ---
    const subRes = await cApp.request(`/api/v1/pleroma/statuses/orig-${aRootUuid}/subscribe`, { method: 'POST' });
    expect(subRes.status, 'stranger-subscribe succeeded via in-band introduction').toBe(200);

    deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (cStore.isSubscribedToThread(aRootUuid)) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(cStore.isSubscribedToThread(aRootUuid), "C joined A's thread channel").toBe(true);
    expect(aStore.hostedThreadChatId(aRootUuid), 'A hosts the thread channel').not.toBeNull();

    // --- C's deep reply now ROOT-COPIES to A (the healed cold-DM gap): A ends up
    //     holding C's reply even though C's feed never reaches A. ---
    const cReplyText = `C deep reply ${stamp}`;
    const cReplyId = await post(cApp, cReplyText, String(b1OnC.id));
    const cReplyUuid = parseWireUuid((await c.message(Number(cReplyId)))!.text)!;
    deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (aStore.resolveKey(cReplyUuid) !== null) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(aStore.resolveKey(cReplyUuid), "A received C's reply via the root DM copy").not.toBeNull();

    // --- A posts a new deep reply; the channel is C's ONLY path to it. ---
    const bReplyOnA = await waitFor(a, (m) => bodyOf(m) === b1Text);
    const a2Text = `A deepreply ${stamp}`;
    const a2Id = await post(aApp, a2Text, String(bReplyOnA.id));
    const a2Uuid = parseWireUuid((await a.message(Number(a2Id)))!.text)!;
    deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (cStore.heldEnvelope(a2Uuid) !== null) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(cStore.heldEnvelope(a2Uuid), "C received A's reply via the channel").not.toBeNull();
    expect(cStore.resolveKey(a2Uuid), 'only via channel — C still does not follow A').toBeNull();

    const ctx = (await (await cApp.request(`/api/v1/statuses/orig-${aRootUuid}/context`)).json()) as any;
    const descContents: string[] = ctx.descendants.map((s: any) => s.content);
    expect(descContents.some((h) => h.includes(a2Text)), "A's reply is in C's thread view").toBe(true);
  }, 1_800_000);
});

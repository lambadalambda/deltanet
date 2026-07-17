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
import { buildEnvelopeRequest, type EnvelopeRef } from '../../src/envelope.js';
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
 * Acceptance scenario from ../../meta/issues/thread-subscribe.md:
 *
 *   A and B mutual-follow and thread; C follows B only. C backfills the thread,
 *   then SUBSCRIBES via the root ref. C→A reachability is established HONESTLY:
 *   C briefly follows A's feed (securejoin), the substrate's only key-exchange
 *   path — after which C holds a KEY-contact for A and can DM the scoped
 *   invite-request. A (root, complete by construction) hosts a per-thread
 *   channel, auto-grants + sends the thread-so-far, and REPUBLISHES B's NEW deep
 *   reply into the channel. C's thread view gains it WITHOUT following anyone new.
 *   Unsubscribe stops further updates.
 */
describe('thread subscribe: C follows the thread via A\'s hosted channel', () => {
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
        // Thread subscribe: channel bundle (subscriber), invite request/grant, republication.
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

  it('C subscribes, gets thread-so-far, and receives B\'s new reply via A\'s channel', async () => {
    const A_DATA = 'data/int-ts-a';
    const B_DATA = 'data/int-ts-b';
    const C_DATA = 'data/int-ts-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));
    const cStore = createStore(join(C_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = { a: null, b: null, c: null };
    const bfRefs: { a: Backfiller | null; b: Backfiller | null; c: Backfiller | null } = { a: null, b: null, c: null };

    const a = await openRelayTransport(A_DATA, { addr: aCreds.addr, password: aCreds.password, displayName: 'int-ts-a' }, { onMessage: wireIngest(aStore, () => refs.a, () => bfRefs.a, serveGuardFor()) });
    const b = await openRelayTransport(B_DATA, { addr: bCreds.addr, password: bCreds.password, displayName: 'int-ts-b' }, { onMessage: wireIngest(bStore, () => refs.b, () => bfRefs.b, serveGuardFor()) });
    const c = await openRelayTransport(C_DATA, { addr: cCreds.addr, password: cCreds.password, displayName: 'int-ts-c' }, { onMessage: wireIngest(cStore, () => refs.c, () => bfRefs.c, serveGuardFor()) });
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

    // --- A and B mutual-follow ---
    const bJoinsA = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(await a.feedInvite());
    await bJoinsA;
    const aJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await a.follow(await b.feedInvite());
    await aJoinsB;

    // --- C follows B (holds B's half) ---
    const cJoinsB = b.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await c.follow(await b.feedInvite());
    await cJoinsB;

    // --- HONEST C→A reachability WITHOUT C following A's feed: A follows C's feed
    // (securejoin is the substrate's only key path). C is the inviter, so the
    // handshake gives C a KEY-contact for A — C can encrypt the scoped invite-
    // request — yet C is NOT a member of A's feed, so A's posts do NOT reach C
    // directly. This keeps the channel (not a feed follow) the ONLY delivery path
    // for A's future replies. No cold send, no faked reachability.
    const aJoinsC = c.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await a.follow(await c.feedInvite());
    await aJoinsC;

    // --- Build a thread: A root <- B reply <- A reply ---
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

    const aRootOnB = await waitFor(b, (m) => bodyOf(m) === aRootText);
    const b1Text = `B reply1 ${stamp}`;
    await post(bApp, b1Text, String(aRootOnB.id));

    const b1OnA = await waitFor(a, (m) => bodyOf(m) === b1Text);
    const a2Text = `A reply2 ${stamp}`;
    await post(aApp, a2Text, String(b1OnA.id));

    // C (following B) receives B's reply on its feed.
    await waitFor(c, (m) => bodyOf(m) === b1Text);

    // C backfills A's half via B (the existing auto-backfill machinery): C follows
    // only B, holds B's reply dangling at A's root, and heals it by asking B. C
    // does NOT follow A's feed, so A's root arrives as a HELD envelope, not local.
    await cApp.request('/api/v1/timelines/home');
    for (const m of await c.timeline({ limit: 60 })) enqueueDangling(cStore, bfRefs.c!, m);
    let deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (cStore.heldEnvelope(aRootUuid) !== null) break;
      await bfRefs.c!.flush();
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(cStore.heldEnvelope(aRootUuid), 'C backfilled A\'s root (held, not local)').not.toBeNull();

    // --- C SUBSCRIBES to the thread via the root ref (orig-<rootUuid>) ---
    const subRes = await cApp.request(`/api/v1/pleroma/statuses/orig-${aRootUuid}/subscribe`, { method: 'POST' });
    expect(subRes.status, 'C could reach A honestly and subscribed').toBe(200);
    expect(cStore.hasPendingThreadRequest(aRootUuid)).toBe(true);

    // A receives the scoped invite-request, hosts the channel, grants + sends the
    // thread-so-far; C joins the channel (its ingest handles the grant).
    deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (cStore.isSubscribedToThread(aRootUuid)) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(cStore.isSubscribedToThread(aRootUuid), 'C joined A\'s thread channel').toBe(true);
    expect(aStore.hostedThreadChatId(aRootUuid), 'A hosts the thread channel').not.toBeNull();

    // --- A (the HOST) posts a NEW deep reply. A republishes it into the channel.
    //     C does NOT follow A's feed, so the ONLY path A's reply can reach C is the
    //     thread channel — the load-bearing property. ---
    const a3Text = `A deepreply ${stamp}`;
    const a3Id = await post(aApp, a3Text, String(b1OnA.id));
    const a3Uuid = parseWireUuid((await a.message(Number(a3Id)))!.text)!;

    deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (cStore.heldEnvelope(a3Uuid) !== null) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(
      cStore.heldEnvelope(a3Uuid),
      "C received A's new deep reply via A's thread channel (C does NOT follow A)",
    ).not.toBeNull();
    expect(cStore.resolveKey(a3Uuid), 'C does not hold A\'s reply locally (only via channel)').toBeNull();

    // C's thread context now contains A's new reply.
    const ctx = (await (await cApp.request(`/api/v1/statuses/orig-${aRootUuid}/context`)).json()) as any;
    const descContents: string[] = ctx.descendants.map((s: any) => s.content);
    expect(descContents.some((h) => h.includes(a3Text)), "A's new reply is in C's thread view").toBe(true);

    // The thread ROOT status is flagged subscribed.
    const rootStatus = (await (await cApp.request(`/api/v1/statuses/orig-${aRootUuid}`)).json()) as any;
    expect(rootStatus.pleroma.headwater.thread_subscribed).toBe(true);

    // --- Suppression: the channel-republished reply is NOT in C's home timeline
    //     and produced no mention notification. ---
    const home = (await (await cApp.request('/api/v1/timelines/home')).json()) as any[];
    expect(home.some((s) => s.content.includes(a3Text))).toBe(false);
    const notifs = (await (await cApp.request('/api/v1/notifications')).json()) as any[];
    expect(notifs.every((n) => n.type !== 'mention')).toBe(true);

    // --- Unsubscribe stops further updates ---
    const unsubRes = await cApp.request(`/api/v1/pleroma/statuses/orig-${aRootUuid}/subscribe`, { method: 'DELETE' });
    expect(unsubRes.status).toBe(200);
    expect(cStore.isSubscribedToThread(aRootUuid)).toBe(false);
    // A posts ANOTHER deep reply; C (now unsubscribed + not following A) must NOT
    // receive it via the (now-left) channel.
    const a4Text = `A afterunsub ${stamp}`;
    const a4Id = await post(aApp, a4Text, String(b1OnA.id));
    const a4Uuid = parseWireUuid((await a.message(Number(a4Id)))!.text)!;
    await new Promise((r) => setTimeout(r, 30_000));
    expect(cStore.heldEnvelope(a4Uuid), 'no updates after unsubscribe').toBeNull();
  }, 1_800_000);
});

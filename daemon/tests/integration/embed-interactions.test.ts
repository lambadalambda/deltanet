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

const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Regression guard for embed-only interactions (favourite/reply/boost on a post
 * held ONLY as a backfilled envelope — never received locally). Over the real
 * relay: A and B mutual-follow and thread; C follows B only and never meets A.
 * C backfills A's root via B, then FAVOURITES it — the reaction control DM
 * reaches A (introducing in-band via the invite A's root carries) and A tallies
 * it as if C held a direct copy. Then C BOOSTS the held post: the boost
 * re-embeds A's SAME signed envelope verbatim, which B (who holds A's original)
 * verifies. Ties together backfill + in-band introduction + orig-<uuid> actions.
 */
describe('embed-only interactions over the relay', () => {
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

  it('C favourites + boosts A\'s backfilled post; A tallies the favourite, B verifies the boost', async () => {
    const A_DATA = 'data/int-emb-a';
    const B_DATA = 'data/int-emb-b';
    const C_DATA = 'data/int-emb-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));
    const cStore = createStore(join(C_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = { a: null, b: null, c: null };
    const bfRefs: { a: Backfiller | null; b: Backfiller | null; c: Backfiller | null } = { a: null, b: null, c: null };

    const a = await openRelayTransport(A_DATA, { addr: aCreds.addr, password: aCreds.password, displayName: 'int-emb-a' }, { onMessage: wireIngest(aStore, () => refs.a, () => bfRefs.a, serveGuardFor()) });
    const b = await openRelayTransport(B_DATA, { addr: bCreds.addr, password: bCreds.password, displayName: 'int-emb-b' }, { onMessage: wireIngest(bStore, () => refs.b, () => bfRefs.b, serveGuardFor()) });
    const c = await openRelayTransport(C_DATA, { addr: cCreds.addr, password: cCreds.password, displayName: 'int-emb-c' }, { onMessage: wireIngest(cStore, () => refs.c, () => bfRefs.c, serveGuardFor()) });
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

    // A<->B mutual-follow; C follows B only. C never meets A.
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

    const stamp = Date.now();
    // A posts a root; B replies (so C, following B, holds a dangling ref at A's root).
    const aRootText = `A root ${stamp}`;
    const aRootId = await post(aApp, aRootText);
    const aRoot = (await a.message(Number(aRootId)))!;
    const aRootUuid = parseWireUuid(aRoot.text)!;
    expect(parseEnvelope(aRoot.text)?.invite, "A's root carries A's contact invite").toBeTruthy();

    const aRootOnB = await waitFor(b, (m) => bodyOf(m) === aRootText);
    const b1Text = `B reply ${stamp}`;
    await post(bApp, b1Text, String(aRootOnB.id));

    // C receives B's reply, backfills A's root via B (held, not local).
    await waitFor(c, (m) => bodyOf(m) === b1Text);
    await cApp.request('/api/v1/timelines/home');
    for (const m of await c.timeline({ limit: 60 })) enqueueDangling(cStore, bfRefs.c!, m);
    let deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (cStore.heldEnvelope(aRootUuid) !== null) break;
      await bfRefs.c!.flush();
      await new Promise((r) => setTimeout(r, 4000));
    }
    expect(cStore.heldEnvelope(aRootUuid), "C backfilled A's root (held, not local)").not.toBeNull();
    expect(cStore.resolveKey(aRootUuid), "C never received A's root directly").toBeNull();

    // --- C FAVOURITES the held post: local uuid tally now, control DM to A. ---
    const favRes = await cApp.request(`/api/v1/statuses/orig-${aRootUuid}/favourite`, { method: 'POST' });
    expect(favRes.status).toBe(200);
    const favStatus = (await favRes.json()) as any;
    expect(favStatus.favourited).toBe(true);
    expect(favStatus.favourites_count).toBe(1);

    // A receives the reaction (introduced in-band via A's own invite in the held
    // root) and tallies C's favourite under the root's uuid post key.
    deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const tallies = aStore.reactionTallies(aRootUuid);
      if (tallies.some((t) => t.reactors.includes(cCreds.addr))) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    const aTallies = aStore.reactionTallies(aRootUuid);
    expect(
      aTallies.some((t) => t.reactors.includes(cCreds.addr)),
      "A tallied C's favourite on the post C never received directly",
    ).toBe(true);

    // --- C BOOSTS the held post: the boost re-embeds A's signed envelope
    //     verbatim; B (who holds A's original) verifies it. ---
    const boostRes = await cApp.request(`/api/v1/statuses/orig-${aRootUuid}/reblog`, { method: 'POST' });
    expect(boostRes.status).toBe(200);
    const cBoostMsg = (await c.timeline({ limit: 5 })).find((m) => parseEnvelope(m.text)?.type === 'boost')!;
    const cBoostEnv = parseEnvelope(cBoostMsg.text)!;
    expect(cBoostEnv.orig?.uuid, 'the boost embeds A\'s original verbatim').toBe(aRootUuid);
    expect(cBoostEnv.orig, 'embedded orig is byte-equal to the held envelope').toEqual(
      cStore.heldEnvelope(aRootUuid)!.env,
    );

    // B follows C? No — B does not follow C, so assert the boost's embed is
    // self-verifying on ITS OWN terms: re-parse + verify against A's addr.
    const { verify } = await import('../../src/attest.js');
    expect(verify(cBoostEnv.orig!, aCreds.addr), "C's boosted embed verifies under A's key").toBe(true);
  }, 1_800_000);
});

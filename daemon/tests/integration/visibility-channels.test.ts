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
import { parseWire } from '../../src/wire.js';

const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Acceptance scenario from ../../meta/issues/visibility-channels.md (part 1):
 * A owns a public feed + a locked channel. B and C follow the public feed;
 * B requests locked access via the scoped invite-request, A approves through
 * the follow_requests API (the grant DMs the locked invite; B's follow-back
 * machinery joins it). A posts one public + one followers-only post: B sees
 * BOTH, C sees ONLY the public one.
 */
describe('visibility channels over the relay', () => {
  const transports: DeltaChatTransport[] = [];
  afterAll(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
  });

  /** index + derive + follow-back (the parts this flow needs). */
  const wireIngest = (store: Store, transportRef: () => Transport | null) =>
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

  const until = async <V>(fn: () => Promise<V | null | undefined | false>, what: string, ms = 180_000): Promise<V> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it('locked follower sees both tiers; public-only follower sees only public', async () => {
    const A_DATA = 'data/int-vis-a';
    const B_DATA = 'data/int-vis-b';
    const C_DATA = 'data/int-vis-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);
    const aStore = createStore(join(A_DATA, 'deltanet-store.json'));
    const bStore = createStore(join(B_DATA, 'deltanet-store.json'));
    const cStore = createStore(join(C_DATA, 'deltanet-store.json'));

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = { a: null, b: null, c: null };
    const a = await openRelayTransport(A_DATA, { addr: aCreds.addr, password: aCreds.password, displayName: 'int-vis-a' }, { onMessage: wireIngest(aStore, () => refs.a) });
    const b = await openRelayTransport(B_DATA, { addr: bCreds.addr, password: bCreds.password, displayName: 'int-vis-b' }, { onMessage: wireIngest(bStore, () => refs.b) });
    const c = await openRelayTransport(C_DATA, { addr: cCreds.addr, password: cCreds.password, displayName: 'int-vis-c' }, { onMessage: wireIngest(cStore, () => refs.c) });
    refs.a = a;
    refs.b = b;
    refs.c = c;
    transports.push(a, b, c);

    const ctxFor = (t: Transport): AppContext => ({
      getTransport: () => t,
      signup: async () => {
        throw new Error('already configured');
      },
    });
    const aApp = createUnsafeTestApp(ctxFor(a), { baseUrl: 'http://localhost:4030', store: aStore, dataDir: A_DATA });
    const bApp = createUnsafeTestApp(ctxFor(b), { baseUrl: 'http://localhost:4031', store: bStore, dataDir: B_DATA });

    // B and C follow A's PUBLIC feed.
    const bJoins = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(await a.feedInvite());
    await bJoins;
    const cJoins = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await c.follow(await a.feedInvite());
    await cJoins;

    // B requests locked access via the API (A = B's followed feed owner).
    const aOnB = (await b.following())[0]!;
    const reqRes = await bApp.request(`/api/deltanet/contacts/${aOnB.contactId}/request-locked`, { method: 'POST' });
    expect(reqRes.status).toBe(200);

    // A's daemon queues the request (follow_request notification + queue).
    const pending = await until(
      async () => aStore.lockedFollowRequests().find((r) => r.addr === bCreds.addr),
      "A's locked follow-request queue entry",
    );
    expect(aStore.listNotifications({ limit: 5 })[0]).toMatchObject({ type: 'follow_request', accountAddr: bCreds.addr });

    // A approves through the follow_requests API; B's follow-back machinery
    // joins the locked channel from the granted invite.
    const bJoinsLocked = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    const authRes = await aApp.request(`/api/v1/follow_requests/${pending.contactId}/authorize`, { method: 'POST' });
    expect(authRes.status).toBe(200);
    expect(aStore.lockedFollowRequests()).toEqual([]);
    await bJoinsLocked;

    // A posts one public + one followers-only post.
    const stamp = Date.now();
    const pubText = `public tier ${stamp}`;
    const lockedText = `locked tier ${stamp}`;
    const post = async (body: Record<string, unknown>) => {
      const res = await aApp.request('/api/v1/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as any;
    };
    const pubStatus = await post({ status: pubText });
    const lockedStatus = await post({ status: lockedText, visibility: 'private' });
    expect(pubStatus.visibility).toBe('public');
    expect(lockedStatus.visibility).toBe('private');

    // B (locked follower) sees BOTH tiers.
    await waitFor(b, (m) => bodyOf(m) === pubText);
    await waitFor(b, (m) => bodyOf(m) === lockedText);

    // C (public-only) sees the public post — and never the locked one.
    await waitFor(c, (m) => bodyOf(m) === pubText);
    // Generous settle window: if the locked post were mis-addressed to the
    // public feed it would arrive alongside/before the public post.
    await new Promise((r) => setTimeout(r, 10_000));
    const cTexts = (await c.timeline({ limit: 60 })).map(bodyOf);
    expect(cTexts).toContain(pubText);
    expect(cTexts, 'the locked post never reaches a public-only follower').not.toContain(lockedText);

    // A's own aggregates span both channels.
    const stats = await a.stats();
    expect(stats.followers).toBe(2); // B + C, deduped across channels
    expect(stats.statuses).toBeGreaterThanOrEqual(2);

    // --- Leak prevention (part 2), on the LOCKED FOLLOWER's node (B) ---
    const lockedOnB = await waitFor(b, (m) => bodyOf(m) === lockedText);
    // The wire marker traveled: B renders the received post as private.
    const bView = (await (await bApp.request(`/api/v1/statuses/${lockedOnB.id}`)).json()) as any;
    expect(bView.visibility, 'B renders the received locked post private').toBe('private');
    // B's daemon refuses to boost it.
    const boostRes = await bApp.request(`/api/v1/statuses/${lockedOnB.id}/reblog`, { method: 'POST' });
    expect(boostRes.status, 'boosting a received followers-only post is refused').toBe(422);
    // B's reply inherits privacy even when requested public: it lands in B's
    // OWN locked channel and carries the marker — so C (who follows B
    // publicly) never receives it.
    const replyRes = await bApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: `b locked reply ${stamp}`, in_reply_to_id: String(lockedOnB.id), visibility: 'public' }),
    });
    expect(replyRes.status).toBe(200);
    expect(((await replyRes.json()) as any).visibility, "B's reply inherited private").toBe('private');
    await new Promise((r) => setTimeout(r, 10_000));
    const cTexts2 = (await c.timeline({ limit: 60 })).map(bodyOf);
    expect(cTexts2, "B's inherited-locked reply never reaches C").not.toContain(`b locked reply ${stamp}`);
  }, 1_800_000);
});

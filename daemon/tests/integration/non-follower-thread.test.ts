import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import {
  type DeltaChatTransport,
  type IngestPhase,
} from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { createApp, type AppContext } from '../../src/server.js';
import { deriveOnIngest } from '../../src/ingest.js';
import { parseWire, parseWireUuid } from '../../src/wire.js';

/** The human body of a wire message (v2 envelope `text`, or legacy body). */
const bodyOf = (m: T.Message): string => parseWire(m.text).body;

/**
 * Acceptance topology from ../meta/issues/non-follower-thread-rendering.md, over
 * real chatmail (local podman relay by default,
 * nine.testrun.org with DELTANET_TEST_RELAY=testrun):
 *
 *   B follows A; A does NOT follow B. A posts; B replies; A reacts ❤ to B's
 *   reply AND replies to it — but A only ever holds the DM copy of B's reply
 *   (A isn't a follower of B).
 *
 * On A's node: the thread of A's original shows B's reply (rendered from the DM
 * copy) and the full chain (A's reply-to-reply too); A's own ❤ shows on B's
 * reply. Then we simulate the v1->v2 migration on A — delete ONLY the test's
 * own store file, reopen, wait for the backfill re-index — and re-assert all of
 * the above, own reaction included.
 *
 * On B's (follower) node the same thread shows exactly ONE copy of each reply
 * (no double-count regression).
 *
 * Fresh accounts + own data/int-nf-* dirs; never touches live daemon data.
 */
describe('non-follower thread rendering + own-reaction re-index over chatmail', () => {
  const transports: DeltaChatTransport[] = [];
  const BASE = 'http://localhost:4030';

  afterAll(() => {
    for (const transport of transports) transport.close();
  });

  /** main.ts-style ingest wiring: index (capturing freshness), then derive with ownAddr. */
  const wireIngest =
    (store: Store, transport: () => Transport | null) =>
    async (msg: T.Message, isFeedMessage: boolean, mid: string | null, phase: IngestPhase): Promise<void> => {
      if (!mid) return;
      if (phase === 'combined' || phase === 'index') store.ingestMessage(msg, mid, isFeedMessage);
      if (phase === 'combined' || phase === 'derive') {
        const t = transport();
        const ownAddr = t ? (await t.self()).address : msg.fromId === 1 ? msg.sender.address : undefined;
        deriveOnIngest(store, msg, mid, ownAddr);
      }
    };

  const ctxFor = (t: Transport): AppContext => ({
    getTransport: () => t,
    signup: async () => {
      throw new Error('already configured');
    },
  });

  const waitFor = async (
    transport: Transport,
    pred: (m: T.Message) => boolean,
    ms = 180_000,
  ): Promise<T.Message> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const tl = await transport.timeline({ limit: 30 });
      const found = tl.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('timed out waiting for feed message');
  };

  /**
   * Locate the DM copy of a reply on the recipient: parsed body starts with
   * text AND carries a logical-post uuid (a wire v2 reply envelope — byte-
   * identical to the feed copy). Excludes feed copies by id.
   */
  const findCanonicalDm = async (t: Transport, text: string): Promise<T.Message | null> => {
    const feedIds = new Set((await t.timeline({ limit: 40 })).map((m) => m.id));
    for (let id = 1; id < 400; id++) {
      if (feedIds.has(id)) continue;
      const msg = await t.message(id).catch(() => null);
      if (msg && bodyOf(msg).startsWith(text) && parseWireUuid(msg.text) !== null) return msg;
    }
    return null;
  };

  it('renders a DM-only reply in A\'s thread, shows A\'s own reaction, and survives a re-index', async () => {
    const A_DATA = 'data/int-nf-a';
    const B_DATA = 'data/int-nf-b';
    const A_STORE = join(A_DATA, 'deltanet-store.json');
    const B_STORE = join(B_DATA, 'deltanet-store.json');
    rmSync(A_DATA, { recursive: true, force: true });
    rmSync(B_DATA, { recursive: true, force: true });

    const [aCreds, bCreds] = await Promise.all([register(), register()]);

    let aStore = createStore(A_STORE);
    const bStore = createStore(B_STORE);

    const refs: { a: Transport | null; b: Transport | null } = { a: null, b: null };
    const a = await openRelayTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-nf-a' },
      { onMessage: wireIngest(aStore, () => refs.a) },
    );
    const b = await openRelayTransport(
      B_DATA,
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-nf-b' },
      { onMessage: wireIngest(bStore, () => refs.b) },
    );
    refs.a = a;
    refs.b = b;
    transports.push(a, b);

    let aApp = createApp(ctxFor(a), { baseUrl: BASE, store: aStore });
    const bApp = createApp(ctxFor(b), { baseUrl: BASE, store: bStore });

    await a.feedInvite();
    await b.feedInvite();

    // --- B follows A (A does NOT follow back) ---
    const aInvite = await a.feedInvite();
    const bJoinsA = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(aInvite);
    await bJoinsA;

    // --- A posts; B (a follower) receives it on its feed ---
    const postText = `A original ${Date.now()}`;
    const aPost = await a.post(postText);
    const aPostId = aPost.id; // A's own feed copy of the original
    const aPostOnB = await waitFor(b, (m) => bodyOf(m) === postText);

    // --- B replies to A's post (feed copy + DM copy to A) ---
    const bReplyText = `B reply ${Date.now()}`;
    const bReplyRes = await bApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: bReplyText, in_reply_to_id: String(aPostOnB.id) }),
    });
    expect(bReplyRes.status).toBe(200);
    const bFeedReplyId = Number(((await bReplyRes.json()) as any).id);

    // --- A receives B's reply ONLY as a DM copy (A doesn't follow B) ---
    const waitDm = async (): Promise<T.Message> => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const found = await findCanonicalDm(a, bReplyText);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error('timed out waiting for DM copy on A');
    };
    const dmOnA = await waitDm();
    // The DM copy is a wire v2 reply envelope (no marker glyphs) carrying a uuid.
    expect(dmOnA.text).not.toContain('⚑');
    expect(parseWireUuid(dmOnA.text)).not.toBeNull();

    // --- A reacts ❤ to B's reply AND replies to it (acting on the DM copy) ---
    const aFavRes = await aApp.request(`/api/v1/statuses/${dmOnA.id}/favourite`, { method: 'POST' });
    expect(aFavRes.status).toBe(200);

    const aReplyText = `A reply-to-reply ${Date.now()}`;
    const aReplyRes = await aApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: aReplyText, in_reply_to_id: String(dmOnA.id) }),
    });
    expect(aReplyRes.status).toBe(200);
    const aReplyId = Number(((await aReplyRes.json()) as any).id);

    // ---- Assertions on A's node (live, before migration) ----
    // A's thread of its own original shows B's reply (from the DM copy) as a
    // descendant, and A's reply-to-reply as a grandchild.
    const assertAThread = async (label: string): Promise<void> => {
      // Warm A's ingest by reading its timeline + context.
      await a.timeline({ limit: 30 });
      const context = (await (await aApp.request(`/api/v1/statuses/${aPostId}/context`)).json()) as any;
      const descIds = context.descendants.map((s: any) => Number(s.id));
      // B's reply renders from its DM copy, and A's reply-to-reply is in the chain.
      expect(descIds, `${label}: descendants include B's reply DM copy`).toContain(dmOnA.id);
      expect(descIds, `${label}: descendants include A's reply-to-reply`).toContain(aReplyId);

      // A's own ❤ shows on B's reply (the DM copy A holds).
      const dmStatus = (await (await aApp.request(`/api/v1/statuses/${dmOnA.id}`)).json()) as any;
      expect(dmStatus.favourites_count, `${label}: own favourite on B's reply`).toBe(1);
      expect(dmStatus.favourited, `${label}: favourited flag set`).toBe(true);
      // And B's reply shows A's reply-to-reply as its own child.
      expect(dmStatus.replies_count, `${label}: B's reply has 1 child`).toBe(1);
    };

    // Poll until A's DM ingest has caught up (the reply/react DMs are async).
    {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await a.timeline({ limit: 30 });
        const dmStatus = (await (await aApp.request(`/api/v1/statuses/${dmOnA.id}`)).json()) as any;
        if (dmStatus.favourites_count >= 1 && dmStatus.replies_count >= 1) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    await assertAThread('live');

    // ---- Simulate the v1->v2 migration on A: fresh store, re-index ----
    // Close A's transport, delete ONLY the test's own store file, reopen: the
    // startup backfill re-indexes every message (reply edges from the DM copy,
    // own reaction from the SELF react control DM) with no data surgery.
    a.close();
    transports.splice(transports.indexOf(a), 1);
    expect(existsSync(A_STORE)).toBe(true);
    rmSync(A_STORE, { force: true }); // the test's own store dir only

    aStore = createStore(A_STORE);
    const refs2: { a: Transport | null } = { a: null };
    const a2 = await openRelayTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-nf-a' },
      { onMessage: wireIngest(aStore, () => refs2.a) },
    );
    refs2.a = a2;
    transports.push(a2);
    aApp = createApp(ctxFor(a2), { baseUrl: BASE, store: aStore });

    // Wait for the backfill re-index to rebuild edges + own reaction.
    {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await a2.timeline({ limit: 30 });
        const dmStatus = (await (await aApp.request(`/api/v1/statuses/${dmOnA.id}`)).json()) as any;
        if (dmStatus.favourites_count >= 1 && dmStatus.replies_count >= 1) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    // Re-point the closures: assertAThread uses `a`/`aApp` from the outer scope,
    // which now reference a2/its app (aApp reassigned). Re-run with the new a2.
    await (async () => {
      await a2.timeline({ limit: 30 });
      const context = (await (await aApp.request(`/api/v1/statuses/${aPostId}/context`)).json()) as any;
      const descIds = context.descendants.map((s: any) => Number(s.id));
      expect(descIds, 'post-migration: descendants include B\'s reply DM copy').toContain(dmOnA.id);
      expect(descIds, 'post-migration: descendants include A\'s reply-to-reply').toContain(aReplyId);
      const dmStatus = (await (await aApp.request(`/api/v1/statuses/${dmOnA.id}`)).json()) as any;
      expect(dmStatus.favourites_count, 'post-migration: own favourite recovered').toBe(1);
      expect(dmStatus.favourited, 'post-migration: favourited flag recovered').toBe(true);
      expect(dmStatus.replies_count, 'post-migration: B\'s reply still has 1 child').toBe(1);
    })();

    // ---- Follower-side no-double-count on B ----
    // B holds BOTH the feed copy and (as author) sent the DM copy of its reply,
    // plus A's reaction/reply-to-reply DMs reference B's feed reply mid. B's
    // feed reply must show exactly ONE reply (A's reply-to-reply) and ONE
    // favourite (A's ❤) — never doubled.
    {
      const deadline = Date.now() + 180_000;
      let bStatus: any;
      while (Date.now() < deadline) {
        await b.timeline({ limit: 30 });
        await bApp.request(`/api/v1/statuses/${aPostOnB.id}/context`);
        bStatus = (await (await bApp.request(`/api/v1/statuses/${bFeedReplyId}`)).json()) as any;
        if (bStatus.replies_count >= 1 && bStatus.favourites_count >= 1) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
      expect(bStatus.replies_count, 'B: exactly one reply-to-reply (no double count)').toBe(1);
      expect(bStatus.favourites_count, 'B: exactly one favourite (no double count)').toBe(1);
    }
  }, 900_000);
});

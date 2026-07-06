import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { registerAccount } from '../../src/signup.js';
import {
  openTransport,
  type DeltaChatTransport,
  type IngestPhase,
} from '../../src/transport/deltachat.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { createApp, type AppContext } from '../../src/server.js';
import { deriveOnIngest } from '../../src/ingest.js';

/**
 * Acceptance topology from ../meta/issues/post-uuids.md, over real chatmail
 * (nine.testrun.org). This is the exact third-party case mid-based refs CANNOT
 * solve, and the reason for author-minted logical-post UUIDs (wire convention
 * v1):
 *
 *   C follows A AND B; B follows A; A does NOT follow B.
 *   A posts. B replies (feed broadcast copy + DM copy to A, ONE shared uuid).
 *   A replies to B's reply — but A holds ONLY B's DM copy (A isn't a follower of
 *   B), so A's reply refs B's reply by its UUID.
 *
 * On C's node (which holds only the FEED copies — A's post, B's feed reply, A's
 * feed reply-to-reply): the full thread renders connected. A's reply-to-reply
 * resolves to B's FEED reply via the shared uuid, even though A minted the ref
 * while holding a different (DM) copy of B's reply. Under mid-based refs A's
 * reply would have referenced B's DM mid, which C never receives — an
 * unresolvable orphan.
 *
 * Fresh accounts + own data/int-uuid-* dirs; never touches live daemon data.
 */
describe('post-uuid third-party thread resolution over chatmail', () => {
  const transports: DeltaChatTransport[] = [];

  afterAll(() => {
    for (const transport of transports) transport.close();
  });

  /** main.ts-style ingest wiring: index (per-message feed/DM classification), then derive with ownAddr. */
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
      const tl = await transport.timeline({ limit: 40 });
      const found = tl.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('timed out waiting for feed message');
  };

  /**
   * Locate the DM copy of a reply on a recipient who is NOT a follower of the
   * replier: the message whose body starts with `text` and lands in a 1:1 chat
   * (not any feed timeline). Under v1 the DM copy carries a `⚑` uuid marker (and
   * NO `⚓` — the shared uuid subsumes it). Probes a small id window.
   */
  const findDmCopy = async (t: Transport, text: string): Promise<T.Message | null> => {
    const feedIds = new Set((await t.timeline({ limit: 40 })).map((m) => m.id));
    for (let id = 1; id < 400; id++) {
      if (feedIds.has(id)) continue;
      const msg = await t.message(id).catch(() => null);
      if (msg && msg.text.startsWith(text) && msg.text.includes('⚑')) return msg;
    }
    return null;
  };

  it('renders the full A->B->A thread on third-party C, connected via uuid refs', async () => {
    const A_DATA = 'data/int-uuid-a';
    const B_DATA = 'data/int-uuid-b';
    const C_DATA = 'data/int-uuid-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const relay = 'https://nine.testrun.org';
    const [aCreds, bCreds, cCreds] = await Promise.all([
      registerAccount(relay),
      registerAccount(relay),
      registerAccount(relay),
    ]);

    const scratchStore = (): Store =>
      createStore(join(mkdtempSync(join(tmpdir(), 'deltanet-uuid-')), 'store.json'));
    const aStore = scratchStore();
    const bStore = scratchStore();
    const cStore = scratchStore();

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = {
      a: null,
      b: null,
      c: null,
    };
    const a = await openTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-uuid-a' },
      { onMessage: wireIngest(aStore, () => refs.a) },
    );
    const b = await openTransport(
      B_DATA,
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-uuid-b' },
      { onMessage: wireIngest(bStore, () => refs.b) },
    );
    const c = await openTransport(
      C_DATA,
      { addr: cCreds.addr, password: cCreds.password, displayName: 'int-uuid-c' },
      { onMessage: wireIngest(cStore, () => refs.c) },
    );
    refs.a = a;
    refs.b = b;
    refs.c = c;
    transports.push(a, b, c);

    const aApp = createApp(ctxFor(a), { baseUrl: 'http://localhost:4030', store: aStore });
    const bApp = createApp(ctxFor(b), { baseUrl: 'http://localhost:4030', store: bStore });
    const cApp = createApp(ctxFor(c), { baseUrl: 'http://localhost:4030', store: cStore });

    // Ensure all feeds exist.
    await Promise.all([a.feedInvite(), b.feedInvite(), c.feedInvite()]);

    // --- Build the follow graph: C follows A and B; B follows A. A follows no one. ---
    const followFeed = async (inviter: DeltaChatTransport, joiner: Transport): Promise<void> => {
      const invite = await inviter.feedInvite();
      const joined = inviter.waitForEvent(
        'SecurejoinInviterProgress',
        120_000,
        (e: { progress: number }) => e.progress === 1000,
      );
      await joiner.follow(invite);
      await joined;
    };
    await followFeed(a, b); // B follows A
    await followFeed(a, c); // C follows A
    await followFeed(b, c); // C follows B

    // --- A posts to A's feed; B and C (both followers) receive it ---
    const postText = `A original ${Date.now()}`;
    const aPostRes = await aApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: postText }),
    });
    expect(aPostRes.status).toBe(200);

    // A plain v1 post carries a trailing `⚑ <uuid>` marker, so match on the body
    // prefix rather than exact equality.
    const aPostOnB = await waitFor(b, (m) => m.text.startsWith(postText));
    const aPostOnC = await waitFor(c, (m) => m.text.startsWith(postText));

    // --- B replies to A's post (feed copy to C, DM copy to A) ---
    const bReplyText = `B reply ${Date.now()}`;
    const bReplyRes = await bApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: bReplyText, in_reply_to_id: String(aPostOnB.id) }),
    });
    expect(bReplyRes.status).toBe(200);

    // C receives B's reply on C's feed of B.
    const bReplyOnC = await waitFor(c, (m) => m.text.startsWith(bReplyText));

    // A receives B's reply ONLY as a DM copy (A doesn't follow B). It carries a
    // `⚑` uuid — the SAME uuid B's feed copy carries.
    const waitDm = async (): Promise<T.Message> => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await a.timeline({ limit: 40 });
        const found = await findDmCopy(a, bReplyText);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error('timed out waiting for DM copy on A');
    };
    const dmOnA = await waitDm();
    expect(dmOnA.text).toContain('⚑');

    // --- A replies to B's reply (acting on the DM copy A holds) ---
    // A's reply refs B's reply by its UUID, so it resolves on any node holding
    // ANY copy of B's reply — including C, which only has B's FEED copy.
    const aReplyText = `A reply-to-reply ${Date.now()}`;
    const aReplyRes = await aApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: aReplyText, in_reply_to_id: String(dmOnA.id) }),
    });
    expect(aReplyRes.status).toBe(200);

    // A is a follower target of C, so A's reply-to-reply reaches C on C's feed of A.
    const aReplyOnC = await waitFor(c, (m) => m.text.startsWith(aReplyText));

    // ---- The full thread renders connected on C (feed copies only) ----
    // C holds: A's post, B's feed reply, A's feed reply-to-reply. Assert:
    //  1. A's post's context descendants include BOTH B's reply and A's reply.
    //  2. A's reply-to-reply resolves in_reply_to to B's FEED reply (uuid-linked),
    //     NOT to some DM copy C never received.
    const assertCThread = async (): Promise<void> => {
      await c.timeline({ limit: 40 });
      // Warm C's ingest of the reply chain by fetching contexts.
      await cApp.request(`/api/v1/statuses/${aPostOnC.id}/context`);
      await cApp.request(`/api/v1/statuses/${bReplyOnC.id}/context`);

      const rootContext = (await (
        await cApp.request(`/api/v1/statuses/${aPostOnC.id}/context`)
      ).json()) as any;
      const descIds = rootContext.descendants.map((s: any) => Number(s.id));
      expect(descIds, 'C: A-post thread includes B\'s feed reply').toContain(bReplyOnC.id);
      expect(descIds, 'C: A-post thread includes A\'s reply-to-reply').toContain(aReplyOnC.id);

      // A's reply-to-reply is in_reply_to B's FEED reply, resolved via uuid.
      const aReplyStatus = (await (
        await cApp.request(`/api/v1/statuses/${aReplyOnC.id}`)
      ).json()) as any;
      expect(aReplyStatus.in_reply_to_id, 'C: A\'s reply links to B\'s FEED reply via uuid').toBe(
        String(bReplyOnC.id),
      );

      // B's feed reply shows exactly ONE child (A's reply-to-reply), and is a
      // child of A's original.
      const bReplyStatus = (await (
        await cApp.request(`/api/v1/statuses/${bReplyOnC.id}`)
      ).json()) as any;
      expect(bReplyStatus.in_reply_to_id, 'C: B\'s reply links to A\'s post').toBe(String(aPostOnC.id));
      expect(bReplyStatus.replies_count, 'C: B\'s reply has exactly one child').toBe(1);
    };

    // Poll until C's ingest of the reply chain has caught up.
    {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await c.timeline({ limit: 40 });
        await cApp.request(`/api/v1/statuses/${bReplyOnC.id}/context`);
        const st = (await (await cApp.request(`/api/v1/statuses/${bReplyOnC.id}`)).json()) as any;
        if (st.replies_count >= 1 && st.in_reply_to_id === String(aPostOnC.id)) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    await assertCThread();
  }, 900_000);
});

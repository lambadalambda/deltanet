import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * QA scenario from ../meta/issues/canonical-mid-unification.md acceptance
 * criteria, over real chatmail (local podman relay by default,
 * nine.testrun.org with DELTANET_TEST_RELAY=testrun):
 *
 *   B follows A (A does NOT follow back). A posts; B replies; A reacts ❤ and
 *   replies to B's reply — but A only ever holds the DM copy of B's reply (A
 *   isn't a follower of B, so B's feed copy never reaches A).
 *
 * On B's node we then assert on the FEED copy of B's reply: replies_count 1,
 * the reaction visible, and that A's original-post thread chains through feed
 * copies (never Single-chat copies).
 *
 * Fresh accounts + own data/int-canon-* dirs; never touches live daemon data.
 */
describe('canonical-mid unification over chatmail', () => {
  const transports: DeltaChatTransport[] = [];
  const BASE = 'http://localhost:4030';

  afterAll(() => {
    for (const transport of transports) transport.close();
  });

  const scratchStore = (): Store =>
    createStore(join(mkdtempSync(join(tmpdir(), 'deltanet-canon-')), 'store.json'));

  /** main.ts-style ingest wiring: index (capturing freshness), then derive. */
  const wireIngest =
    (store: Store, transport: () => Transport | null) =>
    async (msg: T.Message, isFeedMessage: boolean, mid: string | null, phase: IngestPhase): Promise<void> => {
      if (!mid) return;
      if (phase === 'combined' || phase === 'index') store.ingestMessage(msg, mid, isFeedMessage);
      if (phase === 'combined' || phase === 'derive') {
        // Own address for SELF reaction re-derivation (mirrors main.ts): prefer
        // the live transport's self address, fall back to a SELF message's own
        // sender during backfill (before the transport ref is available).
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

  it('routes a non-follower parent\'s interactions onto B\'s feed copies', async () => {
    rmSync('data/int-canon-a', { recursive: true, force: true });
    rmSync('data/int-canon-b', { recursive: true, force: true });

    const [aCreds, bCreds] = await Promise.all([register(), register()]);

    const aStore = scratchStore();
    const bStore = scratchStore();

    const refs: { a: Transport | null; b: Transport | null } = { a: null, b: null };
    const a = await openRelayTransport(
      'data/int-canon-a',
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-canon-a' },
      { onMessage: wireIngest(aStore, () => refs.a) },
    );
    const b = await openRelayTransport(
      'data/int-canon-b',
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-canon-b' },
      { onMessage: wireIngest(bStore, () => refs.b) },
    );
    refs.a = a;
    refs.b = b;
    transports.push(a, b);

    const aApp = createApp(ctxFor(a), { baseUrl: BASE, store: aStore });
    const bApp = createApp(ctxFor(b), { baseUrl: BASE, store: bStore });

    // Ensure both feeds exist.
    await a.feedInvite();
    await b.feedInvite();

    // --- B follows A (A does NOT follow back) ---
    const aInvite = await a.feedInvite();
    const bJoinsA = a.waitForEvent('SecurejoinInviterProgress', 120_000, (e) => e.progress === 1000);
    await b.follow(aInvite);
    await bJoinsA;

    // --- A posts to A's feed; B (a follower) receives it ---
    const postText = `A original ${Date.now()}`;
    await a.post(postText);

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
      throw new Error('timed out waiting for message');
    };

    const aPostOnB = await waitFor(b, (m) => bodyOf(m) === postText);

    // --- B replies to A's post (via B's app: feed copy + DM copy to A) ---
    const bReplyText = `B reply ${Date.now()}`;
    const bReplyRes = await bApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: bReplyText, in_reply_to_id: String(aPostOnB.id) }),
    });
    expect(bReplyRes.status).toBe(200);
    const bReplyStatus = (await bReplyRes.json()) as any;
    const bFeedReplyId = Number(bReplyStatus.id); // B's own feed copy of the reply

    // --- A receives B's reply ONLY as a DM copy (A doesn't follow B) ---
    // Under wire v2 the DM copy is a JSON reply envelope (byte-identical to B's
    // feed copy, same uuid); no marker glyphs.
    const waitDm = async (): Promise<T.Message> => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        // B's reply reaches A only as a DM copy (A isn't a follower of B). It
        // lands in a 1:1 chat, not any feed timeline, so probe A's message-id
        // window for the reply envelope carrying a uuid.
        const found = await findCanonicalDm(a, bReplyText);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error('timed out waiting for DM copy on A');
    };
    const dmOnA = await waitDm();
    // Sanity: A's copy is a v2 reply envelope (no marker glyphs) carrying a uuid.
    expect(dmOnA.text).not.toContain('⚑');
    expect(dmOnA.text).not.toContain('⚓');
    expect(parseWireUuid(dmOnA.text)).not.toBeNull();

    // --- A reacts ❤ to B's reply (acting on the DM copy) ---
    const aFavRes = await aApp.request(`/api/v1/statuses/${dmOnA.id}/favourite`, { method: 'POST' });
    expect(aFavRes.status).toBe(200);

    // --- A replies to B's reply (acting on the DM copy) ---
    const aReplyText = `A reply-to-reply ${Date.now()}`;
    const aReplyRes = await aApp.request('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: aReplyText, in_reply_to_id: String(dmOnA.id) }),
    });
    expect(aReplyRes.status).toBe(200);

    // --- On B's node, wait for A's reaction + reply DM copies to arrive ---
    // B receives A's reaction control-DM and A's reply DM copy (both reference
    // B's feed reply mid via canonicalization / the `⚓` marker).
    const bFeedReplyStatus = async (): Promise<any> =>
      (await (await bApp.request(`/api/v1/statuses/${bFeedReplyId}`)).json()) as any;

    // Poll B's feed reply status until it shows the reaction + reply count.
    let bStatus: any;
    {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        // Warm B's ingest by reading its timeline/context (drives loadMessages).
        await b.timeline({ limit: 30 });
        await bApp.request(`/api/v1/statuses/${aPostOnB.id}/context`);
        bStatus = await bFeedReplyStatus();
        if (bStatus.replies_count >= 1 && bStatus.favourites_count >= 1) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }

    // The reaction and reply landed on B's FEED copy, not a DM twin.
    expect(bStatus.favourites_count).toBe(1);
    expect(bStatus.replies_count).toBe(1);

    // --- Thread of A's original post chains through feed copies ---
    const context = (await (
      await bApp.request(`/api/v1/statuses/${aPostOnB.id}/context`)
    ).json()) as any;
    // Descendants include B's feed reply.
    expect(context.descendants.map((s: any) => String(s.id))).toContain(String(bFeedReplyId));

    // Context of B's feed reply: its ancestor is A's original (a feed message),
    // and its conversation_id is a feed chat's, not a Single-chat's.
    const bReplyContext = (await (
      await bApp.request(`/api/v1/statuses/${bFeedReplyId}/context`)
    ).json()) as any;
    expect(bReplyContext.ancestors.map((s: any) => String(s.id))).toContain(String(aPostOnB.id));

    // No ancestor/descendant routes through a Single (DM) chat: every status in
    // the thread carries a conversation_id belonging to a feed chat (the same
    // chat B's own feed messages use). We assert the ancestor (A's original) and
    // the reply share feed-chat conversation ids (both are broadcast/group).
    const feedConversationIds = new Set(
      (await b.timeline({ limit: 30 })).map((m) => m.chatId),
    );
    for (const s of [...bReplyContext.ancestors, bStatus]) {
      expect(feedConversationIds.has(s.pleroma.conversation_id)).toBe(true);
    }
  }, 600_000);
});

/**
 * Locate the DM copy of a reply on the recipient: the message whose parsed body
 * starts with `text` AND carries a logical-post uuid (a v2 reply envelope; the
 * feed copy never reaches a non-follower). Excludes feed copies by id, then
 * probes a window of message ids via `message()` — per-account ids are small and
 * sequential, so this reliably finds a freshly-delivered DM without needing
 * chat-listing plumbing on the narrow `Transport` interface.
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

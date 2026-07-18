import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { T } from '@deltachat/jsonrpc-client';
import { type DeltaChatTransport, type IngestPhase } from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';
import type { Transport } from '../../src/transport/types.js';
import { createStore, type Store } from '../../src/store.js';
import { createUnsafeTestApp, type AppContext } from '../../src/server.js';
import { deriveOnIngest } from '../../src/ingest.js';
import { parseWire } from '../../src/wire.js';

/**
 * Post-attestations acceptance topology (../../../meta/issues/post-attestations.md):
 *
 *   B follows A; C follows only B (C has NEVER met A).
 *   A posts WITH AN IMAGE (signed envelope: media.sha256 covered by the sig).
 *   B boosts A's post: B's daemon embeds A's complete signed envelope as `orig`
 *     AND re-attaches the SAME image file to the boost message.
 *   C receives only B's boost. C verifies A's embedded envelope offline (sig +
 *     media content-hash) and renders the boost carrying A's TEXT, A's ADDRESS,
 *     and the IMAGE — even though C never received anything from A directly.
 *
 * This is decision 0002's "republished content is verifiable or a placeholder"
 * made real across a third-party hop with media. Fresh accounts + own
 * data/int-attest-* dirs; never touches live daemon data.
 */
describe('post-attestations: verified boost embed with media across a third-party hop', () => {
  const transports: DeltaChatTransport[] = [];
  afterAll(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
  });

  /** main.ts-style ingest wiring: index (feed/DM classification), then derive with ownAddr. */
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

  const bodyOf = (m: T.Message): string => parseWire(m.text).body;

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

  const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

  it('C renders B\'s boost with A\'s text, addr, and the verified image', async () => {
    const A_DATA = 'data/int-attest-a';
    const B_DATA = 'data/int-attest-b';
    const C_DATA = 'data/int-attest-c';
    for (const d of [A_DATA, B_DATA, C_DATA]) rmSync(d, { recursive: true, force: true });

    const [aCreds, bCreds, cCreds] = await Promise.all([register(), register(), register()]);

    const scratchStore = (): Store =>
      createStore(join(mkdtempSync(join(tmpdir(), 'deltanet-attest-')), 'store.json'));
    const aStore = scratchStore();
    const bStore = scratchStore();
    const cStore = scratchStore();

    const refs: { a: Transport | null; b: Transport | null; c: Transport | null } = { a: null, b: null, c: null };
    const a = await openRelayTransport(
      A_DATA,
      { addr: aCreds.addr, password: aCreds.password, displayName: 'int-attest-a' },
      { onMessage: wireIngest(aStore, () => refs.a) },
    );
    const b = await openRelayTransport(
      B_DATA,
      { addr: bCreds.addr, password: bCreds.password, displayName: 'int-attest-b' },
      { onMessage: wireIngest(bStore, () => refs.b) },
    );
    const c = await openRelayTransport(
      C_DATA,
      { addr: cCreds.addr, password: cCreds.password, displayName: 'int-attest-c' },
      { onMessage: wireIngest(cStore, () => refs.c) },
    );
    refs.a = a;
    refs.b = b;
    refs.c = c;
    transports.push(a, b, c);

    // Each app persists its signing key under its own scratch data dir.
    const aApp = createUnsafeTestApp(ctxFor(a), {
      baseUrl: 'http://localhost:4030',
      store: aStore,
      dataDir: mkdtempSync(join(tmpdir(), 'attest-a-data-')),
    });
    const bApp = createUnsafeTestApp(ctxFor(b), {
      baseUrl: 'http://localhost:4030',
      store: bStore,
      dataDir: mkdtempSync(join(tmpdir(), 'attest-b-data-')),
    });
    const cApp = createUnsafeTestApp(ctxFor(c), {
      baseUrl: 'http://localhost:4030',
      store: cStore,
      dataDir: mkdtempSync(join(tmpdir(), 'attest-c-data-')),
    });

    await Promise.all([a.feedInvite(), b.feedInvite(), c.feedInvite()]);

    // Follow graph: B follows A; C follows B. C does NOT follow A.
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
    await followFeed(b, c); // C follows B

    // --- A uploads an image and posts it (signed envelope carries media.sha256). ---
    // A small but non-trivial PNG-ish payload; content is opaque to the daemon,
    // it just needs bytes to hash.
    const imageBytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => (i * 7 + 13) % 251));
    const imageHash = sha256(imageBytes);

    const uploadForm = new FormData();
    uploadForm.append('file', new File([imageBytes], 'pic.png', { type: 'image/png' }));
    uploadForm.append('description', 'a generated pattern');
    const uploadRes = await aApp.request('/api/v1/media', { method: 'POST', body: uploadForm });
    expect(uploadRes.status).toBe(200);
    const media = (await uploadRes.json()) as any;

    const postText = `A image post ${Date.now()}`;
    const postForm = new FormData();
    postForm.append('status', postText);
    postForm.append('media_ids[]', media.id);
    const aPostRes = await aApp.request('/api/v1/statuses', { method: 'POST', body: postForm });
    expect(aPostRes.status).toBe(200);

    // The emitted envelope is signed and declares the media content hash.
    const aPostStatus = (await aPostRes.json()) as any;
    const aPostMsg = await a.message(Number(aPostStatus.id));
    const aEnv = parseWire(aPostMsg!.text);
    expect(aEnv.body).toBe(postText);
    // sanity: the raw envelope carries a signed media.sha256 equal to the image hash
    const rawEnv = JSON.parse(aPostMsg!.text);
    expect(rawEnv.media.sha256).toBe(imageHash);
    expect(typeof rawEnv.sig).toBe('string');

    // --- B receives A's post on B's feed of A. ---
    const aPostOnB = await waitFor(b, (m) => bodyOf(m).startsWith(postText));

    // --- B boosts A's post: embeds A's signed orig + re-attaches the image. ---
    const bReblogRes = await bApp.request(`/api/v1/statuses/${aPostOnB.id}/reblog`, { method: 'POST' });
    expect(bReblogRes.status).toBe(200);

    // The boost B emitted carries `orig` (A's verbatim signed envelope) and a file.
    const bBoostMsg = await waitFor(b, (m) => {
      const raw = (() => {
        try {
          return JSON.parse(m.text);
        } catch {
          return null;
        }
      })();
      return raw?.type === 'boost' && !!raw.orig;
    });
    const bBoostRaw = JSON.parse(bBoostMsg.text);
    expect(bBoostRaw.orig.media.sha256).toBe(imageHash);

    // --- C receives ONLY B's boost (C never met A). ---
    const cBoostMsg = await waitFor(c, (m) => {
      try {
        return JSON.parse(m.text)?.type === 'boost';
      } catch {
        return false;
      }
    });

    // --- C renders the boost as a VERIFIED embed. Poll until C has ingested it. ---
    let cStatus: any;
    {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await c.timeline({ limit: 40 });
        const res = await cApp.request(`/api/v1/statuses/${cBoostMsg.id}`);
        cStatus = await res.json();
        if (cStatus.reblog) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }

    // Verified embed: A's text, attributed to A's ADDRESS, no placeholder flag.
    expect(cStatus.reblog, 'C renders a verified reblog embed').not.toBeNull();
    expect(cStatus.reblog.content).toContain(postText);
    expect(cStatus.reblog.account.acct).toBe(aCreds.addr);
    expect(cStatus.pleroma.headwater, 'no placeholder on a verified embed').toBeUndefined();

    // The image rides on the embed; the media url points at C's boost blob route.
    expect(cStatus.reblog.media_attachments).toHaveLength(1);
    const mediaUrl: string = cStatus.reblog.media_attachments[0].url;
    expect(mediaUrl).toContain(`/headwater/blob/${cBoostMsg.id}`);

    // Fetch the rendered blob from C's own route and hash it: it must equal the
    // ORIGINAL image A signed — verifiable media across the boost hop.
    const blobRes = await cApp.request(`/deltanet/blob/${cBoostMsg.id}`);
    expect(blobRes.status).toBe(200);
    const servedBytes = new Uint8Array(await blobRes.arrayBuffer());
    expect(sha256(servedBytes)).toBe(imageHash);
  }, 900_000);
});

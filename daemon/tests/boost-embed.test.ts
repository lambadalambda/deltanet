import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { T } from '@deltachat/jsonrpc-client';
import { createStore, type Store } from '../src/store.js';
import { createStatusMapper } from '../src/mapping.js';
import { openAttestor, sha256Bytes } from '../src/attest.js';
import {
  buildPostObject,
  buildBoostObject,
  serializeEnvelope,
  type Envelope,
} from '../src/envelope.js';
import type { Transport } from '../src/transport/types.js';
import { makeMessage, makeContact } from './entities.test.js';

const BASE = 'http://localhost:4030';
const ALICE = 'alice@relay.example';
const BOB = 'bob@relay.example';
const CAROL = 'carol@relay.example';
const ORIG_UUID = 'aaaa1111-2222-4333-8444-555555555555';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boost-embed-'));
  store = createStore(join(dir, 'store.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Alice's attestor (a scratch key per test). */
const aliceAttestor = () => openAttestor(join(dir, 'alice-key.json'));

/** A signed post envelope object authored by Alice (optionally with media). */
const alicePost = (text: string, media?: { description?: string | null; sha256?: string }): Envelope => {
  const a = aliceAttestor();
  const env = buildPostObject(text, ORIG_UUID, media);
  const sig = a.sign(env, ALICE);
  return { ...env, ...sig };
};

/**
 * Bob's boost message embedding `orig`. `file` (+ its bytes) models the
 * re-attached media the booster physically carries on the boost message.
 */
const boostMsg = (
  orig: Envelope | undefined,
  opts: { id?: number; file?: string; fileBytes?: Uint8Array } = {},
): T.Message => {
  const boostEnv = buildBoostObject('boost-uuid', { u: ORIG_UUID, addr: ALICE }, orig);
  // Bob signs the boost (irrelevant to the embed verification, but realistic).
  const bobA = openAttestor(join(dir, 'bob-key.json'));
  const signed = { ...boostEnv, ...bobA.sign(boostEnv, BOB) };
  return makeMessage({
    id: opts.id ?? 50,
    fromId: 22,
    text: serializeEnvelope(signed),
    sender: makeContact({ id: 22, address: BOB, displayName: 'bob' }),
    file: opts.file ?? null,
    fileMime: opts.file ? 'image/png' : null,
  });
};

/** A fake transport whose blobPath returns the boost message's own file. */
const fakeTransport = (self = CAROL): Transport =>
  ({
    self: async () => ({ address: self, id: 1, displayName: 'carol' }) as any,
    message: async () => null,
    blobPath: async (msgId: number) => blobs.get(msgId) ?? null,
    contact: async () => null,
  }) as unknown as Transport;

const blobs = new Map<number, string>();

describe('boost embed rendering ladder', () => {
  it('verified embed: renders the orig as an attributed status (addr shell, nested orig-<uuid> id)', async () => {
    const orig = alicePost('hello from alice');
    const msg = boostMsg(orig, { id: 51 });
    const mapper = createStatusMapper(store, BASE);
    const status = await mapper.toStatus(fakeTransport(), msg);

    // The booster's own status wraps the verified embed as `reblog`.
    expect(status.reblog).not.toBeNull();
    expect(status.reblog!.content).toBe('<p>hello from alice</p>');
    // Attributed to Alice's ADDRESS via the addr-based account shell.
    expect(status.reblog!.account.acct).toBe(ALICE);
    expect(status.reblog!.account.username).toBe('alice');
    // Synthetic-free nested id: orig-<uuid>, a string the frontend tolerates.
    expect(status.reblog!.id).toBe(`orig-${ORIG_UUID}`);
    // No placeholder flag when verified.
    expect((status.pleroma as any).deltanet).toBeUndefined();
    // created_at from the author-declared orig.ts.
    expect(status.reblog!.created_at).toBe(new Date(orig.ts!).toISOString());
  });

  it('verified embed with media: attaches the boost message file, alt text from orig', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const filePath = join(dir, 'img.png');
    writeFileSync(filePath, bytes);
    const orig = alicePost('a photo', { description: 'sunset', sha256: sha256Bytes(bytes) });
    const msg = boostMsg(orig, { id: 52, file: filePath });
    blobs.set(52, filePath);

    const status = await createStatusMapper(store, BASE).toStatus(fakeTransport(), msg);
    expect(status.reblog).not.toBeNull();
    expect(status.reblog!.media_attachments).toHaveLength(1);
    expect((status.reblog!.media_attachments[0] as any).description).toBe('sunset');
    // The blob url points at the BOOST message's own id (bytes live there).
    expect((status.reblog!.media_attachments[0] as any).url).toContain('/deltanet/blob/52');
  });

  it('placeholder "boost" when there is no embedded orig (ref-only/legacy)', async () => {
    const msg = boostMsg(undefined, { id: 53 });
    const status = await createStatusMapper(store, BASE).toStatus(fakeTransport(), msg);
    expect(status.reblog).toBeNull();
    expect(status.content).toBe('<p>[boosted post unavailable]</p>');
    expect((status.pleroma as any).deltanet.placeholder).toBe('boost');
  });

  describe('tamper matrix -> placeholder "boost-unverified"', () => {
    const expectUnverified = async (msg: T.Message) => {
      const status = await createStatusMapper(store, BASE).toStatus(fakeTransport(), msg);
      expect(status.reblog, 'no attributed content on failed verification').toBeNull();
      expect((status.pleroma as any).deltanet.placeholder).toBe('boost-unverified');
    };

    it('altered text after signing', async () => {
      const orig = { ...alicePost('authentic'), text: 'tampered' };
      await expectUnverified(boostMsg(orig, { id: 54 }));
    });

    it('wrong pubkey (a key that did not sign)', async () => {
      const other = openAttestor(join(dir, 'other-key.json'));
      const orig = { ...alicePost('hi'), pubkey: other.publicKeyBase64() };
      await expectUnverified(boostMsg(orig, { id: 55 }));
    });

    it('pin conflict: a pinned key disagrees with the embed pubkey', async () => {
      // Carol has previously pinned a DIFFERENT key for Alice (a direct sighting).
      store.pinKey(ALICE, openAttestor(join(dir, 'pinned-key.json')).publicKeyBase64());
      const orig = alicePost('hi'); // validly signed by alice's real key
      await expectUnverified(boostMsg(orig, { id: 56 }));
    });

    it('media hash mismatch: declared sha256 does not match the attached bytes', async () => {
      const declared = sha256Bytes(new Uint8Array([1, 1, 1]));
      const orig = alicePost('a photo', { description: 'x', sha256: declared });
      const wrongBytes = new Uint8Array([2, 2, 2]);
      const filePath = join(dir, 'wrong.png');
      writeFileSync(filePath, wrongBytes);
      const msg = boostMsg(orig, { id: 57, file: filePath });
      blobs.set(57, filePath);
      await expectUnverified(msg);
    });

    it('declared media but no attached file on the boost', async () => {
      const orig = alicePost('a photo', { description: 'x', sha256: 'abc' });
      await expectUnverified(boostMsg(orig, { id: 58 })); // no file
    });
  });

  it('pin-consistent (same key pinned) verified embed still renders', async () => {
    const orig = alicePost('hi');
    store.pinKey(ALICE, orig.pubkey!); // pinned the SAME key
    const status = await createStatusMapper(store, BASE).toStatus(fakeTransport(), boostMsg(orig, { id: 59 }));
    expect(status.reblog).not.toBeNull();
    expect(status.reblog!.content).toBe('<p>hi</p>');
  });
});

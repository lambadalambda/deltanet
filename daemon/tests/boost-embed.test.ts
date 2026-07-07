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
 * A signed reply envelope authored by Alice carrying a thread-root ref (dn3):
 * the embed case where tampering with `root` must break verification.
 */
const aliceReply = (text: string, root: { u: string; addr: string }): Envelope => {
  const a = aliceAttestor();
  const env: Envelope = {
    dn: 2,
    type: 'reply',
    uuid: ORIG_UUID,
    text,
    ref: { u: 'parent-uuid', addr: BOB },
    root,
  };
  return { ...env, ...a.sign(env, ALICE) };
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
    contactIdByAddr: async () => null,
    contact: async () => null,
  }) as unknown as Transport;

/**
 * A fake transport that DOES hold a DC contact row for the embed author
 * (`addr`): `contactIdByAddr` resolves it and `contact` returns the real
 * profile, modelling "the recipient has met the author" (issue: verified embed
 * should attribute via the real contact, not the addr shell).
 */
const fakeTransportWithContact = (addr: string, contact: T.Contact, self = CAROL): Transport =>
  ({
    self: async () => ({ address: self, id: 1, displayName: 'carol' }) as any,
    message: async () => null,
    blobPath: async (msgId: number) => blobs.get(msgId) ?? null,
    contactIdByAddr: async (a: string) => (a === addr ? contact.id : null),
    contact: async (id: number) => (id === contact.id ? contact : null),
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

  it('verified embed with a KNOWN contact: attributes via the real contact (name/avatar/id), nested identity unchanged', async () => {
    const orig = alicePost('hello from alice');
    const msg = boostMsg(orig, { id: 60 });
    // The recipient (carol) holds a real DC contact row for the author (alice):
    // she has met her before, so name/avatar should come from that contact.
    const aliceContact = makeContact({
      id: 77,
      address: ALICE,
      displayName: 'Alice Sparkle',
      status: 'author bio',
    });
    const mapper = createStatusMapper(store, BASE);
    const status = await mapper.toStatus(fakeTransportWithContact(ALICE, aliceContact), msg);

    expect(status.reblog).not.toBeNull();
    expect(status.reblog!.content).toBe('<p>hello from alice</p>');
    // Account object enriches from the real contact: display name, contact id,
    // and the contact-keyed avatar route (NOT the id-`0` `?`-avatar shell).
    expect(status.reblog!.account.id).toBe('77');
    expect(status.reblog!.account.display_name).toBe('Alice Sparkle');
    expect(status.reblog!.account.avatar).toContain('/deltanet/avatar/77');
    expect(status.reblog!.account.acct).toBe(ALICE);
    // Nested status identity is UNCHANGED: orig-<uuid> id, orig.ts created_at,
    // zero counts (we still don't hold the post, only the author's profile).
    expect(status.reblog!.id).toBe(`orig-${ORIG_UUID}`);
    expect(status.reblog!.created_at).toBe(new Date(orig.ts!).toISOString());
    expect(status.reblog!.replies_count).toBe(0);
    expect(status.reblog!.reblogs_count).toBe(0);
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

    it('altered thread-root after signing (dn3 signs the root token)', async () => {
      const orig = aliceReply('deep reply', { u: 'root-uuid', addr: ALICE });
      // Verifies as-is (sanity), then tamper the root -> unverified placeholder.
      const tampered = { ...orig, root: { u: 'forged-root', addr: 'mallory@relay.example' } };
      await expectUnverified(boostMsg(tampered, { id: 61 }));
    });

    it('grafted EMPTY root on a root-less signed orig (nested envelope bypasses parser sanitization)', async () => {
      // The trivial graft: `{u:'', addr:''}` frames identically (`0:0:`) to an
      // absent root, and a nested `orig` never passes through parseEnvelope's
      // tolerant-drop — verify()'s own shape gate must fail this closed before
      // `.root` on verified relayed envelopes becomes load-bearing (backfill).
      const orig = alicePost('authentic, no root');
      const grafted = { ...orig, root: { u: '', addr: '' } as any };
      await expectUnverified(boostMsg(grafted, { id: 63 }));
    });
  });

  it('embeds + verifies a signed reply carrying a thread-root (dn3 round-trip through the ladder)', async () => {
    const orig = aliceReply('deep reply', { u: 'root-uuid', addr: ALICE });
    const status = await createStatusMapper(store, BASE).toStatus(fakeTransport(), boostMsg(orig, { id: 62 }));
    expect(status.reblog).not.toBeNull();
    expect(status.reblog!.content).toBe('<p>deep reply</p>');
  });

  it('pin-consistent (same key pinned) verified embed still renders', async () => {
    const orig = alicePost('hi');
    store.pinKey(ALICE, orig.pubkey!); // pinned the SAME key
    const status = await createStatusMapper(store, BASE).toStatus(fakeTransport(), boostMsg(orig, { id: 59 }));
    expect(status.reblog).not.toBeNull();
    expect(status.reblog!.content).toBe('<p>hi</p>');
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalPayload,
  fieldsFromEnvelope,
  sha256Bytes,
  sha256File,
  openAttestor,
  verify,
  CANONICAL_PAYLOAD_VERSION,
  type CanonicalFields,
} from '../src/attest.js';
import type { Envelope } from '../src/envelope.js';

const ADDR = 'alice@relay.example';
const UUID = '11111111-2222-4333-8444-555555555555';

const fields = (over: Partial<CanonicalFields> = {}): CanonicalFields => ({
  type: 'post',
  uuid: UUID,
  addr: ADDR,
  ts: 1700000000000,
  text: 'hello',
  refToken: '',
  rootToken: '',
  rootAddr: '',
  mediaSha256: '',
  ...over,
});

/** The expected length-prefixed encoding of one field: `<utf8ByteLength>:<part>`. */
const lp = (part: string): string => `${Buffer.byteLength(part, 'utf8')}:${part}`;

describe('canonicalPayload', () => {
  it('is dn3: version-prefixed, length-prefixed, rootToken + rootAddr after refToken', () => {
    expect(CANONICAL_PAYLOAD_VERSION).toBe('dn3');
    const payload = canonicalPayload(fields());
    expect(payload.toString('utf8')).toBe(
      [CANONICAL_PAYLOAD_VERSION, 'post', UUID, ADDR, '1700000000000', 'hello', '', '', '', '']
        .map(lp)
        .join(''),
    );
  });

  it('renders absent parts as zero-length framed fields, keeping the field count constant', () => {
    const boost = canonicalPayload(
      fields({ type: 'boost', text: '', refToken: 'u:x', rootToken: '', rootAddr: '', mediaSha256: '' }),
    );
    expect(boost.toString('utf8')).toBe(
      [CANONICAL_PAYLOAD_VERSION, 'boost', UUID, ADDR, '1700000000000', '', 'u:x', '', '', '']
        .map(lp)
        .join(''),
    );
  });

  it('places rootToken then rootAddr between refToken and mediaSha256 (separate frames)', () => {
    const payload = canonicalPayload(
      fields({
        type: 'reply',
        refToken: 'parent-u',
        rootToken: 'root-u',
        rootAddr: 'alice@x',
        mediaSha256: 'ff',
      }),
    ).toString('utf8');
    expect(payload).toBe(
      [CANONICAL_PAYLOAD_VERSION, 'reply', UUID, ADDR, '1700000000000', 'hello', 'parent-u', 'root-u', 'alice@x', 'ff']
        .map(lp)
        .join(''),
    );
  });

  it('root token participates: present vs absent are distinct payloads', () => {
    const withRoot = canonicalPayload(fields({ type: 'reply', rootToken: 'root-u' })).toString('utf8');
    const noRoot = canonicalPayload(fields({ type: 'reply', rootToken: '' })).toString('utf8');
    expect(withRoot).not.toBe(noRoot);
  });

  it('root ADDR participates: root-with-addr vs root-without-addr are distinct payloads', () => {
    // root.addr is ROUTING (who gets the root DM copy / whom a thread subscriber
    // contacts), unlike ref.addr which is display-only attribution — so it must
    // be signed. A relayed envelope with the root addr swapped must not verify.
    const withAddr = canonicalPayload(
      fields({ type: 'reply', rootToken: 'root-u', rootAddr: 'alice@x' }),
    ).toString('utf8');
    const withoutAddr = canonicalPayload(
      fields({ type: 'reply', rootToken: 'root-u', rootAddr: '' }),
    ).toString('utf8');
    const otherAddr = canonicalPayload(
      fields({ type: 'reply', rootToken: 'root-u', rootAddr: 'mallory@x' }),
    ).toString('utf8');
    expect(withAddr).not.toBe(withoutAddr);
    expect(withAddr).not.toBe(otherAddr);
  });

  it('rootAddr is its OWN frame: token/addr re-splits do not collide', () => {
    // Separate frames (not concatenation into rootToken) are the point of the
    // length-prefix design: `{token:'a@b', addr:''}` vs `{token:'a', addr:'@b'}`
    // must be distinct payloads.
    const first = canonicalPayload(fields({ rootToken: 'a@b', rootAddr: '' }));
    const second = canonicalPayload(fields({ rootToken: 'a', rootAddr: '@b' }));
    expect(first.equals(second)).toBe(false);
  });

  it('length-prefixes with BYTE length, not code-unit length (multi-byte utf8 frames correctly)', () => {
    const payload = canonicalPayload(fields({ text: '♻' })).toString('utf8');
    expect(payload).toContain(`${Buffer.byteLength('♻', 'utf8')}:♻`);
    expect(Buffer.byteLength('♻', 'utf8')).not.toBe('♻'.length); // the distinction matters
  });

  it('is stable: same fields -> byte-identical payload', () => {
    expect(canonicalPayload(fields())).toEqual(canonicalPayload(fields()));
  });

  it('is injective across each field (changing any field changes the payload)', () => {
    const base = canonicalPayload(fields()).toString('utf8');
    expect(canonicalPayload(fields({ text: 'hell0' })).toString('utf8')).not.toBe(base);
    expect(canonicalPayload(fields({ addr: 'mallory@relay.example' })).toString('utf8')).not.toBe(base);
    expect(canonicalPayload(fields({ ts: 1700000000001 })).toString('utf8')).not.toBe(base);
    expect(canonicalPayload(fields({ refToken: UUID })).toString('utf8')).not.toBe(base);
    expect(canonicalPayload(fields({ rootToken: UUID })).toString('utf8')).not.toBe(base);
    expect(canonicalPayload(fields({ rootAddr: 'mallory@x' })).toString('utf8')).not.toBe(base);
    expect(canonicalPayload(fields({ mediaSha256: 'deadbeef' })).toString('utf8')).not.toBe(base);
  });

  it('is unambiguous across field boundaries: NUL-bearing re-splits do NOT collide', () => {
    // Under a bare join('\0') these two tuples produced IDENTICAL byte payloads
    // ("a\0b\0c" either way) — one signature verified two different envelopes,
    // letting anyone re-split attacker-controlled text/refToken fields. Length-
    // prefix framing makes each field self-delimiting, so they must differ.
    const first = canonicalPayload(fields({ text: 'a\u0000b', refToken: 'c' }));
    const second = canonicalPayload(fields({ text: 'a', refToken: 'b\u0000c' }));
    expect(first.equals(second)).toBe(false);
  });

  it('cannot be confused by field content that mimics the framing itself', () => {
    // A text that LOOKS like "…<len>:<next field>" must not collide with the
    // honest split (each frame consumes exactly its declared byte count).
    const tricky = canonicalPayload(fields({ text: `hello${lp('evil')}`, refToken: '' }));
    const honest = canonicalPayload(fields({ text: 'hello', refToken: 'evil' }));
    expect(tricky.equals(honest)).toBe(false);
  });
});

describe('fieldsFromEnvelope', () => {
  it('projects envelope fields, defaulting absent text/ref/media to empty strings', () => {
    const env: Envelope = { dn: 2, type: 'post', uuid: UUID, ts: 5, text: 'hi' };
    expect(fieldsFromEnvelope(env, ADDR)).toEqual({
      type: 'post',
      uuid: UUID,
      addr: ADDR,
      ts: 5,
      text: 'hi',
      refToken: '',
      rootToken: '',
      rootAddr: '',
      mediaSha256: '',
    });
  });

  it('takes the ref/root key strings, root addr, and media sha256 when present', () => {
    const env: Envelope = {
      dn: 2,
      type: 'reply',
      uuid: UUID,
      ts: 5,
      text: 'hi',
      ref: { u: 'parent-uuid', addr: 'bob@x' },
      root: { u: 'root-uuid', addr: 'alice@x' },
      media: { sha256: 'abc123' },
    };
    const f = fieldsFromEnvelope(env, ADDR);
    expect(f.refToken).toBe('parent-uuid');
    expect(f.rootToken).toBe('root-uuid');
    expect(f.rootAddr).toBe('alice@x');
    expect(f.mediaSha256).toBe('abc123');
  });

  it('derives empty rootToken + rootAddr when the reply carries no root', () => {
    const env: Envelope = {
      dn: 2,
      type: 'reply',
      uuid: UUID,
      ts: 5,
      text: 'hi',
      ref: { u: 'parent-uuid', addr: 'bob@x' },
    };
    const f = fieldsFromEnvelope(env, ADDR);
    expect(f.rootToken).toBe('');
    expect(f.rootAddr).toBe('');
  });

  it('derives an empty rootAddr when the root carries no addr', () => {
    const env: Envelope = {
      dn: 2,
      type: 'reply',
      uuid: UUID,
      ts: 5,
      text: 'hi',
      ref: { u: 'parent-uuid', addr: 'bob@x' },
      root: { u: 'root-uuid' },
    };
    const f = fieldsFromEnvelope(env, ADDR);
    expect(f.rootToken).toBe('root-uuid');
    expect(f.rootAddr).toBe('');
  });
});

describe('sha256', () => {
  it('sha256Bytes matches a known vector for empty input', () => {
    expect(sha256Bytes(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('sha256File hashes a file the same as sha256Bytes of its content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attest-hash-'));
    const path = join(dir, 'blob.bin');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    writeFileSync(path, bytes);
    expect(await sha256File(path)).toBe(sha256Bytes(bytes));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('openAttestor / sign / verify', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-key-'));
    keyPath = join(dir, 'deltanet-signing-key.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('generates + persists a keypair on first use, 0600', () => {
    const a = openAttestor(keyPath);
    const pub = a.publicKeyBase64();
    expect(pub).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(existsSync(keyPath)).toBe(true);
    // owner-only permissions (private key material)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('is stable across reopen (same pubkey loaded from disk)', () => {
    const pub1 = openAttestor(keyPath).publicKeyBase64();
    const pub2 = openAttestor(keyPath).publicKeyBase64();
    expect(pub2).toBe(pub1);
  });

  it('verification is INDIFFERENT to the unsigned invite field (by design)', () => {
    // In-band introduction: `invite` is deliberately outside the canonical
    // payload — securejoin links are self-authenticating and the joiner's
    // post-join addr check is the authenticator, so a signature must neither
    // require nor break on the field (authors can rotate invites; relayers
    // stripping it is plain omission).
    const a = openAttestor(keyPath);
    const env: Envelope = { dn: 2, type: 'post', uuid: UUID, text: 'hello' };
    const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
    expect(verify(signed, ADDR)).toBe(true);
    expect(verify({ ...signed, invite: 'https://i.delta.chat/#ABC' }, ADDR)).toBe(true);
    const signedWithInvite: Envelope = {
      ...env,
      invite: 'https://i.delta.chat/#ABC',
      ...a.sign({ ...env, invite: 'https://i.delta.chat/#ABC' }, ADDR),
    };
    expect(verify({ ...signedWithInvite, invite: undefined }, ADDR)).toBe(true);
    expect(verify({ ...signedWithInvite, invite: 'https://i.delta.chat/#SWAPPED' }, ADDR)).toBe(true);
  });

  it('signs an envelope and verify() accepts the round-trip', () => {
    const a = openAttestor(keyPath);
    const env: Envelope = { dn: 2, type: 'post', uuid: UUID, text: 'hello' };
    const { ts, pubkey, sig } = a.sign(env, ADDR);
    const signed: Envelope = { ...env, ts, pubkey, sig };
    expect(verify(signed, ADDR)).toBe(true);
  });

  it('signs + verifies a reply WITH a thread root (round-trip)', () => {
    const a = openAttestor(keyPath);
    const env: Envelope = {
      dn: 2,
      type: 'reply',
      uuid: UUID,
      text: 're',
      ref: { u: 'parent-uuid', addr: 'bob@x' },
      root: { u: 'root-uuid', addr: 'alice@x' },
    };
    const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
    expect(verify(signed, ADDR)).toBe(true);
  });

  it('signs + verifies a reply WITHOUT a root (round-trip)', () => {
    const a = openAttestor(keyPath);
    const env: Envelope = {
      dn: 2,
      type: 'reply',
      uuid: UUID,
      text: 're',
      ref: { u: 'parent-uuid', addr: 'bob@x' },
    };
    const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
    expect(verify(signed, ADDR)).toBe(true);
  });

  it('round-trips text containing embedded NUL bytes (sign/verify against itself)', () => {
    const a = openAttestor(keyPath);
    const env: Envelope = { dn: 2, type: 'post', uuid: UUID, text: 'weird\u0000but\u0000legal' };
    const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
    expect(verify(signed, ADDR)).toBe(true);
  });

  it('uses env.ts when already set, else stamps Date.now()', () => {
    const a = openAttestor(keyPath);
    const withTs = a.sign({ dn: 2, type: 'post', uuid: UUID, text: 'x', ts: 42 }, ADDR);
    expect(withTs.ts).toBe(42);
    const before = Date.now();
    const noTs = a.sign({ dn: 2, type: 'post', uuid: UUID, text: 'x' }, ADDR);
    expect(noTs.ts).toBeGreaterThanOrEqual(before);
  });

  it('never persists the private key material in the loggable pubkey', () => {
    const a = openAttestor(keyPath);
    expect(a.publicKeyBase64()).not.toContain('PRIVATE');
  });

  describe('tamper matrix -> verify false', () => {
    const signedEnv = (): Envelope => {
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'post',
        uuid: UUID,
        text: 'authentic',
        media: { sha256: 'aa' },
      };
      const { ts, pubkey, sig } = a.sign(env, ADDR);
      return { ...env, ts, pubkey, sig };
    };

    it('altered text', () => {
      expect(verify({ ...signedEnv(), text: 'tampered' }, ADDR)).toBe(false);
    });

    it('altered addr (wrong signer identity)', () => {
      expect(verify(signedEnv(), 'mallory@relay.example')).toBe(false);
    });

    it('altered media sha256', () => {
      expect(verify({ ...signedEnv(), media: { sha256: 'bb' } }, ADDR)).toBe(false);
    });

    it('wrong pubkey (a different key that did not sign)', () => {
      const other = openAttestor(join(dir, 'other-key.json'));
      expect(verify({ ...signedEnv(), pubkey: other.publicKeyBase64() }, ADDR)).toBe(false);
    });

    it('NUL re-split of the signed fields does NOT cross-verify (framing ambiguity)', () => {
      // The exact collision the length prefix exists to kill: sign a reply
      // whose text ends in "\0b" targeting ref "c", then present the SAME
      // signature over text "a" and ref "b\0c". Under join('\0') both
      // canonicalize to identical bytes and the signature transfers.
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        text: 'a\u0000b',
        ref: { u: 'c', addr: 'bob@x' },
      };
      const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
      expect(verify(signed, ADDR)).toBe(true); // the honest envelope verifies

      const resplit: Envelope = { ...signed, text: 'a', ref: { u: 'b\u0000c', addr: 'bob@x' } };
      expect(verify(resplit, ADDR), 'one signature must never verify two envelopes').toBe(false);
    });

    it('missing sig / pubkey / uuid / ts', () => {
      const s = signedEnv();
      expect(verify({ ...s, sig: undefined }, ADDR)).toBe(false);
      expect(verify({ ...s, pubkey: undefined }, ADDR)).toBe(false);
      expect(verify({ ...s, uuid: undefined }, ADDR)).toBe(false);
      expect(verify({ ...s, ts: undefined }, ADDR)).toBe(false);
    });

    it('garbage sig / pubkey never throws, returns false', () => {
      const s = signedEnv();
      expect(verify({ ...s, sig: 'not-base64-!!!' }, ADDR)).toBe(false);
      expect(verify({ ...s, pubkey: 'not-a-key' }, ADDR)).toBe(false);
    });

    it('altered root does not verify (dn3 signs the root token)', () => {
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        text: 're',
        ref: { u: 'parent-uuid', addr: 'bob@x' },
        root: { u: 'root-uuid', addr: 'alice@x' },
      };
      const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
      expect(verify(signed, ADDR)).toBe(true);
      expect(verify({ ...signed, root: { u: 'other-root', addr: 'alice@x' } }, ADDR)).toBe(false);
    });

    it('altered root ADDR does not verify (root.addr is a signed ROUTING target)', () => {
      // root.addr decides who receives the root DM copy and whom a thread
      // subscriber contacts — unlike ref.addr (display-only attribution), so it
      // is signed as its own frame. Swapping it on a relayed envelope (boost
      // embed, backfill bundle) must break verification.
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        text: 're',
        ref: { u: 'parent-uuid', addr: 'bob@x' },
        root: { u: 'root-uuid', addr: 'alice@x' },
      };
      const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
      expect(verify(signed, ADDR)).toBe(true);
      expect(verify({ ...signed, root: { u: 'root-uuid', addr: 'mallory@x' } }, ADDR)).toBe(false);
      // Dropping the addr entirely also changes the payload.
      expect(verify({ ...signed, root: { u: 'root-uuid' } }, ADDR)).toBe(false);
    });

    it('dn3-signed envelope with its root STRIPPED does not verify (payloads differ)', () => {
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        text: 're',
        ref: { u: 'parent-uuid', addr: 'bob@x' },
        root: { u: 'root-uuid', addr: 'alice@x' },
      };
      const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
      // Removing root drops the rootToken frame → dn3 layout differs, and the
      // dn2 fallback would sign a DIFFERENT (root-less) payload the dn3 sig never
      // covered — so a stripped-root dn3 sig must fail both layouts.
      const { root: _dropped, ...stripped } = signed;
      expect(verify(stripped as Envelope, ADDR)).toBe(false);
    });

    it('malformed-root graft on a root-less dn3 envelope does not verify (nested-orig path)', () => {
      // Models a boost `orig` / future bundle item: a NESTED envelope object
      // never passes through parseEnvelope's tolerant-drop, so verify() itself
      // must reject a malformed root. The dangerous case is the TRIVIAL graft:
      // `{u:''}` / `{u:'', addr:''}` frame as rootToken '' + rootAddr '' —
      // byte-identical to an absent root — so without an explicit shape gate
      // the signature would still verify with junk `.root` attached.
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        text: 're',
        ref: { u: 'parent-uuid', addr: 'bob@x' },
        // NO root — signed root-less.
      };
      const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
      expect(verify(signed, ADDR)).toBe(true); // sanity: honest envelope verifies

      // Trivial grafts (empty-frame equivalence) and a non-string u.
      expect(verify({ ...signed, root: { u: '' } as any }, ADDR)).toBe(false);
      expect(verify({ ...signed, root: { u: '', addr: '' } as any }, ADDR)).toBe(false);
      expect(verify({ ...signed, root: { u: 5 } as any }, ADDR)).toBe(false);
      // Other malformed shapes fail closed too.
      expect(verify({ ...signed, root: { garbage: true } as any }, ADDR)).toBe(false);
      expect(verify({ ...signed, root: { u: 'root-u', addr: 42 } as any }, ADDR)).toBe(false);
      expect(verify({ ...signed, root: 'not-an-object' as any }, ADDR)).toBe(false);
    });
  });

  // The subtle downgrade-safety property: dn2-era signatures (from outside nodes
  // deployed before the dn3 bump) still verify when root-less, but the fallback
  // can never be abused to forge a root. We hand-sign over the OLD dn2 layout
  // (constructed manually with the length-prefix helper) to model a real dn2 sig.
  describe('dn2 fallback matrix', () => {
    /** The OLD dn2 canonical payload: NO rootToken frame, version string 'dn2'. */
    const dn2Payload = (f: {
      type: string;
      uuid: string;
      addr: string;
      ts: number;
      text: string;
      refToken: string;
      mediaSha256: string;
    }): Buffer =>
      Buffer.from(
        [f.type, f.uuid, f.addr, String(f.ts), f.text, f.refToken, f.mediaSha256]
          .reduce((acc, part) => acc + lp(part), lp('dn2')),
        'utf8',
      );

    /** A generated ed25519 keypair; `pubkey` is the on-wire base64 SPKI DER. */
    const genKey = () => {
      const { generateKeyPairSync } = require('node:crypto');
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      return {
        privateKey,
        pubkey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
      };
    };

    /** Sign arbitrary bytes with an ed25519 private key → base64, like the wire sig. */
    const edSignB64 = (bytes: Buffer, privateKey: unknown): string => {
      const { sign } = require('node:crypto');
      return (sign(null, bytes, privateKey) as Buffer).toString('base64');
    };

    const TS = 1700000000000;
    const dn2SignedReply = () => {
      const { privateKey, pubkey } = genKey();
      const base = {
        type: 'reply',
        uuid: UUID,
        addr: ADDR,
        ts: TS,
        text: 're over dn2',
        refToken: 'parent-uuid',
        mediaSha256: '',
      };
      const sig = edSignB64(dn2Payload(base), privateKey);
      // The envelope a dn2-era node would have produced (no `root`).
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        ts: TS,
        text: 're over dn2',
        ref: { u: 'parent-uuid', addr: 'bob@x' },
        pubkey,
        sig,
      };
      return env;
    };

    it('(i) a hand-signed dn2 envelope verifies when root is absent', () => {
      expect(verify(dn2SignedReply(), ADDR)).toBe(true);
    });

    it('(ii) the SAME dn2 envelope with any root added does NOT verify (no forged-root downgrade)', () => {
      const env = dn2SignedReply();
      expect(verify({ ...env, root: { u: 'forged-root', addr: 'mallory@x' } }, ADDR)).toBe(false);
    });

    it('(iii) a dn3-signed envelope with its root stripped does NOT verify (payloads differ)', () => {
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        text: 're',
        ref: { u: 'parent-uuid', addr: 'bob@x' },
        root: { u: 'root-uuid', addr: 'alice@x' },
      };
      const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
      const { root: _dropped, ...stripped } = signed;
      expect(verify(stripped as Envelope, ADDR)).toBe(false);
    });

    it('(iv) a dn3-signed envelope with root ALTERED does not verify', () => {
      const a = openAttestor(keyPath);
      const env: Envelope = {
        dn: 2,
        type: 'reply',
        uuid: UUID,
        text: 're',
        ref: { u: 'parent-uuid', addr: 'bob@x' },
        root: { u: 'root-uuid', addr: 'alice@x' },
      };
      const signed: Envelope = { ...env, ...a.sign(env, ADDR) };
      expect(verify({ ...signed, root: { u: 'altered', addr: 'alice@x' } }, ADDR)).toBe(false);
    });
  });
});

describe('attestor reload (backup restore seam)', () => {
  it('picks up a key file swapped underneath it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deltanet-attest-reload-'));
    try {
      const keyPath = join(dir, 'key.json');
      const attestor = openAttestor(keyPath);
      const before = attestor.publicKeyBase64(); // generates + writes the file

      const otherPath = join(dir, 'restored-key.json');
      const restored = openAttestor(otherPath);
      const restoredPub = restored.publicKeyBase64();
      writeFileSync(keyPath, readFileSync(otherPath));

      attestor.reload();
      expect(attestor.publicKeyBase64()).toBe(restoredPub);
      expect(attestor.publicKeyBase64()).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

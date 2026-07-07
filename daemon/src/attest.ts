/**
 * Post attestations (design-sketch #6, decision 0002): per-account ed25519
 * signing so republished content (boost embeds; thread republication later) is
 * offline-verifiable by anyone holding the author's public key. A republisher
 * can OMIT content (reply control) but can never ALTER or FABRICATE it.
 *
 * The signature covers a CANONICAL PAYLOAD reconstructed from the envelope's
 * fields — never the raw JSON string — so any re-serialization (key order,
 * whitespace, added-then-ignored fields) can never break verification. The
 * format is fixed-order, LENGTH-PREFIXED per field, and version-prefixed so it
 * can evolve without silently mismatching old signatures. Length-prefixing
 * (rather than a bare separator) makes each field self-delimiting: `text` and
 * `refToken` are attacker-controlled JSON strings that may contain ANY byte
 * (including NUL), so a separator-joined payload would be ambiguous — two
 * different field tuples could concatenate to identical bytes, letting one
 * signature verify two different envelopes.
 *
 * Everything here is pure/injectable where practical: `canonicalPayload`,
 * `verify`, and `sha256File` take their inputs explicitly; only key material is
 * stateful, and its storage path is injected exactly like the store path is.
 * The PRIVATE key is NEVER logged and never leaves this module.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Envelope, EnvelopeRef } from './envelope.js';
import { envelopeRefKeyString, isWellFormedRootRef } from './envelope.js';

/**
 * Canonical-payload format version. Prefixed onto every signed payload so the
 * field order/layout can change later without a new signature silently
 * verifying against an old canonicalization (or vice versa). Bump ONLY when the
 * payload layout below changes.
 *
 * dn3 adds the thread-root frames after `refToken`: the root TOKEN and the root
 * ADDR (see `CanonicalFields`). The addr is signed because — unlike `ref.addr`,
 * a display-only attribution fallback — `root.addr` is a ROUTING target: it
 * decides who receives the root DM copy and whom a thread subscriber contacts,
 * so a relayed envelope (boost embed, backfill bundle) must not be able to swap
 * it. `sign()` emits dn3 exclusively. `verify()` keeps a dn2 fallback for
 * signatures minted before this bump (deployed outside nodes federate dn2 with
 * us) — see the fallback rationale on `verify`.
 */
export const CANONICAL_PAYLOAD_VERSION = 'dn3';

/**
 * The previous canonical-payload version (root-less layout). Retained ONLY so
 * `verify()` can fall back to it for dn2-era signatures; never emitted.
 */
const CANONICAL_PAYLOAD_VERSION_DN2 = 'dn2';

/**
 * A canonical-payload LAYOUT: the version string that prefixes the signed bytes
 * and whether the thread-root token frame is included. The version lives INSIDE
 * the signed bytes, so the two layouts can never cross-verify — a dn3 signature
 * can't be replayed as dn2 or vice versa.
 */
type CanonicalLayout = { version: string; withRoot: boolean };

/** The current (dn3) layout: root token frame present, after refToken. */
const LAYOUT_DN3: CanonicalLayout = { version: CANONICAL_PAYLOAD_VERSION, withRoot: true };

/** The legacy (dn2) layout: no root token frame. verify-only fallback. */
const LAYOUT_DN2: CanonicalLayout = { version: CANONICAL_PAYLOAD_VERSION_DN2, withRoot: false };

/**
 * The fields the attestation signs. Reconstructed from an envelope's own fields
 * (not its JSON), so field order and JSON whitespace are irrelevant to
 * verification. `text`/`mediaSha256`/`refToken` are empty strings when absent.
 */
export type CanonicalFields = {
  /** Envelope type verb (post/reply/boost). */
  type: string;
  /** This message's own logical-post uuid. */
  uuid: string;
  /** The author's address (the signer). */
  addr: string;
  /** Author-declared ms epoch timestamp. */
  ts: number;
  /** Human text (empty for a boost). */
  text: string;
  /** The reply/boost target ref as its opaque key string (uuid or bare mid); empty if none. */
  refToken: string;
  /**
   * The thread-root ref as its opaque key string (uuid or bare mid); empty when
   * absent (non-reply, or a reply whose root is unknowable). Signed directly
   * after `refToken` in the dn3 layout. Its presence vs absence is a distinct
   * payload, so a dn2 envelope can never grow a forged root. (The parse seam
   * additionally drops roots with an empty/missing `u`, closing the graft where
   * an empty key string would frame identically to an absent root.)
   */
  rootToken: string;
  /**
   * The thread-root ref's author ADDRESS; empty when absent. Signed as its OWN
   * frame directly after `rootToken` because — unlike `ref.addr`, which is
   * display-only attribution — the root addr is a ROUTING target: it decides who
   * receives the root DM copy today and whom a subscriber contacts in
   * thread-subscribe. Left unsigned, a relayed envelope (boost embed, backfill
   * bundle) could swap it to an attacker's address while still verifying.
   */
  rootAddr: string;
  /** Lowercase-hex sha256 of the attached media file; empty if no media. */
  mediaSha256: string;
};

/**
 * One canonical-payload frame: `<utf8ByteLength>:<part>`. The decimal byte
 * length makes each field self-delimiting, so NO byte value inside a field
 * (including NUL) can shift a boundary — two distinct field tuples can never
 * concatenate to the same payload. Pure and total.
 */
const lengthPrefixed = (part: string): string => `${Buffer.byteLength(part, 'utf8')}:${part}`;

/**
 * Build the canonical byte payload from explicit fields under a given LAYOUT: a
 * fixed-order, per-field LENGTH-PREFIXED, version-prefixed string. Empty strings
 * stand in for absent parts (framed as `0:`) so the field count is constant.
 * Pure and total — no rejected-content class: any field content, NUL bytes
 * included, frames unambiguously.
 *
 * dn3: lp(dn3) lp(type) lp(uuid) lp(addr) lp(ts) lp(text) lp(refToken) lp(rootToken) lp(rootAddr) lp(mediaSha256)
 * dn2: lp(dn2) lp(type) lp(uuid) lp(addr) lp(ts) lp(text) lp(refToken)                            lp(mediaSha256)
 *
 * where lp(x) = `${utf8ByteLength(x)}:${x}`, concatenated with no separator. The
 * ONE framing implementation is parameterized by layout so dn2 (verify-only
 * fallback) and dn3 never drift. `rootAddr` is its OWN frame (never concatenated
 * into rootToken) — separate self-delimiting frames are the whole point of the
 * length-prefix design; a joined `token+addr` would reintroduce the re-split
 * ambiguity the framing exists to kill. A bare separator-joined format was
 * rejected: `text`/`refToken`/`rootToken`/`rootAddr` are attacker-controlled and
 * may contain the separator byte, making the payload ambiguous across field
 * boundaries (one signature verifying two envelopes).
 */
const canonicalPayloadFor = (fields: CanonicalFields, layout: CanonicalLayout): Buffer => {
  const parts = [
    layout.version,
    fields.type,
    fields.uuid,
    fields.addr,
    String(fields.ts),
    fields.text,
    fields.refToken,
    // The root token + addr frames exist only in dn3. Their presence is what
    // prevents a dn2 envelope from ever growing a forged root (dn2 has no frame
    // for either), and signing the addr keeps the root ROUTING target — who
    // receives the root DM copy — out of a relayer's hands.
    ...(layout.withRoot ? [fields.rootToken, fields.rootAddr] : []),
    fields.mediaSha256,
  ];
  return Buffer.from(parts.map(lengthPrefixed).join(''), 'utf8');
};

/** The canonical (dn3) byte payload for the given fields. Pure and total. */
export const canonicalPayload = (fields: CanonicalFields): Buffer =>
  canonicalPayloadFor(fields, LAYOUT_DN3);

/**
 * Derive the canonical fields from an envelope + the signer's address. The
 * envelope must already carry `uuid` and `ts` (the send path sets `ts` before
 * signing). Pure.
 */
export const fieldsFromEnvelope = (env: Envelope, addr: string): CanonicalFields => ({
  type: env.type,
  uuid: env.uuid ?? '',
  addr,
  ts: env.ts ?? 0,
  text: env.text ?? '',
  refToken: env.ref ? refKeyOf(env.ref) : '',
  rootToken: env.root ? refKeyOf(env.root) : '',
  rootAddr: env.root?.addr ?? '',
  mediaSha256: env.media?.sha256 ?? '',
});

/** The opaque key string a wire ref points at (uuid, or bare mid) — feeds the canonical payload. */
const refKeyOf = (ref: EnvelopeRef): string => envelopeRefKeyString(ref);

/** Streaming sha256 of a file's bytes, lowercase hex. Async; the file is read once. */
export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

/** sha256 of an in-memory buffer, lowercase hex. Pure. */
export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * The persisted keypair file shape. The private key is stored as a PKCS#8 PEM
 * and the public key as base64 (the same base64 that rides in the envelope's
 * `pubkey` field), so the file is self-describing without re-deriving.
 */
type StoredKeyPair = {
  /** PKCS#8 PEM of the ed25519 private key. NEVER logged. */
  privatePem: string;
  /** base64 of the raw ed25519 public key (SPKI DER), the envelope `pubkey`. */
  pubkey: string;
};

/**
 * base64 of an ed25519 public key's SPKI DER — the on-wire `pubkey`. A raw
 * 32-byte ed25519 public key is ambiguous without its algorithm OID, so we
 * carry the full SPKI DER (still tiny) and both sign/verify use it verbatim.
 */
const pubkeyBase64 = (key: KeyObject): string =>
  key.export({ type: 'spki', format: 'der' }).toString('base64');

/** Reconstruct a public KeyObject from the on-wire base64 SPKI DER. */
const publicKeyFromBase64 = (pubkey: string): KeyObject =>
  createPublicKey({ key: Buffer.from(pubkey, 'base64'), type: 'spki', format: 'der' });

/**
 * The attestation signer/verifier for one account. `sign` stamps an envelope
 * with `{ ts, pubkey, sig }` over the canonical payload; `verify` checks a
 * (possibly foreign) envelope's `sig` against its embedded `pubkey`. Key
 * material is loaded/generated lazily from `keyPath` (injected like the store
 * path), and the private key never leaves this closure.
 */
export type Attestor = {
  /** This account's public key, base64 SPKI DER — the value stamped into `pubkey`. */
  publicKeyBase64(): string;
  /**
   * Sign an envelope for `addr` (the signer's own address). Returns the
   * attestation fields to merge onto the envelope: `ts` is taken from
   * `env.ts` if already set (send path stamps it), else `Date.now()`.
   */
  sign(env: Envelope, addr: string): { ts: number; pubkey: string; sig: string };
  /**
   * Drop the cached key pair so the next use re-reads `keyPath` — the
   * backup-restore seam: a restore writes the restored signing key file under
   * a live daemon, and without this the closure would keep signing with the
   * pre-restore key.
   */
  reload(): void;
};

/**
 * Verify an envelope's attestation against its OWN embedded pubkey, using the
 * given canonical fields (the caller derives `addr` — a signed embed carries
 * the author addr in its ref, or the caller supplies it). Returns false for any
 * missing/short/invalid signature or pubkey — never throws. Pure over its
 * inputs (no key files). This is what the boost-embed rendering ladder calls.
 *
 * dn2 FALLBACK (downgrade-safe by construction): we try the current dn3 layout
 * first; if that fails AND the envelope carries NO `root`, we retry the OLD dn2
 * layout (version string 'dn2', no root token/addr frames) so signatures minted
 * before the dn3 bump — deployed outside nodes federate them with us — still
 * verify. This can never widen forgery because the version string is INSIDE the
 * signed bytes: a dn3 signature can't be replayed as dn2 or vice versa (the
 * version frame differs), and a dn2 envelope can never grow a forged `root` —
 * the dn3 layout signs the root token AND the root addr (the DM-copy ROUTING
 * target), and the dn2 fallback is gated on root ABSENCE, so adding any root
 * forces dn3-only verification against bytes the dn2 signer never covered. An
 * omitted root is thus always valid; a present root is dn3-only.
 *
 * MALFORMED-ROOT GATE: a present `root` that is not a well-formed uuid ref
 * (shared `isWellFormedRootRef` predicate) is rejected outright, BEFORE any
 * payload work. Signers never emit malformed roots (builders take typed refs;
 * `parseEnvelope` tolerant-drops junk), so this rejects only GRAFTS. It exists
 * because parser sanitization can't reach NESTED envelopes (a boost `orig`,
 * future backfill bundle items) — and the trivial graft `{u:''}`/`{u:'',addr:''}`
 * frames as rootToken '' + rootAddr '' (`0:0:`), byte-identical to an absent
 * root, so without this gate a root-less dn3 signature would still verify with
 * junk `.root` attached to a "verified" envelope.
 */
export const verify = (env: Envelope, addr: string): boolean => {
  if (!env.sig || !env.pubkey || !env.uuid || env.ts === undefined) return false;
  if (env.root !== undefined && !isWellFormedRootRef(env.root)) return false;
  let publicKey: KeyObject;
  try {
    publicKey = publicKeyFromBase64(env.pubkey);
  } catch {
    return false;
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(env.sig, 'base64');
  } catch {
    return false;
  }
  const fields = fieldsFromEnvelope(env, addr);
  const verifyUnder = (layout: CanonicalLayout): boolean => {
    try {
      return edVerify(null, canonicalPayloadFor(fields, layout), publicKey, sig);
    } catch {
      return false;
    }
  };
  if (verifyUnder(LAYOUT_DN3)) return true;
  // Fallback ONLY for root-less envelopes: a dn2 signer could not have covered a
  // root, so any envelope carrying `root` is dn3-only (no forged-root downgrade).
  if (env.root === undefined && verifyUnder(LAYOUT_DN2)) return true;
  return false;
};

/**
 * Open (or lazily create + persist) the account's ed25519 keypair at `keyPath`,
 * returning an `Attestor`. The private key is generated with
 * `generateKeyPairSync('ed25519')`, written PKCS#8-PEM under the account data
 * dir (0600), and NEVER logged. Injected path mirrors the store path so tests
 * point it at a scratch file.
 */
export const openAttestor = (keyPath: string): Attestor => {
  let priv: KeyObject | null = null;
  let pubB64: string | null = null;

  const ensureKeys = (): void => {
    if (priv && pubB64) return;
    if (existsSync(keyPath)) {
      const stored = JSON.parse(readFileSync(keyPath, 'utf8')) as StoredKeyPair;
      priv = createPrivateKey({ key: stored.privatePem, format: 'pem', type: 'pkcs8' });
      pubB64 = stored.pubkey;
      return;
    }
    const pair = generateKeyPairSync('ed25519');
    priv = pair.privateKey;
    pubB64 = pubkeyBase64(pair.publicKey);
    const stored: StoredKeyPair = {
      privatePem: priv.export({ type: 'pkcs8', format: 'pem' }).toString(),
      pubkey: pubB64,
    };
    mkdirSync(dirname(keyPath), { recursive: true });
    // 0600: the private key is secret material; restrict to the owner.
    writeFileSync(keyPath, JSON.stringify(stored) + '\n', { mode: 0o600 });
  };

  return {
    publicKeyBase64: () => {
      ensureKeys();
      return pubB64!;
    },
    sign: (env, addr) => {
      ensureKeys();
      const ts = env.ts ?? Date.now();
      const payload = canonicalPayload(fieldsFromEnvelope({ ...env, ts }, addr));
      const sig = edSign(null, payload, priv!).toString('base64');
      return { ts, pubkey: pubB64!, sig };
    },
    reload: () => {
      priv = null;
      pubB64 = null;
    },
  };
};

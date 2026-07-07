/**
 * deltanet wire convention v2 (see ../DEVLOG.md "wire convention v2 — JSON
 * envelope" + docs/decisions.md 0001/0002). The ENTIRE message body is a single
 * JSON object — a versioned envelope with an explicit `type`, the human text as
 * a *field*, refs/uuids/extensions as fields. This kills the in-band ambiguity
 * of the v0/v1 text markers (user content can no longer collide with protocol
 * grammar) and lifts the one-glyph-per-verb ceiling.
 *
 * These are pure functions: no transport, no store, just structured value <->
 * JSON string. The v0/v1 marker parsers (./protocol.ts) remain READ-SIDE for
 * existing histories; we NEVER emit them again.
 *
 * Schema discipline (decision 0001): the `dn` version field gates parsing
 * (strict `dn === 2`), unknown fields MUST be ignored (forward-compat), and
 * field names are NEVER repurposed. `pubkey`/`sig` are RESERVED for post
 * attestations (design-sketch #6) — never emitted in v2, never repurposed.
 */

import { randomUUID } from 'node:crypto';
import type { RefToken } from './protocol.js';

/** The wire-format version this module emits and strictly gates on. */
export const DN_VERSION = 2;

/** Every envelope carries an explicit protocol verb. */
export type EnvelopeType =
  | 'post'
  | 'reply'
  | 'boost'
  | 'react'
  | 'unreact'
  | 'invite-request'
  | 'invite-grant';

/**
 * A typed ref on the wire: uuid-first (`{ u }`) targeting an author-minted
 * logical-post UUID, or a legacy `{ mid, addr }` targeting a canonical rfc724
 * Message-ID (targets that never minted a uuid). The addr rides along on mid
 * refs (and is implied by the uuid index for uuid refs) so a recipient can
 * attribute/notify without a separate lookup.
 */
export type EnvelopeRef =
  | { u: string; addr?: string }
  | { mid: string; addr: string };

/**
 * The v2 envelope. `dn`/`type` are always present; the rest are per-verb.
 * `media.description` carries persistent, federated alt text for an attachment
 * (replacing the in-memory mediaStore alt-text hack). `pubkey`/`sig` are
 * RESERVED (design-sketch #6) — typed here so the field names are claimed, but
 * NEVER emitted by the builders below.
 */
export type Envelope = {
  dn: number;
  type: EnvelopeType;
  /** This message's own logical-post UUID (posts/replies/boosts mint one). */
  uuid?: string;
  /** The human text of a post/reply. */
  text?: string;
  /** The target of a reply/boost/react/unreact. */
  ref?: EnvelopeRef;
  /** Alt text for an attachment on a post/reply (persistent + federated). */
  media?: { description?: string | null };
  /** The emoji of a react/unreact. */
  emoji?: string;
  /** The invite link of an invite-grant. */
  link?: string;
  /** RESERVED for post attestations (sketch #6) — never emitted in v2. */
  pubkey?: string;
  /** RESERVED for post attestations (sketch #6) — never emitted in v2. */
  sig?: string;
};

/** Mint a fresh logical-post UUIDv4 (author-side). Same generator as v1. */
export const mintUuid = (): string => randomUUID();

/** Serialize a `RefToken` (+ author addr) to its typed wire ref. */
export const refTokenToEnvelopeRef = (ref: RefToken, addr: string): EnvelopeRef =>
  ref.kind === 'uuid' ? { u: ref.uuid, addr } : { mid: ref.mid, addr };

/** The opaque key string a wire ref points at (uuid, or bare mid) — feeds the store keyspace. */
export const envelopeRefKeyString = (ref: EnvelopeRef): string =>
  'u' in ref ? ref.u : ref.mid;

/** The author address carried by a wire ref, if any. */
export const envelopeRefAddr = (ref: EnvelopeRef): string | undefined => ref.addr;

/** Recover a `RefToken` from a typed wire ref (for read-side resolution). */
export const envelopeRefToken = (ref: EnvelopeRef): RefToken =>
  'u' in ref ? { kind: 'uuid', uuid: ref.u } : { kind: 'mid', mid: ref.mid };

const serialize = (env: Envelope): string => JSON.stringify(env);

/** A plain post envelope: minted uuid + human text (+ optional media alt text). */
export const buildPostEnvelope = (
  text: string,
  uuid: string,
  media?: { description?: string | null },
): string =>
  serialize({
    dn: DN_VERSION,
    type: 'post',
    uuid,
    text,
    ...(media && media.description != null ? { media } : {}),
  });

/** A reply envelope: minted uuid + human text + the parent ref (+ optional media alt text). */
export const buildReplyEnvelope = (
  text: string,
  uuid: string,
  ref: EnvelopeRef,
  media?: { description?: string | null },
): string =>
  serialize({
    dn: DN_VERSION,
    type: 'reply',
    uuid,
    text,
    ref,
    ...(media && media.description != null ? { media } : {}),
  });

/**
 * A boost envelope: minted uuid + the boosted post's ref. Per decision 0002 we
 * do NOT embed the original content (unverifiable embedding returns WITH
 * attestations later) — just the ref.
 */
export const buildBoostEnvelope = (uuid: string, ref: EnvelopeRef): string =>
  serialize({ dn: DN_VERSION, type: 'boost', uuid, ref });

/** A reaction control-DM envelope: emoji + the reacted-to post's ref. */
export const buildReactEnvelope = (emoji: string, ref: EnvelopeRef): string =>
  serialize({ dn: DN_VERSION, type: 'react', emoji, ref });

/** A retraction control-DM envelope: emoji + the reacted-to post's ref. */
export const buildUnreactEnvelope = (emoji: string, ref: EnvelopeRef): string =>
  serialize({ dn: DN_VERSION, type: 'unreact', emoji, ref });

/** An invite-request control-DM envelope (follow-back). */
export const buildInviteRequestEnvelope = (): string =>
  serialize({ dn: DN_VERSION, type: 'invite-request' });

/** An invite-grant control-DM envelope carrying the feed invite link. */
export const buildInviteGrantEnvelope = (link: string): string =>
  serialize({ dn: DN_VERSION, type: 'invite-grant', link });

/**
 * Strict parse: returns the envelope iff `text` is a single JSON object with
 * `dn === 2` and a known `type`. Anything else — malformed JSON, a non-object,
 * a wrong/missing `dn`, an unknown `type` — returns null, so the message falls
 * through to the legacy marker parsers or is treated as plain human text (a
 * real chat message from an external sender must never crash or misparse).
 * Unknown fields are ignored (kept on the returned object but never required).
 */
export const parseEnvelope = (text: string): Envelope | null => {
  const trimmed = text.trim();
  // Cheap gate before attempting a full parse: an envelope is always a JSON
  // object, so it must start with `{`. Skips JSON.parse on ordinary chat text.
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj['dn'] !== DN_VERSION) return null;
  const type = obj['type'];
  if (!isEnvelopeType(type)) return null;
  return obj as Envelope;
};

const ENVELOPE_TYPES: ReadonlySet<string> = new Set<EnvelopeType>([
  'post',
  'reply',
  'boost',
  'react',
  'unreact',
  'invite-request',
  'invite-grant',
]);

const isEnvelopeType = (v: unknown): v is EnvelopeType =>
  typeof v === 'string' && ENVELOPE_TYPES.has(v);

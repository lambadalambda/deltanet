/**
 * Unified read-side wire parser: v2 JSON envelopes (./envelope.ts) FIRST, then
 * the v0/v1 text markers (./protocol.ts) for existing histories, then plain
 * human text. This is the single seam the store/ingest/mapping layers read
 * through, so mixed-era data (a legacy parent, a v2 reply) resolves
 * consistently and no callsite has to know which era a message came from.
 *
 * Emission is v2-only (see ./envelope.ts builders + server.ts); these parsers
 * are read-side. Malformed JSON / unknown-shape text degrades to plain content
 * (a real chat message from an external sender must never crash or misparse).
 */

import {
  parseEnvelope,
  envelopeRefToken,
  envelopeRefKeyString,
  threadScopeRootUuid,
  type Envelope,
  type EnvelopeRef,
} from './envelope.js';
import {
  parseMarkers,
  parseReaction,
  parseInviteRequest,
  parseInviteGrant,
  refFromToken,
  type MsgRef,
  type ParsedReaction,
} from './protocol.js';

/**
 * The normalized post/reply/boost parse over BOTH eras. Mirrors the legacy
 * `ParsedMarkers` shape so existing callers move over with minimal churn, plus
 * `mediaDescription` (v2 federated alt text) and `placeholderRef` (a boost
 * whose content we never embed — see 0002).
 */
export type ParsedWire = {
  /** Human body text (empty for a boost). */
  body: string;
  /** This message's own logical-post UUID, if it carries one. */
  uuid?: string;
  /** The reply parent ref, if this is a reply. */
  reply?: MsgRef;
  /**
   * The thread-root ref surfaced from a v2 reply envelope's signed `root`
   * (design: wire-thread-root-ref). Normalized like `reply`. Present only on a
   * v2 reply that carried one; legacy markers never produce it. Lets thread
   * resolution / future backfill name the thread + owner from a single message.
   */
  root?: MsgRef;
  /** The boosted post ref, if this is a boost. */
  boost?: MsgRef;
  /** Federated attachment alt text (v2 only), if present. */
  mediaDescription?: string | null;
  /** Restricted visibility marker; v2 envelopes only. */
  visibility?: 'private' | 'direct';
  /**
   * The embedded original envelope of a boost (post-attestations, sketch #6):
   * the booster's verbatim copy of the boosted post's signed envelope, for the
   * verified-embed rendering ladder. Present only on a v2 boost that carried one.
   */
  boostOrig?: Envelope;
};

/** Build a legacy-shaped `MsgRef` from a typed v2 envelope ref. */
const msgRefFromEnvelope = (ref: EnvelopeRef): MsgRef => {
  const token = envelopeRefToken(ref);
  // A uuid ref may omit addr on the wire; MsgRef.addr is only used for
  // attribution of unresolvable targets, so an empty string is a safe default.
  const addr = ('addr' in ref && ref.addr) || '';
  return refFromToken(token, addr);
};

/** Normalize a parsed v2 envelope into the `ParsedWire` post/reply/boost shape. */
const wireFromEnvelope = (env: Envelope): ParsedWire => {
  if (env.type === 'reply') {
    return {
      body: env.text ?? '',
      ...(env.uuid !== undefined ? { uuid: env.uuid } : {}),
      ...(env.ref ? { reply: msgRefFromEnvelope(env.ref) } : {}),
      ...(env.root ? { root: msgRefFromEnvelope(env.root) } : {}),
      ...(env.media?.description != null ? { mediaDescription: env.media.description } : {}),
      ...(env.visibility ? { visibility: env.visibility } : {}),
    };
  }
  if (env.type === 'boost') {
    return {
      body: '',
      ...(env.uuid !== undefined ? { uuid: env.uuid } : {}),
      ...(env.ref ? { boost: msgRefFromEnvelope(env.ref) } : {}),
      ...(env.orig ? { boostOrig: env.orig } : {}),
      ...(env.visibility ? { visibility: env.visibility } : {}),
    };
  }
  // 'post' (and any control-message type reaching here) renders as plain body.
  return {
    body: env.type === 'post' ? env.text ?? '' : '',
    ...(env.uuid !== undefined ? { uuid: env.uuid } : {}),
    ...(env.media?.description != null ? { mediaDescription: env.media.description } : {}),
    ...(env.visibility ? { visibility: env.visibility } : {}),
  };
};

/**
 * Parse a message's post/reply/boost structure, v2-first then legacy markers.
 * A control-message envelope (react/unreact/invite-*) has no post structure and
 * yields an empty body with no reply/boost.
 */
export const parseWire = (text: string): ParsedWire => {
  const env = parseEnvelope(text);
  if (env) return wireFromEnvelope(env);
  // Legacy: v0/v1 text markers. `parseMarkers` already peels the `⚑`/`⚓` lines.
  const legacy = parseMarkers(text);
  return {
    body: legacy.body,
    ...(legacy.uuid !== undefined ? { uuid: legacy.uuid } : {}),
    ...(legacy.reply ? { reply: legacy.reply } : {}),
    ...(legacy.boost ? { boost: legacy.boost } : {}),
  };
};

/**
 * Is this wire text a CONTENT message (post/reply/boost) worth surfacing in
 * search results — as opposed to a reaction/invite/backfill CONTROL message?
 * v2 envelopes classify by type; legacy text is content unless it parses as
 * a legacy control marker. Empty text is never content. Pure.
 */
export const isSearchableContent = (text: string): boolean => {
  if (!text.trim()) return false;
  const env = parseEnvelope(text);
  if (env) return env.type === 'post' || env.type === 'reply' || env.type === 'boost';
  if (parseWireReaction(text)) return false;
  if (parseWireInviteRequest(text)) return false;
  if (parseWireInviteGrant(text) !== null) return false;
  if (parseWireThreadInviteRequest(text) !== null) return false;
  if (parseWireThreadInviteGrant(text) !== null) return false;
  return true;
};

/**
 * This message's own logical-post UUID, v2-first then the legacy `⚑` marker.
 * Null for messages that never minted a uuid (pre-v1, or a control message).
 */
export const parseWireUuid = (text: string): string | null => {
  const env = parseEnvelope(text);
  if (env) return env.uuid ?? null;
  return parseMarkers(text).uuid ?? null;
};

/** Parse a reaction/unreaction control message, v2-first then legacy. */
export const parseWireReaction = (text: string): ParsedReaction | null => {
  const env = parseEnvelope(text);
  if (env) {
    if ((env.type === 'react' || env.type === 'unreact') && env.emoji && env.ref) {
      return { kind: env.type, emoji: env.emoji, ref: envelopeRefToken(env.ref) };
    }
    // A non-reaction envelope is definitively not a legacy reaction either.
    return null;
  }
  return parseReaction(text);
};

/** True iff this message is an invite-request control message, v2-first then legacy. */
/** Is this a LOCKED-scoped invite-request (visibility channels 1B)? */
export const parseWireLockedInviteRequest = (text: string): boolean => {
  const env = parseEnvelope(text);
  return env?.type === 'invite-request' && env.scope?.locked === true;
};

export const parseWireInviteRequest = (text: string): boolean => {
  const env = parseEnvelope(text);
  if (env) return env.type === 'invite-request';
  return parseInviteRequest(text);
};

/** Recover the invite link from a grant control message, v2-first then legacy; null otherwise. */
export const parseWireInviteGrant = (text: string): string | null => {
  const env = parseEnvelope(text);
  if (env) return env.type === 'invite-grant' && typeof env.link === 'string' ? env.link : null;
  return parseInviteGrant(text);
};

/**
 * The THREAD scope (root uuid) of a v2 invite-request DM, or null when the DM is
 * NOT a thread-scoped invite-request (a plain follow-back request, a non-request
 * envelope, or a legacy marker). Tolerant: a malformed scope degrades to null,
 * so such a DM is treated as an unscoped follow-back request by the caller. This
 * is how a host tells "subscribe me to this thread" apart from "follow my feed".
 */
export const parseWireThreadInviteRequest = (text: string): string | null => {
  const env = parseEnvelope(text);
  if (!env || env.type !== 'invite-request') return null;
  return threadScopeRootUuid(env.scope);
};

/**
 * The THREAD scope + invite link of a v2 invite-grant DM, or null when the DM is
 * NOT a thread-scoped grant (a plain follow-back grant, a non-grant envelope, or
 * a legacy marker). Returns both so the subscriber can join the granted channel
 * AND record which thread it subscribes. Tolerant on the scope (malformed → null).
 */
export const parseWireThreadInviteGrant = (
  text: string,
): { rootUuid: string; link: string } | null => {
  const env = parseEnvelope(text);
  if (!env || env.type !== 'invite-grant' || typeof env.link !== 'string') return null;
  const rootUuid = threadScopeRootUuid(env.scope);
  return rootUuid ? { rootUuid, link: env.link } : null;
};

/** The store post-key a v2 envelope ref points at (uuid, or bare mid). Re-exported for callers. */
export { envelopeRefKeyString };

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
 * field names are NEVER repurposed. `pubkey`/`sig`/`ts`/`orig`/`media.sha256`
 * are the post-attestation fields (design-sketch #6, decision 0002): every
 * content envelope (post/reply/boost) is signed with a per-account ed25519 key
 * (see ./attest.ts) and boosts embed the boosted post's complete signed
 * envelope as `orig` (+ re-attached media, verified by `media.sha256`).
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
  | 'invite-grant'
  // Thread auto-backfill (design-sketch #3, meta/issues/thread-auto-backfill.md).
  // Two control DMs a daemon exchanges to heal dangling reply/boost/root refs:
  | 'envelope-request'
  | 'envelope-bundle';

/**
 * Max refs carried in one `envelope-request` control DM (the batch cap). Bounds
 * a single request DM's size and the responder's per-request work; the auto-fetch
 * loop chunks a larger pending set across several requests, subject to the global
 * rate cap (see backfill.ts). Chosen at 50 (well under the 60 msgs/min relay
 * budget when batched, and a comfortable ceiling on JSON size for uuid refs).
 */
export const MAX_REFS_PER_REQUEST = 50;

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
 * (replacing the in-memory mediaStore alt-text hack). `media.sha256` is the
 * author-signed content hash of the attachment (post-attestations, sketch #6)
 * so a re-attached (boosted) media file is verifiable against the hash. `ts`/
 * `pubkey`/`sig` are the attestation fields signed over the canonical payload
 * (see ./attest.ts). `orig` on a boost is the complete signed envelope of the
 * boosted post (embedded verbatim from the message the booster holds), so a
 * recipient who never met the original author can verify it offline (0002).
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
  /**
   * On a reply: a ref to the THREAD ROOT (the topmost post the reply descends
   * from). BOTH its key string AND its `addr` are signed inside the canonical
   * payload (see ./attest.ts, dn3): unlike `ref.addr` (display-only), the root
   * addr is a ROUTING target — it decides who gets the root DM copy — so a
   * relayer must not be able to swap it. Uuid refs only; `parseEnvelope` DROPS a
   * malformed root (missing/empty/non-string `u`, non-string `addr`) to absent
   * rather than carrying junk. Only meaningful on `type:'reply'`; best-effort —
   * omitted when the root is unknowable (a legacy chain, no uuid), never
   * fabricated. A holder of a mid-thread reply can name its thread + owner
   * without the full ancestor chain.
   */
  root?: EnvelopeRef;
  /**
   * Attachment metadata on a post/reply: `description` is persistent + federated
   * alt text; `sha256` is the author-signed content hash of the attached file
   * (post-attestations) so a re-attached copy verifies against the signature.
   */
  media?: { description?: string | null; sha256?: string };
  /**
   * In-band introduction (meta/issues/in-band-introduction.md): the author's
   * multi-use CONTACT invite link, so a stranger holding this (verified) post
   * can securejoin its author on demand — the substrate has no cold 1:1 send.
   * DELIBERATELY unsigned (outside the canonical payload): securejoin links are
   * self-authenticating, and the joiner's mandatory post-join address check is
   * the authenticator — a swapped link either fails the handshake or yields a
   * contact whose addr mismatches. Unsigned also lets authors rotate invites
   * and keeps the dn3 layout stable. Non-string values are dropped at parse.
   */
  invite?: string;
  /**
   * Visibility marker (leak prevention, meta/issues/visibility-leak-prevention.md):
   * 'private' on a content envelope means followers-only — honest receivers
   * refuse to boost/serve it and render it as private. DELIBERATELY UNSIGNED
   * (outside the canonical payload, like `invite`): stripping it requires a
   * peer who could equally leak the content itself; the marker guards honest
   * machinery, not malicious holders. Absent = public. Tolerant parse drops
   * any other value.
   */
  visibility?: 'private';
  /** The emoji of a react/unreact. */
  emoji?: string;
  /** The invite link of an invite-grant. */
  link?: string;
  /**
   * On an invite-request / invite-grant: the SCOPE the request/grant is for
   * (thread-subscribe, design-sketch #3 / meta/issues/thread-subscribe.md).
   * ABSENT = the existing follow-back flow (subscribe to the author's whole
   * FEED) — unchanged, so old nodes and the follow-back regression tests keep
   * working. `{ thread: 'u:<root-uuid>' }` = subscribe to a single THREAD:
   * the requester wants the root author's per-thread broadcast channel. Parsed
   * TOLERANTLY (unknown scope shapes degrade to unscoped) so a future scope kind
   * never breaks an old node. The thread token is `u:<uuid>` (mirrors the wire
   * ref-token grammar) rather than a bare uuid, so the scope space can grow.
   */
  scope?: { thread?: string; locked?: boolean };
  /** Author-declared ms epoch timestamp, signed on every content envelope (sketch #6). */
  ts?: number;
  /** base64 SPKI-DER ed25519 public key of the author (sketch #6). */
  pubkey?: string;
  /** base64 ed25519 signature over the canonical payload (sketch #6). */
  sig?: string;
  /**
   * On a boost: the complete signed envelope of the boosted post, embedded
   * verbatim from the message the booster holds, so recipients who lack the
   * original can verify + render it (sketch #6, decision 0002). Never fabricated
   * or altered — omit the boost's `orig` entirely if the held target is
   * unsigned/legacy (nothing to attest → recipient gets the placeholder ladder).
   */
  orig?: Envelope;
  /**
   * On an `envelope-request` (thread auto-backfill): the batch of post refs being
   * asked for (uuid refs only — legacy mid refs are not requestable). Unsigned,
   * like the react/invite-request control DMs — a request carries no attributable
   * claim, only a question.
   */
  refs?: EnvelopeRef[];
  /**
   * On an `envelope-bundle` (thread auto-backfill): the array of SIGNED envelopes
   * the responder holds for the requested refs, embedded VERBATIM (each is a
   * message-body object, same rule as a boost `orig`). The responder never
   * fabricates and never includes unsigned/legacy content — omission is always
   * valid (0002). Each item is re-verified at RENDER time by the recipient
   * (relayed content is never trusted at ingest, never TOFU-pinned).
   */
  envs?: Envelope[];
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

/** Serialize an envelope object to its wire JSON string. The single serialization seam. */
export const serializeEnvelope = (env: Envelope): string => serialize(env);

/** Attachment fields on a content envelope: federated alt text + author-signed content hash. */
export type MediaEnvelopeFields = { description?: string | null; sha256?: string };

/** Build the `media` sub-object iff it carries a description and/or a sha256 (else undefined). */
const mediaFields = (media?: MediaEnvelopeFields): { media: NonNullable<Envelope['media']> } | {} => {
  if (!media) return {};
  const out: NonNullable<Envelope['media']> = {};
  if (media.description != null) out.description = media.description;
  if (media.sha256) out.sha256 = media.sha256;
  return Object.keys(out).length > 0 ? { media: out } : {};
};

/** A plain post envelope OBJECT (unsigned): minted uuid + human text (+ optional media). */
export const buildPostObject = (
  text: string,
  uuid: string,
  media?: MediaEnvelopeFields,
): Envelope => ({
  dn: DN_VERSION,
  type: 'post',
  uuid,
  text,
  ...mediaFields(media),
});

/**
 * A reply envelope OBJECT (unsigned): minted uuid + human text + parent ref
 * (+ optional thread-root ref + optional media). `root` is the topmost post the
 * thread descends from (best-effort, omitted when unknowable), signed alongside
 * `ref` in the dn3 canonical payload so a mid-thread holder can name the thread.
 */
export const buildReplyObject = (
  text: string,
  uuid: string,
  ref: EnvelopeRef,
  media?: MediaEnvelopeFields,
  root?: EnvelopeRef,
): Envelope => ({
  dn: DN_VERSION,
  type: 'reply',
  uuid,
  text,
  ref,
  ...(root ? { root } : {}),
  ...mediaFields(media),
});

/**
 * A boost envelope OBJECT (unsigned): minted uuid + the boosted post's ref, plus
 * the boosted post's complete signed envelope as `orig` when the booster can
 * attest it (see ./attest.ts + server.ts). Omitting `orig` (unsigned/legacy
 * target) leaves a ref-only boost → the recipient renders the placeholder.
 */
export const buildBoostObject = (uuid: string, ref: EnvelopeRef, orig?: Envelope): Envelope => ({
  dn: DN_VERSION,
  type: 'boost',
  uuid,
  ref,
  ...(orig ? { orig } : {}),
});

/** A plain post envelope: minted uuid + human text (+ optional media alt text). */
export const buildPostEnvelope = (
  text: string,
  uuid: string,
  media?: { description?: string | null },
): string => serialize(buildPostObject(text, uuid, media));

/**
 * A reply envelope: minted uuid + human text + the parent ref (+ optional
 * thread-root ref + optional media alt text).
 */
export const buildReplyEnvelope = (
  text: string,
  uuid: string,
  ref: EnvelopeRef,
  media?: { description?: string | null },
  root?: EnvelopeRef,
): string => serialize(buildReplyObject(text, uuid, ref, media, root));

/**
 * A boost envelope: minted uuid + the boosted post's ref (ref-only, unsigned).
 * The signed/embedding boost path uses `buildBoostObject` + attestation.
 */
export const buildBoostEnvelope = (uuid: string, ref: EnvelopeRef): string =>
  serialize(buildBoostObject(uuid, ref));

/** A reaction control-DM envelope: emoji + the reacted-to post's ref. */
export const buildReactEnvelope = (emoji: string, ref: EnvelopeRef): string =>
  serialize({ dn: DN_VERSION, type: 'react', emoji, ref });

/** A retraction control-DM envelope: emoji + the reacted-to post's ref. */
export const buildUnreactEnvelope = (emoji: string, ref: EnvelopeRef): string =>
  serialize({ dn: DN_VERSION, type: 'unreact', emoji, ref });

/** An invite-request control-DM envelope (follow-back). */
export const buildInviteRequestEnvelope = (): string =>
  serialize({ dn: DN_VERSION, type: 'invite-request' });

/**
 * A LOCKED-scoped invite-request (visibility channels 1B): "please grant me
 * access to your followers-only channel". The receiving owner QUEUES it for
 * approval instead of auto-granting. Downgrade note (same as thread scopes):
 * an old node ignores the unknown `scope` field and would auto-grant its
 * PUBLIC feed — a safe failure (public access is what auto-grant always gave).
 */
export const buildLockedInviteRequestEnvelope = (): string =>
  serialize({ dn: DN_VERSION, type: 'invite-request', scope: { locked: true } });

/** An invite-grant control-DM envelope carrying the feed invite link. */
export const buildInviteGrantEnvelope = (link: string): string =>
  serialize({ dn: DN_VERSION, type: 'invite-grant', link });

/** The scope token for a thread subscription: `u:<root-uuid>` (mirrors the ref-token grammar). */
export const threadScopeToken = (rootUuid: string): string => `u:${rootUuid}`;

/**
 * Recover the root UUID from a thread scope, or null if `scope` is absent /
 * malformed / not a thread scope. Tolerant: an unknown scope shape yields null
 * (treated as unscoped by callers), so a future scope kind never breaks parsing.
 * Only the `u:<uuid>` grammar is accepted; a bare or empty token yields null.
 */
export const threadScopeRootUuid = (scope: Envelope['scope']): string | null => {
  const token = scope?.thread;
  if (typeof token !== 'string' || !token.startsWith('u:')) return null;
  const uuid = token.slice('u:'.length);
  return uuid.length > 0 ? uuid : null;
};

/**
 * A SCOPED invite-request control DM (thread-subscribe): asks the root author to
 * subscribe us to the thread rooted at `rootUuid`. Extends the existing
 * invite-request type with a `scope` — an old node parsing this sees a plain
 * invite-request (the scope is an unknown-but-ignored field) and would grant a
 * FEED follow-back; a thread-aware host reads the scope and grants a thread
 * channel instead.
 */
export const buildThreadInviteRequestEnvelope = (rootUuid: string): string =>
  serialize({
    dn: DN_VERSION,
    type: 'invite-request',
    scope: { thread: threadScopeToken(rootUuid) },
  });

/**
 * A SCOPED invite-grant control DM (thread-subscribe): grants a subscriber the
 * per-thread broadcast channel's invite `link` for the thread rooted at
 * `rootUuid`. The subscriber's ingest joins it as a THREAD subscription (not a
 * followed feed). The thread-so-far envelope-bundle DM(s) follow separately.
 */
export const buildThreadInviteGrantEnvelope = (rootUuid: string, link: string): string =>
  serialize({
    dn: DN_VERSION,
    type: 'invite-grant',
    link,
    scope: { thread: threadScopeToken(rootUuid) },
  });

/**
 * An `envelope-request` control-DM envelope: a batch of post refs (uuid refs) we
 * ask a peer to serve. Unsigned (parity with react/invite-request control DMs).
 * The caller caps the batch at `MAX_REFS_PER_REQUEST`.
 */
export const buildEnvelopeRequest = (refs: EnvelopeRef[]): string =>
  serialize({ dn: DN_VERSION, type: 'envelope-request', refs });

/**
 * An `envelope-bundle` control-DM envelope: the SIGNED envelopes we hold for a
 * peer's request, embedded verbatim. Unsigned wrapper (the trust is per-item:
 * each embedded envelope carries its own `sig`/`pubkey`, re-verified at render).
 */
export const buildEnvelopeBundle = (envs: Envelope[]): string =>
  serialize({ dn: DN_VERSION, type: 'envelope-bundle', envs });

/**
 * Strict parse: returns the envelope iff `text` is a single JSON object with
 * `dn === 2` and a known `type`. Anything else — malformed JSON, a non-object,
 * a wrong/missing `dn`, an unknown `type` — returns null, so the message falls
 * through to the legacy marker parsers or is treated as plain human text (a
 * real chat message from an external sender must never crash or misparse).
 * Unknown fields are ignored (kept on the returned object but never required).
 */
/**
 * The leading balanced JSON OBJECT of `text` (which must start with `{`), or
 * null if braces never balance. A plain character scan that respects string
 * literals and escapes — cheap, pure, and total. Exists solely so
 * `parseEnvelope` can shed trailing junk (see its doc comment); it does NOT
 * validate JSON (the follow-up JSON.parse does).
 */
const leadingJsonObject = (text: string): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
};

export const parseEnvelope = (text: string): Envelope | null => {
  const trimmed = text.trim();
  // Cheap gate before attempting a full parse: an envelope is always a JSON
  // object, so it must start with `{`. Skips JSON.parse on ordinary chat text.
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // TRAILING-JUNK tolerance: while an attachment is still downloading, DC
    // core's msg.text can carry its file-placeholder summary appended to the
    // real body (`{...} [Image – 137.37 KiB]`) — transient on the wire but, if
    // parsed naively, it (a) rendered raw JSON in the streamed frame and (b)
    // mis-keyed the message at ingest (uuid lost → mid key). Recover the
    // LEADING balanced JSON object and parse that; anything after it is
    // ignored. Leading junk still fails the `{` gate above by design.
    const lead = leadingJsonObject(trimmed);
    if (lead === null || lead === trimmed) return null;
    try {
      value = JSON.parse(lead);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj['dn'] !== DN_VERSION) return null;
  const type = obj['type'];
  if (!isEnvelopeType(type)) return null;
  // Tolerant-drop for `root` (same philosophy as a malformed ref degrading):
  // a root that isn't a well-formed uuid ref is treated as ABSENT rather than
  // carried as junk. This matters for verification: the dn2 verify-fallback is
  // gated on root ABSENCE, and an absent root frames identically (`0:`) to an
  // EMPTY key string — so a grafted `{u:'',addr:evil}` must never survive the
  // parse seam. Dropping (not rejecting) keeps foreign messages rendering.
  if (obj['root'] !== undefined && !isWellFormedRootRef(obj['root'])) delete obj['root'];
  // `invite` is an unsigned string-only field (in-band introduction); anything
  // else degrades to absent so downstream code never sees junk.
  if (obj['invite'] !== undefined && typeof obj['invite'] !== 'string') delete obj['invite'];
  // `visibility` (leak prevention): only the literal 'private' means anything;
  // junk degrades to absent (= public).
  if (obj['visibility'] !== undefined && obj['visibility'] !== 'private') delete obj['visibility'];
  return obj as Envelope;
};

/**
 * A well-formed thread-root ref: a `{u, addr?}` object whose `u` is a NON-EMPTY
 * string (roots are uuid refs in practice) and whose `addr`, when present, is a
 * string (the signed rootAddr frame must stay a total string projection).
 * Shared by `parseEnvelope`'s tolerant-drop AND `verify()`'s shape gate
 * (./attest.ts): NESTED envelopes (a boost `orig`, future bundle items) never
 * pass through parseEnvelope, so the verifier applies the same predicate itself
 * — one definition, two seams, no drift.
 */
export const isWellFormedRootRef = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const ref = v as Record<string, unknown>;
  if (typeof ref['u'] !== 'string' || ref['u'].length === 0) return false;
  return ref['addr'] === undefined || typeof ref['addr'] === 'string';
};

const ENVELOPE_TYPES: ReadonlySet<string> = new Set<EnvelopeType>([
  'post',
  'reply',
  'boost',
  'react',
  'unreact',
  'invite-request',
  'invite-grant',
  'envelope-request',
  'envelope-bundle',
]);

const isEnvelopeType = (v: unknown): v is EnvelopeType =>
  typeof v === 'string' && ENVELOPE_TYPES.has(v);

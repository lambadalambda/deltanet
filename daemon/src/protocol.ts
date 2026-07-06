/**
 * deltanet wire convention v0 (see ../DEVLOG.md "experiment findings" +
 * "deltanet wire convention v0"). Replies and boosts are plain-text
 * conventions over the global email Message-ID (`rfc724Mid`), since native
 * cross-chat quotes/reactions are rejected by the chatmail core. These are
 * pure functions: no transport, no store, just text in/text out.
 */

import { randomUUID } from 'node:crypto';

/**
 * A reference to a logical post + the address of the post's author.
 *
 * `key` is the wire ref token, discriminated: a `{ kind: 'uuid' }` targets the
 * author-minted logical-post UUID (wire convention v1), a `{ kind: 'mid' }`
 * targets a canonical rfc724 Message-ID (legacy targets that never minted a
 * uuid). `keyString` is that token's opaque post-key value (the uuid, or the
 * mid) — this is what the store's post-key index (see ../store.ts `postKey`/
 * `resolveKey`) is keyed by, so callers pass `ref.keyString` straight through.
 */
export type MsgRef = { key: RefToken; keyString: string; addr: string };

/** Build a `MsgRef` from a post-key token + author address. */
export const refFromToken = (token: RefToken, addr: string): MsgRef => ({
  key: token,
  keyString: token.kind === 'uuid' ? token.uuid : token.mid,
  addr,
});

/**
 * A ref token targets a logical post either by its author-minted UUID (wire
 * convention v1 — see ../DEVLOG.md) or, for legacy targets that never carried a
 * uuid, by its canonical rfc724 Message-ID. Both are self-describing on the
 * wire: uuid refs carry a `u:` prefix, mid refs are bare. The `u:` prefix is
 * belt-and-braces — a uuidv4 has no `@` and a mid in this deployment always
 * does, so shape alone would suffice — but an explicit tag means a parser never
 * has to guess and stays robust to future mid shapes.
 */
export type RefToken =
  | { kind: 'uuid'; uuid: string }
  | { kind: 'mid'; mid: string };

const UUID_REF_PREFIX = 'u:';

/** Serialize a ref token to its wire form: `u:<uuid>` for uuids, bare mid otherwise. */
export const buildRefToken = (ref: RefToken): string =>
  ref.kind === 'uuid' ? `${UUID_REF_PREFIX}${ref.uuid}` : ref.mid;

/** Parse a wire ref token back into its discriminated form. A `u:`-prefixed token is a uuid ref; anything else is a mid. */
export const parseRefToken = (token: string): RefToken =>
  token.startsWith(UUID_REF_PREFIX)
    ? { kind: 'uuid', uuid: token.slice(UUID_REF_PREFIX.length) }
    : { kind: 'mid', mid: token };

/**
 * Post-uuid marker (wire convention v1, ../DEVLOG.md). Every outgoing status
 * message — feed post, reply, boost, and the DM copy of a reply — carries a
 * final `⚑ <uuid>` line minting an author-assigned logical-post UUIDv4; BOTH
 * copies of one logical reply share ONE uuid, so a node holding either copy (or
 * neither, only a ref) can unify the logical post. `⚑` (pennant) reads sensibly
 * in vanilla Delta Chat and doesn't collide with the other single-glyph markers
 * (`⚓` canonical, `♻` boost, `↳` reply/react, `⇋` invite). This supersedes the
 * `⚓` canonical-mid marker for NEW messages: we stop emitting `⚓` but keep
 * parsing it for legacy data.
 */
const UUID_PREFIX = '⚑ ';

/** Mint a fresh logical-post UUIDv4 (author-side). */
export const mintPostUuid = (): string => randomUUID();

export type ParsedMarkers = {
  /** Body text with the marker line(s) stripped (empty string if the whole text was a boost marker). */
  body: string;
  reply?: MsgRef;
  boost?: MsgRef;
  /** This message's own logical-post UUID, if it carried a `⚑` marker (v1 messages). */
  uuid?: string;
};

const REPLY_PREFIX = '↳re ';
const BOOST_PREFIX = '♻ ';
const REACT_INFIX = ' ↳ ';
const UNREACT_PREFIX = '✖ ↳ ';
/**
 * Canonical-mid marker (see ../meta/issues/canonical-mid-unification.md). A DM
 * copy of a reply carries this final line declaring the *feed copy's* mid — the
 * post's canonical identity — so a recipient who only ever sees the DM copy can
 * still resolve everyone's interactions to the one mid feeds/threads render.
 * `⚓` (anchor) reads sensibly in vanilla Delta Chat and won't collide with the
 * other single-glyph markers. The mid is a whitespace-free Message-ID.
 */
const CANONICAL_PREFIX = '⚓ ';

export type ParsedReaction =
  | { kind: 'react'; emoji: string; ref: RefToken }
  | { kind: 'unreact'; emoji: string; ref: RefToken };

/** A ref token has no whitespace (opaque mid or `u:<uuid>`); addr is the trailing token. */
const MARKER_LINE_RE = /^(\S+) (\S+)$/;

/** The trailing `⚑ <uuid>` line every v1 message carries. */
const uuidLine = (uuid: string): string => `${UUID_PREFIX}${uuid}`;

/**
 * A reply message text: body, blank line, reply marker (targeting the parent's
 * post-key ref token), then the `⚑ <uuid>` line minting THIS reply's own logical
 * UUID. Both copies of one logical reply (feed broadcast + DM) are built with the
 * SAME `uuid`, so a node holding either copy resolves the same logical post. The
 * DM copy no longer carries a `⚓` canonical marker — the uuid subsumes it.
 */
export const buildReplyText = (body: string, ref: MsgRef, uuid: string): string =>
  `${body}\n\n${REPLY_PREFIX}${buildRefToken(ref.key)} ${ref.addr}\n${uuidLine(uuid)}`;

/** A boost message text: the boost marker (targeting the boosted post's ref token) then the `⚑ <uuid>` line. */
export const buildBoostText = (ref: MsgRef, uuid: string): string =>
  `${BOOST_PREFIX}${buildRefToken(ref.key)} ${ref.addr}\n${uuidLine(uuid)}`;

/** A plain post's text: the body then the `⚑ <uuid>` line minting its logical UUID. */
export const buildPostText = (body: string, uuid: string): string =>
  body === '' ? uuidLine(uuid) : `${body}\n${uuidLine(uuid)}`;

const parseMarkerLine = (line: string): MsgRef | null => {
  const match = MARKER_LINE_RE.exec(line);
  if (!match) return null;
  const [, token, addr] = match;
  if (!token || !addr) return null;
  return refFromToken(parseRefToken(token), addr);
};

/** Parse a `⚑ <uuid>` line into its uuid, or null if malformed / not a uuid line. */
const parseUuidLine = (line: string): string | null => {
  if (!line.startsWith(UUID_PREFIX)) return null;
  const uuid = line.slice(UUID_PREFIX.length);
  if (!uuid || /\s/.test(uuid)) return null;
  return uuid;
};

/**
 * Recover THIS message's own logical-post UUID from its trailing `⚑ <uuid>`
 * marker, or null (legacy messages, vanilla-DC posts). Tolerant: the marker
 * must be the *final* line, so marker-shaped text elsewhere never misfires.
 */
export const parsePostUuid = (text: string): string | null => {
  const lines = text.split('\n');
  return parseUuidLine(lines[lines.length - 1] ?? '');
};

/**
 * Tolerant parse: a reply marker must be the *final* line (after peeling any
 * trailing `⚑`/`⚓` marker lines), preceded by a blank line (as `buildReplyText`
 * produces); a boost marker must be the *first* line (with only marker lines
 * after it). Anything else is treated as plain body — we never misfire on
 * ordinary vanilla-DC messages that happen to contain similar glyphs.
 */
export const parseMarkers = (text: string): ParsedMarkers => {
  const rawLines = text.split('\n');

  // Peel a trailing `⚑ <uuid>` line (v1 messages) — every copy carries one — so
  // the reply/boost marker is again the effective final/first line below.
  const uuid = parseUuidLine(rawLines[rawLines.length - 1] ?? '') ?? undefined;
  const afterUuid = uuid !== undefined ? rawLines.slice(0, rawLines.length - 1) : rawLines;

  // Boost: the marker is the FIRST line, and everything after it is marker
  // lines only (the `⚑` uuid line for v1, nothing for legacy). This keeps the
  // "boost marker is the whole logical content" invariant while allowing the
  // trailing uuid line.
  const firstLine = afterUuid[0] ?? '';
  if (firstLine.startsWith(BOOST_PREFIX)) {
    const boost = parseMarkerLine(firstLine.slice(BOOST_PREFIX.length));
    if (boost && afterUuid.length === 1) {
      return { body: '', boost, ...(uuid !== undefined ? { uuid } : {}) };
    }
    return { body: text, ...(uuid !== undefined ? { uuid } : {}) };
  }

  // A legacy DM copy appends a trailing `⚓` canonical marker after the reply
  // marker; peel it too so the reply marker is again the effective final line.
  const hasCanonical =
    afterUuid.length >= 2 && parseCanonicalLine(afterUuid[afterUuid.length - 1] ?? '') !== null;
  const effectiveLines = hasCanonical ? afterUuid.slice(0, afterUuid.length - 1) : afterUuid;
  const lastLine = effectiveLines[effectiveLines.length - 1] ?? '';
  if (lastLine.startsWith(REPLY_PREFIX)) {
    const reply = parseMarkerLine(lastLine.slice(REPLY_PREFIX.length));
    const precedingBlank = effectiveLines[effectiveLines.length - 2] === '';
    if (reply && precedingBlank) {
      const body = effectiveLines.slice(0, effectiveLines.length - 2).join('\n');
      return { body, reply, ...(uuid !== undefined ? { uuid } : {}) };
    }
  }

  // No reply/boost marker: the body is the text with any trailing `⚑` uuid line
  // peeled (a plain v1 post), else the whole text.
  return { body: afterUuid.join('\n'), ...(uuid !== undefined ? { uuid } : {}) };
};

/** Parse a `⚓ <mid>` line into its mid, or null if malformed / not a canonical line. */
const parseCanonicalLine = (line: string): string | null => {
  if (!line.startsWith(CANONICAL_PREFIX)) return null;
  const mid = line.slice(CANONICAL_PREFIX.length);
  // A mid is a single whitespace-free token; reject empty or multi-token.
  if (!mid || /\s/.test(mid)) return null;
  return mid;
};

/**
 * Recover the canonical (feed-copy) mid declared by a LEGACY DM reply copy's
 * trailing `⚓ <mid>` marker, or null. New DM copies no longer emit this (they
 * carry the shared `⚑` uuid instead); kept for parsing pre-v1 data. Tolerant:
 * the marker must be the *final* line.
 */
export const parseCanonicalMid = (text: string): string | null => {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  return parseCanonicalLine(lines[lines.length - 1] ?? '');
};

/** Reaction (like/emoji-react) control-DM text: `"<emoji> ↳ <keyToken>"` (keyToken = `u:<uuid>` or bare mid). */
export const buildReactionText = (emoji: string, ref: RefToken): string =>
  `${emoji}${REACT_INFIX}${buildRefToken(ref)}`;

/** Retraction control-DM text: `"✖ ↳ <keyToken> <emoji>"`. */
export const buildUnreactionText = (emoji: string, ref: RefToken): string =>
  `${UNREACT_PREFIX}${buildRefToken(ref)} ${emoji}`;

/**
 * Recognizes reaction/unreaction control-DM texts — single-line only,
 * tolerant otherwise (returns null for anything else, including
 * reaction-shaped text with trailing lines or missing fields, so we never
 * misfire on ordinary vanilla-DC messages).
 */
export const parseReaction = (text: string): ParsedReaction | null => {
  if (text.includes('\n')) return null;

  if (text.startsWith(UNREACT_PREFIX)) {
    const rest = text.slice(UNREACT_PREFIX.length);
    const lastSpace = rest.lastIndexOf(' ');
    if (lastSpace === -1) return null;
    const token = rest.slice(0, lastSpace);
    const emoji = rest.slice(lastSpace + 1);
    if (!token || !emoji) return null;
    return { kind: 'unreact', emoji, ref: parseRefToken(token) };
  }

  const infixIndex = text.indexOf(REACT_INFIX);
  if (infixIndex === -1) return null;
  const emoji = text.slice(0, infixIndex);
  const token = text.slice(infixIndex + REACT_INFIX.length);
  if (!emoji || !token) return null;
  return { kind: 'react', emoji, ref: parseRefToken(token) };
};

/**
 * Follow-back wire convention (see ../meta/issues/follow-back-invite-request.md):
 * a known contact can *ask* for our feed invite over the shared 1:1 channel,
 * and we reply with the invite link. Both markers are human-readable so a
 * vanilla Delta Chat user seeing them in a DM can still make sense of them.
 */
const INVITE_REQUEST_MARKER = '⇋ invite-request';
const INVITE_GRANT_PREFIX = '⇋ invite ';

/** An invite link is either a chatmail deep link or an OpenPGP fingerprint URI. */
const looksLikeInvite = (link: string): boolean =>
  link.startsWith('https://i.delta.chat/') || link.startsWith('OPENPGP4FPR:');

/** DM text asking a contact to send us their feed invite. */
export const buildInviteRequestText = (): string => INVITE_REQUEST_MARKER;

/**
 * Tolerant parse: true iff the message's *first line* starts with the
 * invite-request marker (trailing text on that line is allowed, e.g. a
 * friendly human-readable explanation). Anything else — including the marker
 * appearing mid-line — is not an invite request, so we never misfire on an
 * ordinary vanilla-DC message that merely mentions the glyph.
 */
export const parseInviteRequest = (text: string): boolean => {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.startsWith(INVITE_REQUEST_MARKER);
};

/** DM text granting a feed invite: `"⇋ invite <link>"`. */
export const buildInviteGrantText = (link: string): string => `${INVITE_GRANT_PREFIX}${link}`;

/**
 * Recover the invite link from a grant DM, or null. The link is validated to
 * actually look like a feed invite (chatmail deep link or `OPENPGP4FPR:`
 * URI) so a grant-shaped message carrying a bogus/hostile URL never reaches
 * `follow()`. Single-line grants only; trailing whitespace is trimmed.
 */
export const parseInviteGrant = (text: string): string | null => {
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (!firstLine.startsWith(INVITE_GRANT_PREFIX)) return null;
  const link = firstLine.slice(INVITE_GRANT_PREFIX.length).trim();
  if (!link || !looksLikeInvite(link)) return null;
  return link;
};

/** Build the freeform `quotedText` bubble vanilla Delta Chat renders. */
export const buildQuotedText = (authorName: string, text: string, cap: number): string => {
  const capped = text.length > cap ? `${text.slice(0, cap)}…` : text;
  return `${authorName}: ${capped}`;
};

/**
 * Best-effort recovery of the author name + text from a quotedText bubble.
 * Looks for a "<name>: " prefix; if none is found (or it doesn't look like
 * a name), the whole string is treated as the text with a null author.
 */
export const parseQuotedAuthor = (
  quotedText: string,
): { authorName: string | null; text: string } => {
  const sepIndex = quotedText.indexOf(': ');
  if (sepIndex === -1) return { authorName: null, text: quotedText };
  const authorName = quotedText.slice(0, sepIndex);
  const text = quotedText.slice(sepIndex + 2);
  return { authorName, text };
};

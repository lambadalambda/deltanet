/**
 * deltanet wire convention v0 (see ../DEVLOG.md "experiment findings" +
 * "deltanet wire convention v0"). Replies and boosts are plain-text
 * conventions over the global email Message-ID (`rfc724Mid`), since native
 * cross-chat quotes/reactions are rejected by the chatmail core. These are
 * pure functions: no transport, no store, just text in/text out.
 */

/** Opaque email Message-ID + the address of the message's author. */
export type MsgRef = { mid: string; addr: string };

export type ParsedMarkers = {
  /** Body text with the marker line stripped (empty string if the whole text was a boost marker). */
  body: string;
  reply?: MsgRef;
  boost?: MsgRef;
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
  | { kind: 'react'; emoji: string; mid: string }
  | { kind: 'unreact'; emoji: string; mid: string };

/** A mid has no whitespace (it's an opaque Message-ID); addr is the trailing token. */
const MARKER_LINE_RE = /^(\S+) (\S+)$/;

export const buildReplyText = (body: string, ref: MsgRef): string =>
  `${body}\n\n${REPLY_PREFIX}${ref.mid} ${ref.addr}`;

/**
 * A reply text with a trailing canonical-mid marker line, for the DM copy of a
 * reply. `canonicalMid` is the feed broadcast copy's mid (the post's canonical
 * identity). Only DM copies carry this — the feed copy keeps `buildReplyText`'s
 * exact format, which is its identity for historical text-matching.
 */
export const buildReplyTextWithCanonical = (
  body: string,
  ref: MsgRef,
  canonicalMid: string,
): string => `${buildReplyText(body, ref)}\n${CANONICAL_PREFIX}${canonicalMid}`;

export const buildBoostText = (ref: MsgRef): string => `${BOOST_PREFIX}${ref.mid} ${ref.addr}`;

const parseMarkerLine = (line: string): MsgRef | null => {
  const match = MARKER_LINE_RE.exec(line);
  if (!match) return null;
  const [, mid, addr] = match;
  if (!mid || !addr) return null;
  return { mid, addr };
};

/**
 * Tolerant parse: a reply marker must be the *final* line, preceded by a
 * blank line (as `buildReplyText` produces); a boost marker must be the
 * *entire* text. Anything else (marker-shaped text embedded elsewhere, or
 * malformed marker lines) is treated as plain body — we never misfire on
 * ordinary vanilla-DC messages that happen to contain similar glyphs.
 */
export const parseMarkers = (text: string): ParsedMarkers => {
  if (text.startsWith(BOOST_PREFIX)) {
    const rest = text.slice(BOOST_PREFIX.length);
    // Must be the whole text: no trailing newline/content after the marker.
    if (!rest.includes('\n')) {
      const boost = parseMarkerLine(rest);
      if (boost) return { body: '', boost };
    }
    return { body: text };
  }

  const lines = text.split('\n');
  // A DM copy appends a trailing canonical-mid marker after the reply marker
  // (see buildReplyTextWithCanonical). Peel it off first so the reply marker is
  // once again the effective final line for the parse below.
  const hasCanonical =
    lines.length >= 2 && parseCanonicalLine(lines[lines.length - 1] ?? '') !== null;
  const effectiveLines = hasCanonical ? lines.slice(0, lines.length - 1) : lines;
  const lastLine = effectiveLines[effectiveLines.length - 1] ?? '';
  if (lastLine.startsWith(REPLY_PREFIX)) {
    const reply = parseMarkerLine(lastLine.slice(REPLY_PREFIX.length));
    const precedingBlank = effectiveLines[effectiveLines.length - 2] === '';
    if (reply && precedingBlank) {
      const body = effectiveLines.slice(0, effectiveLines.length - 2).join('\n');
      return { body, reply };
    }
  }

  return { body: text };
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
 * Recover the canonical (feed-copy) mid declared by a DM reply copy's trailing
 * `⚓ <mid>` marker, or null. Tolerant: the marker must be the *final* line, so
 * marker-shaped text elsewhere never misfires (mirrors the other parsers).
 */
export const parseCanonicalMid = (text: string): string | null => {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  return parseCanonicalLine(lines[lines.length - 1] ?? '');
};

/** Reaction (like/emoji-react) control-DM text: `"<emoji> ↳ <mid>"`. */
export const buildReactionText = (emoji: string, mid: string): string =>
  `${emoji}${REACT_INFIX}${mid}`;

/** Retraction control-DM text: `"✖ ↳ <mid> <emoji>"`. */
export const buildUnreactionText = (emoji: string, mid: string): string =>
  `${UNREACT_PREFIX}${mid} ${emoji}`;

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
    const mid = rest.slice(0, lastSpace);
    const emoji = rest.slice(lastSpace + 1);
    if (!mid || !emoji) return null;
    return { kind: 'unreact', emoji, mid };
  }

  const infixIndex = text.indexOf(REACT_INFIX);
  if (infixIndex === -1) return null;
  const emoji = text.slice(0, infixIndex);
  const mid = text.slice(infixIndex + REACT_INFIX.length);
  if (!emoji || !mid) return null;
  return { kind: 'react', emoji, mid };
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

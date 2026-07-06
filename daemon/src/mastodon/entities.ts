import type { T } from '@deltachat/jsonrpc-client';
import { parseMarkers, parseQuotedAuthor, type MsgRef } from '../protocol.js';

const DC_CONTACT_ID_SELF = 1;

export type MastodonAccount = ReturnType<typeof contactToAccount>;

/** A Mastodon mention entry, as embedded in a status's `mentions` array. */
export type MastodonMention = {
  id: string;
  username: string;
  acct: string;
  url: string;
};

/** Full Mastodon relationship shape (only `following` is ever true today; the rest are honest `false`s). */
export type MastodonRelationship = {
  id: string;
  following: boolean;
  showing_reblogs: boolean;
  notifying: boolean;
  followed_by: boolean;
  blocking: boolean;
  blocked_by: boolean;
  muting: boolean;
  muting_notifications: boolean;
  requested: boolean;
  domain_blocking: boolean;
  endorsed: boolean;
  note: string;
};

export type MastodonStatus = {
  id: string;
  uri: string;
  url: string;
  content: string;
  created_at: string;
  account: MastodonAccount | ReturnType<typeof synthesizeAccount>;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  bookmarked: boolean;
  muted: boolean;
  pinned: boolean;
  media_attachments: ReturnType<typeof mediaAttachments>;
  sensitive: boolean;
  spoiler_text: string;
  visibility: 'public';
  language: null;
  reblog: MastodonStatus | null;
  application: { name: string };
  emojis: unknown[];
  mentions: MastodonMention[];
  tags: unknown[];
  card: null;
  poll: null;
  pleroma: {
    local: boolean;
    conversation_id: number | null;
    emoji_reactions: unknown[];
    quote: null;
    quote_id: null;
    quote_visible: boolean;
  };
};

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const URL_RE = /https?:\/\/[^\s<]+/g;

export const textToHtml = (text: string): string => {
  const linkified = escapeHtml(text).replaceAll(
    URL_RE,
    (url) => `<a href="${url}" rel="nofollow noopener">${url}</a>`,
  );
  return `<p>${linkified.replaceAll('\n', '<br/>')}</p>`;
};

/** First grapheme of a display name, uppercased; '?' for an empty name. */
export const initialOf = (displayName: string): string => {
  if (!displayName) return '?';
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const first = [...segmenter.segment(displayName)][0]?.segment ?? '?';
  return first.toUpperCase();
};

/** Placeholder avatar: the contact's initial on their stable color. */
export const avatarPlaceholderSvg = (initial: string, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
  `<rect width="96" height="96" fill="${escapeHtml(color)}"/>` +
  `<text x="48" y="62" font-size="44" text-anchor="middle" fill="#fff" ` +
  `font-family="sans-serif">${escapeHtml(initial)}</text></svg>`;

/** Default profile header banner: a pleasant generated gradient. */
export const headerSvg = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0%" stop-color="#2a3542"/>` +
  `<stop offset="100%" stop-color="#4a6a8a"/>` +
  `</linearGradient></defs>` +
  `<rect width="1500" height="500" fill="url(#g)"/></svg>`;

export const contactToAccount = (
  contact: T.Contact,
  baseUrl: string,
  relationship?: MastodonRelationship,
) => {
  const username = contact.address.split('@')[0] ?? contact.address;
  return {
    id: String(contact.id),
    username,
    acct: contact.address,
    display_name: contact.displayName,
    note: textToHtml(contact.status),
    url: `${baseUrl}/deltanet/contact/${contact.id}`,
    avatar: `${baseUrl}/deltanet/avatar/${contact.id}`,
    avatar_static: `${baseUrl}/deltanet/avatar/${contact.id}`,
    header: `${baseUrl}/deltanet/header/${contact.id}`,
    header_static: `${baseUrl}/deltanet/header/${contact.id}`,
    created_at: new Date(0).toISOString(),
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    locked: false,
    bot: contact.isBot,
    discoverable: true,
    fields: [],
    emojis: [],
    source: { note: contact.status, fields: [] },
    pleroma: {
      is_admin: false,
      is_moderator: false,
      tags: [],
      ...(relationship ? { relationship } : {}),
    },
  };
};

/** A Mastodon mention entry for `contact`, using the same id/username/acct/url values `contactToAccount` would. */
const contactToMention = (contact: T.Contact, baseUrl: string): MastodonMention => {
  const username = contact.address.split('@')[0] ?? contact.address;
  return {
    id: String(contact.id),
    username,
    acct: contact.address,
    url: `${baseUrl}/deltanet/contact/${contact.id}`,
  };
};

const mediaAttachments = (msg: T.Message, baseUrl: string, description: string | null) => {
  if (!msg.file || !msg.fileMime) return [];
  const kind = msg.fileMime.split('/')[0];
  const type =
    kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'unknown';
  return [
    {
      id: String(msg.id),
      type,
      url: `${baseUrl}/deltanet/blob/${msg.id}`,
      preview_url: `${baseUrl}/deltanet/blob/${msg.id}`,
      remote_url: null,
      description,
    },
  ];
};

/**
 * What `messageToStatus` needs to resolve deltanet wire-convention markers
 * into real Mastodon links/counts. Built in server.ts from the per-account
 * `Store`; defaults to no-op so old call sites (and tests that don't care
 * about threading/boosts) keep working unchanged.
 */
export type StatusResolver = {
  resolveMid(mid: string): number | null;
  childrenCount(mid: string): number;
  boostCount(mid: string): number;
  isOwnBoost(mid: string): boolean;
  /** This message's own mid, if known — needed to look up its reply/boost counts. */
  midForMsgId?(msgId: number): string | null;
  /** Reaction tallies for a mid (see ../store.ts `reactionTallies`); default empty. */
  reactionTallies?(mid: string): { emoji: string; count: number; reactors: string[] }[];
  /** Our own account's address, to compute `favourited`/`me` flags; default null (never "me"). */
  ownAddr?(): string | null;
};

export const noopResolver: StatusResolver = {
  resolveMid: () => null,
  childrenCount: () => 0,
  boostCount: () => 0,
  isOwnBoost: () => false,
  midForMsgId: () => null,
  reactionTallies: () => [],
  ownAddr: () => null,
};

const FAVOURITE_EMOJI = '❤';

/** A minimal, non-resolvable account for a boost/reply whose author we can't map to a real contact. */
/** A minimal, non-resolvable account for an address we can't map to a real contact (e.g. a boost/reply author, or a notification's sender before their contact is known). */
export const synthesizeAccount = (authorName: string | null, addr: string, baseUrl: string) => {
  const username = addr.split('@')[0] ?? addr;
  return {
    id: '0',
    username,
    acct: addr,
    display_name: authorName ?? username,
    note: '',
    url: `${baseUrl}/deltanet/contact/0`,
    avatar: `${baseUrl}/deltanet/avatar/0`,
    avatar_static: `${baseUrl}/deltanet/avatar/0`,
    header: `${baseUrl}/deltanet/header.png`,
    header_static: `${baseUrl}/deltanet/header.png`,
    created_at: new Date(0).toISOString(),
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    locked: false,
    bot: false,
    discoverable: false,
    fields: [],
    emojis: [],
    source: { note: '', fields: [] },
    pleroma: { is_admin: false, is_moderator: false, tags: [] },
  };
};

/** A minimal, non-resolvable status embedded as `reblog` when we can't map the boosted mid to a real message. */
const synthesizeStatus = (ref: MsgRef, quotedText: string | undefined, baseUrl: string): MastodonStatus => {
  const { authorName, text } = parseQuotedAuthor(quotedText ?? '');
  return {
    id: `synthetic:${ref.mid}`,
    uri: `${baseUrl}/deltanet/synthetic/${encodeURIComponent(ref.mid)}`,
    url: `${baseUrl}/deltanet/synthetic/${encodeURIComponent(ref.mid)}`,
    content: textToHtml(text),
    created_at: new Date(0).toISOString(),
    account: synthesizeAccount(authorName, ref.addr, baseUrl),
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    favourites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
    favourited: false,
    reblogged: false,
    bookmarked: false,
    muted: false,
    pinned: false,
    media_attachments: [],
    sensitive: false,
    spoiler_text: '',
    visibility: 'public' as const,
    language: null,
    reblog: null,
    application: { name: 'deltanet' },
    emojis: [],
    mentions: [],
    tags: [],
    card: null,
    poll: null,
    pleroma: {
      local: false,
      conversation_id: null,
      emoji_reactions: [],
      quote: null,
      quote_id: null,
      quote_visible: false,
    },
  };
};

/**
 * `description` is the uploaded alt text for this message's attachment, if
 * we have it on hand (in-memory registry keyed by media/msg id) — chatmail
 * itself has no per-attachment alt text field.
 *
 * `resolver` maps deltanet wire-convention markers (see ../protocol.ts) to
 * real ids/counts via the per-account Store; a boosted/replied-to mid that
 * resolves to a locally-known message needs `resolveMessage` (the raw
 * message + its mapping) to embed the real status — passed as `resolveMessage`
 * since a full recursive mapping needs the message, not just its id.
 */
export const messageToStatus = (
  msg: T.Message,
  baseUrl: string,
  description: string | null = null,
  resolver: StatusResolver = noopResolver,
  resolveMessage: (msgId: number) => T.Message | null = () => null,
): MastodonStatus => {
  const parsed = parseMarkers(msg.text);
  const bodyText = parsed.reply || parsed.boost ? parsed.body : msg.text;

  const replyToMsgId = parsed.reply ? resolver.resolveMid(parsed.reply.mid) : null;
  const inReplyToId =
    replyToMsgId !== null ? String(replyToMsgId) : msg.parentId !== null ? String(msg.parentId) : null;

  // Parent lookup for `in_reply_to_account_id`/`mentions` (at most one extra
  // `resolveMessage` call per status). Self-replies are *not* excluded: we
  // include the mention even when the parent author is SELF, since the
  // "replying to" chip should render for reply chains on your own posts too
  // (unlike upstream Mastodon, which drops the author's own mention from a
  // self-reply's `mentions` array).
  const parentMsg = replyToMsgId !== null ? resolveMessage(replyToMsgId) : null;
  const inReplyToAccountId = parentMsg ? String(parentMsg.sender.id) : null;
  const mentions = parentMsg ? [contactToMention(parentMsg.sender, baseUrl)] : [];

  let reblog = null;
  if (parsed.boost) {
    const boostedMsgId = resolver.resolveMid(parsed.boost.mid);
    const boostedMsg = boostedMsgId !== null ? resolveMessage(boostedMsgId) : null;
    reblog = boostedMsg
      ? messageToStatus(boostedMsg, baseUrl, null, resolver, resolveMessage)
      : synthesizeStatus(parsed.boost, msg.quote?.text, baseUrl);
  }

  const ownMid = resolver.midForMsgId?.(msg.id) ?? null;
  const repliesCount = ownMid ? resolver.childrenCount(ownMid) : 0;
  const reblogsCount = ownMid ? resolver.boostCount(ownMid) : 0;
  const reblogged = ownMid ? resolver.isOwnBoost(ownMid) : false;

  const tallies = ownMid ? (resolver.reactionTallies?.(ownMid) ?? []) : [];
  const ownAddr = resolver.ownAddr?.() ?? null;
  const favouriteTally = tallies.find((t) => t.emoji === FAVOURITE_EMOJI);
  const favouritesCount = favouriteTally?.count ?? 0;
  const favourited = ownAddr !== null && (favouriteTally?.reactors.includes(ownAddr) ?? false);
  const emojiReactions = tallies
    .filter((t) => t.emoji !== FAVOURITE_EMOJI)
    .map((t) => ({ name: t.emoji, count: t.count, me: ownAddr !== null && t.reactors.includes(ownAddr) }));

  return {
    id: String(msg.id),
    uri: `${baseUrl}/deltanet/message/${msg.id}`,
    url: `${baseUrl}/deltanet/message/${msg.id}`,
    content: textToHtml(bodyText),
    created_at: new Date(msg.timestamp * 1000).toISOString(),
    account: contactToAccount(msg.sender, baseUrl),
    in_reply_to_id: inReplyToId,
    in_reply_to_account_id: inReplyToAccountId,
    favourites_count: favouritesCount,
    reblogs_count: reblogsCount,
    replies_count: repliesCount,
    favourited,
    reblogged,
    bookmarked: false,
    muted: false,
    pinned: false,
    media_attachments: mediaAttachments(msg, baseUrl, description),
    sensitive: false,
    spoiler_text: '',
    visibility: 'public' as const,
    language: null,
    reblog,
    application: { name: 'deltanet' },
    emojis: [],
    mentions,
    tags: [],
    card: null,
    poll: null,
    pleroma: {
      local: msg.sender.id === DC_CONTACT_ID_SELF,
      conversation_id: msg.chatId,
      emoji_reactions: emojiReactions,
      quote: null,
      quote_id: null,
      quote_visible: false,
    },
  };
};

/**
 * Mastodon-style pagination header. `ids` is the page being returned,
 * newest first; "next" pages older via max_id, "prev" newer via min_id.
 */
export const timelineLinkHeader = (url: string, ids: string[]): string | null => {
  const newest = ids[0];
  const oldest = ids[ids.length - 1];
  if (newest === undefined || oldest === undefined) return null;
  return `<${url}?max_id=${oldest}>; rel="next", <${url}?min_id=${newest}>; rel="prev"`;
};

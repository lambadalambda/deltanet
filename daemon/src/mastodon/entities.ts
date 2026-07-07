import type { T } from '@deltachat/jsonrpc-client';
import { parseWire } from '../wire.js';

const DC_CONTACT_ID_SELF = 1;

/**
 * The fixed placeholder text for a boost whose target is not locally held
 * (any era). Per decision 0002, deltanet never synthesizes attributed content:
 * an unresolvable boost renders as the BOOSTER's own status with this honest
 * placeholder body and `reblog: null` — never fabricated author content. The
 * frontend distinguishes it via `pleroma.deltanet.placeholder`.
 */
export const BOOST_PLACEHOLDER_TEXT = '[boosted post unavailable]';

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
  account: MastodonAccount;
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
    /**
     * deltanet-specific marker for a status the frontend must render specially.
     * Present only on an unresolvable boost (any era): `placeholder: 'boost'`
     * with the target `ref` so the UI can show an honest "boosted a post that
     * cannot be displayed" affordance instead of attributed content (0002).
     */
    deltanet?: { placeholder: 'boost'; ref: { key: string; addr: string } };
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

/**
 * A minimal Mastodon account built from an address alone, for a notification
 * whose sender is a real (core-PGP-verified on delivery) interaction author
 * whose `Contact` object we don't currently hold. This is NOT synthesized
 * content attribution (decision 0002 governs *statuses/status authors*): the
 * interaction itself was verified by core, we simply lack the contact row to
 * enrich the display. Id `0` marks it as non-resolvable to a local contact.
 */
export const addrToAccount = (addr: string, baseUrl: string) => {
  const username = addr.split('@')[0] ?? addr;
  return {
    id: '0',
    username,
    acct: addr,
    display_name: username,
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
  /** Resolve a POST KEY (a logical-post uuid or a canonical mid) to a locally-held msgId, or null. */
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

/**
 * `description` is the uploaded alt text for this message's attachment, if
 * we have it on hand (in-memory registry keyed by media/msg id) — chatmail
 * itself has no per-attachment alt text field.
 *
 * `resolver` maps the deltanet wire convention (v2 JSON envelopes, or the v0/v1
 * markers read-side — see ../wire.ts) to real ids/counts via the per-account
 * Store; a boosted/replied-to post that resolves to a locally-known message
 * needs `resolveMessage` (the raw message + its mapping) to embed the real
 * status — passed as `resolveMessage` since a full recursive mapping needs the
 * message, not just its id.
 *
 * `description` (explicit alt text passed by the caller) wins; otherwise a v2
 * envelope's own `media.description` field (persistent, federated alt text) is
 * used, so a boosted/timelined image carries its alt text without the caller
 * holding an out-of-band registry entry.
 */
export const messageToStatus = (
  msg: T.Message,
  baseUrl: string,
  description: string | null = null,
  resolver: StatusResolver = noopResolver,
  resolveMessage: (msgId: number) => T.Message | null = () => null,
): MastodonStatus => {
  const parsed = parseWire(msg.text);
  // `parsed.body` is the human text with all protocol structure removed (v2:
  // the envelope's `text` field; legacy: marker/`⚑`/`⚓` lines stripped), so a
  // plain post never renders wire structure in content.
  const bodyText = parsed.body;
  // Alt text: explicit caller value wins; else the v2 envelope's federated
  // `media.description`.
  const altText = description ?? parsed.mediaDescription ?? null;

  // in_reply_to_id comes ONLY from a resolved reply-marker/uuid ref. We do NOT
  // fall back to `msg.parentId`: Delta Chat sets parentId from email References
  // to the PREVIOUS MESSAGE IN THE SAME CHAT, which is not authorship-level
  // reply intent (it made replies render as replying to unrelated posts). An
  // unresolvable ref yields null, consistently with an empty context.
  const replyToMsgId = parsed.reply ? resolver.resolveMid(parsed.reply.keyString) : null;
  const inReplyToId = replyToMsgId !== null ? String(replyToMsgId) : null;

  // Parent lookup for `in_reply_to_account_id`/`mentions` (at most one extra
  // `resolveMessage` call per status). Self-replies are *not* excluded: we
  // include the mention even when the parent author is SELF, since the
  // "replying to" chip should render for reply chains on your own posts too
  // (unlike upstream Mastodon, which drops the author's own mention from a
  // self-reply's `mentions` array).
  const parentMsg = replyToMsgId !== null ? resolveMessage(replyToMsgId) : null;
  const inReplyToAccountId = parentMsg ? String(parentMsg.sender.id) : null;
  const mentions = parentMsg ? [contactToMention(parentMsg.sender, baseUrl)] : [];

  // A boost embeds the recipient's OWN verified copy when the target resolves
  // locally; otherwise (any era) it renders as the BOOSTER's own status with a
  // fixed placeholder body and `reblog: null` — never synthesized/attributed
  // content (decision 0002). `boostPlaceholderRef` marks the latter so the
  // frontend can render an honest "unavailable boost" affordance.
  let reblog: MastodonStatus | null = null;
  let boostPlaceholderRef: { key: string; addr: string } | null = null;
  if (parsed.boost) {
    const boostedMsgId = resolver.resolveMid(parsed.boost.keyString);
    const boostedMsg = boostedMsgId !== null ? resolveMessage(boostedMsgId) : null;
    if (boostedMsg) {
      reblog = messageToStatus(boostedMsg, baseUrl, null, resolver, resolveMessage);
    } else {
      boostPlaceholderRef = { key: parsed.boost.keyString, addr: parsed.boost.addr };
    }
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
    content: textToHtml(boostPlaceholderRef ? BOOST_PLACEHOLDER_TEXT : bodyText),
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
    media_attachments: mediaAttachments(msg, baseUrl, altText),
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
      ...(boostPlaceholderRef
        ? { deltanet: { placeholder: 'boost' as const, ref: boostPlaceholderRef } }
        : {}),
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

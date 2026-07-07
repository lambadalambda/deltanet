import type { T } from '@deltachat/jsonrpc-client';
import { parseWire } from '../wire.js';
import type { Envelope } from '../envelope.js';

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
  /**
   * NON-STANDARD additive field: the contact's display name (local petname
   * override wins, like everywhere else). Chatmail local parts are random
   * registration strings, so anything rendering a mention (the "Replying to"
   * pill) needs the name, not the handle (decision 0001: the API is ours;
   * vanilla clients ignore extra fields).
   */
  display_name: string;
  /** NON-STANDARD: the name THEY chose (see petnames — mirrors account pleroma.deltanet.auth_name). */
  auth_name: string;
  /** NON-STANDARD: MY local key-bound petname for them, when set (never for SELF). */
  petname?: string;
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
     * Present only on a boost rendered as a placeholder (never attributed
     * content, per 0002), with the target `ref`:
     *  - `'boost'`: the boosted post is unavailable/legacy (no embedded signed
     *    envelope to verify) — "boosted a post that cannot be displayed".
     *  - `'boost-unverified'`: an embedded original WAS present but FAILED
     *    verification (bad sig, pin conflict, or media-hash mismatch) — the
     *    republisher may have tampered, so we show a distinguishable
     *    "cannot be verified" affordance instead of the content.
     * `thread_subscribed` is true iff this status is a thread ROOT the user is
     * currently subscribed to (thread-subscribe) — drives the Subscribe/Unsubscribe
     * toggle on the thread view's root status. Present (true) only when subscribed;
     * absent/false otherwise.
     */
    deltanet?: {
      placeholder?: 'boost' | 'boost-unverified';
      ref?: { key: string; addr: string };
      thread_subscribed?: boolean;
    };
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
      // Petnames (see ../meta/issues/petnames.md): `authName` is the name THEY
      // chose (carried on their messages); `name` is MY local override — a
      // key-bound petname, set via changeContactName. `displayName` (mapped to
      // `display_name` above) already prefers the petname; shipping both lets
      // the UI render "TheirName ⟦petname⟧". SELF's `name` is the account's
      // own configured displayname, never a petname.
      deltanet: {
        auth_name: contact.authName,
        ...(contact.id !== 1 && contact.name.trim() ? { petname: contact.name } : {}),
      },
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
export const addrToAccount = (addr: string, baseUrl: string, displayName?: string) => {
  const username = addr.split('@')[0] ?? addr;
  return {
    id: '0',
    username,
    acct: addr,
    // An attested display name (carried by a verified embed) wins; otherwise the
    // addr-derived username. We NEVER invent a display name for an address.
    display_name: displayName ?? username,
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
    pleroma: {
      is_admin: false,
      is_moderator: false,
      tags: [],
      // Addr shells have no contact row, so no petname is possible; the
      // attested display name (when present) is the closest thing to an
      // auth_name we can honestly claim.
      deltanet: { auth_name: displayName ?? '' },
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
    display_name: contact.displayName,
    auth_name: contact.authName,
    ...(contact.id !== 1 && contact.name.trim() ? { petname: contact.name } : {}),
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
 * Media attachments for a VERIFIED boost embed: the bytes physically live on the
 * BOOST message (the booster re-attached the original's file), so the id/url
 * point at the boost message's own blob route, but the alt text comes from the
 * embedded (author-signed) envelope. Empty when the orig declared no media.
 */
const embedMediaAttachments = (
  boostMsg: T.Message,
  baseUrl: string,
  orig: Envelope,
): ReturnType<typeof mediaAttachments> => {
  if (!orig.media?.sha256 || !boostMsg.file || !boostMsg.fileMime) return [];
  return mediaAttachments(boostMsg, baseUrl, orig.media.description ?? null);
};

/**
 * The outcome of the boost-embed rendering ladder for one boost (post
 * attestations, sketch #6 / decision 0002). Computed by the async mapping layer
 * (which alone can hash the attached media file and read the store's pins), then
 * handed to `messageToStatus` so the render stays synchronous and pure.
 *
 *  - `kind: 'verified'`: `orig` is present AND its signature verified AND it is
 *    pin-consistent AND (if it declared media) the boost's attached file hashes
 *    to the signed `media.sha256`. Render `orig` as a real attributed status via
 *    an addr-based account shell — honest attributed content, NOT synthesis.
 *  - `kind: 'unverified'`: `orig` was present but FAILED verification → the
 *    `'boost-unverified'` placeholder (0002: never partial/attributed content).
 *  - absent (`undefined`): no embed to consider; fall through to the local-copy
 *    resolve, then the plain `'boost'` placeholder.
 */
export type BoostEmbed =
  | { kind: 'verified'; orig: Envelope; addr: string }
  | { kind: 'unverified' };

/**
 * Render a VERIFIED embedded original as a real Mastodon status attributed to
 * its author. Attribution: the async mapping layer resolves the author's real
 * DC contact first (the recipient may have MET the author — a boost of carol by
 * bob still lets you use carol's contact profile if you hold one) and passes it
 * as `account`; only when no contact resolves do we fall back to the addr-based
 * account shell (`addrToAccount`, id `0`, `?`-avatar). This function stays pure
 * and transport-unaware — it merely uses the pre-resolved `account` override if
 * given. The nested status IDENTITY never changes (see below); only the
 * `account` object enriches — we still don't hold the post, only the profile.
 *
 * Identity: no local msgId exists for content the recipient never received
 * directly, and 0002 forbids a synthetic-but-attributable id that could be
 * mistaken for a resolvable local status. We give the nested reblog a stable,
 * synthetic-FREE id `orig-<uuid>` (uuid is the author-minted logical-post id) —
 * the frontend treats status ids as opaque strings (verified against a
 * Playwright fixture, e.g. `notif-boost`), and the Mastodon reblog wrapper
 * already nests a full status whose own id is what actions would target; here
 * that id intentionally does not resolve to a local action target.
 *
 * created_at uses the author-declared `orig.ts`; media (if declared + hash-
 * verified upstream) is the boost message's own re-attached file.
 */
export const verifiedEmbedToStatus = (
  orig: Envelope,
  addr: string,
  baseUrl: string,
  boostMsg: T.Message,
  /**
   * Pre-resolved author account (the recipient's real DC contact, via
   * `contactToAccount`). Supplied by the async mapping layer when it holds a
   * contact for `addr`; absent → we fall back to the addr shell. Only this
   * object enriches; the status identity below is unaffected.
   */
  account?: MastodonAccount,
): MastodonStatus => {
  const id = `orig-${orig.uuid ?? 'unknown'}`;
  const createdAt = new Date(orig.ts ?? 0).toISOString();
  return {
    id,
    uri: `${baseUrl}/deltanet/orig/${orig.uuid ?? ''}`,
    url: `${baseUrl}/deltanet/orig/${orig.uuid ?? ''}`,
    content: textToHtml(orig.text ?? ''),
    created_at: createdAt,
    account: account ?? addrToAccount(addr, baseUrl),
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
    media_attachments: embedMediaAttachments(boostMsg, baseUrl, orig),
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
 * Render a HELD foreign envelope (thread auto-backfill) as a thread-participating
 * Mastodon status. Unlike `verifiedEmbedToStatus` (a boost's nested reblog, which
 * is a leaf with no reply linkage), a held reply MUST carry `in_reply_to_id` so
 * the thread view links it to its parent — that linkage is the whole point of
 * backfill (carol sees alice's held posts as REAL threaded statuses). Identity is
 * the same synthetic-free `orig-<uuid>` (non-actionable — interactions are a
 * separate issue), created_at from the author-declared `orig.ts`.
 *
 * `inReplyToId` is the caller-resolved status id of this envelope's reply parent
 * (a local numeric msgId string, or another `orig-<uuid>`), or null. Media is NOT
 * bundled (see the issue): a held post renders with its alt text and NO
 * attachment — the signed `media.sha256` stays in the envelope for a later
 * verified fetch. Attribution: the pre-resolved contact `account` (contact-first)
 * when held, else the addr shell — identical to the verified-embed ladder. Pure.
 */
export const heldEnvelopeToStatus = (
  env: Envelope,
  authorAddr: string,
  baseUrl: string,
  inReplyToId: string | null,
  account?: MastodonAccount,
  threadSubscribed = false,
): MastodonStatus => {
  const parsed = parseWire(env.text ?? '');
  const bodyText = env.type === 'boost' ? '' : (env.text ?? parsed.body);
  return {
    id: `orig-${env.uuid ?? 'unknown'}`,
    uri: `${baseUrl}/deltanet/orig/${env.uuid ?? ''}`,
    url: `${baseUrl}/deltanet/orig/${env.uuid ?? ''}`,
    content: textToHtml(bodyText),
    created_at: new Date(env.ts ?? 0).toISOString(),
    account: account ?? addrToAccount(authorAddr, baseUrl),
    in_reply_to_id: inReplyToId,
    in_reply_to_account_id: null,
    favourites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
    favourited: false,
    reblogged: false,
    bookmarked: false,
    muted: false,
    pinned: false,
    // Media not bundled: alt text is preserved (federated `media.description`),
    // but no attachment is rendered until a later per-item verified fetch.
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
      ...deltanetPleroma(null, threadSubscribed),
    },
  };
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
  /**
   * Thread auto-backfill: if a reply's parent post key resolves to a HELD
   * envelope (not a local message), the `orig-<uuid>` status id it renders under —
   * so a LOCAL reply to a backfilled parent still links into the thread via
   * `in_reply_to_id`. Default null (no held content). Consulted only when the
   * local `resolveMid` misses.
   */
  heldOrigId?(keyString: string): string | null;
  /**
   * thread-subscribe: is this uuid a thread ROOT the user currently subscribes
   * to? Drives `pleroma.deltanet.thread_subscribed` on the root status so the UI
   * shows Subscribe vs Unsubscribe. Default false (no subscriptions).
   */
  isThreadSubscribed?(uuid: string): boolean;
};

export const noopResolver: StatusResolver = {
  resolveMid: () => null,
  childrenCount: () => 0,
  boostCount: () => 0,
  isOwnBoost: () => false,
  midForMsgId: () => null,
  reactionTallies: () => [],
  ownAddr: () => null,
  heldOrigId: () => null,
  isThreadSubscribed: () => false,
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
  /**
   * The precomputed boost-embed decision (post attestations, sketch #6). Only
   * the async mapping layer can compute it (it hashes the boost's attached media
   * and reads the store's pins), so it's injected here to keep the render sync.
   * `undefined` means "no embed considered" — the local-copy resolve then the
   * plain `'boost'` placeholder apply, exactly as before attestations.
   */
  boostEmbed?: BoostEmbed,
  /**
   * Pre-resolved author account for a VERIFIED embed (the recipient's real DC
   * contact, if held). Kept SEPARATE from `boostEmbed` on purpose: `boostEmbed`
   * is the memoized verification VERDICT, whereas contact resolution must stay
   * as fresh as any other contact render (a contact can appear after we first
   * verified). Absent → the addr shell inside `verifiedEmbedToStatus`.
   */
  embedAccount?: MastodonAccount,
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
  // A local reply parent wins; else a HELD (backfilled) parent's `orig-<uuid>` id
  // so the reply still threads into a backfilled ancestor. Null when neither.
  const inReplyToId =
    replyToMsgId !== null
      ? String(replyToMsgId)
      : parsed.reply
        ? (resolver.heldOrigId?.(parsed.reply.keyString) ?? null)
        : null;

  // Parent lookup for `in_reply_to_account_id`/`mentions` (at most one extra
  // `resolveMessage` call per status). Self-replies are *not* excluded: we
  // include the mention even when the parent author is SELF, since the
  // "replying to" chip should render for reply chains on your own posts too
  // (unlike upstream Mastodon, which drops the author's own mention from a
  // self-reply's `mentions` array).
  const parentMsg = replyToMsgId !== null ? resolveMessage(replyToMsgId) : null;
  const inReplyToAccountId = parentMsg ? String(parentMsg.sender.id) : null;
  const mentions = parentMsg ? [contactToMention(parentMsg.sender, baseUrl)] : [];

  // Boost rendering ladder (post attestations, sketch #6 / decision 0002):
  //  (a) own-copy: the target resolves LOCALLY → embed the recipient's own
  //      verified copy (as today), the strongest possible attribution.
  //  (b) verified-orig: the embedded `orig` verified (sig + pin + media hash,
  //      precomputed in `boostEmbed`) → render it as a real status attributed
  //      via an addr-based account shell. Honest attributed content, NOT
  //      synthesis: the signature IS the attribution.
  //  (c) placeholder: `'boost'` (no embed / legacy) or `'boost-unverified'`
  //      (an embed was present but FAILED verification) — never partial or
  //      attributed content (0002).
  let reblog: MastodonStatus | null = null;
  let boostPlaceholder: { placeholder: 'boost' | 'boost-unverified'; key: string; addr: string } | null =
    null;
  if (parsed.boost) {
    const boostedMsgId = resolver.resolveMid(parsed.boost.keyString);
    const boostedMsg = boostedMsgId !== null ? resolveMessage(boostedMsgId) : null;
    if (boostedMsg) {
      // (a) own local copy.
      reblog = messageToStatus(boostedMsg, baseUrl, null, resolver, resolveMessage);
    } else if (boostEmbed?.kind === 'verified') {
      // (b) verified embedded original — attributed via the recipient's real
      // contact (`embedAccount`) when held, else the addr shell.
      reblog = verifiedEmbedToStatus(boostEmbed.orig, boostEmbed.addr, baseUrl, msg, embedAccount);
    } else {
      // (c) placeholder — distinguish a failed-verification embed from an
      // absent/legacy one so the UI can flag tampering.
      boostPlaceholder = {
        placeholder: boostEmbed?.kind === 'unverified' ? 'boost-unverified' : 'boost',
        key: parsed.boost.keyString,
        addr: parsed.boost.addr,
      };
    }
  }

  const ownMid = resolver.midForMsgId?.(msg.id) ?? null;
  const repliesCount = ownMid ? resolver.childrenCount(ownMid) : 0;
  const reblogsCount = ownMid ? resolver.boostCount(ownMid) : 0;
  const reblogged = ownMid ? resolver.isOwnBoost(ownMid) : false;
  // thread-subscribe: flag a status that IS a thread root the user subscribes to.
  const threadSubscribed = parsed.uuid ? resolver.isThreadSubscribed?.(parsed.uuid) ?? false : false;

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
    content: textToHtml(boostPlaceholder ? BOOST_PLACEHOLDER_TEXT : bodyText),
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
      ...deltanetPleroma(boostPlaceholder, threadSubscribed),
    },
  };
};

/**
 * Build the optional `pleroma.deltanet` object from a boost placeholder and/or a
 * thread-subscription flag — merged so a status can carry either or both without
 * clobbering. Omitted entirely when neither applies (the common case).
 */
const deltanetPleroma = (
  boostPlaceholder: { placeholder: 'boost' | 'boost-unverified'; key: string; addr: string } | null,
  threadSubscribed: boolean,
): { deltanet: NonNullable<MastodonStatus['pleroma']['deltanet']> } | {} => {
  if (!boostPlaceholder && !threadSubscribed) return {};
  return {
    deltanet: {
      ...(boostPlaceholder
        ? {
            placeholder: boostPlaceholder.placeholder,
            ref: { key: boostPlaceholder.key, addr: boostPlaceholder.addr },
          }
        : {}),
      ...(threadSubscribed ? { thread_subscribed: true } : {}),
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

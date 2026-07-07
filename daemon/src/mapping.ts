/**
 * Message/notification -> Mastodon JSON mapping, factored out of
 * `server.ts` so the live-ingestion path (`main.ts`) can map a freshly
 * ingested message/notification to exactly the same JSON shape the REST
 * endpoints (`GET /api/v1/timelines/*`, `GET /api/v1/notifications`) return,
 * for streaming over the websocket hub (`streaming.ts`). No divergent
 * mapping logic may exist outside this module.
 */
import type { T } from '@deltachat/jsonrpc-client';
import {
  addrToAccount,
  contactToAccount,
  messageToStatus,
  type BoostEmbed,
  type MastodonStatus,
  type StatusResolver,
} from './mastodon/entities.js';
import { parseWire } from './wire.js';
import { verify, sha256File } from './attest.js';
import type { Envelope } from './envelope.js';
import type { Notification, Store } from './store.js';
import type { Transport } from './transport/types.js';

export type MediaDescriptionLookup = (msgId: number) => string | null;

export type StatusMapper = {
  resolver: StatusResolver;
  /** Our own account's address, cached after the first call. */
  ownAddr(transport: Transport): Promise<string>;
  /** Map a message to a status, resolving reply/boost markers via the store, embedding boosted messages by re-fetching them from the transport. */
  toStatus(transport: Transport, msg: T.Message, description?: string | null): Promise<MastodonStatus>;
};

/**
 * Builds the `{ resolver, ownAddr, toStatus }` trio `server.ts`'s REST
 * handlers and `main.ts`'s live-ingestion path both need, backed by the same
 * `Store` instance and a fixed `baseUrl`. `ownAddr` is memoized across calls
 * (per mapper instance) exactly as `server.ts`'s previous inline
 * `ownAddrCache` was.
 */
export const createStatusMapper = (store: Store, baseUrl: string): StatusMapper => {
  let ownAddrCache: string | null = null;
  // Per-msgId boost-embed verification cache (mapping runs per render, and
  // verification hashes a media file + does ed25519 verify — memoize per boost
  // message so a timeline of the same boost doesn't re-verify each poll).
  const embedCache = new Map<number, BoostEmbed | undefined>();

  const resolver: StatusResolver = {
    resolveMid: (mid) => store.resolveMid(mid),
    childrenCount: (mid) => store.childrenCount(mid),
    boostCount: (mid) => store.boostCount(mid),
    isOwnBoost: (mid) => store.isOwnBoost(mid),
    midForMsgId: (msgId) => store.midForMsgId(msgId),
    reactionTallies: (mid) => store.reactionTallies(mid),
    ownAddr: () => ownAddrCache,
  };

  const ownAddr = async (transport: Transport): Promise<string> => {
    if (ownAddrCache === null) ownAddrCache = (await transport.self()).address;
    return ownAddrCache;
  };

  /**
   * Verify an embedded boost original against the full ladder (sig + TOFU-pin
   * consistency + declared-media content hash). `addr` is the original author's
   * address (carried on the boost ref). The media file being hashed is the BOOST
   * message's OWN re-attached file (`blobPath(boostMsgId)`) — the booster
   * re-attaches the bytes, the author signs their hash. Returns the decision the
   * render ladder consumes. Any failure → `unverified` (0002: placeholder, never
   * partial content).
   */
  const verifyEmbed = async (
    transport: Transport,
    boostMsgId: number,
    orig: Envelope,
    addr: string,
  ): Promise<BoostEmbed> => {
    // 1. Signature over the canonical payload, against the embed's OWN pubkey.
    if (!verify(orig, addr)) return { kind: 'unverified' };
    // 2. Pin consistency (TOFU): a pinned key that DISAGREES with the embed's
    //    pubkey means possible impersonation → unverified. No pin yet → OK
    //    (we never met this author directly; the signature still stands).
    const pinned = store.pinnedKey(addr);
    if (pinned !== null && pinned !== orig.pubkey) return { kind: 'unverified' };
    // 3. Declared media: the boost's attached file must hash to the signed
    //    `media.sha256`. A declared hash with no/failed attachment → unverified.
    if (orig.media?.sha256) {
      const path = await transport.blobPath(boostMsgId).catch(() => null);
      if (!path) return { kind: 'unverified' };
      const actual = await sha256File(path).catch(() => null);
      if (actual !== orig.media.sha256) return { kind: 'unverified' };
    }
    return { kind: 'verified', orig, addr };
  };

  /**
   * The boost-embed decision for a message, memoized per msgId. `undefined` when
   * this isn't a boost carrying an embedded original — the render ladder then
   * uses the local-copy resolve / plain `'boost'` placeholder.
   */
  const boostEmbedFor = async (
    transport: Transport,
    msg: T.Message,
  ): Promise<BoostEmbed | undefined> => {
    if (embedCache.has(msg.id)) return embedCache.get(msg.id);
    const parsed = parseWire(msg.text);
    let decision: BoostEmbed | undefined;
    if (parsed.boost && parsed.boostOrig) {
      // Only compute an embed decision when the local copy WON'T win — if we
      // hold the original, the own-copy branch renders and the embed is moot.
      const localMsgId = store.resolveKey(parsed.boost.keyString);
      if (localMsgId === null) {
        decision = await verifyEmbed(transport, msg.id, parsed.boostOrig, parsed.boost.addr);
      }
    }
    embedCache.set(msg.id, decision);
    return decision;
  };

  const toStatus = async (
    transport: Transport,
    msg: T.Message,
    description: string | null = null,
  ): Promise<MastodonStatus> => {
    await ownAddr(transport); // warm the cache the resolver reads synchronously
    const parsed = parseWire(msg.text);
    // At most one extra fetch each for the boosted message (embedded as
    // `reblog`) and the reply parent (used for `in_reply_to_account_id`/
    // `mentions`) — reused via `resolvedById` below so `messageToStatus`'s
    // single `resolveMessage(msgId)` callback serves both call sites without
    // re-fetching if they ever resolve to the same message.
    const resolvedById = new Map<number, T.Message | null>();
    const fetchOnce = async (msgId: number): Promise<T.Message | null> => {
      if (!resolvedById.has(msgId)) resolvedById.set(msgId, await transport.message(msgId));
      return resolvedById.get(msgId) ?? null;
    };
    if (parsed.boost) {
      const boostedMsgId = store.resolveKey(parsed.boost.keyString);
      if (boostedMsgId !== null) await fetchOnce(boostedMsgId);
    }
    if (parsed.reply) {
      const replyToMsgId = store.resolveKey(parsed.reply.keyString);
      if (replyToMsgId !== null) await fetchOnce(replyToMsgId);
    }
    // Boost-embed verification (post attestations): computed here (async — it
    // hashes the boost's attached media + reads store pins) and handed to the
    // synchronous render.
    const boostEmbed = await boostEmbedFor(transport, msg);
    return messageToStatus(
      msg,
      baseUrl,
      description,
      resolver,
      (msgId) => resolvedById.get(msgId) ?? null,
      boostEmbed,
    );
  };

  return { resolver, ownAddr, toStatus };
};

/** Map a stored `Notification` to the same JSON shape `GET /api/v1/notifications` returns. */
export const mapNotification = async (
  n: Notification,
  transport: Transport,
  mapper: StatusMapper,
  baseUrl: string,
  mediaDescriptionFor: MediaDescriptionLookup,
): Promise<Record<string, unknown>> => {
  const contact = n.accountContactId !== undefined ? await transport.contact(n.accountContactId) : null;
  const account = contact ? contactToAccount(contact, baseUrl) : addrToAccount(n.accountAddr, baseUrl);
  const status =
    n.statusMsgId !== undefined
      ? await (async () => {
          const msg = await transport.message(n.statusMsgId!);
          return msg ? mapper.toStatus(transport, msg, mediaDescriptionFor(msg.id)) : null;
        })()
      : null;
  return {
    id: n.id,
    type: n.type,
    created_at: n.createdAt,
    account,
    status,
    ...(n.emoji !== undefined ? { emoji: n.emoji } : {}),
  };
};

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
  contactToAccount,
  messageToStatus,
  synthesizeAccount,
  type MastodonStatus,
  type StatusResolver,
} from './mastodon/entities.js';
import { parseMarkers } from './protocol.js';
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

  const toStatus = async (
    transport: Transport,
    msg: T.Message,
    description: string | null = null,
  ): Promise<MastodonStatus> => {
    await ownAddr(transport); // warm the cache the resolver reads synchronously
    const parsed = parseMarkers(msg.text);
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
    return messageToStatus(msg, baseUrl, description, resolver, (msgId) => resolvedById.get(msgId) ?? null);
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
  const account = contact ? contactToAccount(contact, baseUrl) : synthesizeAccount(null, n.accountAddr, baseUrl);
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

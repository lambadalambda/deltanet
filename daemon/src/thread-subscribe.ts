/**
 * Thread subscribe — per-thread broadcast channel hosted by the root author
 * (design-sketch #3, layers 2–3; meta/issues/thread-subscribe.md). The INGEST-
 * side wiring + pure helpers, factored out of main.ts so the whole surface is
 * unit-testable against a fake transport + a plain store, mirroring
 * backfill-ingest.ts.
 *
 * Three flows the daemon runs at ingest time:
 *
 *  1. HOST — a scoped invite-request DM (`{type:'invite-request',scope:{thread}}`)
 *     for a thread WE hold: lazily create a per-thread broadcast channel (once),
 *     auto-grant by DMing back a scoped invite-grant, then DM the thread-so-far
 *     as envelope-bundle(s) (same format + signed-only rule as backfill; a
 *     requester is 1:1-reachable by construction — their request DM just arrived,
 *     so we reply via `msg.fromId`). Public-thread semantics: auto-grant.
 *
 *  2. REPUBLISH — a freshly-ingested reply whose SIGNED `root` names a hosted
 *     thread: wrap the reply's SIGNED envelope VERBATIM in an envelope-bundle and
 *     post it into the thread channel. Never alter/fabricate (0002); the host MAY
 *     omit (reply control = moderation). Dedupe: never republish the same uuid
 *     twice.
 *
 *  3. SUBSCRIBE — a scoped invite-grant DM we SOLICITED: securejoin the granted
 *     channel and record it as a THREAD SUBSCRIPTION (not a followed feed — it
 *     must not surface in following()/home). Bundles arriving on a subscribed
 *     thread channel are then admitted through the EXISTING backfill bundle
 *     ingest (held envelopes, render-time verify, no TOFU pins).
 *
 * CRITICAL suppression (issue): none of these create notifications or streaming
 * events, and held envelopes from a thread channel NEVER enter timelines — the
 * thread view (context endpoint) is where subscribed content appears. Enforced
 * structurally: this module only touches the store's thread maps + held state +
 * the backfiller, never the notification store / streaming hub / timeline read.
 */

import type { T } from '@deltachat/jsonrpc-client';
import {
  buildEnvelopeBundle,
  buildThreadInviteGrantEnvelope,
  parseEnvelope,
} from './envelope.js';
import { parseWireThreadInviteRequest, parseWireThreadInviteGrant } from './wire.js';
import { buildServeBundles, processBundle } from './backfill-ingest.js';
import { collectThreadUuids } from './thread-collect.js';
import type { Store } from './store.js';
import type { Transport } from './transport/types.js';
import type { Backfiller } from './backfill.js';

const DC_CONTACT_ID_SELF = 1;

/** The broadcast-channel name for a hosted thread. Human-legible for a vanilla DC viewer. */
export const threadChannelName = (rootUuid: string): string => `Thread ${rootUuid.slice(0, 8)}`;

/**
 * HOST: handle a possible thread invite-request DM. Returns true iff this message
 * WAS a thread invite-request (so the caller SKIPS the plain follow-back grant +
 * notification tail for it). Steps, all best-effort and DM-only:
 *
 *  - ignore feed-chat / SELF messages and non-thread-scoped requests (a plain
 *    follow-back request is NOT ours — return false so the existing follow-back
 *    path handles it unchanged);
 *  - only host a thread WE actually hold the root of (local OR held) — a request
 *    for a thread we don't have the root for is ignored (we can't serve it);
 *  - lazily create the channel (once) + persist the binding;
 *  - auto-grant: DM the scoped invite-grant to `msg.fromId` (the requester is
 *    1:1-reachable — their request just arrived);
 *  - DM the thread-so-far as chunked envelope-bundle(s).
 */
export const handleThreadInviteRequest = async (
  store: Store,
  transport: Transport,
  msg: T.Message,
  isFeedMessage: boolean,
): Promise<boolean> => {
  if (isFeedMessage || msg.fromId === DC_CONTACT_ID_SELF) return false;
  const rootUuid = parseWireThreadInviteRequest(msg.text);
  if (!rootUuid) return false;

  // We can only host a thread whose ROOT we hold (locally or as a held envelope);
  // otherwise there is nothing to accumulate/serve. Silently ignore (the DM was
  // still a thread request, so we consume it — return true).
  const haveRoot = store.resolveKey(rootUuid) !== null || store.heldEnvelope(rootUuid) !== null;
  if (!haveRoot) return true;

  // Lazily create the per-thread channel on first granted subscriber.
  let chatId = store.hostedThreadChatId(rootUuid);
  if (chatId === null) {
    chatId = await transport.createBroadcast(threadChannelName(rootUuid));
    store.addHostedThread(rootUuid, chatId);
  }

  // Auto-grant: the scoped grant DM carrying the channel's invite link. The
  // requester is reachable via the request DM's own sender id (a key-contact).
  const link = await transport.chatInvite(chatId);
  await transport
    .sendControlDm(msg.fromId, buildThreadInviteGrantEnvelope(rootUuid, link))
    .catch((err) => console.error('thread grant DM failed (non-fatal):', err));

  // Thread-so-far bundle(s): every SIGNED envelope we hold for the thread (root +
  // descendants), verbatim — same format + signed-only rule as backfill. The
  // 10-message core join backfill is NOT relied upon.
  const uuids = collectThreadUuids(store, rootUuid);
  const bundles = await buildServeBundles(
    store,
    transport,
    uuids.map((u) => ({ u })),
  );
  for (const body of bundles) {
    await transport
      .sendControlDm(msg.fromId, body)
      .catch((err) => console.error('thread-so-far bundle DM failed (non-fatal):', err));
  }
  return true;
};

/**
 * HOST: republish a freshly-ingested reply into its thread channel iff its SIGNED
 * root names a hosted thread. The reply's message body IS its signed envelope; we
 * wrap it VERBATIM in an envelope-bundle and post it into the channel. Never
 * alter/fabricate (0002); the host MAY omit (moderation) — here we republish
 * every valid signed reply. Dedupe via `store.wasRepublished` so the same uuid is
 * never republished twice (idempotent under repeated ingest / feed+DM copies).
 *
 * Self-echo is naturally idempotent on the subscriber (held-envelope ingest
 * refuses to overwrite a local resolution), so a subscriber who authored a reply
 * seeing it again via the channel is a no-op — asserted in tests.
 *
 * Returns true iff a republication was posted (for tests). Best-effort: a post
 * failure logs + returns false, never throws.
 */
export const republishReplyToThread = async (
  store: Store,
  transport: Transport,
  msg: T.Message,
  isFeedMessage: boolean,
): Promise<boolean> => {
  // Republish from FEED copies only (a reply arrives twice: feed + DM copy) — the
  // signed envelope is byte-identical, and the store's republished set dedupes
  // anyway, but gating on the feed copy avoids a redundant channel post.
  if (!isFeedMessage) return false;
  const env = parseEnvelope(msg.text);
  if (!env || env.type !== 'reply' || !env.uuid) return false;
  // The SIGNED root ref (not display attribution) names the thread + owner.
  const root = env.root;
  if (!root || !('u' in root) || !root.u) return false;
  const chatId = store.hostedThreadChatId(root.u);
  if (chatId === null) return false;
  // Only republish a SIGNED reply (verbatim, attestable). An unsigned/legacy
  // reply has nothing to attest — omit (never fabricate).
  if (!env.sig || !env.pubkey) return false;
  // Dedupe: never republish the same uuid twice.
  if (store.wasRepublished(env.uuid)) return false;
  store.markRepublished(env.uuid);

  const bundle = buildEnvelopeBundle([env]);
  const ok = await transport
    .postToChat(chatId, bundle)
    .then(() => true)
    .catch((err) => {
      console.error('thread republication post failed (non-fatal):', err);
      return false;
    });
  return ok;
};

/**
 * SUBSCRIBER: handle a possible thread invite-grant DM. Returns true iff this
 * message WAS a thread invite-grant we SOLICITED (so the caller skips the plain
 * follow-back path + notification tail). Only auto-joins a grant whose rootUuid
 * has a pending thread request (anti-unsolicited-join gate, like feed grants);
 * an unsolicited scoped grant is consumed (return true) but never joined.
 *
 * Join = securejoin (`follow()`) the granted link, then persist it as a THREAD
 * SUBSCRIPTION (NOT a followed feed) so following()/home exclude it. The pending
 * marker is cleared even if the join throws, so a persistently-failing link never
 * loops re-joining on every restart.
 */
export const handleThreadInviteGrant = async (
  store: Store,
  transport: Transport,
  msg: T.Message,
  isFeedMessage: boolean,
): Promise<boolean> => {
  if (isFeedMessage || msg.fromId === DC_CONTACT_ID_SELF) return false;
  const grant = parseWireThreadInviteGrant(msg.text);
  if (!grant) return false;
  // Unsolicited scoped grant: consume it but never join (same gate as follow-back).
  if (!store.hasPendingThreadRequest(grant.rootUuid)) return true;
  try {
    const chatId = await transport.follow(grant.link);
    store.addThreadSubscription(grant.rootUuid, chatId);
  } catch (err) {
    console.error('thread subscription join failed (non-fatal):', err);
  } finally {
    store.clearPendingThreadRequest(grant.rootUuid);
  }
  return true;
};

/**
 * SUBSCRIBER: admit an envelope-bundle arriving on a SUBSCRIBED THREAD CHANNEL
 * through the EXISTING backfill bundle ingest (held envelopes, render-time
 * verify, no TOFU pins). Returns true iff the message was such a bundle (so the
 * caller skips notification/streaming). Gate: the bundle's chat must be a
 * registered thread-subscription chat — bundles from a feed chat or an unknown
 * chat are NOT admitted here (never serve requests from channels; a channel is
 * one-way, so an `envelope-request` arriving on one is ignored too).
 *
 * `fromContactId` is the channel owner (the message's sender id) — the peer we'd
 * chase transitive refs against, addressed by its message-derived id.
 */
export const handleThreadChannelBundle = (
  store: Store,
  backfiller: Backfiller,
  msg: T.Message,
  nowMs: number,
): boolean => {
  if (!store.isThreadSubscriptionChat(msg.chatId)) return false;
  if (msg.fromId === DC_CONTACT_ID_SELF) return false;
  const env = parseEnvelope(msg.text);
  if (!env || env.type !== 'envelope-bundle') return false;
  const peer = msg.sender?.address;
  if (!peer) return true; // it was a channel bundle; just can't attribute — drop
  processBundle(store, backfiller, peer, msg.fromId, env, nowMs);
  return true;
};

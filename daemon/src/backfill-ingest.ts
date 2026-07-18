/**
 * Thread auto-backfill — the INGEST-side wiring (design-sketch #3,
 * meta/issues/thread-auto-backfill.md): the three things that happen when
 * messages flow through the daemon's ingest hook, factored out of daemon.ts so
 * they're unit-testable against a fake transport + a plain store + a fake
 * backfiller:
 *
 *  1. DANGLING DETECTION — on any content message, enqueue its unresolved
 *     uuid refs `(peer=sender, uuid)` for the auto-fetch loop.
 *  2. SERVE — on an `envelope-request` DIRECT DM (never one relayed inside a
 *     bundle), reply with a size-chunked bundle of the SIGNED envelopes we hold
 *     for the requested uuids (verbatim; unsigned/legacy omitted). Rate-limited
 *     per peer.
 *  3. BUNDLE RECEIPT — on an `envelope-bundle` DM, validate + store each item as
 *     a HELD envelope (no overwrite of a local/held resolution), mark resolved,
 *     and re-run dangling detection on the new items (transitive fill).
 *
 * CRITICAL suppression (issue): NONE of these create notifications or streaming
 * events, and held envelopes NEVER enter timelines. Enforced structurally —
 * this module only calls `store.addHeldEnvelope` / the backfiller / the bundle
 * send, none of which touch the notification store, the streaming hub, or the
 * timeline read path. A caller must invoke `handleBackfillControlDm` BEFORE (or
 * instead of) any notification-deriving pass for these control types (they carry
 * no user-facing interaction), and must skip streaming for them.
 */

import type { T } from '@deltachat/jsonrpc-client';
import { verify } from './attest.js';
import { parseEnvelope, type Envelope } from './envelope.js';
import { danglingTargets, heldDanglingTargets, storableBundleItem } from './heldenvelopes.js';
import { servableEnvelope, chunkBundles } from './bundle.js';
import type { Store } from './store.js';
import type { Transport } from './transport/types.js';
import type { Backfiller } from './backfill.js';

const DC_CONTACT_ID_SELF = 1;

/** Per-peer serve-side response rate limit: max bundle-reply DMs per minute per requester. */
export const MAX_SERVE_RESPONSES_PER_MINUTE = 10;

/** Does the store already resolve this uuid (a local message OR a held envelope)? */
export const resolvesUuid = (store: Store, uuid: string): boolean =>
  store.resolveKey(uuid) !== null || store.heldEnvelope(uuid) !== null;

/**
 * Enqueue the dangling (unresolved) uuid refs of a freshly-ingested content
 * message. Pure decision + a side-effecting enqueue. SELF messages are skipped
 * (we authored them; we hold what they reference, or chose not to). The sender
 * is a MET contact (their message reached us), so the request is never a cold
 * send. No-op for control messages / messages with no requestable refs.
 */
export const enqueueDangling = (store: Store, backfiller: Backfiller, msg: T.Message): void => {
  if (msg.fromId === DC_CONTACT_ID_SELF) return;
  const senderAddr = msg.sender?.address;
  if (!senderAddr) return;
  for (const t of danglingTargets(msg.text, senderAddr, (u) => resolvesUuid(store, u))) {
    // The send target is the sender's MESSAGE-DERIVED contact id (`msg.fromId`) —
    // a KEY-contact core can encrypt to. An addr lookup would land on the keyless
    // address-contact row (see backfill.ts `QueuedRef.peerContactId`).
    backfiller.enqueue({ ...t, peerContactId: msg.fromId });
  }
};

/**
 * Serve an `envelope-request`: look up each requested uuid, collect the SIGNED
 * envelope we hold for it (a local message's body IS its signed envelope; a held
 * envelope is already a signed body), and reply with size-chunked bundle DMs.
 * Omission is always valid — a uuid we don't hold, or hold only as unsigned/
 * legacy, is simply left out (never fabricated). Returns the serialized bundle
 * DM strings to send (empty ⇒ nothing to serve ⇒ no reply). Async only to fetch
 * local message bodies.
 */
export const buildServeBundles = async (
  store: Store,
  transport: Transport,
  refs: Envelope['refs'],
): Promise<string[]> => {
  const envs: Envelope[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    if (!('u' in ref) || !ref.u || seen.has(ref.u)) continue;
    seen.add(ref.u);
    const uuid = ref.u;
    // Restricted own posts are never served: backfill would otherwise hand
    // followers-only/direct content to any met contact who asks.
    if (store.isLockedPost(uuid) || store.isDirectPost(uuid)) continue;
    // Prefer the real local message (strongest source), else a held envelope we
    // can relay onward (both are signed bodies).
    const localMsgId = store.resolveKey(uuid);
    let env: Envelope | null = null;
    if (localMsgId !== null) {
      const msg = await transport.message(localMsgId).catch(() => null);
      env = msg ? parseEnvelope(msg.text) : null;
    } else {
      env = store.heldEnvelope(uuid)?.env ?? null;
    }
    // Restricted wire-marked envelopes are never served onward.
    if (env?.visibility === 'private' || env?.visibility === 'direct') continue;
    const servable = servableEnvelope(env);
    if (servable) envs.push(servable);
  }
  return chunkBundles(envs);
};

/**
 * Process a received `envelope-bundle`: validate + store each item as a held
 * envelope (attributing the ORIGINAL author from the item's own uuid/refs — the
 * author addr is recovered from the ref that requested it, threaded via
 * `attributedAddrFor`), then re-run dangling detection on the new items so a
 * newly-held reply's OWN dangling parent/root is chased next round (transitive,
 * bounded by the backfiller's per-peer round cap). Suppression: only touches the
 * held store + backfiller — never notifications/streaming/timelines.
 *
 * `from` is the peer who sent the bundle (provenance + the peer we chase
 * transitive refs against — by the invariant they hold what their content
 * references); `fromContactId` is that peer's message-derived contact id (the
 * bundle DM's `msg.fromId`), the send target for transitive follow-ups.
 * `nowMs` timestamps the held entries.
 */
export const processBundle = (
  store: Store,
  backfiller: Backfiller,
  from: string,
  fromContactId: number,
  bundle: Envelope,
  nowMs: number,
): void => {
  for (const item of bundle.envs ?? []) {
    const storable = storableBundleItem(item);
    if (!storable || !storable.uuid) continue;
    // Author attribution for verification/render: an item's author addr is not a
    // top-level field. PREFER the addr the backfiller tracked from the ref that
    // requested this uuid (the strong signal — the ref carried the author addr);
    // fall back to a scan of held content that points at this uuid, then to the
    // bundling peer. A wrong guess simply fails render-time verify (dropping the
    // item), never mis-attributes verified content.
    const authorAddr =
      backfiller.attributedAddr(storable.uuid) ?? attributedAddrFor(store, storable.uuid, from);
    // Self-served-bundle pin rule (key confirmation, see
    // ../meta/issues/key-confirmation.md): an item that verifies against the
    // SENDER's OWN address is the author attesting their own envelope over a
    // PGP-verified direct channel — pin it exactly like a direct content
    // delivery would (first-wins; `pinKey` never overwrites). Relayed items
    // (author != sender) still never pin.
    if (storable.pubkey && verify(storable, from)) store.pinKey(from, storable.pubkey);
    const stored = store.addHeldEnvelope(storable, from, fromContactId, authorAddr, nowMs);
    // Whether freshly stored or already held, this uuid is now resolved for the
    // backfiller (release its in-flight lock + clear negative cache).
    backfiller.onResolved(storable.uuid);
    if (!stored) continue;
    // Transitive: the newly-held item's OWN dangling refs (its parent + root)
    // may need chasing — enqueue them against the same peer (who holds them),
    // addressed by the peer's message-derived contact id.
    for (const t of heldDanglingTargets(storable, from, (u) => resolvesUuid(store, u))) {
      backfiller.enqueue({ ...t, peerContactId: fromContactId });
    }
  }
};

/**
 * The author addr to attribute a held bundle item to. A held reply/post does not
 * carry its own author addr on the wire (only its refs' addrs, which point at
 * OTHER posts). The best signal is the ATTRIBUTING ref — the reply/root ref in
 * some already-held or local message that points at THIS uuid and carries the
 * author's addr. Scan for it; fall back to the bundling peer's addr (a weak
 * guess that will simply fail render-time verification if wrong, dropping the
 * item — never mis-attributing verified content, since verify() checks the sig
 * against this exact addr). Pure over the store.
 */
export const attributedAddrFor = (store: Store, uuid: string, from: string): string => {
  // Any held envelope whose ref/root points at `uuid` carries the author's addr.
  for (const heldUuid of store.heldEnvelopeUuids()) {
    const env = store.heldEnvelope(heldUuid)?.env;
    if (!env) continue;
    for (const ref of [env.ref, env.root]) {
      if (ref && 'u' in ref && ref.u === uuid && ref.addr) return ref.addr;
    }
  }
  return from;
};

/**
 * Handle a control DM that MIGHT be a backfill request/bundle. Returns true iff
 * the message was a backfill control envelope (so the caller can SKIP the
 * notification-derive + streaming passes for it — suppression). A request from a
 * contact is served (rate-limited); a bundle is processed into held state. A
 * request/bundle RELAYED inside a bundle never reaches here (we only parse the
 * outer DM body), satisfying "never respond to requests relayed inside bundles".
 *
 * `serveGuard(peer)` is the per-peer serve rate limiter (returns true iff a
 * response is allowed now); injected so the limiter state lives in the caller.
 */
export const handleBackfillControlDm = async (
  store: Store,
  backfiller: Backfiller,
  transport: Transport,
  msg: T.Message,
  isFeedMessage: boolean,
  nowMs: number,
  serveGuard: (peer: string) => boolean,
): Promise<boolean> => {
  // Backfill control DMs are DM-only (like invite-request/grant). A feed-chat
  // message carrying one of these types is ignored as a control (it still flows
  // through normal ingest as content if it is one).
  if (isFeedMessage) return false;
  if (msg.fromId === DC_CONTACT_ID_SELF) return false;
  const env = parseEnvelope(msg.text);
  if (!env) return false;
  const peer = msg.sender?.address;
  if (!peer) return false;

  if (env.type === 'envelope-request') {
    // Serve from any contact, rate-limited per peer.
    if (!serveGuard(peer)) return true;
    const bundles = await buildServeBundles(store, transport, env.refs);
    for (const body of bundles) {
      await transport.sendControlDm(msg.fromId, body).catch((err) => {
        console.error('backfill serve sendControlDm failed (non-fatal):', err);
      });
    }
    return true;
  }

  if (env.type === 'envelope-bundle') {
    processBundle(store, backfiller, peer, msg.fromId, env, nowMs);
    return true;
  }

  return false;
};

/**
 * Startup queue seed (thread auto-backfill): existing stores already contain
 * dangling refs predating this feature (carol's case). Seed the auto-fetch queue
 * from store state — held envelopes' own dangling refs, capped to a burst so a
 * large store doesn't flood the queue at once (the flush's global rate cap then
 * paces the actual sends). Pure decision + enqueue. The dangling refs of LOCAL
 * messages are seeded by the existing startup re-index pass, which runs
 * `enqueueDangling` on each backfilled message (wired in daemon.ts).
 */
export const seedBackfillQueue = (store: Store, backfiller: Backfiller, maxSeed = 200): void => {
  let seeded = 0;
  for (const uuid of store.heldEnvelopeUuids()) {
    if (seeded >= maxSeed) break;
    const held = store.heldEnvelope(uuid);
    if (!held) continue;
    for (const t of heldDanglingTargets(held.env, held.from, (u) => resolvesUuid(store, u))) {
      // Address follow-ups to the peer's persisted message-derived contact id.
      backfiller.enqueue({ ...t, peerContactId: held.fromContactId });
      seeded += 1;
      if (seeded >= maxSeed) break;
    }
  }
};

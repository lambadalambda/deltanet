/**
 * Thread auto-backfill (design-sketch #3, meta/issues/thread-auto-backfill.md):
 * the auto-fetch LOOP that heals dangling reply/boost/root refs by asking the
 * peer who showed them to us. On ingest of a message whose ref doesn't resolve
 * (locally or as a held envelope), we enqueue `(peer=sender, uuid)`; per-peer
 * batches flush into ONE `envelope-request` control DM (60 msgs/min relay budget
 * → batching is mandatory), the peer answers with an `envelope-bundle`, and the
 * new held items may themselves dangle → next round, bounded.
 *
 * The scheduling policy (which refs are eligible under backoff, how to chunk a
 * peer's pending set into request-sized batches) is PURE and unit-tested here;
 * the closure below wires it to an injected clock + send callback + the store's
 * negative-cache, so nothing in this file touches the transport or real time.
 *
 * CRITICAL suppression: this module NEVER creates notifications or streaming
 * events, and held envelopes it stores NEVER enter timelines — they exist only
 * for thread views + status fetch (other people's backfilled history). Enforced
 * structurally: the receive path calls `store.addHeldEnvelope` (which no
 * notification/stream code path reads) and nothing else.
 */

import { MAX_REFS_PER_REQUEST, type EnvelopeRef } from './envelope.js';
import type { BackfillAttempt } from './store.js';

/**
 * A queued backfill target: the uuid we need, the peer (a met contact) to ask,
 * and the ORIGINAL author's addr (from the ref that surfaced this uuid) so a
 * received bundle item can be stored + verified against the right author.
 *
 * `peerContactId` is the peer's MESSAGE-DERIVED DC contact id (`msg.fromId` of
 * the message that surfaced the dangling ref, or of the bundle DM for transitive
 * refs). This — not the addr — is what the request DM is SENT to: DC core 2.x
 * separates KEY-contacts (securejoin/message-derived, e2ee-capable) from
 * ADDRESS-contacts (`createContact`/addr lookup, keyless), and resolving a peer
 * BY ADDRESS lands on the keyless row ("e2e encryption unavailable") even when
 * the key-contact exists. Every working DM send in this codebase targets a
 * message-derived id (e.g. the reply copy uses `target.sender.id`); backfill does
 * the same. The `peer` addr remains only a dedupe/label/negative-cache key.
 */
export type QueuedRef = { uuid: string; peer: string; peerContactId: number; authorAddr: string };

/**
 * Backfill tuning. Defaults chosen for the 60 msgs/min relay budget where USER
 * actions (posts, replies, reactions) must never starve:
 *  - `maxRequestsPerMinute` (4): the global rate cap on request DMs — a small
 *    slice of the 60/min budget, leaving the rest for the user.
 *  - `flushDelayMs` (2000): per-peer batching window; refs that arrive close
 *    together coalesce into ONE request rather than one DM each.
 *  - `maxAttempts` (5): give up on a ref after this many request DMs (peers go
 *    offline; accounts expire at 90 days) so a dead ref never loops forever.
 *  - `backoffBaseMs` (60_000) + `backoffFactor` (4): exponential backoff between
 *    attempts on the SAME ref — 1m, 4m, 16m, 64m — so a temporarily-unreachable
 *    peer is retried without hammering.
 *  - `maxRounds` (10): transitive-fill depth bound per peer chain, so a
 *    pathological reply chain (or a peer feeding us endless new dangling refs)
 *    can't loop unboundedly; combined with the global rate cap this is belt+braces.
 *  - `maxRefsPerRequest`: the per-DM batch cap (envelope.ts).
 */
export type BackfillConfig = {
  maxRequestsPerMinute: number;
  flushDelayMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffFactor: number;
  maxRounds: number;
  maxRefsPerRequest: number;
};

export const DEFAULT_BACKFILL_CONFIG: BackfillConfig = {
  maxRequestsPerMinute: 4,
  flushDelayMs: 2000,
  maxAttempts: 5,
  backoffBaseMs: 60_000,
  backoffFactor: 4,
  maxRounds: 10,
  maxRefsPerRequest: MAX_REFS_PER_REQUEST,
};

/**
 * The earliest ms a ref may be re-attempted given its negative-cache state:
 * `lastAttemptAt + backoffBaseMs * backoffFactor^(attempts-1)`. A never-attempted
 * ref (attempt === null) is eligible immediately (returns 0). Pure.
 */
export const nextEligibleAt = (
  attempt: BackfillAttempt | null,
  cfg: Pick<BackfillConfig, 'backoffBaseMs' | 'backoffFactor'>,
): number => {
  if (!attempt || attempt.attempts <= 0) return 0;
  const delay = cfg.backoffBaseMs * Math.pow(cfg.backoffFactor, attempt.attempts - 1);
  return attempt.lastAttemptAt + delay;
};

/**
 * Is this ref eligible to be requested at `nowMs`? False when it has exhausted
 * `maxAttempts` (give up — dead ref) OR is still inside its backoff window.
 * Pure over the injected attempt state. This is the single gate the flush uses
 * to skip a ref without popping it (so a backed-off ref stays queued for later).
 */
export const isEligible = (
  attempt: BackfillAttempt | null,
  nowMs: number,
  cfg: Pick<BackfillConfig, 'maxAttempts' | 'backoffBaseMs' | 'backoffFactor'>,
): boolean => {
  if (attempt && attempt.attempts >= cfg.maxAttempts) return false;
  return nowMs >= nextEligibleAt(attempt, cfg);
};

/**
 * Chunk a peer's eligible uuids into request-sized batches (`maxRefsPerRequest`
 * each), turning them into typed uuid refs addressed to `peer`. Pure. The rate
 * cap (how many of these batches actually go out this minute) is applied by the
 * caller against the global budget — chunking only shapes the batches.
 */
export const chunkRefs = (uuids: string[], peer: string, maxPerRequest: number): EnvelopeRef[][] => {
  const batches: EnvelopeRef[][] = [];
  for (let i = 0; i < uuids.length; i += maxPerRequest) {
    batches.push(uuids.slice(i, i + maxPerRequest).map((u) => ({ u, addr: peer })));
  }
  return batches;
};

/**
 * A sliding-window rate limiter over request-DM timestamps: given the ms of
 * every request sent in the trailing minute, how many MORE may go out at
 * `nowMs`. Pure. Callers prune old timestamps against `nowMs - 60_000`.
 */
export const remainingBudget = (
  sentTimestamps: number[],
  nowMs: number,
  maxPerMinute: number,
): number => {
  const windowStart = nowMs - 60_000;
  const recent = sentTimestamps.filter((t) => t > windowStart).length;
  return Math.max(0, maxPerMinute - recent);
};

/** The minimal store surface the backfiller needs — the negative-cache methods only. */
export type BackfillStore = {
  backfillAttempt(refUuid: string): BackfillAttempt | null;
  recordBackfillAttempt(refUuid: string, nowMs: number): void;
  clearBackfillAttempt(refUuid: string): void;
};

/**
 * Sends one `envelope-request` control DM to the peer carrying `refs`.
 * `peerContactId` is the peer's message-derived (key-)contact id — the send
 * target; `peer` (the addr) rides along for logging only. Best-effort; may reject.
 */
export type SendRequest = (peer: string, peerContactId: number, refs: EnvelopeRef[]) => Promise<void>;

export type Backfiller = {
  /**
   * Enqueue a backfill target. Deduped: a uuid already queued or already
   * in-flight for the same peer is ignored. Schedules a per-peer flush after
   * `flushDelayMs` (coalescing bursts). No-op for a ref that's already exhausted
   * its attempts (dead — never re-queue).
   */
  enqueue(target: QueuedRef): void;
  /** Flush all peers whose batching window has elapsed, subject to the global rate cap. Returns # of request DMs sent. */
  flush(): Promise<number>;
  /**
   * Mark a uuid resolved (a bundle delivered it, or a local copy arrived):
   * release the in-flight lock and clear its negative cache, so backoff state
   * doesn't linger on a ref we now hold.
   */
  onResolved(uuid: string): void;
  /** Queued (not-yet-sent) uuids for a peer — for tests/introspection. */
  pendingFor(peer: string): string[];
  /** Is a uuid currently in-flight (requested, awaiting a bundle)? */
  isInFlight(uuid: string): boolean;
  /**
   * The ORIGINAL author addr attributed to a uuid when it was enqueued (from the
   * ref that surfaced it), or null if unknown. Used to store + verify a received
   * bundle item against the right author (a signed envelope carries no author
   * field). Retained until `onResolved`.
   */
  attributedAddr(uuid: string): string | null;
  /** Stop the internal timer (if any). */
  stop(): void;
};

/**
 * Build the auto-fetch loop. Injected seams keep it testable:
 *  - `store`: the negative-cache (attempt count + backoff).
 *  - `send`: emits one request DM (the transport wiring lives in main.ts).
 *  - `now`: the clock (tests pass a controllable one).
 *  - `schedule`/`cancel`: timer seam (defaults to setTimeout; tests drive flush
 *    directly and pass no-ops).
 *
 * Rounds are bounded PER PEER: a `roundsByPeer` counter increments each flush for
 * that peer and enqueues from a peer that has hit `maxRounds` are dropped, so a
 * peer that keeps feeding us new dangling refs cannot loop unboundedly.
 */
export const createBackfiller = (opts: {
  store: BackfillStore;
  send: SendRequest;
  config?: Partial<BackfillConfig>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): Backfiller => {
  const cfg: BackfillConfig = { ...DEFAULT_BACKFILL_CONFIG, ...opts.config };
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  // Per-peer pending uuids (insertion-ordered, deduped). Refs move OUT of here
  // into `inFlight` only when actually sent, so a backed-off ref stays queued.
  const pending = new Map<string, Set<string>>();
  // uuids we've sent a request for and are awaiting a bundle on (dedupe across
  // enqueues so a re-seen dangling ref doesn't re-request while one is in flight).
  const inFlight = new Set<string>();
  // Per-peer transitive round counter (bounded by cfg.maxRounds).
  const roundsByPeer = new Map<string, number>();
  // peer addr -> the peer's message-derived contact id (the SEND target; see
  // QueuedRef.peerContactId). Last sighting wins — a contact id is stable per
  // account db, so this is effectively constant per peer.
  const contactIdByPeer = new Map<string, number>();
  // uuid -> attributed author addr (from the surfacing ref), so a received bundle
  // item is stored/verified against the right author. Kept until onResolved.
  const authorByUuid = new Map<string, string>();
  // Sliding-window request-DM timestamps for the global rate cap.
  let sentTimestamps: number[] = [];
  let timer: unknown = null;

  const armTimer = (): void => {
    if (timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void flush();
    }, cfg.flushDelayMs);
  };

  const enqueue = (target: QueuedRef): void => {
    const { uuid, peer } = target;
    if (inFlight.has(uuid)) return;
    // A ref that has already given up (exhausted attempts) is never re-queued.
    const att = opts.store.backfillAttempt(uuid);
    if (att && att.attempts >= cfg.maxAttempts) return;
    // A peer that has already spent its transitive rounds is not chased further.
    if ((roundsByPeer.get(peer) ?? 0) >= cfg.maxRounds) return;
    // Remember the attributed author addr (first attribution wins; a later
    // sighting with a different addr doesn't overwrite an in-flight attribution).
    if (!authorByUuid.has(uuid)) authorByUuid.set(uuid, target.authorAddr);
    contactIdByPeer.set(peer, target.peerContactId);
    const set = pending.get(peer) ?? new Set<string>();
    if (set.has(uuid)) return;
    set.add(uuid);
    pending.set(peer, set);
    armTimer();
  };

  const flush = async (): Promise<number> => {
    const nowMs = now();
    sentTimestamps = sentTimestamps.filter((t) => t > nowMs - 60_000);
    let budget = remainingBudget(sentTimestamps, nowMs, cfg.maxRequestsPerMinute);
    let sent = 0;

    for (const [peer, set] of pending) {
      if (budget <= 0) break;
      // Eligible uuids only (skip backed-off / given-up refs without popping them).
      const eligible = [...set].filter((u) =>
        !inFlight.has(u) && isEligible(opts.store.backfillAttempt(u), nowMs, cfg),
      );
      if (eligible.length === 0) {
        // Nothing eligible right now; if the whole set is given-up, drop it so we
        // don't rescan forever. Otherwise leave it for a later flush (backoff).
        const anyLive = [...set].some(
          (u) => (opts.store.backfillAttempt(u)?.attempts ?? 0) < cfg.maxAttempts,
        );
        if (!anyLive) pending.delete(peer);
        continue;
      }
      const batches = chunkRefs(eligible, peer, cfg.maxRefsPerRequest);
      const round = (roundsByPeer.get(peer) ?? 0) + 1;
      roundsByPeer.set(peer, round);
      const peerContactId = contactIdByPeer.get(peer);
      if (peerContactId === undefined) continue; // unreachable by construction (set on enqueue)
      for (const refs of batches) {
        if (budget <= 0) break;
        try {
          await opts.send(peer, peerContactId, refs);
          for (const ref of refs) {
            const uuid = (ref as { u: string }).u;
            set.delete(uuid);
            inFlight.add(uuid);
            opts.store.recordBackfillAttempt(uuid, nowMs);
          }
          sentTimestamps.push(nowMs);
          budget -= 1;
          sent += 1;
        } catch {
          // A failed send leaves the refs queued (not in-flight, no attempt
          // recorded) so a later flush retries — but stop this peer this round.
          break;
        }
      }
      if (set.size === 0) pending.delete(peer);
    }
    // Re-arm if anything remains queued (backed-off refs awaiting their window).
    if (pending.size > 0) armTimer();
    return sent;
  };

  return {
    enqueue,
    flush,
    onResolved: (uuid) => {
      inFlight.delete(uuid);
      authorByUuid.delete(uuid);
      opts.store.clearBackfillAttempt(uuid);
    },
    pendingFor: (peer) => [...(pending.get(peer) ?? [])],
    isInFlight: (uuid) => inFlight.has(uuid),
    attributedAddr: (uuid) => authorByUuid.get(uuid) ?? null,
    stop: () => {
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
};

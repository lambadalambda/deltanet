/**
 * Derivation pass run over every ingested message: turns Headwater
 * wire-convention markers (see ./protocol.ts) into store side effects —
 * reaction tallies and notifications. Separate from `Store.ingestMessage`
 * (which only maintains the mid/msgId/reply/boost indices) so the
 * notification-producing logic stays independently testable with a plain
 * `Store` + fake messages, no transport required.
 */
import type { T } from '@deltachat/jsonrpc-client';
import { type RefToken } from './protocol.js';
import { buildInviteGrantEnvelope, parseEnvelope } from './envelope.js';
import { parseBodyMentions } from './mentions.js';
import {
  parseWire,
  parseWireInviteGrant,
  parseWireInviteRequest,
  parseWireLockedInviteRequest,
  parseWireReaction,
  parseWireThreadInviteGrant,
  parseWireThreadInviteRequest,
  parseWireUuid,
} from './wire.js';
import type { Notification, Store } from './store.js';
import type { Transport } from './transport/types.js';

const DC_CONTACT_ID_SELF = 1;
const FAVOURITE_EMOJI = '❤';

/**
 * The POST KEY a wire ref token targets: a uuid ref targets the uuid directly;
 * a mid ref canonicalizes via the store (legacy targets / aliased DM copies).
 * This is the single place ref tokens become store post keys in the derive path.
 */
const refKey = (store: Store, ref: RefToken): string =>
  ref.kind === 'uuid' ? ref.uuid : store.canonicalize(ref.mid);

/**
 * Given a message that has just been ingested into the mid/msgId index
 * (`mid` is that message's own rfc724 Message-ID), derive any notification
 * and/or reaction-store side effects implied by its wire-convention markers.
 *
 * - incoming (non-SELF) reply targeting an own mid -> mention notification.
 * - incoming (non-SELF) boost targeting an own mid -> reblog notification.
 * - incoming (non-SELF) reaction/unreaction -> apply/retract in the
 *   reaction store; if the reacted-to mid is our own, also notify
 *   (favourite for ❤, pleroma:emoji_reaction otherwise).
 * - SELF reaction/unreaction control DMs re-derive OUR OWN tally (apply/retract
 *   with `ownAddr`), so a re-index (migration) restores reactions we made —
 *   the endpoints only ever applied them directly, so without this a fresh
 *   store loses them (see ../meta/issues/non-follower-thread-rendering.md).
 *   `ownAddr` is threaded in from the caller (main.ts/server/integration
 *   ingest) since a SELF message's `sender.address` is not reliably our own
 *   canonical address. Requires `ownAddr` to be present; when it's undefined
 *   (a caller that can't know it yet) SELF derivation is skipped.
 * - SELF messages otherwise produce NO notifications and NO reaction side
 *   effects here (and never a follow-back action). The endpoints' direct-apply
 *   of our own reactions stays (idempotent set-add, so a later re-derive is a
 *   no-op).
 *
 * Ordering caveat for the SELF reaction re-derivation: within one chat,
 * `getMessageIds` is chronological, so a react then a later unreact of the same
 * mid replay in order and the retract wins; across chats, ordering is
 * irrelevant since distinct chats hold reactions for distinct mids.
 *
 * Returns the notifications actually created (i.e. not dedupe no-ops) —
 * `Store.addNotification` already reports this per-call via its `| null`
 * return, so this just collects the non-null results. Live ingestion
 * (`main.ts`) uses this to broadcast exactly the newly-derived notifications
 * over the streaming hub without a separate before/after diff against
 * `listNotifications`. SELF re-derivation never produces notifications, so it
 * doesn't affect the return value.
 */
export const deriveOnIngest = (
  store: Store,
  msg: T.Message,
  mid: string,
  ownAddr?: string,
): Notification[] => {
  if (msg.fromId === DC_CONTACT_ID_SELF) {
    // SELF still derives zero notifications and no follow-back actions, but a
    // SELF reaction/unreaction control DM must re-apply OUR OWN tally so a
    // re-indexed store recovers reactions we made. Pure: only touches the
    // reaction store, keyed by our own address.
    if (ownAddr) {
      const reaction = parseWireReaction(msg.text);
      if (reaction) {
        const targetKey = refKey(store, reaction.ref);
        if (reaction.kind === 'react') store.applyReaction(targetKey, ownAddr, reaction.emoji);
        else store.retractReaction(targetKey, ownAddr, reaction.emoji);
      }
    }
    return [];
  }

  const accountAddr = msg.sender.address;
  const accountContactId = msg.fromId;
  const created: Notification[] = [];

  // TOFU key pinning (post-attestations, sketch #6 / decision 0002): this
  // message arrived through normal transport ingestion — a DIRECT delivery,
  // core-PGP verified (any chat type: feed broadcast or DM copy, both are
  // securejoin/Autocrypt-verified channels). If its OUTER envelope carries a
  // signing pubkey, pin `sender.address -> pubkey`, first-wins. We read the
  // pubkey off the outer envelope ONLY — NEVER off an embedded boost `orig`
  // (that would let a booster seed a fake pin for an author they impersonate).
  // The pin is the strong binding a later verification checks against.
  const env = parseEnvelope(msg.text);
  if (env?.pubkey) store.pinKey(accountAddr, env.pubkey);

  const reaction = parseWireReaction(msg.text);
  if (reaction) {
    // Resolve the target to its POST KEY (uuid, or the canonical mid for a mid
    // ref) so an interaction referencing a DM copy applies to (and notifies
    // about) the one logical post. Keeping the key consistent here keeps the
    // dedupe key + notification statusMsgId consistent with the feed copy too.
    const targetKey = refKey(store, reaction.ref);
    if (reaction.kind === 'react') {
      store.applyReaction(targetKey, accountAddr, reaction.emoji);
    } else {
      store.retractReaction(targetKey, accountAddr, reaction.emoji);
    }

    if (reaction.kind === 'react' && store.isOwnMid(targetKey)) {
      const statusMsgId = store.resolveKey(targetKey) ?? undefined;
      const isFavourite = reaction.emoji === FAVOURITE_EMOJI;
      const notification = store.addNotification({
        type: isFavourite ? 'favourite' : 'pleroma:emoji_reaction',
        accountAddr,
        accountContactId,
        ...(isFavourite ? {} : { emoji: reaction.emoji }),
        ...(statusMsgId !== undefined ? { statusMsgId } : {}),
        dedupeMid: targetKey,
        // Fold the emoji into the dedupe key even for favourites (whose
        // stored notification has no `emoji` field) so a ❤ and a distinct
        // emoji reaction from the same reactor on the same post never
        // dedupe against each other.
        dedupeEmoji: reaction.emoji,
      });
      if (notification) created.push(notification);
    }
    return created;
  }

  const parsed = parseWire(msg.text);

  if (parsed.reply) {
    const parentKey = refKey(store, parsed.reply.key);
    if (store.isOwnMid(parentKey)) {
      const notification = store.addNotification({
        type: 'mention',
        accountAddr,
        accountContactId,
        statusMsgId: msg.id,
        dedupeMid: parentKey,
      });
      if (notification) created.push(notification);
    }
  }

  if (parsed.boost) {
    const boostedKey = refKey(store, parsed.boost.key);
    if (store.isOwnMid(boostedKey)) {
      const notification = store.addNotification({
        type: 'reblog',
        accountAddr,
        accountContactId,
        statusMsgId: msg.id,
        dedupeMid: boostedKey,
      });
      if (notification) created.push(notification);
    }
  }

  // Body mentions (see ../meta/issues/mention-addressing-autocomplete.md): a
  // content message whose body carries my `@address` token notifies me —
  // that's the receive half of mention addressing (the send half DM-copies
  // the same envelope here, so this fires even for posters I don't follow).
  // Skipped when this same message already notified as a reply to one of my
  // posts (one logical event, one notification), and deduped by the POST KEY
  // so the feed copy and the mention DM copy collapse.
  if (ownAddr && parsed.body) {
    const alreadyNotifiedAsReply = parsed.reply
      ? store.isOwnMid(refKey(store, parsed.reply.key))
      : false;
    if (!alreadyNotifiedAsReply && parseBodyMentions(parsed.body).includes(ownAddr.toLowerCase())) {
      const postKey = parseWireUuid(msg.text) ?? mid;
      const notification = store.addNotification({
        type: 'mention',
        accountAddr,
        accountContactId,
        statusMsgId: msg.id,
        dedupeMid: postKey,
      });
      if (notification) created.push(notification);
    }
  }

  return created;
};

/**
 * Follow-back actions (see ../meta/issues/follow-back-invite-request.md).
 *
 * Interpreting an invite-request/invite-grant DM requires *async* transport
 * work (replying with our invite, or joining a feed), but `deriveOnIngest`
 * (and the whole store-derivation path) is sync. Rather than force async into
 * it, `deriveFollowbackActions` is a pure, sync function that inspects a
 * message and returns the typed action(s) it implies; the caller (main.ts's
 * ingest hook) executes them against the live `Transport` via
 * `executeFollowbackAction`, and only for *live* (`'combined'`) messages — so
 * a daemon restart replaying old requests never re-answers or re-joins.
 */
export type FollowbackAction =
  /** Reply to `toContactId` with our feed invite (open grant policy v1). */
  | { kind: 'grant-invite'; toContactId: number }
  /** Join `link` (a solicited grant from `fromAddr`) then clear the pending marker. */
  | { kind: 'accept-grant'; link: string; fromAddr: string }
  /**
   * Queue a LOCKED-channel access request for owner approval (visibility
   * channels 1B) — store-only: pending entry + follow_request notification.
   */
  | { kind: 'queue-locked-request'; fromContactId: number; fromAddr: string };

/**
 * Pure: derive the follow-back action(s) implied by a message's marker,
 * gated purely on store/message state (never on transport):
 *
 * - the convention is **DM-only**: `isFeedMessage === true` (a Group/
 *   OutBroadcast/InBroadcast delivery) derives nothing. Without this gate a
 *   broadcast *post* containing `⇋ invite-request` would make every follower
 *   auto-DM the poster a grant — unintended amplification.
 * - a non-SELF `⇋ invite-request` DM -> a `grant-invite` reply action.
 * - a non-SELF `⇋ invite <link>` grant DM -> an `accept-grant` action *only
 *   if* we have a recorded pending request to that sender's address.
 *   Unsolicited grants (no pending entry) return nothing, so they can never
 *   trigger a join.
 *
 * SELF-authored copies of either marker are ignored (we never grant to, or
 * accept from, ourselves).
 */
export const deriveFollowbackActions = (
  store: Store,
  msg: T.Message,
  isFeedMessage: boolean,
): FollowbackAction[] => {
  if (isFeedMessage) return [];
  if (msg.fromId === DC_CONTACT_ID_SELF) return [];
  const text = msg.text;

  // A THREAD-scoped invite-request/grant is NOT a feed follow-back — it belongs
  // to the thread-subscribe path (handled separately in main.ts). Skip it here so
  // a "subscribe to your thread" DM never makes us grant a FEED follow-back, and a
  // scoped grant never joins us to a feed. Unscoped requests/grants (the existing
  // follow-back flow) are unchanged.
  if (parseWireThreadInviteRequest(text) !== null) return [];
  if (parseWireThreadInviteGrant(text) !== null) return [];

  // A LOCKED-scoped request (visibility channels 1B) is QUEUED for approval,
  // never auto-granted — checked before the unscoped match below, which would
  // otherwise treat it as a plain (auto-grant) request.
  if (parseWireLockedInviteRequest(text)) {
    return [{ kind: 'queue-locked-request', fromContactId: msg.fromId, fromAddr: msg.sender.address }];
  }

  if (parseWireInviteRequest(text)) {
    return [{ kind: 'grant-invite', toContactId: msg.fromId }];
  }

  const link = parseWireInviteGrant(text);
  if (link) {
    const fromAddr = msg.sender.address;
    if (store.hasPendingFollowRequest(fromAddr)) {
      return [{ kind: 'accept-grant', link, fromAddr }];
    }
  }

  return [];
};

/**
 * Execute a follow-back action against the live transport. Called ONLY for
 * live (`'combined'`) messages by main.ts's ingest hook.
 *
 * - `grant-invite`: fetch our feed invite and DM it back to the requester.
 * - `accept-grant`: securejoin the feed via `follow()` (which also unblocks a
 *   previously-unfollowed feed), then clear the pending marker. The pending
 *   entry is cleared even if `follow()` throws, so a persistently failing
 *   join never loops re-answering the same grant on every restart.
 */
export const executeFollowbackAction = async (
  store: Store,
  transport: Transport,
  action: FollowbackAction,
): Promise<void> => {
  if (action.kind === 'grant-invite') {
    const invite = await transport.feedInvite();
    await transport.sendControlDm(action.toContactId, buildInviteGrantEnvelope(invite));
    return;
  }

  if (action.kind === 'queue-locked-request') {
    // Store-only: queue for approval + surface a follow_request notification
    // (the frontend's notifications page renders accept/decline for these).
    // Both idempotent, so a duplicate request DM never duplicates state.
    store.addLockedFollowRequest(action.fromAddr, action.fromContactId, Date.now());
    store.addNotification({
      type: 'follow_request',
      accountAddr: action.fromAddr,
      accountContactId: action.fromContactId,
      dedupeMid: `locked-request:${action.fromAddr.toLowerCase()}`,
    });
    return;
  }

  // accept-grant: join, then clear pending regardless of join outcome. A
  // failed join is logged, not thrown: we still clear the pending marker so a
  // persistently-failing link never loops re-answering the same grant.
  try {
    await transport.follow(action.link);
  } catch (err) {
    console.error('follow-back join failed (non-fatal):', err);
  } finally {
    store.clearPendingFollowRequest(action.fromAddr);
  }
};

/**
 * Backfill-only side effect for a follow-back action: pending-state cleanup
 * *without* any network action. A grant that arrived while the daemon was
 * down is replayed by the startup backfill sweep; we must not re-join on it
 * (that's `executeFollowbackAction`'s live-only job), but clearing the now-
 * satisfied pending entry is safe and desirable — otherwise `requested`
 * would stick forever for a follow that already completed before shutdown.
 */
export const cleanupFollowbackAction = (store: Store, action: FollowbackAction): void => {
  if (action.kind === 'accept-grant') store.clearPendingFollowRequest(action.fromAddr);
};

/**
 * The complete follow-back half of the ingest hook, extracted from `main.ts`
 * so the wiring itself is unit-testable (see tests/followback.test.ts):
 *
 * - `'index'` phase: nothing (follow-back is derive-side work).
 * - `'derive'` phase (startup backfill): pending-state cleanup only — never
 *   any network action, so a restart replaying old requests/grants never
 *   re-grants or re-joins (idempotent, safe to run repeatedly).
 * - `'combined'` phase (live): execute the actions against the transport,
 *   but ONLY when `freshlyIngested` is true — `store.ingestMessage`'s
 *   freshness return for this msgId. One live DM can reach the hook several
 *   times (IncomingMsg + the MsgsChanged safety net + repeat MsgsChanged on
 *   state changes), and without this gate a single invite-request would send
 *   one grant DM per delivery. Also skipped when no transport is available
 *   yet (the same startup race main.ts tolerates for streaming): the message
 *   is left un-actioned rather than crashing.
 */
export const runFollowbackOnIngest = async (
  store: Store,
  transport: Transport | null,
  msg: T.Message,
  isFeedMessage: boolean,
  phase: 'combined' | 'index' | 'derive',
  freshlyIngested: boolean,
): Promise<void> => {
  if (phase === 'index') return;
  const actions = deriveFollowbackActions(store, msg, isFeedMessage);

  if (phase === 'derive') {
    for (const action of actions) cleanupFollowbackAction(store, action);
    return;
  }

  if (!freshlyIngested || !transport) return;
  for (const action of actions) {
    try {
      await executeFollowbackAction(store, transport, action);
    } catch (err) {
      console.error('follow-back action failed (non-fatal):', err);
    }
  }
};

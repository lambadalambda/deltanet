/**
 * Derivation pass run over every ingested message: turns deltanet
 * wire-convention markers (see ./protocol.ts) into store side effects —
 * reaction tallies and notifications. Separate from `Store.ingestMessage`
 * (which only maintains the mid/msgId/reply/boost indices) so the
 * notification-producing logic stays independently testable with a plain
 * `Store` + fake messages, no transport required.
 */
import type { T } from '@deltachat/jsonrpc-client';
import { parseMarkers, parseReaction } from './protocol.js';
import type { Notification, Store } from './store.js';

const DC_CONTACT_ID_SELF = 1;
const FAVOURITE_EMOJI = '❤';

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
 * - SELF messages are ingested for `ownMids` bookkeeping elsewhere
 *   (`Store.ingestMessage`) but never produce notifications or reaction
 *   side effects here — the favourite/react endpoints apply our own
 *   reactions to the store directly instead of relying on ingesting our
 *   own outgoing control DM.
 *
 * Returns the notifications actually created (i.e. not dedupe no-ops) —
 * `Store.addNotification` already reports this per-call via its `| null`
 * return, so this just collects the non-null results. Live ingestion
 * (`main.ts`) uses this to broadcast exactly the newly-derived notifications
 * over the streaming hub without a separate before/after diff against
 * `listNotifications`.
 */
export const deriveOnIngest = (store: Store, msg: T.Message, mid: string): Notification[] => {
  if (msg.fromId === DC_CONTACT_ID_SELF) return [];

  const accountAddr = msg.sender.address;
  const accountContactId = msg.fromId;
  const created: Notification[] = [];

  const reaction = parseReaction(msg.text);
  if (reaction) {
    if (reaction.kind === 'react') {
      store.applyReaction(reaction.mid, accountAddr, reaction.emoji);
    } else {
      store.retractReaction(reaction.mid, accountAddr, reaction.emoji);
    }

    if (reaction.kind === 'react' && store.isOwnMid(reaction.mid)) {
      const statusMsgId = store.resolveMid(reaction.mid) ?? undefined;
      const isFavourite = reaction.emoji === FAVOURITE_EMOJI;
      const notification = store.addNotification({
        type: isFavourite ? 'favourite' : 'pleroma:emoji_reaction',
        accountAddr,
        accountContactId,
        ...(isFavourite ? {} : { emoji: reaction.emoji }),
        ...(statusMsgId !== undefined ? { statusMsgId } : {}),
        dedupeMid: reaction.mid,
        // Fold the emoji into the dedupe key even for favourites (whose
        // stored notification has no `emoji` field) so a ❤ and a distinct
        // emoji reaction from the same reactor on the same mid never
        // dedupe against each other.
        dedupeEmoji: reaction.emoji,
      });
      if (notification) created.push(notification);
    }
    return created;
  }

  const parsed = parseMarkers(msg.text);

  if (parsed.reply && store.isOwnMid(parsed.reply.mid)) {
    const notification = store.addNotification({
      type: 'mention',
      accountAddr,
      accountContactId,
      statusMsgId: msg.id,
      dedupeMid: parsed.reply.mid,
    });
    if (notification) created.push(notification);
  }

  if (parsed.boost && store.isOwnMid(parsed.boost.mid)) {
    const notification = store.addNotification({
      type: 'reblog',
      accountAddr,
      accountContactId,
      statusMsgId: msg.id,
      dedupeMid: parsed.boost.mid,
    });
    if (notification) created.push(notification);
  }

  return created;
};

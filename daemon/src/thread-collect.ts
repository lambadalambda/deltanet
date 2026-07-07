/**
 * Thread membership collection (thread-subscribe): the set of post uuids that
 * make up a thread — its root plus every descendant reply — walked over the
 * store's reply graph (local edges + the held reply graph), exactly like the
 * context endpoint's descendant BFS. Pure over the store; used to build the
 * thread-so-far bundle a host sends a new subscriber.
 *
 * WHY a separate module: the collection is a pure store traversal with no
 * transport, so it's unit-testable with a plain store, and both the host grant
 * path and any future thread-request path can share one definition.
 */

import type { Store } from './store.js';

/** Bound the walk so a pathological reply graph can't produce an unbounded set. */
const MAX_THREAD_UUIDS = 500;

/**
 * The uuids of every post in the thread rooted at `rootUuid`: the root itself
 * plus all descendant replies reachable through the reply graph (local children
 * via `replyChildMids`, held children via `heldChildrenOf`). Only UUID keys are
 * collected (legacy mid-only posts aren't backfillable and can't ride a bundle).
 * Deduped, insertion-ordered (root first). Bounded by `MAX_THREAD_UUIDS`.
 */
export const collectThreadUuids = (store: Store, rootUuid: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [rootUuid];
  while (queue.length > 0 && out.length < MAX_THREAD_UUIDS) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    // Only uuid-shaped keys are collectible (a uuid has no '@'; a legacy mid does).
    if (!key.includes('@')) out.push(key);
    for (const childMid of store.replyChildMids(key)) {
      if (!seen.has(childMid)) queue.push(childMid);
    }
    for (const childUuid of store.heldChildrenOf(key)) {
      if (!seen.has(childUuid)) queue.push(childUuid);
    }
  }
  return out;
};

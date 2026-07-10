/**
 * Thread auto-backfill — the SERVE side + bundle chunking (design-sketch #3,
 * meta/issues/thread-auto-backfill.md). PURE helpers: given the envelopes we
 * hold for a peer's requested uuids, select which are SERVABLE (signed content
 * envelopes, embedded VERBATIM — same rule as a boost `orig`; never fabricate,
 * never include unsigned/legacy — omission is always valid, 0002) and chunk them
 * into size-capped bundles. The transport lookup + rate-limit live in server.ts;
 * this file only decides what goes in the bundle and how it's split.
 */

import { serializeEnvelope, buildEnvelopeBundle, type Envelope } from './envelope.js';

/**
 * Max serialized size of one `envelope-bundle` control DM (~100KB). A peer's
 * response that would exceed this is split across several bundle DMs. Kept well
 * under typical mail size limits while letting a normal thread's worth of posts
 * ride in one message.
 */
export const MAX_BUNDLE_BYTES = 100_000;

/**
 * A servable bundle item: the VERBATIM envelope body we hold for a requested
 * uuid, iff it is a SIGNED content envelope. The message body a responder holds
 * for a post/reply/boost IS that post's signed envelope, so serving is a pure
 * pass-through of the parsed body — never a re-synthesis. Returns null to OMIT
 * (unsigned/legacy/control/uuid-less — omission is always valid).
 */
export const servableEnvelope = (env: Envelope | null): Envelope | null => {
  if (!env) return null;
  if (env.type !== 'post' && env.type !== 'reply' && env.type !== 'boost') return null;
  if (env.visibility === 'direct') return null;
  if (typeof env.uuid !== 'string' || env.uuid.length === 0) return null;
  if (!env.sig || !env.pubkey) return null;
  return env;
};

/**
 * Split servable envelopes into bundle DMs each under `maxBytes` serialized. A
 * single envelope larger than `maxBytes` still ships alone (we never drop a
 * legitimate held item — a giant post is rare and one oversized DM is better
 * than silent omission). Pure; returns the serialized bundle DM strings ready to
 * send. Empty input → no bundles (a request we can serve NOTHING for gets no
 * reply — omission is valid, and an empty bundle would be pure noise).
 */
export const chunkBundles = (envs: Envelope[], maxBytes = MAX_BUNDLE_BYTES): string[] => {
  const bundles: string[] = [];
  let batch: Envelope[] = [];
  const flush = (): void => {
    if (batch.length > 0) bundles.push(buildEnvelopeBundle(batch));
    batch = [];
  };
  for (const env of envs) {
    const itemBytes = Buffer.byteLength(serializeEnvelope(env), 'utf8');
    // Start a fresh bundle if adding this item would blow the cap (unless the
    // current batch is empty — a single oversized item ships alone).
    const projected = Buffer.byteLength(buildEnvelopeBundle([...batch, env]), 'utf8');
    if (batch.length > 0 && projected > maxBytes) flush();
    batch.push(env);
    // If even this one item alone exceeds the cap, ship it immediately as its
    // own bundle so the next item starts clean.
    if (batch.length === 1 && itemBytes > maxBytes) flush();
  }
  flush();
  return bundles;
};

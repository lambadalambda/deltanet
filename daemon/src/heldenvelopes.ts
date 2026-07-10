/**
 * Thread auto-backfill (design-sketch #3, meta/issues/thread-auto-backfill.md):
 * PURE helpers over held foreign envelopes — the dangling-ref detection that
 * feeds the auto-fetch queue, the bundle-item validation that gates what a
 * received bundle may store, and the render-time verification of a held envelope
 * through the EXACT existing attestation ladder (reused, never reimplemented).
 *
 * WHY a separate module: keeping this transport/store-free means the whole
 * backfill decision surface (which refs dangle, which bundle items are
 * well-formed, whether a held envelope renders) is unit-testable with plain
 * objects — no relay, no DC messages. The store I/O and the request scheduling
 * live elsewhere (store.ts / backfill.ts); this file only decides.
 */

import { parseWire } from './wire.js';
import { verify } from './attest.js';
import { envelopeRefAddr, type Envelope, type EnvelopeRef } from './envelope.js';

/**
 * A backfill target: the uuid we need and the peer to ask. The peer is ALWAYS
 * the sender of the message carrying the dangling ref — the load-bearing
 * invariant (you cannot reference a message you never held, so the sender holds
 * it). That sender is a MET contact (their message reached us → core has their
 * key), so a request to them is never a cold send.
 */
export type BackfillTarget = {
  uuid: string;
  peer: string;
  /**
   * The ORIGINAL author's addr, as attributed by the ref that surfaced this uuid
   * (a reply/boost/root ref carries the author's addr). Threaded through the
   * request round so the received bundle item can be stored + verified against
   * the RIGHT author (a signed envelope doesn't carry its own author addr).
   */
  authorAddr: string;
};

/** True iff a wire ref is a REQUESTABLE uuid ref (legacy mid refs are not backfillable). */
export const isUuidRef = (ref: EnvelopeRef): ref is { u: string; addr?: string } =>
  'u' in ref && typeof ref.u === 'string' && ref.u.length > 0;

/**
 * The uuid refs a message points at that a peer could serve: its reply parent,
 * its boost target, and its thread root (all uuid refs; mid refs skipped). Pure
 * over the message text via `parseWire`. The `peer` for every returned target is
 * `senderAddr` — the sender always holds what they reference.
 *
 * `resolves(uuid)` is the caller's "do we already have this?" predicate (local
 * message OR held envelope); a ref that already resolves is NOT a dangling
 * target. Deduped by uuid. Returns [] for a message with no requestable refs.
 */
export const danglingTargets = (
  text: string,
  senderAddr: string,
  resolves: (uuid: string) => boolean,
): BackfillTarget[] => {
  const parsed = parseWire(text);
  const out: BackfillTarget[] = [];
  const seen = new Set<string>();
  const consider = (
    keyString: string | undefined,
    kind: 'uuid' | 'mid' | undefined,
    addr: string | undefined,
  ): void => {
    // Only uuid refs are requestable; parseWire's MsgRef carries the discriminated
    // token, so we can tell a uuid ref from a legacy mid ref.
    if (kind !== 'uuid' || !keyString || seen.has(keyString)) return;
    if (resolves(keyString)) return;
    seen.add(keyString);
    // The ref carries the author's addr (parseWire normalizes it onto `.addr`);
    // fall back to the sender if a uuid ref omitted its addr (still requestable,
    // just verified against the sender as a weak default).
    out.push({ uuid: keyString, peer: senderAddr, authorAddr: addr || senderAddr });
  };
  consider(parsed.reply?.keyString, parsed.reply?.key.kind, parsed.reply?.addr);
  consider(parsed.boost?.keyString, parsed.boost?.key.kind, parsed.boost?.addr);
  consider(parsed.root?.keyString, parsed.root?.key.kind, parsed.root?.addr);
  return out;
};

/**
 * The uuid refs a HELD envelope points at (its reply parent + thread root) —
 * used to chase transitive ancestors after a bundle lands. Same shape as
 * `danglingTargets` but sourced from an already-parsed held envelope's own
 * fields (its `ref`/`root`), and the peer is the envelope's provenance addr
 * (`from` — the bundling peer, who by the same invariant holds what the bundled
 * content references). Boost targets are not chased from held content (a held
 * boost's orig is embedded, not separately requestable here).
 */
export const heldDanglingTargets = (
  env: Envelope,
  from: string,
  resolves: (uuid: string) => boolean,
): BackfillTarget[] => {
  const out: BackfillTarget[] = [];
  const seen = new Set<string>();
  const consider = (ref: EnvelopeRef | undefined): void => {
    if (!ref || !isUuidRef(ref)) return;
    const uuid = ref.u;
    if (seen.has(uuid) || resolves(uuid)) return;
    seen.add(uuid);
    out.push({ uuid, peer: from, authorAddr: envelopeRefAddr(ref) || from });
  };
  consider(env.ref);
  consider(env.root);
  return out;
};

/**
 * Validate one bundle item as a well-formed, storable held envelope: it must be
 * a content envelope (post/reply/boost) carrying a uuid AND a signature
 * (`sig`+`pubkey`). The responder is supposed to send only SIGNED envelopes it
 * holds verbatim; this is the recipient-side gate that drops anything else
 * (unsigned, control-typed, uuid-less) BEFORE it reaches the store. Verification
 * of the signature itself is deferred to render (pins can change), but a
 * *structurally* unsigned item can never become renderable, so we reject it now.
 * Pure; returns the envelope narrowed as storable, or null.
 */
export const storableBundleItem = (env: Envelope): Envelope | null => {
  if (env.type !== 'post' && env.type !== 'reply' && env.type !== 'boost') return null;
  if (env.visibility === 'direct') return null;
  if (typeof env.uuid !== 'string' || env.uuid.length === 0) return null;
  if (!env.sig || !env.pubkey) return null;
  return env;
};

/**
 * Render-time verification of a held envelope against `authorAddr`, through the
 * EXACT `verify()` seam (sig over canonical payload, against the envelope's OWN
 * pubkey) plus TOFU-pin consistency — the same ladder the boost embed uses
 * (mapping.ts `verifyEmbed`), minus the media-hash step (media is not bundled;
 * a held post renders with alt text + no attachment — deferred, see the issue).
 *
 *  - signature must verify under `verify(env, authorAddr)`;
 *  - if we hold a TOFU pin for `authorAddr`, the envelope's pubkey must match it
 *    (a pin that DISAGREES means possible impersonation → unverified). No pin →
 *    OK (we never met this author directly; the signature still stands).
 *
 * `pinnedKey(addr)` is injected (the store's pin lookup). Pure over its inputs.
 * A false result means the caller renders NOTHING for this held envelope (an
 * unresolvable ancestor needs no placeholder) and drops it from the store.
 */
export const verifyHeld = (
  env: Envelope,
  authorAddr: string,
  pinnedKey: (addr: string) => string | null,
): boolean => {
  if (!verify(env, authorAddr)) return false;
  const pinned = pinnedKey(authorAddr);
  if (pinned !== null && pinned !== env.pubkey) return false;
  return true;
};

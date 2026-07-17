import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono, type Context, type Next } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { UpgradeWebSocket, WSEvents } from 'hono/ws';
import type { T } from '@deltachat/jsonrpc-client';
import {
  addrToAccount,
  avatarPlaceholderSvg,
  contactToAccount,
  headerSvg,
  timelineLinkHeader,
  type MastodonRelationship,
  type MastodonStatus,
} from './mastodon/entities.js';
import type { OwnChannel, Transport } from './transport/types.js';
import {
  createMediaStore,
  isSupportedImageMime,
  MediaCapacityError,
  MediaDescriptionTooLargeError,
  MediaTooLargeError,
  type MediaRecord,
} from './media.js';
import { parseCanonicalMid, type RefToken } from './protocol.js';
import {
  buildBoostObject,
  buildEnvelopeRequest,
  buildInviteGrantEnvelope,
  buildInviteRequestEnvelope,
  buildLockedInviteRequestEnvelope,
  buildPostObject,
  buildReactEnvelope,
  buildReplyObject,
  buildThreadInviteRequestEnvelope,
  buildUnreactEnvelope,
  envelopeRefAddr,
  envelopeRefKeyString,
  mintUuid,
  parseEnvelope,
  refTokenToEnvelopeRef,
  serializeEnvelope,
  type Envelope,
  type EnvelopeRef,
} from './envelope.js';
import { isSearchableContent, parseWire, parseWireUuid } from './wire.js';
import { openAttestor, sha256File } from './attest.js';
import { parseBodyMentions, rankedContactMatches, rankedContactSearch } from './mentions.js';
import {
  BackupDecodeError,
  BackupSizeError,
  BACKUP_MAGIC,
  backupPrefixLength,
  backupFilename,
  decodeBackupPrefix,
  encodeBackupPrefix,
  type BackupSidecar,
} from './backup.js';
import {
  createStore,
  ephemeralStorePath,
  StoreCorruptionError,
  type Store,
} from './store.js';
import { deriveOnIngest } from './ingest.js';
import { createStatusMapper, mapNotification } from './mapping.js';
import { createStreamingEvents, type StreamingHub } from './streaming.js';
import { republishReplyToThread } from './thread-subscribe.js';
import { AuthError, type AuthSession, type AuthStore } from './auth.js';
import {
  beginSidecarRestore,
  restoreJournalPathFor,
} from './restore-journal.js';
import {
  SigningKeySnapshotError,
  validateSigningKeySnapshot,
} from './attest.js';
import { readOptionalText } from './durable-file.js';
import type { PreparedRestore } from './restore-lifecycle.js';
import { normalizeRelayUrl } from './signup.js';
import {
  formatByteLimit,
  requestBodyLimitFor,
  resolveResourceLimits,
  type ResourceLimits,
} from './resource-limits.js';
import { createResourceBudget } from './resource-budget.js';
import { resolveDataFilePath } from './config.js';

const DC_CONTACT_ID_SELF = 1;
const FAVOURITE_EMOJI = '❤';
const MAX_CONTEXT_ANCESTORS = 20;
const MAX_CONTEXT_DESCENDANTS = 100;

export type ServerOptions = {
  baseUrl: string;
  /** Mandatory: production auth, or the conspicuous unsafe test-only factory below. */
  security:
    | {
        auth: AuthStore;
        /** Additional browser origins trusted alongside baseUrl's own origin. */
        trustedOrigins?: string[];
      }
    | { unsafeTestOnly: true };
  /** Absolute path to a built frontend SPA to serve as static files; skipped if unset/missing. */
  staticDir?: string;
  /**
   * The Headwater wire-convention store (mid/msgId index, reply/boost
   * edges). Share the same instance passed to `openTransport`'s
   * `onMessage` hook so ingestion from timeline reads and from the daemon's
   * background event subscription land in one place. Defaults to a fresh
   * ephemeral (scratch-file-backed) store, which is fine for tests.
   */
  store?: Store;
  /**
   * Enables `GET /api/v1/streaming` (+ trailing-slash alias) when both this
   * and `hub` are provided. Hono's node-server `upgradeWebSocket` helper
   * (see `main.ts`, which also wires the `ws.WebSocketServer` into `serve`'s
   * `websocket.server` option — that half lives outside `createApp` since it
   * needs the real HTTP server instance `serve()` returns). Optional so
   * `createApp` stays usable in tests/contexts with no real websocket
   * transport (the hub logic itself is unit-tested directly against
   * `./streaming.ts`, no `ws` involved).
   */
  upgradeWebSocket?: UpgradeWebSocket;
  /** Streaming hub live messages/notifications are broadcast through; see `./streaming.ts`. Required iff `upgradeWebSocket` is provided. */
  hub?: StreamingHub;
  /**
   * Absolute path to the account's data directory. Profile-editing writes the
   * uploaded avatar (before handing its path to the transport, which imports
   * it into DC's blob store) and the SELF header banner here, so both survive
   * a daemon restart. Defaults to an ephemeral scratch dir (fine for tests).
   */
  dataDir?: string;
  /** Production restore journal location and optional credential file transaction participant. */
  restoreJournal?: { path: string; accountsPath?: string; accountName?: string };
  /** Resource caps are injectable at small values for deterministic boundary tests. */
  resourceLimits?: Partial<ResourceLimits>;
  /** Staged-upload directory override for tests and managed deployments. */
  mediaUploadDir?: string;
  /** Operator-approved signup relay origins in addition to the public default. */
  signupRelays?: string[];
};

/**
 * Mutable source of the (possibly not-yet-configured) transport, plus the
 * signup operation that brings one into existence. Kept narrow so the API
 * layer can be unit-tested without a real chatmail account.
 */
export type AppContext = {
  getTransport(): Transport | null;
  signup(displayName: string, relay: string): Promise<Transport>;
  /**
   * Restore-instead-of-signup (see ../meta/issues/backup-second-device.md):
   * import a CORE backup tar into this node's data dir and return an UNCOMMITTED
   * opened transport. The server checks its core identity against sidecar.addr
   * before invoking the prepared handle's credential/global commit.
   * `beforeOpen` MUST be invoked after the core import succeeded but before
   * IO/ingestion starts: it writes the `.dnbk` sidecar files (store + signing
   * key) into the data dir, which can't happen any earlier — core refuses to
   * initialize an accounts structure in a non-empty directory. Optional so
   * Test contexts without a real data dir stay minimal; the endpoint answers
   * 501 when absent.
   */
  restore?(
    backupTarPath: string,
    passphrase: string,
    beforeOpen: () => void,
  ): Promise<PreparedRestore>;
};

type AppEnv = { Variables: { transport: Transport; authSession: AuthSession } };

const OAUTH_SCOPE = 'read write follow push';
const MAX_POST_CHARS = 5000;
const DEFAULT_PAGE = 20;
const DEFAULT_RELAY = 'https://nine.testrun.org';
const API_PREFIXES = ['/api/headwater', '/api/deltanet'] as const;
const ASSET_PREFIXES = ['/headwater', '/deltanet'] as const;
const apiPaths = (suffix: string): string[] => API_PREFIXES.map((prefix) => `${prefix}${suffix}`);
const assetPaths = (suffix: string): string[] => ASSET_PREFIXES.map((prefix) => `${prefix}${suffix}`);
const isApiPath = (path: string, suffix: string): boolean => apiPaths(suffix).includes(path);
const isAssetPath = (path: string): boolean => ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
const testOnlyRandomCredential = (): string => randomBytes(32).toString('base64url');

const intParam = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A unique scratch dir for profile assets when no real data dir is provided (tests). */
const profileScratchDir = (): string => join(tmpdir(), `headwater-profile-${randomUUID()}`);

/** File extension (with dot) for an uploaded image, from its mime; '.png' fallback. */
const imageExt = (mime: string): string =>
  mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.png';

/**
 * Content-Type for a file served from disk (avatars/blobs/headers), sniffed
 * from its extension. Avatars/blobs are DC blob-store copies whose paths keep
 * the original extension, so this is enough to stop them defaulting to
 * text/plain. Unknown extensions fall back to a safe binary type.
 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};
const contentTypeForPath = (path: string): string => {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
};

const prefixedFileStream = (
  prefix: Buffer,
  path: string,
  cleanup: () => void,
): ReadableStream<Uint8Array> => {
  const source = Readable.from((async function* () {
    try {
      yield prefix;
      for await (const chunk of createReadStream(path)) yield chunk;
    } finally {
      cleanup();
    }
  })());
  return Readable.toWeb(source) as ReadableStream<Uint8Array>;
};

export const createApp = (
  ctx: AppContext,
  {
    baseUrl,
    staticDir,
    store: injectedStore,
    upgradeWebSocket,
    hub,
    dataDir,
    restoreJournal,
    resourceLimits,
    mediaUploadDir,
    signupRelays,
    security,
  }: ServerOptions,
) => {
  const enabledSecurity = 'auth' in security ? security : null;
  const allowedSignupRelays = new Set(
    [DEFAULT_RELAY, ...(signupRelays ?? [])].map(normalizeRelayUrl),
  );
  const app = new Hono<AppEnv>();
  const limits = resolveResourceLimits(resourceLimits);
  const requestBudget = createResourceBudget(limits.maxInFlightRequestBytes);
  let readingRestoreBody = false;
  const mediaStore = createMediaStore({
    uploadDir: mediaUploadDir,
    maxFileBytes: limits.maxMediaBytes,
    maxRecords: limits.maxStagedMedia,
    maxMessageDescriptions: limits.maxMessageDescriptions,
    maxDescriptionBytes: limits.maxMediaDescriptionBytes,
    ttlMs: limits.mediaTtlMs,
  });
  const store: Store = injectedStore ?? createStore(ephemeralStorePath());
  // Where profile-editing persists the uploaded avatar + SELF header banner.
  // Falls back to a per-process scratch dir so tests need no real data dir.
  const profileDir = dataDir ?? profileScratchDir();
  const headerPath = join(profileDir, 'header.png');

  // Per-account ed25519 signing key (post attestations, sketch #6). Persisted
  // in the account data dir exactly like the store — never logged. Falls back
  // to a scratch dir when no real data dir is provided (tests).
  const attestorKeyPath = resolveDataFilePath(
    profileDir,
    'headwater-signing-key.json',
    'deltanet-signing-key.json',
  );
  const attestor = openAttestor(attestorKeyPath);
  const backgroundMutation = (
    operation: () => Promise<void>,
    onError: (error: unknown) => void,
  ): void => {
    const release = store.beginExternalMutation();
    void operation().catch(onError).finally(release);
  };

  // Async API mutations can change core first and Store only after an await.
  // Track that whole interval without taking the synchronous writer lock.
  app.use('*', async (c, next) => {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method);
    if (
      !mutating ||
      isApiPath(c.req.path.replace(/\/$/, ''), '/backup/export')
    ) return next();
    const release = store.beginExternalMutation();
    try {
      await next();
    } finally {
      release();
    }
  });

  /**
   * Attest a content envelope: stamp `{ ts, pubkey, sig }` over its canonical
   * payload, signed as `addr` (the daemon's own address), plus the UNSIGNED
   * in-band `invite` when provided (outside the canonical payload by design —
   * see envelope.ts). Returns the serialized signed wire string. The single
   * place send paths turn an envelope object into a signed message body.
   */
  const signEnvelope = (env: Envelope, addr: string, invite?: string | null): string => {
    const { ts, pubkey, sig } = attestor.sign(env, addr);
    return serializeEnvelope({ ...env, ...(invite ? { invite } : {}), ts, pubkey, sig });
  };

  /**
   * Key confirmation (see ../meta/issues/key-confirmation.md): actively
   * confirm an UNPINNED author's signing key when a thread render surfaces
   * their held content. Introduce via the invite the envelope carries
   * (checkQr-gated + post-join address check inside `introduceViaInvite`),
   * then send an ordinary envelope-request for the post's uuid DIRECTLY to
   * the author — they serve their own signed copy over the PGP-verified
   * channel, and the self-served-bundle rule (backfill-ingest.ts) pins them.
   * Background + best-effort (a securejoin is slow and must never delay the
   * render); one attempt per addr per window so repeated renders never spam
   * introductions. Skipped entirely once a pin exists.
   */
  const KEY_CONFIRM_RETRY_MS = 15 * 60 * 1000;
  const keyConfirmAttempts = new Map<string, number>();
  const scheduleKeyConfirm = (
    transport: Transport,
    authorAddr: string,
    invite: string | null,
    uuid: string,
  ): void => {
    const addr = authorAddr.toLowerCase();
    if (store.pinnedKey(authorAddr) !== null) return;
    const last = keyConfirmAttempts.get(addr) ?? 0;
    if (Date.now() - last < KEY_CONFIRM_RETRY_MS) return;
    keyConfirmAttempts.set(addr, Date.now());
    backgroundMutation(async () => {
      const contactId = await keyContactOrIntroduce(transport, authorAddr, invite);
      if (contactId === null || contactId === DC_CONTACT_ID_SELF) return;
      await transport.sendControlDm(contactId, buildEnvelopeRequest([{ u: uuid, addr: authorAddr }]));
    }, (err) => console.error('key confirmation failed (non-fatal):', err));
  };

  /**
   * `mapper.heldStatus` + the thread-view key-confirmation trigger: every
   * held render is a thread/orig view (held content never enters timelines),
   * so this wrapper IS the "confirm on thread view" seam. Rendered content
   * from an unpinned author schedules a background confirmation.
   */
  const heldStatusConfirming = async (
    transport: Transport,
    uuid: string,
    inReplyToId: string | null,
  ): Promise<MastodonStatus | null> => {
    const held = store.heldEnvelope(uuid);
    const status = await mapper.heldStatus(transport, uuid, inReplyToId);
    if (status && held && store.pinnedKey(held.authorAddr) === null) {
      scheduleKeyConfirm(transport, held.authorAddr, held.env.invite ?? null, uuid);
    }
    return status;
  };

  /**
   * Mention delivery — the send half of addressing (see
   * ../meta/issues/mention-addressing-autocomplete.md): copy the SAME signed
   * wire text as a control DM to every `@addr` mentioned in the body, so a
   * mention reaches its target even when they don't follow the poster. The
   * receive side derives the mention notification from the same body grammar.
   * Targets KEY-contacts only (autocomplete only offers those; anything else
   * is skipped) — no in-band introductions here, so awaiting stays fast.
   * `skipAddrs` excludes recipients already getting a copy (the author, the
   * reply parent/root). Best-effort per recipient.
   */
  const deliverMentionCopies = async (
    transport: Transport,
    wireText: string,
    bodyText: string,
    skipAddrs: (string | undefined)[],
  ): Promise<void> => {
    const skip = new Set(
      skipAddrs.filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase()),
    );
    for (const addr of parseBodyMentions(bodyText)) {
      if (skip.has(addr)) continue;
      const contactId = await transport.keyContactIdForAddr(addr).catch(() => null);
      if (contactId === null || contactId === DC_CONTACT_ID_SELF) continue;
      await transport.sendControlDm(contactId, wireText).catch((err) => {
        console.error('mention copy failed (non-fatal):', err);
      });
    }
  };

  type DirectRecipient = { contactId: number; addr: string };

  /**
   * Resolve the complete direct audience before the first send. `base` carries
   * reply recipients already proven reachable by their message-derived contact
   * id; every body mention is still probed through the E2EE-capable key-contact
   * lookup. Null means one explicit mention was unreachable, so the caller must
   * reject the whole request without sending anything.
   */
  const resolveDirectRecipients = async (
    transport: Transport,
    bodyText: string,
    base: DirectRecipient[] = [],
  ): Promise<DirectRecipient[] | null> => {
    const recipients = new Map<number, DirectRecipient>();
    for (const recipient of base) {
      if (recipient.contactId !== DC_CONTACT_ID_SELF) recipients.set(recipient.contactId, recipient);
    }
    for (const addr of parseBodyMentions(bodyText)) {
      const contactId = await transport.keyContactIdForAddr(addr).catch(() => null);
      if (contactId === null) return null;
      if (contactId !== DC_CONTACT_ID_SELF) recipients.set(contactId, { contactId, addr });
    }
    return [...recipients.values()];
  };

  type DirectDelivery = { messages: T.Message[]; failed: number; total: number };

  /**
   * Send one byte-identical signed envelope to every pre-resolved recipient.
   * Delivery cannot be transactional across independent SMTP messages, so keep
   * every successful local copy even when another recipient fails. Callers
   * persist those copies before returning an explicit partial-delivery error.
   */
  const sendDirectCopies = async (
    transport: Transport,
    wireText: string,
    recipients: DirectRecipient[],
    file?: string,
  ): Promise<DirectDelivery> => {
    const messages: T.Message[] = [];
    let failed = 0;
    for (const { contactId } of recipients) {
      try {
        messages.push(await transport.sendContentDm(contactId, wireText, file ? { file } : undefined));
      } catch {
        failed += 1;
      }
    }
    return { messages, failed, total: recipients.length };
  };

  const directDeliveryError = (delivery: DirectDelivery) => ({
    error: delivery.messages.length > 0
      ? `direct post reached ${delivery.messages.length} of ${delivery.total} recipients`
      : 'direct post could not be delivered',
    code: delivery.messages.length > 0 ? 'partial_delivery' : 'delivery_failed',
    delivered: delivery.messages.length,
    total: delivery.total,
    ...(delivery.messages[0] ? { status_id: String(delivery.messages[0].id) } : {}),
  });

  // Our own multi-use contact invite link (in-band introduction), minted once
  // per daemon lifetime and stamped onto every outgoing content envelope so
  // strangers holding our posts can securejoin us. Failure → envelopes simply
  // omit it (mixed-era behavior).
  let cachedContactInvite: string | null | undefined;
  const ownContactInvite = async (transport: Transport): Promise<string | null> => {
    if (cachedContactInvite === undefined) {
      cachedContactInvite = await transport.contactInvite().catch(() => null);
    }
    return cachedContactInvite;
  };

  /**
   * The in-band contact invite carried by the thread-root post `rootUuid`, from
   * our local copy or a held envelope — the introduction payload for reaching a
   * never-met root author. Null when we don't hold the root or it carries none.
   */
  const rootPostInvite = async (
    transport: Transport,
    rootUuid: string,
  ): Promise<string | null> => {
    const localId = store.resolveKey(rootUuid);
    if (localId !== null) {
      const msg = await transport.message(localId);
      const env = msg ? parseEnvelope(msg.text) : null;
      if (env?.invite) return env.invite;
    }
    return store.heldEnvelope(rootUuid)?.env.invite ?? null;
  };

  // Failed introductions, negative-cached per addr so a dead invite isn't
  // re-joined on every reply into the same thread. In-memory (retrying after a
  // restart is fine); successful introductions need no cache — the key-contact
  // then exists and the direct path wins.
  const failedIntroductions = new Map<string, number>();
  const INTRODUCTION_RETRY_MS = 10 * 60_000;

  /**
   * Resolve a sendable KEY-contact for `addr`, introducing ourselves in-band
   * via `invite` when we've never met them. Introduction is EXPLICIT-need-only
   * (callers are our own outgoing copies / a user-triggered subscribe — never
   * plain ingest), slow (securejoin), and negative-cached on failure.
   */
  const keyContactOrIntroduce = async (
    transport: Transport,
    addr: string,
    invite: string | null,
  ): Promise<number | null> => {
    const direct = await transport.keyContactIdForAddr(addr);
    if (direct !== null) return direct;
    if (!invite) return null;
    const failedAt = failedIntroductions.get(addr.toLowerCase());
    if (failedAt !== undefined && Date.now() - failedAt < INTRODUCTION_RETRY_MS) return null;
    const introduced = await transport.introduceViaInvite(invite, addr);
    if (introduced === null) failedIntroductions.set(addr.toLowerCase(), Date.now());
    return introduced;
  };

  /**
   * Persist an uploaded profile image under the data dir and return its path.
   * The avatar is written here (not os tmpdir) so the file survives long
   * enough for DC to import it, and — since we keep it — remains a stable
   * on-disk artifact independent of DC's blob store.
   */
  const stageProfileImage = async (file: File, targetPath: string): Promise<string> => {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const temporary = `${targetPath}.tmp-${randomUUID()}`;
    try {
      await pipeline(
        Readable.fromWeb(file.stream() as globalThis.ReadableStream<Uint8Array>),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return temporary;
  };

  // Shared status/notification JSON mapping (see ./mapping.ts) — the same
  // instance's `toStatus`/`ownAddr` (with its request-lifetime cache) backs
  // every REST handler below, and `main.ts`'s live-ingestion path builds its
  // own instance over the same `store` so streamed frames use identical
  // mapping logic.
  const mapper = createStatusMapper(store, baseUrl, {
    blobUrl: enabledSecurity
      ? (msgId) => {
          const signed = enabledSecurity.auth.signBlobPath(msgId);
          const url = new URL(`/headwater/blob/${msgId}`, baseUrl);
          url.searchParams.set('expires', String(signed.expires));
          url.searchParams.set('signature', signed.signature);
          return url.toString();
        }
      : undefined,
  });
  const { toStatus } = mapper;

  /**
   * The status id of a held envelope's reply PARENT, for thread linkage
   * (`in_reply_to_id`): the parent's local numeric msgId if we hold it, else an
   * `orig-<parentUuid>` id if the parent is itself held, else null. Uuid refs
   * only (legacy mid refs don't backfill). Pure over the store.
   */
  const heldReplyParentId = (env: Envelope): string | null => {
    const ref = env.ref;
    if (!ref || !('u' in ref) || !ref.u) return null;
    const parentUuid = ref.u;
    const localMsgId = store.resolveKey(parentUuid);
    if (localMsgId !== null) return String(localMsgId);
    return store.heldEnvelope(parentUuid) ? `orig-${parentUuid}` : null;
  };

  /**
   * Ingest a message into the store, tolerating a transport that can't resolve
   * its mid. Timeline/message callers use the feed default; direct send paths
   * explicitly pass false for their returned 1:1 local copies.
   */
  const ingest = async (
    transport: Transport,
    msg: T.Message,
    isFeedMessage = true,
  ): Promise<void> => {
    try {
      const mid = await transport.messageMid(msg.id);
      if (mid) {
        store.ingestMessage(msg, mid, isFeedMessage);
        // Pass our own address so a SELF reaction control DM re-applies our own
        // tally on (re)ingest (see deriveOnIngest); `ownAddr` is memoized.
        deriveOnIngest(store, msg, mid, await mapper.ownAddr(transport));
      }
    } catch (err) {
      console.error('ingest failed (non-fatal):', err);
    }
  };

  /**
   * Parse a `/statuses/:id` path param into a typed target. Status ids are
   * OPAQUE strings on the wire: a numeric id is a local DC msgId, while a
   * verified boost embed's nested status carries an `orig-<uuid>` id (see
   * `verifiedEmbedToStatus`) that points at an original post we may never hold.
   * Returning a discriminated union (instead of scattering `Number(id)` +
   * `isNaN` guards) is what lets every `:id` handler treat a non-numeric id as
   * a clean 404 rather than crashing on `transport.message(NaN)` (→ 500).
   *   - all-digits           → `{ kind: 'msg', msgId }`  (an actionable local id)
   *   - `orig-<uuid>`        → `{ kind: 'orig', uuid }`  (a verified-embed ref)
   *   - anything else / empty → `null`                    (→ 404)
   */
  const parseStatusId = (raw: string | undefined): { kind: 'msg'; msgId: number } | { kind: 'orig'; uuid: string } | null => {
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return { kind: 'msg', msgId: Number(raw) };
    if (raw.startsWith('orig-')) {
      const uuid = raw.slice('orig-'.length);
      return uuid ? { kind: 'orig', uuid } : null;
    }
    return null;
  };

  /**
   * Resolve an `orig-<uuid>` status id to the status the thread view should
   * focus, WITHOUT re-implementing any verification (0002): reuse the exact
   * timeline mapper.
   *   1. If we actually hold the original post (the uuid resolves locally),
   *      return the real local status — the honest thing when we have it.
   *   2. Otherwise walk the store's boost index (`boostsByMid[<uuid>]`) for a
   *      held boost message whose embedded `orig` verifies: `toStatus` runs the
   *      full ladder (sig + pin + media hash + contact-first attribution) and
   *      yields a status whose `.reblog` IS the verified embed. Return that
   *      nested reblog (its own id is `orig-<uuid>`).
   *   3. No verifiable candidate → `null` (the caller 404s; never 500).
   */
  /**
   * Resolve an orig-<uuid> id to an ACTIONABLE target — the VERIFIED signed
   * envelope + its author addr — for embed-only interactions (favourite/
   * reaction/reply/boost on a post we never held as a local message). Sources,
   * in order: a held envelope (render-verified via the mapper, which also
   * drops tampered entries), else a held boost whose verified embed carries
   * the uuid. Unverified/absent -> null: interactions never act on content we
   * could not verify (0002).
   */
  const resolveOrigAction = async (
    transport: Transport,
    uuid: string,
  ): Promise<{ env: Envelope; authorAddr: string } | null> => {
    const held = store.heldEnvelope(uuid);
    if (held) {
      const status = await heldStatusConfirming(transport, uuid, null);
      return status ? { env: held.env, authorAddr: held.authorAddr } : null;
    }
    const embedId = `orig-${uuid}`;
    for (const boostMsgId of store.boostsByMid(uuid)) {
      const boostMsg = await transport.message(boostMsgId);
      if (!boostMsg) continue;
      const status = await toStatus(transport, boostMsg);
      if (!status.reblog || status.reblog.id !== embedId) continue; // verified gate
      const bEnv = parseEnvelope(boostMsg.text);
      const addr = bEnv?.ref ? envelopeRefAddr(bEnv.ref) : undefined;
      if (bEnv?.orig && addr) return { env: bEnv.orig, authorAddr: addr };
    }
    return null;
  };

  const resolveOrigStatus = async (
    transport: Transport,
    uuid: string,
  ): Promise<MastodonStatus | null> => {
    const localMsgId = store.resolveKey(uuid);
    if (localMsgId !== null) {
      const msg = await transport.message(localMsgId);
      if (msg) return toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id));
    }
    // Held envelope (thread auto-backfill): a verified foreign post/reply we
    // backfilled from a peer. `heldStatus` runs the same verify+pin ladder and
    // yields the `orig-<uuid>` status; its reply parent is resolved to a status
    // id here (a local msgId or another orig-<uuid>) so the thread links. A
    // tampered/unverifiable held envelope returns null (and self-drops) → fall
    // through to the boost walk.
    const held = store.heldEnvelope(uuid);
    if (held) {
      const heldStatus = await heldStatusConfirming(transport, uuid, heldReplyParentId(held.env));
      if (heldStatus) return heldStatus;
    }
    const embedId = `orig-${uuid}`;
    for (const boostMsgId of store.boostsByMid(uuid)) {
      const boostMsg = await transport.message(boostMsgId);
      if (!boostMsg) continue;
      const status = await toStatus(transport, boostMsg);
      // The boost renders its verified embed as `.reblog` with id `orig-<uuid>`
      // (an unverified/placeholder boost leaves `.reblog` null → skip it).
      if (status.reblog && status.reblog.id === embedId) return status.reblog;
    }
    return null;
  };

  /**
   * The ref TOKEN a reply/react/boost should target for a given message (wire
   * convention v1). Preference order:
   *  1. The target's own logical-post UUID (`⚑` marker) — a uuid ref. Every v1
   *     copy of a post carries the same uuid, so a uuid ref resolves on ANY
   *     node holding ANY copy (or a third party who only has the feed copy).
   *     This is the case mid-based refs could not solve.
   *  2. A legacy `⚓` canonical-mid marker (a DM copy of a pre-v1 reply the user
   *     only holds privately) — a canonical mid ref.
   *  3. The target's own rfc724 mid — a mid ref (legacy targets that never
   *     minted a uuid).
   * Pure protocol parse plus at most the `messageMid` the caller already needed.
   * Returns null iff none of the above yields a token.
   */
  const targetRef = async (transport: Transport, target: T.Message): Promise<RefToken | null> => {
    const uuid = parseWireUuid(target.text);
    if (uuid) return { kind: 'uuid', uuid };
    const canonical = parseCanonicalMid(target.text);
    if (canonical) return { kind: 'mid', mid: canonical };
    const mid = await transport.messageMid(target.id);
    return mid ? { kind: 'mid', mid } : null;
  };

  /** The store post-key for a ref token (mirrors ingest.ts `refKey`): a uuid, or the canonicalized mid. */
  const refKeyString = (ref: RefToken): string =>
    ref.kind === 'uuid' ? ref.uuid : store.canonicalize(ref.mid);

  /**
   * The thread-root ref for a reply whose parent is `parent` (design:
   * wire-thread-root-ref). Best-effort, never fabricated — an omitted (undefined)
   * root is always valid, so every branch that can't PROVE the root returns
   * undefined:
   *
   *  a. If the parent's own envelope carries `root`, reuse it VERBATIM (the
   *     parent already resolved the thread root; the chain is transitive).
   *  b. Else if the parent is NOT itself a reply, the parent IS the root — but
   *     only when it carries a uuid (a uuid ref resolves on any node holding any
   *     copy). A uuid-less legacy parent falls through to (c).
   *  c. Else walk locally-held ancestors (same resolveKey/parseWire climb the
   *     context endpoint uses, bounded) to the topmost held message and apply
   *     (a)/(b) to it. If the true root isn't determinable (the chain breaks, a
   *     legacy/uuid-less link), OMIT — never guess.
   */
  const deriveRootRef = async (
    transport: Transport,
    parent: T.Message,
  ): Promise<EnvelopeRef | undefined> => {
    let current: T.Message | null = parent;
    for (let depth = 0; depth < MAX_CONTEXT_ANCESTORS && current; depth++) {
      const env = parseEnvelope(current.text);
      // (a) The current node already names the thread root — reuse verbatim.
      if (env?.root) return env.root;
      const parsed = parseWire(current.text);
      // (b) The current node is not a reply → it IS the root (if it has a uuid).
      if (!parsed.reply) {
        return parsed.uuid ? { u: parsed.uuid, addr: current.sender.address } : undefined;
      }
      // (c) Climb one held ancestor and repeat; a broken/unheld link → omit.
      const parentMsgId = store.resolveKey(parsed.reply.keyString);
      if (parentMsgId === null) return undefined;
      current = await transport.message(parentMsgId);
    }
    return undefined;
  };

  /**
   * Resolve a `/statuses/:id` target to its THREAD ROOT (uuid + author addr) for
   * thread-subscribe: identify the thread via the SIGNED `root` ref when the
   * target is a reply, else the target's own uuid+author when it IS the root.
   *   - `orig-<uuid>` id: the target is a HELD envelope — use its signed root, or
   *     its own uuid+authorAddr when it's the root of the thread.
   *   - numeric id: the local message — same logic over its envelope.
   * Returns null when no uuid-rooted thread is determinable (legacy/uuid-less).
   * The root ADDR is a signed routing target (root.addr / the message's sender),
   * so a subscriber contacts the RIGHT author, not a swappable display attr.
   */
  const resolveThreadRoot = async (
    transport: Transport,
    parsed: { kind: 'msg'; msgId: number } | { kind: 'orig'; uuid: string },
  ): Promise<{ rootUuid: string; rootAddr: string; rootInvite: string | null } | null> => {
    let env: Envelope | null = null;
    let ownUuid: string | undefined;
    let ownAddr: string | undefined;
    if (parsed.kind === 'orig') {
      const held = store.heldEnvelope(parsed.uuid);
      if (held) {
        env = held.env;
        ownUuid = env.uuid;
        ownAddr = held.authorAddr;
      } else {
        // We may hold the original LOCALLY (e.g. we also follow the author's
        // feed) — resolve the real message, so subscribing on an `orig-<uuid>`
        // whose post we hold locally still works.
        const localMsgId = store.resolveKey(parsed.uuid);
        const msg = localMsgId !== null ? await transport.message(localMsgId) : null;
        if (!msg) return null;
        env = parseEnvelope(msg.text);
        ownUuid = env?.uuid ?? parseWireUuid(msg.text) ?? undefined;
        ownAddr = msg.sender.address;
      }
    } else {
      const msg = await transport.message(parsed.msgId);
      if (!msg) return null;
      env = parseEnvelope(msg.text);
      ownUuid = env?.uuid ?? parseWireUuid(msg.text) ?? undefined;
      ownAddr = msg.sender.address;
    }
    // A reply carries the signed root ref (uuid + signed addr). The reply's own
    // invite is the PARENT author's, not the root's — resolve the root post's.
    const root = env?.root;
    if (root && 'u' in root && root.u && root.addr) {
      return {
        rootUuid: root.u,
        rootAddr: root.addr,
        rootInvite: await rootPostInvite(transport, root.u),
      };
    }
    // Otherwise the target IS the root (a non-reply post) — subscribe to its
    // uuid, and its own envelope carries its author's in-band invite (if any).
    if (env?.type === 'reply') return null; // a reply with no resolvable root: can't
    if (ownUuid && ownAddr) {
      return { rootUuid: ownUuid, rootAddr: ownAddr, rootInvite: env?.invite ?? null };
    }
    return null;
  };

  /**
   * The status JSON the subscribe/unsubscribe endpoints return: the target status
   * re-rendered so `pleroma.headwater.thread_subscribed` reflects the post-mutation
   * store state (the mapper reads it from `store.isSubscribedToThread`). When the
   * subscription is merely PENDING (request sent, grant not yet arrived), the
   * store isn't subscribed yet, so `forcePending` overlays the flag optimistically
   * so the UI can show the toggle flipped immediately. Falls back to a minimal
   * shape if the status can't be re-rendered (still reports the flag).
   */
  const toSubscribeStatus = async (
    transport: Transport,
    parsed: { kind: 'msg'; msgId: number } | { kind: 'orig'; uuid: string },
    rootUuid: string,
    forcePending = false,
  ): Promise<Record<string, unknown>> => {
    let status: MastodonStatus | null = null;
    if (parsed.kind === 'msg') {
      const msg = await transport.message(parsed.msgId).catch(() => null);
      if (msg) status = await toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id));
    } else {
      status = await resolveOrigStatus(transport, parsed.uuid);
    }
    const subscribed = forcePending || store.isSubscribedToThread(rootUuid);
    const metadata = { thread_subscribed: subscribed };
    if (!status) return {
      id: parsed.kind === 'msg' ? String(parsed.msgId) : `orig-${parsed.uuid}`,
      pleroma: { headwater: metadata, deltanet: metadata },
    };
    const currentMetadata = status.pleroma.headwater ?? status.pleroma.deltanet ?? {};
    const nextMetadata = { ...currentMetadata, thread_subscribed: subscribed };
    return {
      ...status,
      pleroma: {
        ...status.pleroma,
        headwater: nextMetadata,
        deltanet: nextMetadata,
      },
    };
  };

  const trustedOrigins = new Set<string>([
    new URL(baseUrl).origin,
    ...(enabledSecurity?.trustedOrigins ?? []).map((origin) => new URL(origin).origin),
  ]);
  const isStreamingPath = (path: string) =>
    path === '/api/v1/streaming' || path === '/api/v1/streaming/';
  const isAnonymousRequest = (method: string, path: string): boolean => {
    if (method === 'GET' && (path === '/api/v1/instance' || path === '/api/v2/instance')) return true;
    if (method === 'GET' && isApiPath(path, '/status')) return true;
    if (method === 'POST' && path === '/api/v1/apps') return true;
    if (method === 'GET' && path === '/oauth/authorize') return true;
    if (method === 'POST' && path === '/oauth/token') return true;
    if (
      method === 'POST' &&
      (isApiPath(path, '/signup') || isApiPath(path, '/restore')) &&
      ctx.getTransport() === null
    ) return true;
    if (method === 'GET' && path === '/api/v1/timelines/public') return true;
    if (method === 'GET' && /^\/api\/v1\/accounts\/\d+(?:\/statuses)?$/.test(path)) return true;
    if (method === 'GET' && /^\/(?:headwater|deltanet)\/(?:avatar|header)\//.test(path)) return true;
    if (method === 'GET' && (/^\/(?:headwater|deltanet)\/header\.png$/.test(path) || /^\/(?:headwater|deltanet)\/blob\/[^/]+$/.test(path))) return true;
    if (method === 'GET' && (path === '/api/v1/custom_emojis' || path === '/api/v1/trends' || path === '/api/v1/trends/tags')) return true;
    if (
      (method === 'GET' || method === 'HEAD') &&
      !path.startsWith('/api') &&
      !path.startsWith('/oauth') &&
      !isAssetPath(path)
    ) return true;
    return false;
  };
  const bearerToken = (authorization: string | undefined): string | null => {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    return match?.[1] ?? null;
  };

  app.use('*', async (c, next) => {
    c.header('Vary', 'Origin');
    const origin = c.req.header('origin');
    const trustedOrigin = origin !== undefined && trustedOrigins.has(origin);
    const path = new URL(c.req.url).pathname;
    const method = c.req.method.toUpperCase();
    if (path === '/api/v1/apps' || path.startsWith('/oauth/')) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
    }
    const publicBrowserBoundary =
      isStreamingPath(path) ||
      path.startsWith('/oauth') ||
      path === '/api/v1/apps' ||
      isApiPath(path, '/status') ||
      isApiPath(path, '/signup') ||
      isApiPath(path, '/restore');

    const setCorsHeaders = () => {
      if (!trustedOrigin) return;
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      c.header('Access-Control-Expose-Headers', 'Content-Disposition');
    };
    setCorsHeaders();

    if (
      enabledSecurity &&
      origin &&
      !trustedOrigin &&
      (method === 'OPTIONS' || !['GET', 'HEAD'].includes(method) || publicBrowserBoundary)
    ) {
      return c.json({ error: 'untrusted browser origin' }, 403);
    }

    if (method === 'OPTIONS') {
      return c.body(null, 204);
    }

    if (enabledSecurity) {
      if (isStreamingPath(path)) {
        const ticket = c.req.query('ticket') ?? '';
        const session = enabledSecurity.auth.consumeStreamTicket(ticket);
        if (!session) return c.json({ error: 'invalid or missing stream ticket' }, 401);
        c.set('authSession', session);
      } else if (isAnonymousRequest(method, path)) {
        const token = bearerToken(c.req.header('authorization'));
        const session = token ? enabledSecurity.auth.validateAccessToken(token) : null;
        if (session) c.set('authSession', session);
      } else {
        const token = bearerToken(c.req.header('authorization'));
        const session = token ? enabledSecurity.auth.validateAccessToken(token) : null;
        if (!session) return c.json({ error: 'invalid or missing bearer token' }, 401);
        c.set('authSession', session);
      }
    }

    await next();
    setCorsHeaders();
  });

  app.use('*', async (c, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(c.req.method)) return next();
    const isRestore = isApiPath(c.req.path, '/restore');
    if (isRestore && readingRestoreBody) {
      return c.json({ error: 'configuration already in progress', code: 'resource_busy' }, 409);
    }
    const maxSize = requestBodyLimitFor(c.req.path, limits);
    // The limiter and form parser each retain at most one body-sized copy.
    const release = requestBudget.tryAcquire(maxSize * 2);
    if (!release) {
      return c.json({ error: 'Server request-memory budget is busy; retry shortly', code: 'resource_busy' }, 429);
    }
    if (isRestore) readingRestoreBody = true;
    try {
      const declaredLength = Number(c.req.header('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxSize) {
        return c.json({
          error: `Request body exceeds the ${formatByteLimit(maxSize)} limit`,
          code: 'request_too_large',
        }, 413);
      }
      const reader = c.req.raw.body?.getReader();
      if (!reader) return next();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxSize) {
          await reader.cancel();
          return c.json({
            error: `Request body exceeds the ${formatByteLimit(maxSize)} limit`,
            code: 'request_too_large',
          }, 413);
        }
        chunks.push(value);
      }
      c.req.raw = new Request(c.req.raw, {
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        duplex: 'half',
      });
      return await next();
    } finally {
      if (isRestore) readingRestoreBody = false;
      release();
    }
  });

  // --- transport gate: attach the live transport, or 401 if unconfigured ---

  const requireTransport = async (c: Context<AppEnv>, next: Next) => {
    const transport = ctx.getTransport();
    if (!transport) return c.json({ error: 'not configured' }, 401);
    c.set('transport', transport);
    await next();
  };

  // --- Headwater: status + signup -------------------------------------------

  let configuring = false;

  app.on('GET', apiPaths('/status'), async (c) => {
    const transport = ctx.getTransport();
    if (!transport) return c.json({ configured: false, address: null });
    // Configuration is safe onboarding metadata; the account address itself is
    // private unless this request already carries a valid session.
    const session = enabledSecurity ? c.get('authSession') : true;
    const self = session ? await transport.self() : null;
    return c.json({ configured: true, address: self?.address ?? null });
  });

  app.on('POST', apiPaths('/signup'), async (c) => {
    if (ctx.getTransport()) return c.json({ error: 'already configured' }, 409);
    if (configuring) return c.json({ error: 'configuration already in progress' }, 409);
    configuring = true;
    try {
      const body = await c.req.json<{
        display_name?: string;
        relay?: string;
        enrollment_code?: string;
      }>().catch(() => ({}) as any);
      const displayName = String(body.display_name ?? '').trim();
      if (!displayName) {
        return c.json({ error: "Validation failed: display_name can't be blank" }, 422);
      }
      let relay: string;
      try {
        relay = body.relay === undefined
          ? DEFAULT_RELAY
          : normalizeRelayUrl(typeof body.relay === 'string' ? body.relay : '');
      } catch {
        return c.json({ error: 'Validation failed: relay is invalid' }, 422);
      }
      if (!allowedSignupRelays.has(relay)) {
        return c.json({ error: 'Validation failed: relay is not configured for this node' }, 422);
      }
      if (
        relay !== DEFAULT_RELAY &&
        (!enabledSecurity || !enabledSecurity.auth.validateEnrollmentCode(String(body.enrollment_code ?? '')))
      ) {
        return c.json({ error: 'valid terminal enrollment proof is required for a custom relay' }, 403);
      }
      const transport = await ctx.signup(displayName, relay);
      return c.json({ account: contactToAccount(await transport.self(), baseUrl) });
    } finally {
      configuring = false;
    }
  });

  // --- Headwater: backup & restore ------------------------------------------

  let exportingBackup = false;

  app.on('GET', apiPaths('/backup'), requireTransport, async (c) =>
    c.json({ last_backup_at: await c.get('transport').lastBackupAt() }),
  );

  app.on('POST', apiPaths('/backup/export'), requireTransport, async (c) => {
    const transport = c.get('transport');
    const body = await c.req.json<{ passphrase?: string }>().catch(() => ({}) as { passphrase?: string });
    const passphrase = String(body.passphrase ?? '');
    if (!passphrase) {
      return c.json({ error: "Validation failed: passphrase can't be blank" }, 422);
    }
    if (exportingBackup) {
      return c.json({ error: 'A backup export is already in progress', code: 'resource_busy' }, 429);
    }
    exportingBackup = true;
    const scratch = mkdtempSync(join(tmpdir(), 'headwater-export-'));
    let handedOff = false;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(scratch, { recursive: true, force: true });
      exportingBackup = false;
    };
    try {
      if (store.mutationBarrierSnapshot().active > 0) {
        return c.json({ error: 'store changed during backup export; retry' }, 409);
      }
      const self = await transport.self();
      let tarPath: string | null = null;
      let storeSnapshot: ReturnType<Store['readSnapshot']> = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptDir = join(scratch, `attempt-${attempt}`);
        mkdirSync(attemptDir, { mode: 0o700 });
        const barrierBefore = store.mutationBarrierSnapshot();
        if (barrierBefore.active > 0) {
          return c.json({ error: 'store changed during backup export; retry' }, 409);
        }
        const before = store.readSnapshot();
        const candidateTar = await transport.exportBackup(attemptDir, passphrase);
        if (statSync(candidateTar).size > limits.maxBackupCoreBytes) {
          return c.json({
            error: `Generated backup core exceeds the ${formatByteLimit(limits.maxBackupCoreBytes)} limit`,
            code: 'backup_too_large',
          }, 413);
        }
        const after = store.readSnapshot();
        const barrierAfter = store.mutationBarrierSnapshot();
        if (
          barrierAfter.active === 0 &&
          barrierBefore.revision === barrierAfter.revision &&
          before?.generation === after?.generation &&
          before?.contents === after?.contents
        ) {
          tarPath = candidateTar;
          storeSnapshot = after;
          break;
        }
        rmSync(attemptDir, { recursive: true, force: true });
      }
      if (tarPath === null) {
        return c.json({ error: 'store changed during backup export; retry' }, 409);
      }
      const tarSize = statSync(tarPath).size;
      const exportedAt = Date.now();
      const signingKey = readOptionalText(attestorKeyPath);
      if (signingKey !== null) validateSigningKeySnapshot(signingKey);
      const sidecar: BackupSidecar = {
        addr: self.address,
        exportedAt,
        // Both are lazily created, so either may legitimately not exist yet
        // (a node that never signed / never persisted derived state).
        ...(signingKey !== null ? { signingKey } : {}),
        ...(storeSnapshot !== null ? { store: storeSnapshot.contents } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(sidecar), 'utf8') + 128 > limits.maxBackupSidecarBytes) {
        return c.json({
          error: `Backup sidecar exceeds the ${formatByteLimit(limits.maxBackupSidecarBytes)} limit`,
          code: 'backup_too_large',
        }, 413);
      }
      const prefix = encodeBackupPrefix({ sidecar, coreTarSha256: await sha256File(tarPath) }, passphrase);
      const containerSize = prefix.length + tarSize;
      if (containerSize > limits.maxBackupExportBytes) {
        return c.json({
          error: `Generated backup exceeds the ${formatByteLimit(limits.maxBackupExportBytes)} limit`,
          code: 'backup_too_large',
        }, 413);
      }
      await transport.markBackupExported(exportedAt);
      c.header('Content-Type', 'application/octet-stream');
      c.header('Content-Length', String(containerSize));
      c.header(
        'Content-Disposition',
        `attachment; filename="${backupFilename(self.address, exportedAt)}"`,
      );
      handedOff = true;
      return c.body(prefixedFileStream(prefix, tarPath, cleanup));
    } finally {
      if (!handedOff) cleanup();
    }
  });

  app.on('POST', apiPaths('/restore'), async (c) => {
    if (ctx.getTransport()) return c.json({ error: 'already configured' }, 409);
    if (!ctx.restore) return c.json({ error: 'restore not supported' }, 501);
    if (configuring) return c.json({ error: 'configuration already in progress' }, 409);
    configuring = true;
    try {
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.['file'];
    const passphrase = String(body?.['passphrase'] ?? '');
    if (!(file instanceof File) || !passphrase) {
      return c.json({ error: 'Validation failed: file and passphrase are required' }, 422);
    }
    if (file.size > limits.maxRestoreBytes) {
      return c.json({
        error: `Backup file exceeds the ${formatByteLimit(limits.maxRestoreBytes)} limit`,
        code: 'backup_too_large',
      }, 413);
    }
    let sidecar: BackupSidecar;
    let expectedCoreHash: string | undefined;
    let prefixLength: number;
    try {
      // The GCM tag rejects a wrong passphrase / corrupted file HERE, before
      // any state is touched (core import included).
      const headerLength = BACKUP_MAGIC.length + 4;
      const header = Buffer.from(await file.slice(0, headerLength).arrayBuffer());
      prefixLength = backupPrefixLength(header, { maxSidecarBytes: limits.maxBackupSidecarBytes });
      const prefix = Buffer.from(await file.slice(0, prefixLength).arrayBuffer());
      const decoded = decodeBackupPrefix(prefix, passphrase, { maxSidecarBytes: limits.maxBackupSidecarBytes });
      sidecar = decoded.sidecar;
      expectedCoreHash = decoded.coreTarSha256;
      const coreBytes = file.size - prefixLength;
      if (coreBytes < 0) throw new BackupDecodeError('truncated backup file');
      if (coreBytes > limits.maxBackupCoreBytes) {
        throw new BackupSizeError('backup core exceeds the configured size limit');
      }
    } catch (err) {
      if (err instanceof BackupSizeError) {
        return c.json({ error: err.message, code: 'backup_too_large' }, 413);
      }
      if (err instanceof BackupDecodeError) return c.json({ error: err.message }, 422);
      throw err;
    }
    try {
      if (sidecar.store !== undefined) store.validateSnapshot(sidecar.store);
      if (sidecar.signingKey !== undefined) validateSigningKeySnapshot(sidecar.signingKey);
    } catch (err) {
      if (err instanceof StoreCorruptionError || err instanceof SigningKeySnapshotError) {
        return c.json({ error: err.message }, 422);
      }
      throw err;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'headwater-restore-'));
    try {
      const tarPath = join(scratch, 'core-backup.tar');
      await pipeline(
        Readable.fromWeb(file.slice(prefixLength).stream() as globalThis.ReadableStream<Uint8Array>),
        createWriteStream(tarPath, { flags: 'wx', mode: 0o600 }),
      );
      if (expectedCoreHash !== undefined && await sha256File(tarPath) !== expectedCoreHash) {
        return c.json({ error: 'core tar hash mismatch' }, 422);
      }
      const journal = beginSidecarRestore({
        journalPath: restoreJournal?.path ?? restoreJournalPathFor(profileDir),
        store,
        signingKeyPath: attestorKeyPath,
        accountsPath: restoreJournal?.accountsPath,
        accountName: restoreJournal?.accountName,
        donorStore: sidecar.store,
        donorSigningKey: sidecar.signingKey,
      });

      const writeSidecarFiles = () => {
        journal.install();
        store.reload();
        attestor.reload();
      };
      const rollbackSidecarFiles = () => {
        journal.rollback();
        store.reload();
        attestor.reload();
      };
      let prepared: PreparedRestore | null = null;
      let committed = false;
      try {
        prepared = await ctx.restore(
          tarPath,
          passphrase,
          writeSidecarFiles,
        );
        const restoredSelf = await prepared.transport.self();
        if (restoredSelf.address !== sidecar.addr) {
          throw new Error('restored core address does not match backup sidecar');
        }
        await prepared.commit(journal.persistCredentials);
        committed = true;
        journal.finish();
        return c.json({ account: contactToAccount(restoredSelf, baseUrl) });
      } catch (err) {
        if (journal.phase === 'committed') {
          journal.finish();
        } else {
          if (!committed) {
            try {
              prepared?.abort();
            } finally {
              rollbackSidecarFiles();
            }
          }
        }
        const message = err instanceof Error ? err.message : 'restore failed';
        return c.json({ error: message }, 422);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    } finally {
      configuring = false;
    }
  });

  // --- OAuth: persisted local bearer sessions, auto-granted ---------------

  const oauthScopes = new Set(OAUTH_SCOPE.split(' '));
  const normalizedScope = (raw: unknown): string | null => {
    const scopes = [...new Set(String(raw ?? '').trim().split(/\s+/).filter(Boolean))];
    return scopes.length === oauthScopes.size && scopes.every((scope) => oauthScopes.has(scope))
      ? OAUTH_SCOPE
      : null;
  };
  const validatedRedirect = (raw: unknown): string | null => {
    const value = String(raw ?? '').trim();
    if (!value || /\s/.test(value)) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
      return trustedOrigins.has(url.origin) ? url.toString() : null;
    } catch {
      return null;
    }
  };

  app.post('/api/v1/apps', async (c) => {
    if (!enabledSecurity) {
      const body = await c.req.parseBody();
      return c.json({
        id: testOnlyRandomCredential(),
        name: String(body['client_name'] ?? 'app'),
        website: null,
        redirect_uri: String(body['redirect_uris'] ?? ''),
        client_id: testOnlyRandomCredential(),
        client_secret: testOnlyRandomCredential(),
        vapid_key: '',
      });
    }
    const body = await c.req.parseBody().catch(() => null);
    const name = String(body?.['client_name'] ?? '').trim();
    const redirectUri = validatedRedirect(body?.['redirect_uris']);
    const scope = normalizedScope(body?.['scopes'] ?? OAUTH_SCOPE);
    if (!name || name.length > 200 || !redirectUri || !scope) {
      return c.json({ error: 'invalid_client_metadata' }, 422);
    }
    try {
      const client = enabledSecurity.auth.registerClient(
        { name, redirectUri, scope },
        {
          enrollmentCode: String(body?.['enrollment_code'] ?? '') || undefined,
          accessToken: bearerToken(c.req.header('authorization')) ?? undefined,
        },
      );
      return c.json({
        id: client.clientId,
        name: client.name,
        website: null,
        redirect_uri: client.redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        vapid_key: '',
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      if (authError?.code === 'client_limit') return c.json({ error: authError.code }, 429);
      return c.json({ error: authError?.code ?? 'invalid_enrollment' }, 403);
    }
  });

  app.get('/oauth/authorize', (c) => {
    const redirectUri = c.req.query('redirect_uri');
    if (!enabledSecurity) {
      if (!redirectUri) return c.json({ error: 'redirect_uri missing' }, 400);
      const target = new URL(redirectUri);
      target.searchParams.set('code', testOnlyRandomCredential());
      const state = c.req.query('state');
      if (state) target.searchParams.set('state', state);
      return c.redirect(target.toString(), 302);
    }
    if (!ctx.getTransport()) return c.json({ error: 'not configured' }, 409);
    const clientId = c.req.query('client_id') ?? '';
    const client = enabledSecurity.auth.client(clientId);
    const scope = normalizedScope(c.req.query('scope'));
    if (
      !client ||
      c.req.query('response_type') !== 'code' ||
      !redirectUri ||
      redirectUri !== client.redirectUri ||
      !scope
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    try {
      const code = enabledSecurity.auth.issueAuthorizationCode({ clientId, redirectUri, scope });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      const state = c.req.query('state');
      if (state) target.searchParams.set('state', state);
      return c.redirect(target.toString(), 302);
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
  });

  app.post('/oauth/token', async (c) => {
    if (!enabledSecurity) {
      return c.json({
        access_token: testOnlyRandomCredential(),
        token_type: 'Bearer',
        scope: OAUTH_SCOPE,
        created_at: Math.floor(Date.now() / 1000),
      });
    }
    const body = await c.req.parseBody().catch(() => null);
    if (!body || body['grant_type'] !== 'authorization_code') {
      return c.json({ error: 'unsupported_grant_type' }, 400);
    }
    try {
      const session = enabledSecurity.auth.exchangeAuthorizationCode({
        clientId: String(body['client_id'] ?? ''),
        clientSecret: String(body['client_secret'] ?? ''),
        redirectUri: String(body['redirect_uri'] ?? ''),
        code: String(body['code'] ?? ''),
      });
      return c.json({
        access_token: session.accessToken,
        token_type: session.tokenType,
        scope: session.scope,
        created_at: Math.floor(session.createdAt / 1000),
        expires_in: Math.max(0, Math.floor((session.expiresAt - session.createdAt) / 1000)),
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      return c.json(
        { error: authError?.code ?? 'invalid_grant' },
        authError?.code === 'invalid_client' ? 401 : 400,
      );
    }
  });

  app.post('/oauth/revoke', async (c) => {
    if (!enabledSecurity) return c.json({});
    const body = await c.req.parseBody().catch(() => ({} as Record<string, string | File>));
    const fromBody = String(body['token'] ?? '');
    const fromHeader = bearerToken(c.req.header('authorization')) ?? '';
    if (!fromBody || !fromHeader || fromHeader !== fromBody) {
      return c.json({ error: 'invalid_token' }, 401);
    }
    if (!enabledSecurity.auth.revokeClientForAccessToken(fromHeader)) {
      return c.json({ error: 'invalid_token' }, 401);
    }
    const enrollment = enabledSecurity.auth.createEnrollmentCode();
    console.log(`Headwater: one-time frontend enrollment code (10 minutes): ${enrollment.code}`);
    return c.json({});
  });

  app.on('POST', apiPaths('/streaming/token'), (c) => {
    if (!enabledSecurity) {
      return c.json({ ticket: testOnlyRandomCredential(), expires_at: Date.now() + 30_000 });
    }
    const accessToken = bearerToken(c.req.header('authorization')) ?? '';
    try {
      const issued = enabledSecurity.auth.issueStreamTicket(accessToken);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ ticket: issued.ticket, expires_at: issued.expiresAt });
    } catch {
      return c.json({ error: 'invalid session' }, 401);
    }
  });

  // --- Streaming (Mastodon websocket API) ----------------------------------
  //
  // `stream` (default 'user') and a one-use short-lived `ticket` consumed by
  // the global security middleware before this upgrade handler can run
  // match the frontend's `buildPleromaStreamingUrl`
  // (../frontend/src/lib/pleroma/streaming.ts). Registered under both
  // '/api/v1/streaming' and the trailing-slash variant the frontend actually
  // connects to. All the fan-out/dedupe/keepalive logic lives in
  // `createStreamingEvents` (./streaming.ts, unit-tested with fake sockets —
  // a real websocket upgrade can't be driven through Hono's `app.request()`
  // test helper, so keeping this handler a one-line adapter is what makes
  // the actual registration/cleanup behavior testable at all); this handler
  // only wires the real `WSContext` through.
  if (upgradeWebSocket && hub) {
    // `createStreamingEvents` is typed against a narrow, hub-only
    // `StreamingWsContext` (see ./streaming.ts) so it's testable with plain
    // fakes; hono's real `WSContext.raw` is `unknown` (it's generic over the
    // adapter), so this cast is the one place that ties the two together.
    const streamingHandler = upgradeWebSocket((c) => {
      const events = createStreamingEvents(hub, c.req.query('stream'));
      if (!enabledSecurity) return events as unknown as WSEvents;
      const session = c.get('authSession');
      let expiryTimer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribeInvalidation: (() => void) | null = null;
      let terminated = false;

      const clearSessionGuards = () => {
        if (expiryTimer !== null) clearTimeout(expiryTimer);
        expiryTimer = null;
        unsubscribeInvalidation?.();
        unsubscribeInvalidation = null;
      };

      return {
        onOpen(event, ws) {
          events.onOpen(event, ws as any);
          const close = (reason: 'session revoked' | 'session expired') => {
            if (terminated) return;
            terminated = true;
            clearSessionGuards();
            events.onClose(undefined, ws as any);
            (ws as unknown as { close(code?: number, reason?: string): void }).close(4001, reason);
          };
          const scheduleExpiry = () => {
            const remaining = session.expiresAt - Date.now();
            if (remaining <= 0) {
              close('session expired');
              return;
            }
            expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_000_000));
          };
          unsubscribeInvalidation = enabledSecurity.auth.onSessionInvalidated((sessionId) => {
            if (sessionId === session.sessionId) close('session revoked');
          });
          scheduleExpiry();
        },
        onClose(event, ws) {
          clearSessionGuards();
          events.onClose(event, ws as any);
        },
        onError(event, ws) {
          clearSessionGuards();
          events.onError(event, ws as any);
        },
      } as WSEvents;
    });
    app.get('/api/v1/streaming', streamingHandler);
    app.get('/api/v1/streaming/', streamingHandler);
  }

  // --- Instance -----------------------------------------------------------

  const capabilities = {
    bookmarks: false,
    status_deletion: false,
    account_moderation: false,
    media_description: true,
    chats: false,
    polls: false,
    unlisted_visibility: false,
    content_warnings: false,
    extended_profile: false,
  };
  const productConfiguration = { capabilities };
  const instanceV2 = () => ({
    domain: new URL(baseUrl).host,
    title: 'Headwater',
    version: '2.7.2 (compatible; Headwater 0.0.1)',
    source_url: 'https://localhost/headwater',
    description: 'single-user pleroma-style backend federating over chatmail',
    languages: ['en'],
    registrations: { enabled: false, approval_required: false },
    configuration: {
      statuses: { max_characters: MAX_POST_CHARS, max_media_attachments: 1 },
      media_attachments: { supported_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
      headwater: productConfiguration,
      deltanet: productConfiguration,
    },
    max_toot_chars: MAX_POST_CHARS,
    pleroma: {
      metadata: { features: [], max_toot_chars: MAX_POST_CHARS },
      headwater: productConfiguration,
      deltanet: productConfiguration,
    },
  });

  app.get('/api/v2/instance', (c) => c.json(instanceV2()));
  app.get('/api/v1/instance', (c) => c.json({ ...instanceV2(), uri: new URL(baseUrl).host }));

  // --- Accounts -----------------------------------------------------------

  /** The full self account JSON (self contact + real stats), as both verify_credentials and update_credentials return. */
  const selfAccountJson = async (transport: Transport) => {
    const [self, stats] = await Promise.all([transport.self(), transport.stats()]);
    return {
      ...contactToAccount(self, baseUrl),
      followers_count: stats.followers,
      following_count: stats.following,
      statuses_count: stats.statuses,
    };
  };

  app.get('/api/v1/accounts/verify_credentials', requireTransport, async (c) =>
    c.json(await selfAccountJson(c.get('transport'))),
  );

  // Profile editing (Mastodon update_credentials). The frontend currently
  // sends this as JSON (display_name/note), but the endpoint also accepts
  // multipart form-data so avatar/header File uploads work — hono's parseBody
  // yields File objects for those (same as /api/v1/media). `display_name`
  // maps to DC `displayname`, `note` to `selfstatus` (both federate in
  // outgoing message headers); the avatar is persisted under the data dir and
  // set as `selfavatar` (DC imports it into its blob store). `header` has no
  // DC equivalent — it's stored locally and served for SELF only.
  app.patch('/api/v1/accounts/update_credentials', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contentType = c.req.header('content-type') ?? '';
    const body = contentType.includes('json')
      ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
      : ((await c.req.parseBody()) as Record<string, unknown>);

    if (Object.keys(body).some((key) =>
      key === 'discoverable' || key === 'hide_followers_count' || key.startsWith('fields_attributes'),
    )) {
      return c.json({ error: 'Extended profile fields are not supported by this Headwater node', code: 'unsupported_capability' }, 422);
    }

    const updates: Parameters<Transport['updateProfile']>[0] = {};

    if (body['display_name'] !== undefined) {
      const displayName = String(body['display_name']);
      // A blank display name is rejected: unlike note, an empty name would
      // leave the account effectively nameless everywhere it federates.
      if (displayName.trim() === '') {
        return c.json({ error: "Validation failed: display_name can't be blank" }, 422);
      }
      updates.displayName = displayName;
    }

    // `note` may be empty — that's a valid "clear my bio".
    if (body['note'] !== undefined) updates.bio = String(body['note']);

    const avatar = body['avatar'];
    if (avatar instanceof File) {
      if (!isSupportedImageMime(avatar.type)) {
        return c.json({ error: 'Validation failed: avatar must be an image' }, 422);
      }
      if (avatar.size > limits.maxMediaBytes) {
        return c.json({ error: `Avatar exceeds the ${formatByteLimit(limits.maxMediaBytes)} limit`, code: 'media_too_large' }, 413);
      }
    }

    const header = body['header'];
    if (header instanceof File) {
      if (!isSupportedImageMime(header.type)) {
        return c.json({ error: 'Validation failed: header must be an image' }, 422);
      }
      if (header.size > limits.maxMediaBytes) {
        return c.json({ error: `Header exceeds the ${formatByteLimit(limits.maxMediaBytes)} limit`, code: 'media_too_large' }, 413);
      }
    }
    const avatarPath = avatar instanceof File
      ? join(profileDir, `avatar${imageExt(avatar.type)}`)
      : null;
    const staged: { temporary: string; target: string; backup: string | null; installed: boolean }[] = [];
    let profileUpdated = false;
    try {
      if (avatar instanceof File && avatarPath) {
        staged.push({ temporary: await stageProfileImage(avatar, avatarPath), target: avatarPath, backup: null, installed: false });
        updates.avatarPath = avatarPath;
      }
      if (header instanceof File) {
        staged.push({ temporary: await stageProfileImage(header, headerPath), target: headerPath, backup: null, installed: false });
      }
      for (const item of staged) {
        const backup = `${item.target}.previous-${randomUUID()}`;
        try {
          await rename(item.target, backup);
          item.backup = backup;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rename(item.temporary, item.target);
        item.installed = true;
        await chmod(item.target, 0o600);
      }
      await transport.updateProfile(updates);
      profileUpdated = true;
    } finally {
      for (const item of [...staged].reverse()) {
        if (!profileUpdated) {
          if (item.installed) await rm(item.target, { force: true });
          if (item.backup) await rename(item.backup, item.target);
        } else if (profileUpdated && item.backup) {
          await rm(item.backup, { force: true });
        }
        await rm(item.temporary, { force: true });
      }
    }
    return c.json(await selfAccountJson(transport));
  });

  const relationshipFor = (following: boolean, id: number, requested = false): MastodonRelationship => ({
    id: String(id),
    following,
    showing_reblogs: following,
    notifying: false,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    // A follow-back invite-request we've sent but whose grant hasn't arrived
    // yet: not following yet, but the request is outstanding. Cleared to false
    // once the grant lands and the join completes (`store.clearPendingFollowRequest`).
    requested: requested && !following,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });

  /**
   * The relationship for a resolved contact: `following` from the transport's
   * live follow list, `requested` from the store's pending invite-requests
   * (keyed by address). Shared by the relationships/lookup/account endpoints
   * so `requested` surfaces consistently.
   */
  const relationshipForContact = (
    contact: T.Contact,
    followedIds: Set<number>,
  ): MastodonRelationship =>
    relationshipFor(
      followedIds.has(contact.id),
      contact.id,
      store.hasPendingFollowRequest(contact.address),
    );

  const isPublicMessage = (msg: T.Message): boolean => {
    const parsed = parseWire(msg.text);
    return (
      parsed.visibility !== 'private' &&
      parsed.visibility !== 'direct' &&
      !(parsed.uuid && (store.isLockedPost(parsed.uuid) || store.isDirectPost(parsed.uuid)))
    );
  };

  const publicAccountProjection = (account: MastodonStatus['account']): MastodonStatus['account'] => {
    const pleroma = account.pleroma as Record<string, unknown>;
    const headwater = (pleroma['headwater'] ?? pleroma['deltanet'] ?? {}) as Record<string, unknown>;
    const { relationship: _relationship, ...publicPleroma } = pleroma;
    const { petname: _petname, ...publicHeadwater } = headwater;
    const authName = typeof publicHeadwater['auth_name'] === 'string' && publicHeadwater['auth_name']
      ? publicHeadwater['auth_name']
      : account.display_name;
    return {
      ...account,
      display_name: authName,
      pleroma: {
        ...publicPleroma,
        headwater: publicHeadwater,
        deltanet: publicHeadwater,
      },
    } as MastodonStatus['account'];
  };

  const publicStatusProjection = (status: MastodonStatus): MastodonStatus => {
    return {
      ...status,
      account: publicAccountProjection(status.account),
      in_reply_to_id: null,
      in_reply_to_account_id: null,
      favourites_count: 0,
      reblogs_count: 0,
      replies_count: 0,
      favourited: false,
      reblogged: false,
      bookmarked: false,
      muted: false,
      pinned: false,
      mentions: [],
      reblog: status.reblog ? publicStatusProjection(status.reblog) : null,
      pleroma: {
        ...status.pleroma,
        conversation_id: null,
        emoji_reactions: [],
        headwater: undefined,
        deltanet: undefined,
      },
    };
  };

  const isPublicStatusTree = (status: MastodonStatus): boolean =>
    status.visibility === 'public' &&
    (status.reblog === null || isPublicStatusTree(status.reblog));

  const isPublicMessageTree = async (
    transport: Transport,
    msg: T.Message,
    seen = new Set<number>(),
  ): Promise<boolean> => {
    if (seen.has(msg.id) || !store.isFeedMessage(msg.id) || !isPublicMessage(msg)) return false;
    seen.add(msg.id);
    const parsed = parseWire(msg.text);
    if (parsed.boostOrig?.visibility === 'private' || parsed.boostOrig?.visibility === 'direct') {
      return false;
    }
    if (!parsed.boost) return true;
    const targetId = store.resolveKey(parsed.boost.keyString);
    if (targetId === null) return false;
    const target = await transport.message(targetId);
    return target ? isPublicMessageTree(transport, target, seen) : false;
  };

  const mapPublicMessages = async (
    transport: Transport,
    messages: T.Message[],
  ): Promise<MastodonStatus[]> => {
    const statuses: MastodonStatus[] = [];
    for (const msg of messages) {
      if (!(await isPublicMessageTree(transport, msg))) continue;
      const status = await toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id));
      if (isPublicStatusTree(status)) statuses.push(publicStatusProjection(status));
    }
    return statuses;
  };

  const hasPublicMessage = async (transport: Transport, messages: T.Message[]): Promise<boolean> => {
    for (const message of messages) {
      if (await isPublicMessageTree(transport, message)) return true;
    }
    return false;
  };

  // Leak prevention: revoke a follower from BOTH channels (Mastodon's
  // remove_from_followers). Future delivery only — already-delivered posts
  // stay on their device.
  app.post('/api/v1/accounts/:id/remove_from_followers', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contactId = Number(c.req.param('id'));
    if (!Number.isInteger(contactId) || contactId <= 0 || contactId === 1) {
      return c.json({ error: 'Record not found' }, 404);
    }
    const contact = await transport.contact(contactId);
    if (!contact) return c.json({ error: 'Record not found' }, 404);
    await transport.removeFollower(contactId);
    return c.json({ ...relationshipFor(false, contactId), followed_by: false });
  });

  app.get('/api/v1/accounts/relationships', requireTransport, async (c) => {
    const transport = c.get('transport');
    const raw = c.req.queries('id[]') ?? c.req.queries('id') ?? [];
    const ids = raw.map(Number);
    const followedIds = new Set((await followedFeeds(transport)).map((f) => f.contactId));
    const contacts = await Promise.all(ids.map((id) => transport.contact(id)));
    return c.json(
      ids.map((id, i) => {
        const contact = contacts[i];
        return contact
          ? relationshipForContact(contact, followedIds)
          : relationshipFor(followedIds.has(id), id);
      }),
    );
  });

  // Registered before `/:id` so the static segment wins. The frontend
  // resolves profile routes via this endpoint; the handle is an email
  // address (our acct values are full addresses), optionally "@"-prefixed,
  // or a bare local part matching our own account's username.
  app.get('/api/v1/accounts/lookup', requireTransport, async (c) => {
    const transport = c.get('transport');
    const raw = (c.req.query('acct') ?? '').trim();
    if (!raw) return c.json({ error: 'Record not found' }, 404);
    const handle = raw.startsWith('@') ? raw.slice(1) : raw;
    const contactId = await transport.contactIdByAddr(handle);
    const contact = contactId !== null ? await transport.contact(contactId) : null;
    if (!contact) return c.json({ error: 'Record not found' }, 404);
    const followedIds = new Set((await followedFeeds(transport)).map((f) => f.contactId));
    const relationship = relationshipForContact(contact, followedIds);
    return c.json(contactToAccount(contact, baseUrl, relationship));
  });

  // Search (see ../meta/issues/search.md): users we know about (every contact
  // row, key or keyless — search is discovery, not deliverability) + posts we
  // know about (core's full-text search over all chats, filtered to CONTENT
  // messages and deduped so a reply's feed/DM copies collapse; plus VERIFIED
  // held envelopes we never received directly). No hashtag system → [].
  app.get('/api/v2/search', requireTransport, async (c) => {
    const transport = c.get('transport');
    const q = (c.req.query('q') ?? '').trim();
    const type = c.req.query('type');
    const limit = Math.max(1, Math.min(intParam(c.req.query('limit')) ?? 20, 40));
    if (!q) return c.json({ accounts: [], statuses: [], hashtags: [] });

    const accounts =
      type && type !== 'accounts'
        ? []
        : rankedContactSearch(await transport.contacts(), q, limit).map((contact) =>
            contactToAccount(contact, baseUrl),
          );

    let statuses: MastodonStatus[] = [];
    if (!type || type === 'statuses') {
      const seenKeys = new Set<string>();
      const hits: T.Message[] = [];
      // Overfetch: some ids are control DMs or duplicate copies.
      for (const msgId of (await transport.searchMessages(q)).slice(0, limit * 4)) {
        if (hits.length >= limit) break;
        const msg = await transport.message(msgId);
        if (!msg || !isSearchableContent(msg.text)) continue;
        const parsed = parseWire(msg.text);
        if (parsed.visibility === 'direct' || (parsed.uuid && store.isDirectPost(parsed.uuid))) {
          continue;
        }
        // Collapse copies of one logical post onto the store-preferred copy
        // (the feed copy when both exist).
        const key = parsed.uuid ?? null;
        const canonicalId = key !== null ? (store.resolveKey(key) ?? msg.id) : msg.id;
        const dedupeKey = key ?? `msg:${canonicalId}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        const canonical = canonicalId === msg.id ? msg : await transport.message(canonicalId);
        hits.push(canonical ?? msg);
      }
      statuses = await Promise.all(
        hits.map((msg) => toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id))),
      );

      // Held envelopes: verified-only (heldStatus runs the render-time verify
      // ladder and returns null on failure), text-matched, and only for posts
      // with NO local copy (a local copy is already covered by core's search).
      const needle = q.toLowerCase();
      for (const uuid of store.heldEnvelopeUuids()) {
        if (statuses.length >= limit) break;
        if (seenKeys.has(uuid) || store.resolveKey(uuid) !== null) continue;
        const held = store.heldEnvelope(uuid);
        if (
          !held?.env.text ||
          held.env.visibility === 'direct' ||
          !held.env.text.toLowerCase().includes(needle)
        ) continue;
        const status = await heldStatusConfirming(transport, uuid, heldReplyParentId(held.env));
        if (!status) continue;
        seenKeys.add(uuid);
        statuses.push(status);
      }

      statuses.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      statuses = statuses.slice(0, limit);
    }

    return c.json({ accounts, statuses, hashtags: [] });
  });

  // Mention autocomplete (see ../meta/issues/mention-addressing-autocomplete.md):
  // known key-contacts matching `q`, petname match first, then their name,
  // then the address. Registered before `/:id` so the static segment wins.
  app.get('/api/v1/accounts/search', requireTransport, async (c) => {
    const transport = c.get('transport');
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.max(0, Math.min(intParam(c.req.query('limit')) ?? 5, 40));
    if (!q || limit === 0) return c.json([]);
    const matches = rankedContactMatches(await transport.contacts(), q, limit);
    return c.json(matches.map((contact) => contactToAccount(contact, baseUrl)));
  });

  app.get('/api/v1/accounts/:id', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contactId = Number(c.req.param('id'));
    const contact = await transport.contact(contactId);
    if (!contact) return c.json({ error: 'Record not found' }, 404);
    const authenticated = !enabledSecurity || Boolean(c.get('authSession'));
    if (!authenticated && contactId !== DC_CONTACT_ID_SELF) {
      const publicMessages = await transport.timelineFrom(contactId, { limit: DEFAULT_PAGE });
      for (const message of publicMessages) await ingest(transport, message, true);
      if (!(await hasPublicMessage(transport, publicMessages))) return c.json({ error: 'Record not found' }, 404);
    }
    if (!authenticated) {
      return c.json(publicAccountProjection(contactToAccount({
        ...contact,
        name: '',
        displayName: contact.authName || contact.displayName,
      }, baseUrl)));
    }
    const followedIds = new Set((await followedFeeds(transport)).map((f) => f.contactId));
    const relationship = relationshipForContact(contact, followedIds);
    return c.json(contactToAccount(contact, baseUrl, relationship));
  });

  app.post('/api/v1/accounts/:id/unfollow', requireTransport, async (c) => {
    const contactId = Number(c.req.param('id'));
    await c.get('transport').unfollow(contactId);
    return c.json(relationshipFor(false, contactId));
  });

  // Follow-back via invite-request (see ../meta/issues/follow-back-invite-request.md):
  // a known contact already shares a verified 1:1 channel with us, so instead
  // of pasting an invite link we DM them a `⇋ invite-request` and record the
  // request as pending. Their daemon auto-grants (replies with its feed
  // invite); our ingest hook joins on the grant and clears the pending marker,
  // flipping `following` true via the normal `transport.following()` path.
  app.post('/api/v1/accounts/:id/follow', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contactId = Number(c.req.param('id'));
    const contact = await transport.contact(contactId);
    if (!contact) return c.json({ error: 'Record not found' }, 404);

    const followedIds = new Set((await followedFeeds(transport)).map((f) => f.contactId));
    // Already following: no-op, return the current relationship unchanged.
    if (followedIds.has(contactId)) {
      return c.json(relationshipForContact(contact, followedIds));
    }

    // v2 invite-request envelope (no human quotedText bubble — 0001).
    await transport.sendControlDm(contactId, buildInviteRequestEnvelope());
    store.addPendingFollowRequest(contact.address, Date.now());

    return c.json(relationshipFor(false, contactId, true));
  });

  app.get('/api/v1/accounts/:id/statuses', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contactId = Number(c.req.param('id'));
    const limit = intParam(c.req.query('limit')) ?? DEFAULT_PAGE;
    const publicOnly = Boolean(enabledSecurity) && !c.get('authSession');
    const outerMessages = await transport.timelineFrom(contactId, {
      limit,
      maxId: intParam(c.req.query('max_id')),
      minId: intParam(c.req.query('min_id')) ?? intParam(c.req.query('since_id')),
    });
    for (const message of outerMessages) await ingest(transport, message, true);
    const messages = outerMessages.filter((msg) => {
      if (publicOnly) return isPublicMessage(msg);
      const parsed = parseWire(msg.text);
      return parsed.visibility !== 'direct' && !(parsed.uuid && store.isDirectPost(parsed.uuid));
    });
    const statuses = publicOnly
      ? await mapPublicMessages(transport, messages)
      : await Promise.all(messages.map((msg) => toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id))));
    return c.json(statuses);
  });

  // --- Timelines ----------------------------------------------------------

  /**
   * Filter out messages that arrived on a THREAD-SUBSCRIPTION channel
   * (thread-subscribe): a subscribed thread's chat is an InBroadcast just like a
   * followed feed, so its republished replies would otherwise leak into the home
   * timeline. Subscribed content belongs to the THREAD VIEW only (context
   * endpoint), never the home/public timeline. Keyed off the store's
   * `threadSubscriptions` map — the transport-neutral way to tell a thread
   * channel apart from a real feed.
   */
  const excludeThreadSubscriptionMessages = (messages: T.Message[]): T.Message[] => {
    const excluded = new Set(store.threadSubscriptionChatIds());
    if (excluded.size === 0) return messages;
    return messages.filter((m) => !excluded.has(m.chatId));
  };

  /**
   * Followed FEEDS only — `transport.following()` minus any InBroadcast chat we
   * joined as a THREAD SUBSCRIPTION (thread-subscribe). A subscribed thread's
   * channel is an InBroadcast too, so without this filter it would pollute the
   * following list / relationship computations. Distinguished purely by the
   * store's `threadSubscriptions` map (chatId), never a transport-level hack.
   */
  const followedFeeds = async (
    transport: Transport,
  ): Promise<Awaited<ReturnType<Transport['following']>>> => {
    const excluded = new Set(store.threadSubscriptionChatIds());
    const feeds = await transport.following();
    return excluded.size === 0 ? feeds : feeds.filter((f) => !excluded.has(f.chatId));
  };

  const timeline = async (c: Context<AppEnv>, publicOnly = false) => {
    const transport = c.get('transport');
    const limit = intParam(c.req.query('limit')) ?? DEFAULT_PAGE;
    const outerMessages = excludeThreadSubscriptionMessages(
      await transport.timeline({
        limit,
        maxId: intParam(c.req.query('max_id')),
        minId: intParam(c.req.query('min_id')) ?? intParam(c.req.query('since_id')),
      }),
    );
    for (const message of outerMessages) await ingest(transport, message, true);
    const messages = outerMessages.filter((msg) => {
      if (publicOnly) return isPublicMessage(msg);
      const parsed = parseWire(msg.text);
      return parsed.visibility !== 'direct' && !(parsed.uuid && store.isDirectPost(parsed.uuid));
    });
    const statuses: MastodonStatus[] = publicOnly
      ? await mapPublicMessages(transport, messages)
      : await Promise.all(messages.map((msg) => toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id))));
    const link = timelineLinkHeader(
      `${baseUrl}${new URL(c.req.url).pathname}`,
      statuses.map((s) => s.id),
    );
    if (link) c.header('Link', link);
    return c.json(statuses);
  };

  app.get('/api/v1/timelines/home', requireTransport, (c) => timeline(c));
  app.get('/api/v1/timelines/public', requireTransport, (c) => timeline(c, enabledSecurity !== null));

  // --- Statuses -----------------------------------------------------------

  const mediaIds = (body: Record<string, unknown>): string[] => {
    const raw = body['media_ids[]'] ?? body['media_ids'];
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    return raw === undefined ? [] : [String(raw)].filter(Boolean);
  };

  app.post('/api/v1/statuses', requireTransport, async (c) => {
    const transport = c.get('transport');
    const contentType = c.req.header('content-type') ?? '';
    const body = contentType.includes('json')
      ? await c.req.json()
      : await c.req.parseBody({ all: true });
    const requestedVisibilityValue = String(body['visibility'] ?? '');
    if (!['', 'public', 'private', 'direct'].includes(requestedVisibilityValue)) {
      return c.json({ error: `Unsupported visibility: ${requestedVisibilityValue}`, code: 'unsupported_capability' }, 422);
    }
    if (String(body['spoiler_text'] ?? '').trim()) {
      return c.json({ error: 'Content warnings are not supported by this Headwater node', code: 'unsupported_capability' }, 422);
    }
    if (Object.keys(body).some((key) => key === 'poll' || key.startsWith('poll['))) {
      return c.json({ error: 'Polls are not supported by this Headwater node', code: 'unsupported_capability' }, 422);
    }
    const text = String(body['status'] ?? '').trim();
    const submittedMediaIds = mediaIds(body as Record<string, unknown>);
    if (submittedMediaIds.length > 1) {
      return c.json({ error: 'Validation failed: only one media attachment is supported' }, 422);
    }
    const mediaId = submittedMediaIds[0];
    const mediaLease = mediaId ? mediaStore.acquire(mediaId) : undefined;
    const media = mediaLease?.record;
    if (mediaId && !media) {
      return c.json({ error: 'Validation failed: media is expired, consumed, or unknown' }, 422);
    }
    if (!text && !media) {
      return c.json({ error: 'Validation failed: text cannot be blank' }, 422);
    }

    try {

    const inReplyToId = body['in_reply_to_id'] != null ? String(body['in_reply_to_id']) : undefined;
    // Visibility delivery: direct bypasses owned broadcasts entirely and uses
    // pre-resolved 1:1 content DMs; private uses the locked channel; everything
    // else uses public. Reply inheritance below can force a stricter tier.
    const requestedVisibility = requestedVisibilityValue;
    let direct = requestedVisibility === 'direct';
    let channel: OwnChannel = requestedVisibility === 'private' ? 'locked' : 'public';
    /** Unsigned honest-machinery marker; the signed body/refs remain unchanged. */
    const visibilityMark = () =>
      direct
        ? { visibility: 'direct' as const }
        : channel === 'locked'
          ? { visibility: 'private' as const }
          : {};
    if (inReplyToId) {
      const parsedParent = parseStatusId(inReplyToId);
      if (parsedParent?.kind === 'orig') {
        // Embed-only interaction: reply to a VERIFIED post we hold only as a
        // held envelope / boost embed. The uuid ref threads on any node holding
        // any copy; the parent DM copy goes to the AUTHOR (introduced in-band
        // when never met) in the background; the root rides signed as usual
        // (the held parent's own root, or the parent itself when it is one).
        const orig = await resolveOrigAction(transport, parsedParent.uuid);
        if (!orig) return c.json({ error: 'Record not found' }, 404);
        // Reply privacy inheritance: a private-marked held parent forces the
        // reply onto the locked channel.
        if (orig.env.visibility === 'direct' || store.isDirectPost(parsedParent.uuid)) {
          direct = true;
        } else if (orig.env.visibility === 'private') {
          channel = 'locked';
        }
        const envRef: EnvelopeRef = { u: parsedParent.uuid, addr: orig.authorAddr };
        const root =
          orig.env.root ??
          (orig.env.type !== 'reply' ? { u: parsedParent.uuid, addr: orig.authorAddr } : undefined);
        const uuid = mintUuid();
        const mediaFields = media
          ? { description: media.description, sha256: await sha256File(media.path) }
          : undefined;
        let directRecipients: DirectRecipient[] | null = null;
        if (direct) {
          const parentId = await transport.keyContactIdForAddr(orig.authorAddr).catch(() => null);
          if (parentId === null) {
            return c.json({ error: "can't reach every direct recipient", code: 'unreachable_recipient' }, 422);
          }
          directRecipients = await resolveDirectRecipients(transport, text, [
            { contactId: parentId, addr: orig.authorAddr },
          ]);
          if (!directRecipients || directRecipients.length === 0) {
            return c.json({ error: 'direct posts require a non-self key-contact recipient' }, 422);
          }
        }
        const replyText = signEnvelope(
          { ...buildReplyObject(text, uuid, envRef, mediaFields, root), ...visibilityMark() },
          await mapper.ownAddr(transport),
          await ownContactInvite(transport),
        );
        const delivery = direct
          ? await sendDirectCopies(transport, replyText, directRecipients!, media?.path)
          : null;
        const sent = delivery?.messages ?? [await transport.post(replyText, { channel, ...(media ? { file: media.path } : {}) })];
        if (direct && sent.length === 0) return c.json(directDeliveryError(delivery!), 502);
        const msg = sent[0]!;
        for (const copy of sent) {
          if (media) mediaStore.tagMessage(copy.id, media.description);
          await ingest(transport, copy, !direct);
        }
        if (direct) store.markDirectPost(uuid);
        else if (channel === 'locked') store.markLockedPost(uuid);
        if (delivery?.failed) return c.json(directDeliveryError(delivery), 502);
        if (direct) return c.json(await toStatus(transport, msg, media?.description ?? null));
        // Parent-author DM copy + root copy, both key-contact-first with
        // in-band introduction, background + best-effort.
        const myAddr = (await mapper.ownAddr(transport)).toLowerCase();
        backgroundMutation(async () => {
          const parentId = await keyContactOrIntroduce(transport, orig.authorAddr, orig.env.invite ?? null);
          if (parentId !== null && parentId !== DC_CONTACT_ID_SELF) {
            await transport.sendControlDm(parentId, replyText);
          }
          const rootAddr = root ? envelopeRefAddr(root) : undefined;
          if (rootAddr && rootAddr.toLowerCase() !== orig.authorAddr.toLowerCase() && rootAddr.toLowerCase() !== myAddr) {
            const rootUuid = root && 'u' in root ? root.u : null;
            const invite = rootUuid ? await rootPostInvite(transport, rootUuid) : null;
            const rootId = await keyContactOrIntroduce(transport, rootAddr, invite);
            if (rootId !== null && rootId !== DC_CONTACT_ID_SELF) {
              await transport.sendControlDm(rootId, replyText);
            }
          }
        }, (err) => console.error('orig reply copies failed (non-fatal):', err));
        await deliverMentionCopies(transport, replyText, text, [
          myAddr,
          orig.authorAddr,
          root ? envelopeRefAddr(root) : undefined,
        ]);
        return c.json(await toStatus(transport, msg, media?.description ?? null));
      }
      // A non-numeric, non-orig id (e.g. junk) is a clean 404, never a
      // Number(NaN) -> transport.message(NaN) crash.
      if (parsedParent?.kind !== 'msg') return c.json({ error: 'Record not found' }, 404);
      const target = await transport.message(parsedParent.msgId);
      if (!target) return c.json({ error: 'Record not found' }, 404);
      // The reply target's ref TOKEN: its logical-post uuid if it carries one,
      // else a canonical/mid ref. A uuid ref resolves on any node holding any
      // copy of the target — including a third party who only has the feed copy.
      const ref = await targetRef(transport, target);
      if (!ref) return c.json({ error: 'cannot resolve message id for reply target' }, 422);
      // Reply privacy inheritance: a private-marked parent (received) or an
      // own locked parent forces the reply onto the locked channel.
      const parentUuid = parseWireUuid(target.text);
      if (
        parseWire(target.text).visibility === 'direct' ||
        (parentUuid !== null && store.isDirectPost(parentUuid))
      ) {
        direct = true;
      } else if (
        !direct &&
        (parseWire(target.text).visibility === 'private' ||
          (parentUuid !== null && store.isLockedPost(parentUuid)))
      ) {
        channel = 'locked';
      }
      const envRef = refTokenToEnvelopeRef(ref, target.sender.address);
      await ingest(transport, target);

      // Mint ONE logical-post UUID for THIS reply and emit the SAME SIGNED v2
      // envelope (byte-identical) as BOTH copies — the feed broadcast copy and
      // the DM copy to the parent author — so a node holding either copy (or
      // only a ref) unifies the one logical post. No quotedText bubble (0001).
      // The signed envelope covers the media content hash so a boosted copy of
      // this reply's image stays verifiable.
      const uuid = mintUuid();
      const mediaFields = media
        ? { description: media.description, sha256: await sha256File(media.path) }
        : undefined;
      // The signed thread-root ref (best-effort; omitted when unknowable) MUST be
      // set before signing — it rides inside the dn3 canonical payload so a
      // mid-thread holder can name the thread + owner.
      const root = await deriveRootRef(transport, target);
      const directRecipients = direct
        ? await resolveDirectRecipients(
            transport,
            text,
            target.sender.id === DC_CONTACT_ID_SELF
              ? []
              : [{ contactId: target.sender.id, addr: target.sender.address }],
          )
        : null;
      if (direct && (!directRecipients || directRecipients.length === 0)) {
        return c.json(
          {
            error: directRecipients === null
              ? "can't reach every direct recipient"
              : 'direct posts require a non-self key-contact recipient',
            ...(directRecipients === null ? { code: 'unreachable_recipient' } : {}),
          },
          422,
        );
      }
      const replyText = signEnvelope(
        { ...buildReplyObject(text, uuid, envRef, mediaFields, root), ...visibilityMark() },
        await mapper.ownAddr(transport),
        await ownContactInvite(transport),
      );

      const delivery = direct
        ? await sendDirectCopies(transport, replyText, directRecipients!, media?.path)
        : null;
      const sent = delivery?.messages ?? [await transport.post(replyText, { channel, ...(media ? { file: media.path } : {}) })];
      if (direct && sent.length === 0) return c.json(directDeliveryError(delivery!), 502);
      const msg = sent[0]!;
      for (const copy of sent) {
        if (media) mediaStore.tagMessage(copy.id, media.description);
        await ingest(transport, copy, !direct);
      }
      if (direct) store.markDirectPost(uuid);
      else if (channel === 'locked') store.markLockedPost(uuid);
      if (delivery?.failed) return c.json(directDeliveryError(delivery), 502);
      if (direct) return c.json(await toStatus(transport, msg, media?.description ?? null));

      // Thread-subscribe (host side): if WE host the thread this reply belongs to,
      // republish our OWN reply into the channel now — a self-authored feed post
      // never re-arrives via the ingest hook (no IncomingMsg for own sends), so the
      // republication must be triggered at post time. Dedupe + signed-only gating
      // live in `republishReplyToThread`; idempotent with the ingest-hook path for
      // replies we RECEIVE from others. Best-effort.
      await republishReplyToThread(store, transport, msg, true).catch((err) => {
        console.error('own-reply thread republication failed (non-fatal):', err);
      });

      if (target.sender.id !== DC_CONTACT_ID_SELF) {
        // DM copy: byte-identical envelope, SAME uuid as the feed copy.
        await transport.sendControlDm(target.sender.id, replyText).catch((err) => {
          console.error('sendControlDm failed (non-fatal):', err);
        });
      }

      // Root DM copy (thread completeness by construction): also copy the SAME
      // reply envelope to the ROOT author when known, distinct from the parent
      // author and not SELF, so the root accumulates the full thread (a thread
      // host must be complete). Delivery targets a KEY-contact; for a NEVER-MET
      // root author we introduce ourselves IN-BAND via the invite carried by
      // the root post we hold (backfill fetches roots, roots carry invites).
      // The introduction path runs in the BACKGROUND — a securejoin is a
      // multi-message email exchange and must never delay the reply response —
      // and everything here is BEST-EFFORT: no failure may fail the reply,
      // feed post, or parent copy.
      const rootAddr = root ? envelopeRefAddr(root) : undefined;
      const parentAddr = target.sender.address.toLowerCase();
      const myAddr = (await mapper.ownAddr(transport)).toLowerCase();
      if (
        rootAddr &&
        rootAddr.toLowerCase() !== parentAddr &&
        rootAddr.toLowerCase() !== myAddr
      ) {
        const rootUuidForInvite = root && 'u' in root ? root.u : null;
        backgroundMutation(async () => {
          const invite = rootUuidForInvite
            ? await rootPostInvite(transport, rootUuidForInvite)
            : null;
          const rootContactId = await keyContactOrIntroduce(transport, rootAddr, invite);
          if (rootContactId === null || rootContactId === DC_CONTACT_ID_SELF) return;
          await transport.sendControlDm(rootContactId, replyText);
        }, (err) => {
          console.error('root copy (incl. introduction) failed (non-fatal):', err);
        });
      }

      await deliverMentionCopies(transport, replyText, text, [myAddr, parentAddr, rootAddr]);
      return c.json(await toStatus(transport, msg, media?.description ?? null));
    }

    // A plain post carries its own minted logical-post UUID (v2 envelope) so
    // replies/boosts/reactions can target it by uuid (resolvable on any node).
    // Alt text rides in the envelope's `media.description` (persistent +
    // federated); the SIGNED envelope also covers the media content hash
    // (`media.sha256`) so a boosted copy of this post's image is verifiable.
    const postMedia = media
      ? { description: media.description, sha256: await sha256File(media.path) }
      : undefined;
    const postUuid = mintUuid();
    const directRecipients = direct ? await resolveDirectRecipients(transport, text) : null;
    if (direct && (!directRecipients || directRecipients.length === 0)) {
      return c.json(
        {
          error: directRecipients === null
            ? "can't reach every direct recipient"
            : 'direct posts require a non-self key-contact recipient',
          ...(directRecipients === null ? { code: 'unreachable_recipient' } : {}),
        },
        422,
      );
    }
    const postText = signEnvelope(
      { ...buildPostObject(text, postUuid, postMedia), ...visibilityMark() },
      await mapper.ownAddr(transport),
      await ownContactInvite(transport),
    );
    const delivery = direct
      ? await sendDirectCopies(transport, postText, directRecipients!, media?.path)
      : null;
    const sent = delivery?.messages ?? [await transport.post(postText, { channel, ...(media ? { file: media.path } : {}) })];
    if (direct && sent.length === 0) return c.json(directDeliveryError(delivery!), 502);
    const msg = sent[0]!;
    for (const copy of sent) {
      if (media) mediaStore.tagMessage(copy.id, media.description);
      await ingest(transport, copy, !direct);
    }
    if (direct) store.markDirectPost(postUuid);
    else if (channel === 'locked') store.markLockedPost(postUuid);
    if (delivery?.failed) return c.json(directDeliveryError(delivery), 502);
    if (direct) return c.json(await toStatus(transport, msg, media?.description ?? null));
    await deliverMentionCopies(transport, postText, text, [
      (await mapper.ownAddr(transport)).toLowerCase(),
    ]);
    return c.json(await toStatus(transport, msg, media?.description ?? null));
    } finally {
      await mediaLease?.finish();
    }
  });

  // --- Media uploads --------------------------------------------------------

  app.post('/api/v1/media', requireTransport, async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: "Validation failed: file can't be blank" }, 422);
    }
    if (!isSupportedImageMime(file.type)) {
      return c.json({ error: 'Validation failed: unsupported media type' }, 422);
    }
    if (file.size > limits.maxMediaBytes) {
      return c.json({
        error: `Media file exceeds the ${formatByteLimit(limits.maxMediaBytes)} limit`,
        code: 'media_too_large',
      }, 413);
    }
    const description = body['description'] != null ? String(body['description']) : null;
    let id: string;
    try {
      ({ id } = await mediaStore.save(file, description));
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        return c.json({ error: error.message, code: 'media_too_large' }, 413);
      }
      if (error instanceof MediaCapacityError) {
        return c.json({ error: 'Too many staged media uploads; remove or post one and retry', code: 'media_capacity' }, 429);
      }
      if (error instanceof MediaDescriptionTooLargeError) {
        return c.json({ error: `Media description exceeds the ${formatByteLimit(error.maxBytes)} limit`, code: 'description_too_large' }, 422);
      }
      throw error;
    }
    return c.json({
      id,
      type: 'image',
      url: '',
      preview_url: '',
      description,
    });
  });

  app.put('/api/v1/media/:id', requireTransport, async (c) => {
    const body: { description?: unknown } = await c.req.json<{ description?: unknown }>().catch(() => ({}));
    const description = body.description == null ? null : String(body.description);
    let record: MediaRecord | undefined;
    try {
      record = mediaStore.updateDescription(c.req.param('id') ?? '', description);
    } catch (error) {
      if (error instanceof MediaDescriptionTooLargeError) {
        return c.json({ error: `Media description exceeds the ${formatByteLimit(error.maxBytes)} limit`, code: 'description_too_large' }, 422);
      }
      throw error;
    }
    if (!record) return c.json({ error: 'Record not found' }, 404);
    return c.json({
      id: c.req.param('id'),
      type: 'image',
      url: '',
      preview_url: '',
      description: record.description,
    });
  });

  app.delete('/api/v1/media/:id', requireTransport, async (c) => {
    await mediaStore.discard(c.req.param('id') ?? '');
    return c.body(null, 204);
  });

  // --- Reblog / unreblog ---------------------------------------------------

  app.post('/api/v1/statuses/:id/reblog', requireTransport, async (c) => {
    const transport = c.get('transport');
    const parsed = parseStatusId(c.req.param('id'));
    if (parsed?.kind === 'orig') {
      // Embed-only interaction: boost a VERIFIED post we hold only as a held
      // envelope / boost embed. We re-embed the SAME author-signed envelope
      // VERBATIM — attestations make second-hand boosts sound (no trust chain
      // needed). Declared media we cannot re-attach (media is not bundled) ->
      // ref-only, the same rule as an unattestable local target.
      const orig = await resolveOrigAction(transport, parsed.uuid);
      if (!orig) return c.json({ error: 'Record not found' }, 404);
      // Leak guard: a held/embedded followers-only post is not reboggable.
      if (orig.env.visibility === 'private' || orig.env.visibility === 'direct' || store.isDirectPost(parsed.uuid)) {
        return c.json({ error: 'private/locked or direct posts cannot be boosted' }, 422);
      }
      const envRef: EnvelopeRef = { u: parsed.uuid, addr: orig.authorAddr };
      const embed = orig.env.media?.sha256 ? undefined : orig.env;
      const boostText = signEnvelope(
        buildBoostObject(mintUuid(), envRef, embed),
        await mapper.ownAddr(transport),
        await ownContactInvite(transport),
      );
      const msg = await transport.post(boostText);
      await ingest(transport, msg);
      const status = await resolveOrigStatus(transport, parsed.uuid);
      if (!status) return c.json({ error: 'Record not found' }, 404);
      return c.json({
        id: String(msg.id),
        reblog: status,
        reblogged: true,
        content: '',
      });
    }
    const target = parsed?.kind === 'msg' ? await transport.message(parsed.msgId) : null;
    if (!target) return c.json({ error: 'Record not found' }, 404);
    // Leak guards: boosting a followers-only post would republish it into the
    // public feed. Refuse for OWN locked posts (store-known) AND for RECEIVED
    // posts carrying the wire marker (Mastodon semantics: private posts are
    // not reboggable).
    const targetUuid = parseWireUuid(target.text);
    if (
      (targetUuid && store.isLockedPost(targetUuid)) ||
      (targetUuid && store.isDirectPost(targetUuid)) ||
      parseWire(target.text).visibility === 'private' ||
      parseWire(target.text).visibility === 'direct'
    ) {
      return c.json({ error: 'private/locked or direct posts cannot be boosted' }, 422);
    }
    // Target the boosted post's uuid ref (or canonical/mid) so the boost
    // resolves on any node, even when acting on a DM copy.
    const ref = await targetRef(transport, target);
    if (!ref) return c.json({ error: 'cannot resolve message id to boost' }, 422);
    await ingest(transport, target);

    // Boost embedding (post attestations, sketch #6 / decision 0002): the target
    // message the booster holds — its TEXT IS the boosted post's envelope. We
    // embed that object VERBATIM as `orig` so recipients who lack the original
    // can verify it offline. Requirements to embed:
    //  - the target parses as a SIGNED v2 envelope (has sig + pubkey); an
    //    unsigned/legacy target has nothing to attest → ref-only boost, and the
    //    recipient gets the placeholder ladder. We never fabricate an attestation.
    //  - if the target declares media (orig.media.sha256), we re-attach the SAME
    //    file to the boost message so the recipient can hash-verify it; if the
    //    target has a file but the envelope carries NO signed sha256, we cannot
    //    attest the bytes → ref-only (no orig), never a fabricated hash.
    const orig = parseEnvelope(target.text);
    const canEmbed = orig !== null && !!orig.sig && !!orig.pubkey;
    // Only re-attach (and only embed) when the signed envelope covers the file's
    // hash; a media target whose envelope lacks a signed sha256 falls back to
    // ref-only so the recipient never sees an unverifiable image.
    const embedMedia = canEmbed && !!orig!.media?.sha256 && !!target.file;
    const embedOrig = canEmbed && (!target.file || embedMedia);

    const boostText = signEnvelope(
      buildBoostObject(
        mintUuid(),
        refTokenToEnvelopeRef(ref, target.sender.address),
        embedOrig ? orig! : undefined,
      ),
      await mapper.ownAddr(transport),
      await ownContactInvite(transport),
    );

    const msg = await transport.post(
      boostText,
      embedMedia && target.file ? { file: target.file } : undefined,
    );
    await ingest(transport, msg);

    // The response wraps our new boost message; it always reflects "you just
    // reblogged this", regardless of what the store's (possibly-stale, in
    // the fake-transport-test sense) boost tally for the boost message
    // itself would say.
    const status = await toStatus(transport, msg);
    return c.json({ ...status, reblogged: true });
  });

  app.post('/api/v1/statuses/:id/unreblog', requireTransport, async (c) => {
    const transport = c.get('transport');
    const parsed = parseStatusId(c.req.param('id'));
    if (parsed?.kind === 'orig') {
      // Embed-only unboost: our own boost of the uuid post key, deleted for
      // all recipients (same as the numeric path).
      const ownBoostMsgId = store.ownBoostMsgId(parsed.uuid);
      if (ownBoostMsgId !== null) {
        await transport.deleteMessage(ownBoostMsgId);
      }
      const status = await resolveOrigStatus(transport, parsed.uuid);
      if (!status) return c.json({ error: 'Record not found' }, 404);
      return c.json({ ...status, reblogged: false });
    }
    const target = parsed?.kind === 'msg' ? await transport.message(parsed.msgId) : null;
    if (!target) return c.json({ error: 'Record not found' }, 404);
    // Look up our own boost of this target under its POST KEY (uuid ref or
    // canonical mid) — the same key `reblog` registered `ownBoosts` under.
    const ref = await targetRef(transport, target);
    const ownBoostMsgId = ref ? store.ownBoostMsgId(refKeyString(ref)) : null;
    if (ownBoostMsgId !== null) {
      await transport.deleteMessage(ownBoostMsgId);
    }

    // Retracted: report the original with reblogged:false regardless of the
    // store's tally (it isn't updated on delete — the daemon only tracks
    // what it has *seen posted*, not retractions, per the wire convention's
    // "authoritative only for what this node has seen" caveat).
    const status = await toStatus(transport, target, mediaStore.descriptionForMessage(target.id));
    return c.json({ ...status, reblogged: false });
  });

  // --- Favourites / emoji reactions -----------------------------------------

  /**
   * Shared react/unreact flow for both `/favourite` (❤) and the arbitrary
   * `pleroma/reactions/:emoji` endpoints. Applies our own reaction to the
   * store immediately (so the response reflects it without waiting on
   * delivery), and DMs the author unless the target is our own post.
   */
  const reactToStatus = async (
    c: Context<AppEnv>,
    emoji: string,
    action: 'react' | 'unreact',
  ) => {
    const transport = c.get('transport');
    const parsed = parseStatusId(c.req.param('id'));
    if (parsed?.kind === 'orig') {
      // Embed-only interaction: react to a VERIFIED post we hold only as a
      // held envelope / boost embed. Tally locally under the uuid post key;
      // deliver the control DM to the AUTHOR (tallies are authoritative
      // author-side) in the BACKGROUND, introducing in-band via the envelope's
      // own invite when we never met them — the response never waits on a
      // securejoin.
      const orig = await resolveOrigAction(transport, parsed.uuid);
      if (!orig) return c.json({ error: 'Record not found' }, 404);
      const myAddr = await mapper.ownAddr(transport);
      if (action === 'react') store.applyReaction(parsed.uuid, myAddr, emoji);
      else store.retractReaction(parsed.uuid, myAddr, emoji);
      const envRef: EnvelopeRef = { u: parsed.uuid, addr: orig.authorAddr };
      const text =
        action === 'react' ? buildReactEnvelope(emoji, envRef) : buildUnreactEnvelope(emoji, envRef);
      backgroundMutation(async () => {
        const id = await keyContactOrIntroduce(transport, orig.authorAddr, orig.env.invite ?? null);
        if (id !== null && id !== DC_CONTACT_ID_SELF) await transport.sendControlDm(id, text);
      }, (err) => console.error('orig reaction DM failed (non-fatal):', err));
      const status = await resolveOrigStatus(transport, parsed.uuid);
      return status ? c.json(status) : c.json({ error: 'Record not found' }, 404);
    }
    const target = parsed?.kind === 'msg' ? await transport.message(parsed.msgId) : null;
    if (!target) return c.json({ error: 'Record not found' }, 404);
    // Target the post's uuid ref (or canonical/mid) so a third party who only
    // has the feed copy sees our reaction, even when acting on a DM copy.
    const ref = await targetRef(transport, target);
    if (!ref) return c.json({ error: 'cannot resolve message id to react to' }, 422);
    await ingest(transport, target);

    const myAddr = await mapper.ownAddr(transport);
    // Apply to our own local tally under the target's POST KEY.
    const key = refKeyString(ref);
    if (action === 'react') store.applyReaction(key, myAddr, emoji);
    else store.retractReaction(key, myAddr, emoji);

    if (target.sender.id !== DC_CONTACT_ID_SELF) {
      // The control DM is a v2 react/unreact envelope carrying the typed ref,
      // which the recipient's `parseWireReaction` recovers. No quotedText (0001).
      const envRef = refTokenToEnvelopeRef(ref, target.sender.address);
      const text = action === 'react' ? buildReactEnvelope(emoji, envRef) : buildUnreactEnvelope(emoji, envRef);
      await transport.sendControlDm(target.sender.id, text).catch((err) => {
        console.error('sendControlDm failed (non-fatal):', err);
      });
    }

    return c.json(await toStatus(transport, target, mediaStore.descriptionForMessage(target.id)));
  };

  app.post('/api/v1/statuses/:id/favourite', requireTransport, (c) => reactToStatus(c, FAVOURITE_EMOJI, 'react'));
  app.post('/api/v1/statuses/:id/unfavourite', requireTransport, (c) =>
    reactToStatus(c, FAVOURITE_EMOJI, 'unreact'),
  );

  app.put('/api/v1/pleroma/statuses/:id/reactions/:emoji', requireTransport, (c) =>
    reactToStatus(c, decodeURIComponent(c.req.param('emoji') ?? ''), 'react'),
  );
  app.delete('/api/v1/pleroma/statuses/:id/reactions/:emoji', requireTransport, (c) =>
    reactToStatus(c, decodeURIComponent(c.req.param('emoji') ?? ''), 'unreact'),
  );

  // --- Context (ancestors / descendants) -----------------------------------

  app.get('/api/v1/statuses/:id/context', requireTransport, async (c) => {
    const transport = c.get('transport');
    const parsed = parseStatusId(c.req.param('id'));
    if (parsed === null) return c.json({ error: 'Record not found' }, 404);

    // The BFS root post key + the (msg) target we walk ancestors from. For an
    // `orig-<uuid>` id we don't hold the original: ancestors are empty (there's
    // no local reply chain to climb), and the descendant BFS roots at the uuid
    // post key so DM reply copies we DO hold still render. For a numeric id we
    // must actually hold the message; otherwise 404 (never 500).
    let target: T.Message | null = null;
    let rootKey: string | null;
    if (parsed.kind === 'orig') {
      rootKey = parsed.uuid;
    } else {
      target = await transport.message(parsed.msgId);
      if (!target) return c.json({ error: 'Record not found' }, 404);
      await ingest(transport, target);
      rootKey = store.midForMsgId(target.id);
    }

    // A context entry sortable across BOTH local messages and held envelopes
    // (thread auto-backfill): the pre-rendered status + a sort timestamp (ms).
    type Entry = { status: MastodonStatus; sortTs: number };

    // Ancestors: ONE upward climb by post KEY (uuid or legacy mid). Each parent
    // is EITHER a locally-held message OR (for uuid keys) a HELD foreign
    // envelope (backfilled) — the walk crosses freely between eras and classes:
    // uuid links, legacy mid links, and held envelopes all continue the same
    // loop. Deliberate: a mixed-era chain (legacy root under a v2 subtree) must
    // render the SAME ancestors from every entry point — the split-loop version
    // this replaces broke at the uuid→mid boundary (live QA: /thread of a deep
    // reply lost the legacy root its parent's own /thread still showed). Stops
    // at the first unresolvable link or a non-reply root.
    const ancestors: MastodonStatus[] = [];
    // The reply-parent key of the target (numeric path: the message's parsed
    // reply ref of EITHER kind; orig path: the held envelope's ref).
    let climbKey: string | null = null;
    if (target) {
      const p = parseWire(target.text);
      climbKey = p.reply ? p.reply.keyString : null;
    } else if (parsed.kind === 'orig') {
      const held = store.heldEnvelope(parsed.uuid);
      const ref = held?.env.ref;
      climbKey = ref ? envelopeRefKeyString(ref) : null;
    }
    for (let depth = 0; depth < MAX_CONTEXT_ANCESTORS && climbKey; depth++) {
      const localId = store.resolveKey(climbKey);
      if (localId !== null) {
        const msg = await transport.message(localId);
        if (!msg) break;
        await ingest(transport, msg);
        ancestors.unshift(await toStatus(transport, msg));
        const p = parseWire(msg.text);
        climbKey = p.reply ? p.reply.keyString : null;
        continue;
      }
      // Not locally held: only a uuid key can resolve to a held envelope (mid
      // keys contain '@' and are never held-envelope keys).
      if (climbKey.includes('@')) break;
      const held = store.heldEnvelope(climbKey);
      if (!held) break;
      const status = await heldStatusConfirming(transport, climbKey, heldReplyParentId(held.env));
      if (!status) break; // unverifiable held ancestor: render nothing, stop
      ancestors.unshift(status);
      const ref = held.env.ref;
      climbKey = ref ? envelopeRefKeyString(ref) : null;
    }

    // Descendants: BFS over BOTH the local reply-children index AND the held
    // reply graph (held envelopes whose `ref` points at the current uuid). A
    // local child renders via `toStatus`; a held child renders via the verified
    // `heldStatus` — so carol's thread shows alice's held replies as real
    // statuses. Capped, deduped, sorted chronologically (oldest first).
    const descendants: Entry[] = [];
    const queue: string[] = rootKey ? [rootKey] : [];
    const seen = new Set<number>();
    const seenKeys = new Set<string>();
    while (queue.length > 0 && descendants.length < MAX_CONTEXT_DESCENDANTS) {
      const key = queue.shift()!;
      // Local children (post keys; may be uuid or mid).
      for (const childMid of store.replyChildMids(key)) {
        if (seenKeys.has(childMid) || descendants.length >= MAX_CONTEXT_DESCENDANTS) continue;
        seenKeys.add(childMid);
        const childMsgId = store.resolveKey(childMid);
        if (childMsgId === null || seen.has(childMsgId)) {
          queue.push(childMid);
          continue;
        }
        seen.add(childMsgId);
        const childMsg = await transport.message(childMsgId);
        if (childMsg) {
          await ingest(transport, childMsg);
          descendants.push({ status: await toStatus(transport, childMsg), sortTs: childMsg.timestamp * 1000 });
        }
        queue.push(childMid);
      }
      // Held children (backfilled foreign replies to this uuid).
      for (const childUuid of store.heldChildrenOf(key)) {
        if (seenKeys.has(childUuid) || descendants.length >= MAX_CONTEXT_DESCENDANTS) continue;
        // A held child whose real copy is now local was already handled above via
        // the local index; skip to avoid a double entry.
        if (store.resolveKey(childUuid) !== null) continue;
        seenKeys.add(childUuid);
        const held = store.heldEnvelope(childUuid);
        const status = held
          ? await heldStatusConfirming(transport, childUuid, heldReplyParentId(held.env))
          : null;
        if (status) descendants.push({ status, sortTs: held!.env.ts ?? 0 });
        // Explore the held child's subtree regardless (its own held/local replies).
        queue.push(childUuid);
      }
    }
    descendants.sort((a, b) => a.sortTs - b.sortTs);

    return c.json({ ancestors, descendants: descendants.map((e) => e.status) });
  });

  // --- Thread subscription (thread-subscribe) ------------------------------
  //
  // POST/DELETE /api/v1/pleroma/statuses/:id/subscribe (mirrors Pleroma's
  // status-subscription naming). `:id` is the thread ROOT status (numeric or
  // `orig-<uuid>`). Subscribe: DM a SCOPED invite-request to the root author via
  // a KEY-contact (honest reachability — no cold send); the host auto-grants a
  // per-thread channel our ingest joins as a thread subscription. Unsubscribe:
  // leave/block the channel + drop the subscription.

  app.post('/api/v1/pleroma/statuses/:id/subscribe', requireTransport, async (c) => {
    const transport = c.get('transport');
    const parsed = parseStatusId(c.req.param('id'));
    if (parsed === null) return c.json({ error: 'Record not found' }, 404);
    const root = await resolveThreadRoot(transport, parsed);
    if (!root) return c.json({ error: 'Record not found' }, 404);

    // Leak prevention: a followers-only root has no public thread channel —
    // subscribing would republish locked content to arbitrary subscribers.
    // Checked on the resolved root's local/held copies AND on the subscribe
    // TARGET itself (the target is either the root, or a reply whose privacy
    // inheritance implies a private thread).
    const rootLocal = store.resolveKey(root.rootUuid);
    const rootMsg = rootLocal !== null ? await transport.message(rootLocal) : null;
    const targetMsg = parsed.kind === 'msg' ? await transport.message(parsed.msgId) : null;
    const rootRestricted =
      store.isLockedPost(root.rootUuid) ||
      store.isDirectPost(root.rootUuid) ||
      (rootMsg ? parseWire(rootMsg.text).visibility === 'private' : false) ||
      (rootMsg ? parseWire(rootMsg.text).visibility === 'direct' : false) ||
      (targetMsg ? parseWire(targetMsg.text).visibility === 'private' : false) ||
      (targetMsg ? parseWire(targetMsg.text).visibility === 'direct' : false) ||
      store.heldEnvelope(root.rootUuid)?.env.visibility === 'private' ||
      store.heldEnvelope(root.rootUuid)?.env.visibility === 'direct';
    if (rootRestricted) {
      return c.json(
        { error: 'restricted threads cannot be subscribed to', code: 'private_thread' },
        422,
      );
    }

    // Already subscribed: idempotent success.
    if (store.isSubscribedToThread(root.rootUuid)) {
      return c.json(await toSubscribeStatus(transport, parsed, root.rootUuid));
    }

    // Reachability gate: we can only DM the root author if we hold a KEY path to
    // them (a received message / securejoin). A keyless address-contact would
    // fail "e2e encryption unavailable" — so probe honestly and 422 with a
    // distinguishable error the UI shows, NEVER a cold send. Subscribing to our
    // OWN thread is nonsensical (we already host/hold it) → also 422.
    const myAddr = (await mapper.ownAddr(transport)).toLowerCase();
    if (root.rootAddr.toLowerCase() === myAddr) {
      return c.json({ error: "can't subscribe to your own thread", code: 'own_thread' }, 422);
    }
    // Never met the root author → introduce ourselves IN-BAND via the invite
    // their root post carries (user-triggered, so attempted inline; a securejoin
    // takes seconds — acceptable for an explicit subscribe click). No invite or
    // a failed handshake → the same clean 422.
    const rootContactId = await keyContactOrIntroduce(transport, root.rootAddr, root.rootInvite);
    if (rootContactId === null || rootContactId === DC_CONTACT_ID_SELF) {
      return c.json(
        { error: "can't reach the thread author yet", code: 'unreachable_author' },
        422,
      );
    }

    await transport.sendControlDm(rootContactId, buildThreadInviteRequestEnvelope(root.rootUuid));
    store.addPendingThreadRequest(root.rootUuid, Date.now());
    return c.json(await toSubscribeStatus(transport, parsed, root.rootUuid, true));
  });

  app.delete('/api/v1/pleroma/statuses/:id/subscribe', requireTransport, async (c) => {
    const transport = c.get('transport');
    const parsed = parseStatusId(c.req.param('id'));
    if (parsed === null) return c.json({ error: 'Record not found' }, 404);
    const root = await resolveThreadRoot(transport, parsed);
    if (!root) return c.json({ error: 'Record not found' }, 404);

    // Leave/block the channel chat + drop both the subscription and any pending
    // request (idempotent — reports unsubscribed even if we weren't subscribed).
    const chatId = store.threadSubscriptionChatId(root.rootUuid);
    if (chatId !== null) {
      await transport.leaveChat(chatId).catch((err) => {
        console.error('thread channel leave failed (non-fatal):', err);
      });
    }
    store.removeThreadSubscription(root.rootUuid);
    store.clearPendingThreadRequest(root.rootUuid);
    return c.json(await toSubscribeStatus(transport, parsed, root.rootUuid));
  });

  app.get('/api/v1/statuses/:id', requireTransport, async (c) => {
    const transport = c.get('transport');
    const parsed = parseStatusId(c.req.param('id'));
    if (parsed === null) return c.json({ error: 'Record not found' }, 404);
    if (parsed.kind === 'orig') {
      // A verified boost embed's nested status: the local original if we hold
      // it, else the verified embed rendered from a held boost. Never 500.
      const status = await resolveOrigStatus(transport, parsed.uuid);
      return status ? c.json(status) : c.json({ error: 'Record not found' }, 404);
    }
    const msg = await transport.message(parsed.msgId);
    if (!msg) return c.json({ error: 'Record not found' }, 404);
    return c.json(await toStatus(transport, msg, mediaStore.descriptionForMessage(msg.id)));
  });

  // --- Headwater-specific: feed invite + follow ---------------------------

  // Locked follow requests (visibility channels 1B): the queue the ingest
  // path fills from locked-scoped invite-request DMs. Approval = DM-ing the
  // LOCKED channel invite as an invite-grant, which the requester's existing
  // follow-back machinery joins (they recorded a pending marker when asking).

  app.get('/api/v1/follow_requests', requireTransport, async (c) => {
    const transport = c.get('transport');
    const accounts = await Promise.all(
      store.lockedFollowRequests().map(async ({ contactId, addr }) => {
        const contact = await transport.contact(contactId);
        return contact ? contactToAccount(contact, baseUrl) : addrToAccount(addr, baseUrl);
      }),
    );
    return c.json(accounts);
  });

  /** The pending locked request for a contact-id route param, or null. */
  const pendingLockedRequestFor = (idParam: string | undefined) => {
    const contactId = Number(idParam ?? NaN);
    if (!Number.isInteger(contactId)) return null;
    return store.lockedFollowRequests().find((r) => r.contactId === contactId) ?? null;
  };

  app.post('/api/v1/follow_requests/:id/authorize', requireTransport, async (c) => {
    const transport = c.get('transport');
    const pending = pendingLockedRequestFor(c.req.param('id'));
    if (!pending) return c.json({ error: 'Record not found' }, 404);
    const invite = await transport.feedInvite('locked');
    await transport.sendControlDm(pending.contactId, buildInviteGrantEnvelope(invite));
    store.clearLockedFollowRequest(pending.addr);
    return c.json({ ...relationshipFor(false, pending.contactId), followed_by: true });
  });

  app.post('/api/v1/follow_requests/:id/reject', requireTransport, async (c) => {
    const pending = pendingLockedRequestFor(c.req.param('id'));
    if (!pending) return c.json({ error: 'Record not found' }, 404);
    store.clearLockedFollowRequest(pending.addr);
    return c.json(relationshipFor(false, pending.contactId));
  });

  // Requester side: ask a contact for access to their LOCKED channel. Records
  // the pending marker so their eventual invite-grant DM auto-joins (the
  // existing follow-back accept path — unsolicited grants still never join).
  app.on('POST', apiPaths('/contacts/:id/request-locked'), requireTransport, async (c) => {
    const transport = c.get('transport');
    const contactId = Number(c.req.param('id'));
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return c.json({ error: 'Record not found' }, 404);
    }
    if (contactId === 1) {
      return c.json({ error: "Validation failed: can't request access to your own channel" }, 422);
    }
    const contact = await transport.contact(contactId);
    if (!contact) return c.json({ error: 'Record not found' }, 404);
    store.addPendingFollowRequest(contact.address, Date.now());
    await transport.sendControlDm(contactId, buildLockedInviteRequestEnvelope());
    return c.json({ requested: true });
  });

  // Petnames (see ../meta/issues/petnames.md): set/clear MY local, key-bound
  // name override for a contact. Core's `displayName` prefers it everywhere,
  // so timelines/mentions/notifications pick it up with no further plumbing.
  app.on('POST', apiPaths('/contacts/:id/petname'), requireTransport, async (c) => {
    const transport = c.get('transport');
    const contactId = Number(c.req.param('id'));
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return c.json({ error: 'Record not found' }, 404);
    }
    if (contactId === 1) {
      return c.json({ error: "Validation failed: can't set a petname for yourself" }, 422);
    }
    const existing = await transport.contact(contactId);
    if (!existing) return c.json({ error: 'Record not found' }, 404);
    const body = await c.req.json<{ petname?: string }>().catch(() => ({}) as { petname?: string });
    const petname = String(body.petname ?? '').trim();
    await transport.setContactName(contactId, petname);
    const updated = await transport.contact(contactId);
    return c.json(contactToAccount(updated ?? existing, baseUrl));
  });

  app.on('GET', apiPaths('/invite'), requireTransport, async (c) => {
    // Visibility channels: `?channel=locked` hands out the locked channel's
    // invite — meant to be shared one-to-one (approval = sending it), never
    // published. Default stays the public feed.
    const channel: OwnChannel = c.req.query('channel') === 'locked' ? 'locked' : 'public';
    return c.json({ invite: await c.get('transport').feedInvite(channel) });
  });

  app.on('POST', apiPaths('/follow'), requireTransport, async (c) => {
    const { invite } = await c.req.json<{ invite?: string }>();
    if (!invite) return c.json({ error: 'invite missing' }, 422);
    return c.json({ chat_id: await c.get('transport').follow(invite) });
  });

  // --- Blobs / avatars ----------------------------------------------------

  const serveFile = async (path: string | null, c: Context) => {
    if (!path) return c.notFound();
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(path).catch(() => null);
    if (!data) return c.notFound();
    return new Response(new Uint8Array(data), {
      headers: { 'Content-Type': contentTypeForPath(path) },
    });
  };

  const NEUTRAL_BADGE = { initial: '?', color: '#2a3542' };

  app.on('GET', assetPaths('/avatar/:contactId'), async (c) => {
    const contactId = Number(c.req.param('contactId'));
    const transport = ctx.getTransport();
    if (enabledSecurity && !c.get('authSession') && contactId !== DC_CONTACT_ID_SELF) {
      const publicMessages = transport && Number.isInteger(contactId)
        ? await transport.timelineFrom(contactId, { limit: DEFAULT_PAGE })
        : [];
      if (transport) {
        for (const message of publicMessages) await ingest(transport, message, true);
      }
      if (!transport || !(await hasPublicMessage(transport, publicMessages))) {
        const svg = avatarPlaceholderSvg(NEUTRAL_BADGE.initial, NEUTRAL_BADGE.color);
        return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' });
      }
    }
    const path = transport ? await transport.avatarPath(contactId) : null;
    if (path) return serveFile(path, c);
    const badge = transport ? (await transport.contactBadge(contactId)) ?? NEUTRAL_BADGE : NEUTRAL_BADGE;
    const svg = avatarPlaceholderSvg(badge.initial, badge.color);
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' });
  });

  const gradientHeader = (c: Context) =>
    c.body(headerSvg(), 200, { 'Content-Type': 'image/svg+xml' });

  // Per-contact header banner. Only SELF (contact id 1) can have a stored
  // custom header (uploaded via update_credentials, kept locally — headers
  // don't federate); every other contact id gets the generated gradient.
  app.on('GET', assetPaths('/header/:contactId'), async (c) => {
    const contactId = Number(c.req.param('contactId'));
    if (contactId === DC_CONTACT_ID_SELF) {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(headerPath).catch(() => null);
      if (data) {
        return new Response(new Uint8Array(data), {
          headers: { 'Content-Type': contentTypeForPath(headerPath) },
        });
      }
    }
    return gradientHeader(c);
  });

  // Back-compat alias for the old single global header route (still the
  // default gradient) so any cached URLs / synthesized accounts keep working.
  app.on('GET', assetPaths('/header.png'), gradientHeader);

  app.on('GET', assetPaths('/blob/:msgId'), async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const msgId = Number(c.req.param('msgId'));
    if (enabledSecurity) {
      const expires = Number(c.req.query('expires'));
      const signature = c.req.query('signature') ?? '';
      if (
        !c.get('authSession') &&
        !enabledSecurity.auth.verifyBlobSignature(msgId, expires, signature)
      ) {
        return c.json({ error: 'invalid or expired blob capability' }, 401);
      }
    }
    const transport = ctx.getTransport();
    if (!transport) return c.json({ error: 'not configured' }, 401);
    if (!Number.isInteger(msgId) || msgId <= 0) return c.notFound();
    const msg = await transport.message(msgId);
    if (!msg) return c.notFound();
    const response = await serveFile(await transport.blobPath(msgId), c);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  });

  // --- Notifications --------------------------------------------------------

  app.get('/api/v1/notifications', async (c) => {
    const transport = ctx.getTransport();
    if (!transport) return c.json([]);
    const notifications = store.listNotifications({
      limit: intParam(c.req.query('limit')) ?? DEFAULT_PAGE,
      maxId: c.req.query('max_id'),
      sinceId: c.req.query('since_id'),
    });
    const mapped = await Promise.all(
      notifications.map((n) =>
        mapNotification(n, transport, mapper, baseUrl, (msgId) => mediaStore.descriptionForMessage(msgId)),
      ),
    );
    return c.json(mapped);
  });

  // --- Intentionally empty read-only discovery surfaces -------------------
  // These work whether or not the daemon is configured yet.

  const emptyList = (path: string) => app.get(path, (c) => c.json([]));
  emptyList('/api/v1/custom_emojis');
  emptyList('/api/v1/trends/tags');
  emptyList('/api/v1/trends');
  emptyList('/api/v2/suggestions');
  emptyList('/api/v1/suggestions');
  emptyList('/api/v1/filters');
  app.get('/api/v1/markers', (c) => c.json({}));
  app.get('/api/v1/preferences', (c) => c.json({}));

  // --- Static SPA: serve the built frontend, falling back to index.html ---

  if (staticDir) {
    app.use('*', serveStatic({ root: staticDir }));
    app.get('*', async (c, next) => {
      const path = new URL(c.req.url).pathname;
      if (path.startsWith('/api') || path.startsWith('/oauth') || isAssetPath(path)) {
        return next();
      }
      return serveStatic({ root: staticDir, path: 'index.html' })(c, next);
    });
  }

  return app;
};

export type UnsafeTestServerOptions = Omit<ServerOptions, 'security'>;

/** Explicit auth bypass for focused protocol/transport tests. Never use in production. */
export const createUnsafeTestApp = (ctx: AppContext, options: UnsafeTestServerOptions) =>
  createApp(ctx, { ...options, security: { unsafeTestOnly: true } });

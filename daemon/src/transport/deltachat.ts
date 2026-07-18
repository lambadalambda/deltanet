import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRPCServerPath } from '@deltachat/stdio-rpc-server';
import { StdioDeltaChat, type T } from '@deltachat/jsonrpc-client';
import type { PostOptions, ProfileUpdate, TimelineQuery, Transport } from './types.js';
import { initialOf } from '../mastodon/entities.js';

const DC_CONTACT_ID_SELF = 1;
const FEED_CHAT_ID_KEY = 'ui.headwater.feed_chat_id';
const LEGACY_FEED_CHAT_ID_KEY = 'ui.deltanet.feed_chat_id';
const LOCKED_CHAT_ID_KEY = 'ui.headwater.locked_chat_id';
const LEGACY_LOCKED_CHAT_ID_KEY = 'ui.deltanet.locked_chat_id';

export type NativeCoreExit = {
  expected: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

type ManagedDeltaChat = Omit<StdioDeltaChat, 'close'> & {
  close(): Promise<void>;
  forceClose(): Promise<void>;
  exited: Promise<NativeCoreExit>;
};

type StartCore = (dataDir: string, rpcServerPath?: string) => ManagedDeltaChat;

const startCore: StartCore = (dataDir, rpcServerPath) => {
  const server = spawn(rpcServerPath ?? getRPCServerPath(), {
    env: {
      RUST_LOG: process.env['RUST_LOG'],
      DC_ACCOUNTS_PATH: dataDir,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  server.stdin.on('error', () => {});
  server.stdout.on('error', () => {});
  let expected = false;
  const exited = new Promise<NativeCoreExit>((resolve) => {
    server.once('error', (error) => resolve({
      expected,
      code: server.exitCode,
      signal: server.signalCode,
      error,
    }));
    server.once('exit', (code, signal) => resolve({ expected, code, signal }));
  });
  const dc = new StdioDeltaChat(server.stdin, server.stdout, true);
  let closePromise: Promise<void> | null = null;
  let forceClosePromise: Promise<void> | null = null;
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const forceClose = (): Promise<void> => {
    if (forceClosePromise) return forceClosePromise;
    forceClosePromise = (async () => {
      expected = true;
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
      if (!await waitForExit(1_000)) {
        throw new Error('deltachat-rpc-server did not exit after SIGKILL');
      }
    })();
    return forceClosePromise;
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      expected = true;
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
      if (!await waitForExit(3_000)) {
        await forceClose();
      }
    })();
    return closePromise;
  };
  return Object.assign(dc, { close, forceClose, exited }) as unknown as ManagedDeltaChat;
};

const coreExitError = (exit: NativeCoreExit): Error =>
  new Error(
    exit.error?.message ??
    `deltachat-rpc-server exited during startup (${exit.code ?? exit.signal ?? 'unknown'})`,
    exit.error ? { cause: exit.error } : undefined,
  );

const whileCoreRunning = async <TValue>(
  dc: ManagedDeltaChat,
  operation: () => Promise<TValue>,
  signal?: AbortSignal,
): Promise<TValue> => {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Delta Chat startup aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([
      operation(),
      dc.exited.then((exit) => Promise.reject(coreExitError(exit))),
      aborted,
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
};

export const readCompatibleConfig = async (
  get: (key: string) => Promise<string | null>,
  set: (key: string, value: string) => Promise<unknown>,
  preferredKey: string,
  legacyKey: string,
): Promise<string | null> => {
  const preferred = await get(preferredKey);
  if (preferred) return preferred;
  const legacy = await get(legacyKey);
  if (legacy) await set(preferredKey, legacy);
  return legacy;
};

export const writeCompatibleConfig = async (
  set: (key: string, value: string) => Promise<unknown>,
  preferredKey: string,
  legacyKey: string,
  value: string,
): Promise<void> => {
  await set(legacyKey, value);
  await set(preferredKey, value);
};

/** Chat types whose messages appear in the timeline. */
const FEED_CHAT_TYPES: ReadonlySet<T.ChatType> = new Set([
  'Group',
  'OutBroadcast',
  'InBroadcast',
]);

/**
 * Pure predicate: is this message worth passing to `notifyOnMessage`?
 *
 * Filters out info/system messages (chat-membership changes etc.) and
 * "empty" messages with no sender, no text, and no attached file — these
 * show up as artifacts of chat-level `MsgsChanged` events (e.g. drafts) and
 * carry nothing a `Store` derivation pass could act on. Extracted as a pure
 * function so the filtering logic is unit-testable without a running core.
 */
export const shouldIngest = (msg: T.Message): boolean => {
  if (msg.isInfo) return false;
  if (msg.fromId === 0) return false;
  if (!msg.text && !msg.file) return false;
  return true;
};

/**
 * Pure predicate: does this chat's type make it a FEED chat (messages that
 * appear in the timeline: Group/OutBroadcast/InBroadcast), as opposed to a
 * DM (Single-chat)? Extracted so the FEED-vs-DM classification driving
 * `Store.ingestMessage`'s reply/boost edge gating is unit-testable without a
 * running core.
 */
export const isFeedChat = (chatType: T.ChatType): boolean => FEED_CHAT_TYPES.has(chatType);

/**
 * Pure predicate: which of these contacts are currently blocked?
 *
 * There is no chat-level "blocked" flag on `BasicChat`/`FullChat` — blocking
 * a chat (`blockChat`, used by `unfollow()`) actually blocks the underlying
 * contact(s), which surfaces as `Contact.isBlocked`. Used by `follow()` to
 * detect a previously-unfollowed feed owner so it can be unblocked before
 * the (re-)joined chat can deliver again.
 */
export const blockedContactIds = (contacts: T.Contact[]): number[] =>
  contacts.filter((contact) => contact.isBlocked).map((contact) => contact.id);

/**
 * Pure predicate: does `handle` refer to our own account? Matches the full
 * address or its bare local part (username), case-insensitively. Used by
 * `contactIdByAddr` so profile lookups for "carol" or "carol@relay" resolve
 * to SELF without an RPC round-trip.
 */
export const matchesSelfAddr = (handle: string, selfAddr: string): boolean => {
  const h = handle.toLowerCase();
  const addr = selfAddr.toLowerCase();
  return h === addr || h === (addr.split('@')[0] ?? addr);
};

/**
 * Pure mapping: a contact's avatar-placeholder badge. For the SELF contact
 * (id 1) the core's `displayName` is a placeholder ("Me"), so the configured
 * `displayname` — the same override `self()`/`withSelfDisplayName` apply —
 * takes precedence when present.
 */
export const badgeOf = (
  contact: T.Contact,
  selfDisplayname: string | null,
): { initial: string; color: string } => ({
  initial: initialOf(
    contact.id === DC_CONTACT_ID_SELF && selfDisplayname ? selfDisplayname : contact.displayName,
  ),
  color: contact.color,
});

export type ChatmailCredentials = {
  addr: string;
  password: string;
  displayName: string;
};

/**
 * Explicit IMAP/SMTP coordinates for configuring an account against a known
 * server, bypassing DNS/`.well-known` autoconfig. Used by the integration
 * suite to point at a local self-signed podman relay; production/normal use
 * leaves this undefined and lets core autoconfigure from the address.
 */
export type ExplicitTransportParams = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Accept self-signed / hostname-mismatched TLS certs. */
  acceptInvalidCerts: boolean;
};

/**
 * Pure builder: map credentials + explicit server coordinates into the
 * `EnteredLoginParam` shape `rpc.addTransport` expects. Extracted so the
 * autoconfig-vs-explicit-server decision is unit-testable without a running
 * core. Both IMAP and SMTP use `ssl` (implicit TLS: IMAPS 993 / SMTPS 465),
 * matching a chatmail relay's submission/IMAPS listeners.
 */
export const buildEnteredLoginParam = (
  creds: ChatmailCredentials,
  params: ExplicitTransportParams,
): T.EnteredLoginParam => ({
  addr: creds.addr,
  password: creds.password,
  imapServer: params.imapHost,
  imapPort: params.imapPort,
  imapFolder: null,
  imapSecurity: 'ssl',
  imapUser: null,
  smtpServer: params.smtpHost,
  smtpPort: params.smtpPort,
  smtpSecurity: 'ssl',
  smtpUser: null,
  smtpPassword: null,
  certificateChecks: params.acceptInvalidCerts ? 'acceptInvalidCertificates' : 'automatic',
  oauth2: false,
});

export type DeltaChatTransport = Transport & {
  close(): Promise<void>;
  forceClose(): Promise<void>;
  exited: Promise<NativeCoreExit>;
  accountId: number;
  /** Resolve when a core event of `kind` matching `predicate` arrives. */
  waitForEvent<K extends T.EventType['kind']>(
    kind: K,
    timeoutMs: number,
    predicate?: (event: Extract<T.EventType, { kind: K }>) => boolean,
  ): Promise<Extract<T.EventType, { kind: K }>>;
};

/**
 * Which half of ingestion an `onMessage` call represents.
 *
 * - `'combined'`: do both the mid/msgId-index bookkeeping (`Store.
 *   ingestMessage`) *and* notification/reaction derivation (`deriveOnIngest`)
 *   for this message, in one call — what every live event (`IncomingMsg`/
 *   `MsgsChanged`) and ordinary timeline/message load has always done, and
 *   still does.
 * - `'index'` / `'derive'`: the two halves of that same work, split across
 *   two separate calls for the same message. Only the startup `backfill()`
 *   sweep uses this split — see its doc comment for why: a chat containing
 *   reaction/reply control DMs can be swept before the chat holding the mid
 *   they target, and running derivation inline (as `'combined'` would) means
 *   `store.isOwnMid` isn't populated yet for that target, so the
 *   notification is silently never derived. Doing an `'index'` pass over
 *   *every* backfilled message first (populating `ownMids` etc. store-wide),
 *   then a `'derive'` pass over all of them, makes backfill order-independent.
 */
export type IngestPhase = 'combined' | 'index' | 'derive';

export type OpenTransportOptions = {
  /**
   * Called for every message loaded via timeline/message reads, and for
   * every incoming-message core event (so DMs/messages that never hit a
   * timeline render still get ingested). Failures are logged and otherwise
   * ignored — ingestion is best-effort bookkeeping, never load-bearing for
   * serving the request that triggered it.
   *
   * The second argument is `true` iff the message's chat is a FEED chat
   * (Group/OutBroadcast/InBroadcast, per `FEED_CHAT_TYPES`) rather than a
   * DM (Single-chat) — e.g. a reply-notify control DM. Callers use this to
   * decide whether the message may register reply/boost edges (see
   * `Store.ingestMessage`), since the same logical reply/boost is delivered
   * twice: once via the feed broadcast, once as a DM copy to the original
   * author.
   *
   * The third argument is the message's resolved `rfc724Mid` (or null if it
   * couldn't be resolved), pre-fetched by the transport itself via the same
   * `messageMid`/cache machinery `DeltaChatTransport.messageMid` exposes.
   * This exists so callers never need to reach back into a
   * not-yet-constructed transport handle to resolve it themselves — see the
   * DEVLOG entry on the startup-backfill race this replaced: `openTransport`
   * fires the startup backfill sweep (and may deliver live events) before
   * it returns, so a caller that captures its own `transport` reference in
   * an outer variable and assigns it only after `await openTransport(...)`
   * resolves would see that variable still `null` for every message the
   * backfill sweep or an early event delivers — silently dropping them.
   * Passing everything the hook needs as arguments removes that variable
   * from the picture entirely.
   *
   * The fourth argument is the ingestion `phase` (see `IngestPhase`). Every
   * caller except the startup backfill sweep sees `'combined'` for every
   * call, exactly as before this argument existed; callers that don't care
   * about the split can ignore it entirely and always do both halves of
   * their work.
   */
  onMessage?: (
    msg: T.Message,
    isFeedMessage: boolean,
    mid: string | null,
    phase: IngestPhase,
  ) => void | Promise<void>;
  /** Starts a caller-owned consistency barrier around core-to-store ingestion. */
  beginExternalMutation?: () => () => void;
  /** Restore-only: return an inert transport plus an explicit start handle. */
  deferStart?: boolean;
  /** Absolute packaged helper path; defaults to the pinned platform package. */
  rpcServerPath?: string;
  /** Native-core launcher seam for lifecycle tests. */
  startCore?: StartCore;
  /** Cancels native-core startup while preserving cleanup ownership. */
  signal?: AbortSignal;
};

type DeferredBackground = { start?: () => void };

export const openTransport = async (
  dataDir: string,
  creds: ChatmailCredentials,
  options: OpenTransportOptions = {},
  /**
   * When set, configure the account against these explicit IMAP/SMTP servers
   * (via `rpc.addTransport` with an `EnteredLoginParam`) instead of running
   * DNS/`.well-known` autoconfig. Used by the integration suite to target a
   * local self-signed podman relay; unset in normal operation.
   */
  transportParams?: ExplicitTransportParams,
): Promise<DeltaChatTransport> => {
  const dc = (options.startCore ?? startCore)(dataDir, options.rpcServerPath);
  const rpc = dc.rpc;
  try {
    return await whileCoreRunning(dc, async () => {
      const accountIds = await rpc.getAllAccountIds();
      const accountId = accountIds[0] ?? (await rpc.addAccount());

      if (!(await rpc.isConfigured(accountId))) {
        // Display name is a UI-only config value carried on the account regardless
        // of how the transport is configured; set it up front either way.
        await rpc.setConfig(accountId, 'displayname', creds.displayName);
        if (transportParams) {
          // Explicit-server path: no autoconfig, accept the relay's self-signed
          // cert. `addTransport` both stores the login params and configures the
          // account, so no separate `configure()` call is needed.
          await rpc.addTransport(accountId, buildEnteredLoginParam(creds, transportParams));
        } else {
          await rpc.batchSetConfig(accountId, {
            addr: creds.addr,
            mail_pw: creds.password,
          });
          await rpc.configure(accountId);
        }
      }
      await rpc.startIo(accountId);
      return buildTransport(dc, accountId, creds, options);
    }, options.signal);
  } catch (error) {
    await dc.close();
    throw error;
  }
};

/** Config key stamped after the API validates a complete downloadable backup. */
export const LAST_BACKUP_AT_KEY = 'ui.headwater.last_backup_at';
export const LEGACY_LAST_BACKUP_AT_KEY = 'ui.deltanet.last_backup_at';

/**
 * Pure mapper: reconstruct `ChatmailCredentials` from an imported backup's
 * config reads (`configured_addr`/`addr`/`configured_mail_pw`/`displayname`).
 * Null when no address survived — an unusable backup. Extracted so the
 * fallback ladder is unit-testable without a running core.
 */
export const credsFromConfig = (cfg: {
  addr?: string | null;
  configuredAddr?: string | null;
  password?: string | null;
  displayName?: string | null;
}): ChatmailCredentials | null => {
  const addr = cfg.configuredAddr || cfg.addr;
  if (!addr) return null;
  return {
    addr,
    password: cfg.password ?? '',
    displayName: cfg.displayName || (addr.split('@')[0] ?? addr),
  };
};

/**
 * Boot a transport for a FRESH data dir by importing a core backup tar
 * (`importBackup`) instead of configuring credentials — the restore-instead-
 * of-signup path. The backup carries the account config (addr/password/
 * displayname), which is read back out and returned alongside the transport so
 * the caller can persist it to the accounts file (a later normal
 * `openTransport` boot then finds an already-configured account and skips
 * configuration entirely). Throws if the data dir already has a configured
 * account or core rejects the tar/passphrase; the spawned core process is
 * closed on every failure path.
 */
export const restoreTransport = async (
  dataDir: string,
  backupTarPath: string,
  passphrase: string,
  options: OpenTransportOptions = {},
  /**
   * Runs after the core import succeeded but BEFORE IO starts and any
   * ingestion can fire: the window where the API layer writes the Headwater
   * sidecar files (store + signing key) into the data dir. It cannot write
   * them any earlier: core REFUSES to initialize an accounts structure in a
   * non-empty directory ("<dir> is not empty", exits immediately — observed
   * live), so the data dir must stay untouched until the import has created
   * that structure.
   */
  beforeOpen?: () => void,
): Promise<{
  transport: DeltaChatTransport;
  creds: ChatmailCredentials;
  start(): Promise<void>;
}> => {
  const dc = (options.startCore ?? startCore)(dataDir, options.rpcServerPath);
  const rpc = dc.rpc;
  try {
    return await whileCoreRunning(dc, async () => {
    const accountIds = await rpc.getAllAccountIds();
    const accountId = accountIds[0] ?? (await rpc.addAccount());
    if (await rpc.isConfigured(accountId)) {
      throw new Error('this data dir already has a configured account');
    }
    await rpc.importBackup(accountId, backupTarPath, passphrase);
    const [configuredAddr, addr, password, displayName] = await Promise.all([
      rpc.getConfig(accountId, 'configured_addr').catch(() => null),
      rpc.getConfig(accountId, 'addr').catch(() => null),
      rpc.getConfig(accountId, 'configured_mail_pw').catch(() => null),
      rpc.getConfig(accountId, 'displayname').catch(() => null),
    ]);
    const creds = credsFromConfig({ configuredAddr, addr, password, displayName });
    if (!creds) throw new Error('restored account carries no address');
    // A freshly restored node IS fully backed up (its state equals the backup
    // it came from), so stamp the restore moment as the last backup. Without
    // this the settings nag would claim "never backed up" right after a
    // restore: complete export finalization stamps AFTER exporting, so the stamp inside the
    // tar always points at the previous export (null for a first backup).
    await writeCompatibleConfig(
      (key, value) => rpc.setConfig(accountId, key, value),
      LAST_BACKUP_AT_KEY,
      LEGACY_LAST_BACKUP_AT_KEY,
      String(Date.now()),
    );
    beforeOpen?.();
    const deferred: DeferredBackground = {};
    const transport = buildTransport(dc, accountId, creds, options, deferred);
    let started = false;
    const start = async (): Promise<void> => {
      if (started) return;
      await whileCoreRunning(dc, () => rpc.startIo(accountId), options.signal);
      started = true;
      deferred.start?.();
    };
    if (!options.deferStart) await start();
    return { transport, creds, start };
    }, options.signal);
  } catch (err) {
    await dc.close();
    throw err;
  }
};

/**
 * Everything `openTransport` (signup/normal boot) and `restoreTransport`
 * (backup import) share, given an already-configured, IO-started account:
 * event wiring, ingestion machinery, and the whole Transport surface.
 */
const buildTransport = (
  dc: ManagedDeltaChat,
  accountId: number,
  creds: ChatmailCredentials,
  options: OpenTransportOptions,
  deferredBackground?: DeferredBackground,
): DeltaChatTransport => {
  const rpc = dc.rpc;
  let ingestionActive = deferredBackground === undefined;
  const withExternalMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = options.beginExternalMutation?.();
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  // Reaction/reply control DMs from a node we don't yet have an accepted
  // 1:1 chat with land in a contact-request chat. Core suppresses
  // `IncomingMsg` for those (confirmed live: feed/broadcast messages ingest
  // fine, but contact-request DMs never fire the event) — accepting the
  // chat as soon as we see a message in it stops it being a pending request
  // so future deliveries flow through normal events. Best-effort: a failure
  // here must never block ingestion.
  const acceptIfContactRequest = async (chat: T.BasicChat): Promise<void> => {
    try {
      if (chat.isContactRequest) await rpc.acceptChat(accountId, chat.id);
    } catch (err) {
      console.error('failed to accept contact-request chat (non-fatal):', err);
    }
  };

  // No reverse mid -> msgId RPC exists; getMessageInfoObject is the only way
  // to learn a message's rfc724Mid, so cache it in-memory once resolved.
  // Defined ahead of `notifyOnMessage` (which resolves each ingested
  // message's mid via `resolveMid` before calling `options.onMessage`).
  const midCache = new Map<number, string | null>();

  const resolveMid = async (msgId: number): Promise<string | null> => {
    if (midCache.has(msgId)) return midCache.get(msgId) ?? null;
    const mid = await rpc
      .getMessageInfoObject(accountId, msgId)
      .then((info) => info.rfc724Mid ?? null)
      .catch(() => null);
    midCache.set(msgId, mid);
    return mid;
  };

  const notifyOnMessage = async (
    msg: T.Message,
    phase: IngestPhase = 'combined',
  ): Promise<void> => withExternalMutation(async () => {
    if (!shouldIngest(msg)) return;
    // Single getBasicChatInfo lookup, reused for both the contact-request
    // check and the FEED-vs-DM classification passed to onMessage — avoids
    // firing a second RPC call for the same chatId.
    const chat = await rpc.getBasicChatInfo(accountId, msg.chatId).catch((err) => {
      console.error('failed to load chat info for ingestion (non-fatal):', err);
      return null;
    });
    // Only worth doing once, on the 'index'/'combined' pass: a 'derive'-phase
    // call means backfill already saw (and accepted, if needed) this exact
    // message during its 'index' pass moments earlier.
    if (chat && phase !== 'derive') await acceptIfContactRequest(chat);
    if (!options.onMessage) return;
    const isFeedMessage = chat ? isFeedChat(chat.chatType) : false;
    const mid = await resolveMid(msg.id);
    try {
      await options.onMessage(msg, isFeedMessage, mid, phase);
    } catch (err) {
      console.error('onMessage ingestion failed (non-fatal):', err);
    }
  });

  /** Load a message by id and pass it through `notifyOnMessage`, tagging errors with their source event. */
  const loadAndNotify = async (msgId: number, eventKind: string): Promise<void> => {
    await withExternalMutation(async () => {
      try {
        const msg = await rpc.getMessage(accountId, msgId);
        const displayname = await selfDisplayName();
        await notifyOnMessage(withSelfDisplayName(msg, displayname));
      } catch (err) {
        console.error(`failed to load message from ${eventKind} for ingestion:`, err);
      }
    });
  };

  const feedChatIds = async (): Promise<number[]> => {
    const entries = await rpc.getChatlistEntries(accountId, null, null, null);
    const chats = await Promise.all(entries.map((id) => rpc.getBasicChatInfo(accountId, id)));
    return chats.filter((chat) => isFeedChat(chat.chatType)).map((chat) => chat.id);
  };

  const ensureFeedChat = async (): Promise<number> => {
    const stored = await readCompatibleConfig(
      (key) => rpc.getConfig(accountId, key),
      (key, value) => rpc.setConfig(accountId, key, value),
      FEED_CHAT_ID_KEY,
      LEGACY_FEED_CHAT_ID_KEY,
    );
    if (stored) return Number(stored);
    const name = `${creds.displayName}'s Headwater feed`;
    const chatId = await rpc.createBroadcast(accountId, name);
    await writeCompatibleConfig(
      (key, value) => rpc.setConfig(accountId, key, value),
      FEED_CHAT_ID_KEY,
      LEGACY_FEED_CHAT_ID_KEY,
      String(chatId),
    );
    return chatId;
  };

  /** The LOCKED channel (visibility channels), created lazily like the feed. */
  const ensureLockedChat = async (): Promise<number> => {
    const stored = await readCompatibleConfig(
      (key) => rpc.getConfig(accountId, key),
      (key, value) => rpc.setConfig(accountId, key, value),
      LOCKED_CHAT_ID_KEY,
      LEGACY_LOCKED_CHAT_ID_KEY,
    );
    if (stored) return Number(stored);
    const name = `${creds.displayName}'s locked Headwater feed`;
    const chatId = await rpc.createBroadcast(accountId, name);
    await writeCompatibleConfig(
      (key, value) => rpc.setConfig(accountId, key, value),
      LOCKED_CHAT_ID_KEY,
      LEGACY_LOCKED_CHAT_ID_KEY,
      String(chatId),
    );
    return chatId;
  };

  /**
   * The locked channel's chat id WITHOUT creating it — read paths (stats,
   * self timeline) must not conjure an empty channel as a side effect.
   */
  const lockedChatIdIfAny = async (): Promise<number | null> => {
    const stored = await readCompatibleConfig(
      (key) => rpc.getConfig(accountId, key),
      (key, value) => rpc.setConfig(accountId, key, value),
      LOCKED_CHAT_ID_KEY,
      LEGACY_LOCKED_CHAT_ID_KEY,
    );
    return stored ? Number(stored) : null;
  };

  /** The target chat for an own post/invite by channel choice. */
  const ownChannelChat = async (channel?: 'public' | 'locked'): Promise<number> =>
    channel === 'locked' ? ensureLockedChat() : ensureFeedChat();

  /**
   * The e2ee-capable KEY-contact id for `addr`, or null. Core keeps
   * KEY-contacts (securejoin/message-derived) and ADDRESS-contacts (keyless)
   * as SEPARATE rows for the same addr; only a row with `e2eeAvail` can be
   * sent to (a keyless row fails "e2e encryption unavailable"). Shared by
   * `keyContactIdForAddr` (reachability probe) and `introduceViaInvite`
   * (whose success criterion + post-join address check this IS).
   */
  const keyContactFor = async (addr: string): Promise<number | null> => {
    const contacts = await rpc.getContacts(accountId, 0, addr).catch(() => [] as T.Contact[]);
    const target = addr.toLowerCase();
    const match = contacts.find(
      (c) => c.address.toLowerCase() === target && c.e2eeAvail && c.id !== DC_CONTACT_ID_SELF,
    );
    return match ? match.id : null;
  };

  // Cached so we don't hit getConfig once per message when mapping timelines.
  let cachedDisplayName: string | null | undefined;
  const selfDisplayName = async (): Promise<string | null> => {
    if (cachedDisplayName === undefined) {
      cachedDisplayName = await rpc.getConfig(accountId, 'displayname');
    }
    return cachedDisplayName;
  };
  /** Force the next `selfDisplayName()` to re-read `displayname` from config. */
  const invalidateSelfDisplayName = (): void => {
    cachedDisplayName = undefined;
  };

  /** Same trick as self(): the SELF contact's displayName is a placeholder ("Me"). */
  const withSelfDisplayName = (msg: T.Message, displayname: string | null): T.Message =>
    msg.sender.id === DC_CONTACT_ID_SELF && displayname
      ? { ...msg, sender: { ...msg.sender, displayName: displayname } }
      : msg;

  const loadMessages = async (msgIds: number[]): Promise<T.Message[]> => {
    if (msgIds.length === 0) return [];
    const loaded = await rpc.getMessages(accountId, msgIds);
    const displayname = await selfDisplayName();
    const messages = Object.values(loaded)
      .filter((res): res is Extract<T.MessageLoadResult, { kind: 'message' }> => res.kind === 'message')
      .filter((msg) => !msg.isInfo)
      .map((msg) => withSelfDisplayName(msg, displayname));
    for (const msg of messages) void notifyOnMessage(msg);
    return messages;
  };

  const dm1to1ChatId = async (contactId: number): Promise<number> => {
    const existing = await rpc.getChatIdByContactId(accountId, contactId).catch(() => null);
    if (existing) return existing;
    return rpc.createChatByContactId(accountId, contactId);
  };

  // Ingest DMs/messages that never render in a timeline (e.g. reply-notify
  // copies to us) as soon as the core reports them.
  dc.on('IncomingMsg', (eventAccountId, event) => {
    if (eventAccountId !== accountId) return;
    if (!ingestionActive) return;
    void loadAndNotify(event.msgId, 'IncomingMsg');
  });

  // Safety net: per its own doc comment, `IncomingMsg` fires with "no extra
  // MsgsChanged event sent together with this event" for the normal case —
  // but live testing showed the *reverse* isn't true for messages that land
  // in a contact-request chat (reaction/reply control DMs from a node we
  // haven't accepted yet): those never fire `IncomingMsg` at all, only
  // `MsgsChanged`. Subscribing here catches that case, plus anything else
  // IncomingMsg might miss. `msgId` is 0 for chat-level changes (e.g. drafts,
  // multiple messages affected at once) — nothing to load, so skip those.
  // Downstream ingestion is idempotent (`Store.ingestMessage` dedupes via
  // `ingestedMsgIds`), so double-delivery via both events is harmless.
  dc.on('MsgsChanged', (eventAccountId, event) => {
    if (eventAccountId !== accountId) return;
    if (!ingestionActive) return;
    if (event.msgId === 0) return;
    void loadAndNotify(event.msgId, 'MsgsChanged');
  });

  // Fires when someone finishes securejoin-ing our feed broadcast (i.e. a
  // new follower). `progress` is always 1000 on this event per its core doc
  // comment (there is no intermediate-progress variant here); `contactId`
  // is the joiner.
  const followerHandlers = new Set<(contactId: number) => void>();
  dc.on('SecurejoinInviterProgress', (eventAccountId, event) => {
    if (eventAccountId !== accountId) return;
    if (!ingestionActive) return;
    if (event.progress !== 1000) return;
    for (const handler of followerHandlers) handler(event.contactId);
  });

  /** The InBroadcast chat we joined for a given feed owner's contact id, or null. */
  const inBroadcastChatFor = async (contactId: number): Promise<number | null> => {
    const entries = await rpc.getChatlistEntries(accountId, null, null, null);
    for (const chatId of entries) {
      const full = await rpc.getFullChatById(accountId, chatId);
      if (full.chatType === 'InBroadcast' && full.contactIds.includes(contactId)) return chatId;
    }
    return null;
  };

  const BACKFILL_BATCH_SIZE = 50;

  /**
   * Startup backfill: walk every chat's message ids and run them through
   * `notifyOnMessage`. Catches two gaps events alone can't cover: messages
   * that arrived while the daemon was down, and — per the bug this fixes —
   * contact-request DMs for which core may never have emitted an event we
   * were subscribed to in the first place. Sequential (one chat/batch at a
   * time) rather than parallel: this is a background sweep, not
   * latency-sensitive, and a simple sequential loop is easiest to reason
   * about for concurrency. Errors are logged per-chat so one bad chat
   * doesn't abort the whole sweep.
   *
   * Two-pass over the whole collected set rather than one `notifyOnMessage`
   * call per message as they're loaded: `getChatlistEntries` returns chats in
   * recency order, not dependency order, so e.g. a DM chat carrying a
   * reaction control message can be swept *before* the chat holding the mid
   * it targets. Deriving inline (as live single-call ingestion does) would
   * then run `deriveOnIngest` before the target mid's `ownMids` bookkeeping
   * exists yet, so `store.isOwnMid` reads false and the notification is
   * silently never derived — the reaction tally still applies (that's
   * `Store.ingestMessage`'s job, run in the first pass), only the
   * *notification* derivation was order-dependent. Splitting into an
   * `'index'` pass over every backfilled message (mid/msgId bookkeeping only)
   * followed by a `'derive'` pass over the same messages (notification/
   * reaction-store side effects) makes backfill order-independent: by the
   * time any message is derived, every backfilled message — regardless of
   * which chat or batch it came from — has already been indexed.
   */
  const backfill = async (): Promise<void> => withExternalMutation(async () => {
    const chatIds = await rpc.getChatlistEntries(accountId, null, null, null);
    const displayname = await selfDisplayName();
    const collected: T.Message[] = [];

    for (const chatId of chatIds) {
      try {
        const msgIds = await rpc.getMessageIds(accountId, chatId, false, false);
        for (let i = 0; i < msgIds.length; i += BACKFILL_BATCH_SIZE) {
          const batch = msgIds.slice(i, i + BACKFILL_BATCH_SIZE);
          const loaded = await rpc.getMessages(accountId, batch);
          const messages = Object.values(loaded)
            .filter((res): res is Extract<T.MessageLoadResult, { kind: 'message' }> => res.kind === 'message')
            .map((msg) => withSelfDisplayName(msg, displayname));
          collected.push(...messages);
        }
      } catch (err) {
        console.error(`backfill failed for chat ${chatId} (non-fatal):`, err);
      }
    }

    for (const msg of collected) await notifyOnMessage(msg, 'index');
    for (const msg of collected) await notifyOnMessage(msg, 'derive');
  });

  const startBackground = (): void => {
    ingestionActive = true;
    // Fire-and-forget: must not delay transport startup.
    void backfill().catch((err) => console.error('startup backfill failed (non-fatal):', err));
  };
  if (deferredBackground) deferredBackground.start = startBackground;
  else startBackground();

  return {
    accountId,
    exited: dc.exited,
    forceClose: async () => {
      ingestionActive = false;
      followerHandlers.clear();
      await dc.forceClose();
    },
    close: (() => {
      let closePromise: Promise<void> | null = null;
      return (): Promise<void> => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          ingestionActive = false;
          followerHandlers.clear();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            rpc.stopIo(accountId).catch(() => {}),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, 3_000);
              timeout.unref();
            }),
          ]);
          if (timeout) clearTimeout(timeout);
          await dc.close();
        })();
        return closePromise;
      };
    })(),

    waitForEvent: <K extends T.EventType['kind']>(
      kind: K,
      timeoutMs: number,
      predicate?: (event: Extract<T.EventType, { kind: K }>) => boolean,
    ) =>
      new Promise<Extract<T.EventType, { kind: K }>>((resolve, reject) => {
        type Handler = Parameters<typeof dc.on<K>>[1];
        const handler = ((eventAccountId: number, event: Extract<T.EventType, { kind: K }>) => {
          if (eventAccountId !== accountId) return;
          if (predicate && !predicate(event)) return;
          clearTimeout(timer);
          dc.off(kind, handler);
          resolve(event);
        }) as Handler;
        const timer = setTimeout(() => {
          dc.off(kind, handler);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${kind}`));
        }, timeoutMs);
        dc.on(kind, handler);
      }),

    self: async () => {
      // the SELF contact's displayName is a placeholder ("Me"); use the config value
      const contact = await rpc.getContact(accountId, DC_CONTACT_ID_SELF);
      const displayname = await rpc.getConfig(accountId, 'displayname');
      return displayname ? { ...contact, displayName: displayname } : contact;
    },

    updateProfile: async (updates: ProfileUpdate) => {
      // Map only the keys present in `updates` to their DC config keys.
      // `selfavatar: null` clears the avatar. Setting `selfavatar` to a path
      // makes core import (copy) the file into its blob store, so the source
      // file need not outlive this call.
      const config: Record<string, string | null> = {};
      if (updates.displayName !== undefined) config['displayname'] = updates.displayName;
      if (updates.bio !== undefined) config['selfstatus'] = updates.bio;
      if (updates.avatarPath !== undefined) config['selfavatar'] = updates.avatarPath;
      if (Object.keys(config).length > 0) await rpc.batchSetConfig(accountId, config);
      // The self display name is cached (self()/timeline/contactBadge read it);
      // drop it so the change is visible on the very next read.
      invalidateSelfDisplayName();
    },

    timeline: async ({ limit, maxId, minId }: TimelineQuery) => {
      const chatIds = await feedChatIds();
      const perChat = await Promise.all(
        chatIds.map((chatId) => rpc.getMessageIds(accountId, chatId, false, false)),
      );
      const ids = perChat
        .flat()
        .filter((id) => (maxId === undefined || id < maxId) && (minId === undefined || id > minId))
        .sort((a, b) => b - a)
        .slice(0, limit * 2); // overfetch: some may be info messages
      const messages = await loadMessages(ids);
      return messages.sort((a, b) => b.sortTimestamp - a.sortTimestamp || b.id - a.id).slice(0, limit);
    },

    message: async (msgId) => {
      const [msg] = await loadMessages([msgId]);
      return msg ?? null;
    },

    post: async (text: string, opts?: PostOptions) => {
      const chatId = await ownChannelChat(opts?.channel);
      // Our own just-sent message has the SELF contact as sender, whose
      // displayName is the placeholder "Me" — apply the same override
      // loadMessages/self() do so the returned status carries the configured
      // display name (this message is echoed straight back to the poster).
      const loadOwn = async (msgId: number): Promise<T.Message> =>
        withSelfDisplayName(await rpc.getMessage(accountId, msgId), await selfDisplayName());
      if (opts?.file || opts?.quotedText) {
        const base: T.MessageData = {
          text: text || null,
          html: null,
          viewtype: opts?.file ? 'Image' : null,
          file: opts?.file ?? null,
          filename: null,
          location: null,
          overrideSenderName: null,
          quotedMessageId: null,
          quotedText: opts?.quotedText ?? null,
        };
        const msgId = await rpc.sendMsg(accountId, chatId, base);
        return loadOwn(msgId);
      }
      const msgId = await rpc.miscSendTextMessage(accountId, chatId, text);
      return loadOwn(msgId);
    },

    feedInvite: async (channel?: 'public' | 'locked') => {
      const chatId = await ownChannelChat(channel);
      return rpc.getChatSecurejoinQrCode(accountId, chatId);
    },

    exportBackup: async (destDir: string, passphrase: string) => {
      await rpc.exportBackup(accountId, destDir, passphrase);
      // Core picks the tar's filename and has fully written it by the time the
      // RPC resolves, so take the newest entry in the (scratch) dest dir. NOT
      // the `ImexFileWritten` event: that arrives on the event channel and can
      // land after the RPC response, so a listener scoped to the call misses
      // it (observed live against the podman relay).
      const newest = readdirSync(destDir)
        .map((name) => join(destDir, name))
        .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
        .sort((x, y) => y.mtime - x.mtime)[0];
      if (!newest) throw new Error('backup export produced no file');
      return newest.path;
    },

    markBackupExported: async (exportedAt) => {
      await writeCompatibleConfig(
        (key, value) => rpc.setConfig(accountId, key, value),
        LAST_BACKUP_AT_KEY,
        LEGACY_LAST_BACKUP_AT_KEY,
        String(exportedAt),
      );
    },

    lastBackupAt: async () => {
      const raw = await readCompatibleConfig(
        (key) => rpc.getConfig(accountId, key).catch(() => null),
        (key, value) => rpc.setConfig(accountId, key, value),
        LAST_BACKUP_AT_KEY,
        LEGACY_LAST_BACKUP_AT_KEY,
      );
      const parsed = Number(raw);
      return raw && Number.isFinite(parsed) ? parsed : null;
    },

    createBroadcast: async (name: string) => rpc.createBroadcast(accountId, name),

    chatInvite: async (chatId: number) => rpc.getChatSecurejoinQrCode(accountId, chatId),

    postToChat: async (chatId: number, text: string, opts?: PostOptions) => {
      const loadOwn = async (msgId: number): Promise<T.Message> =>
        withSelfDisplayName(await rpc.getMessage(accountId, msgId), await selfDisplayName());
      if (opts?.file || opts?.quotedText) {
        const data: T.MessageData = {
          text: text || null,
          html: null,
          viewtype: opts?.file ? 'Image' : null,
          file: opts?.file ?? null,
          filename: null,
          location: null,
          overrideSenderName: null,
          quotedMessageId: null,
          quotedText: opts?.quotedText ?? null,
        };
        return loadOwn(await rpc.sendMsg(accountId, chatId, data));
      }
      return loadOwn(await rpc.miscSendTextMessage(accountId, chatId, text));
    },

    keyContactIdForAddr: async (addr: string) => {
      // SELF is trivially reachable (we can address our own thread), but a
      // subscription to our own thread is nonsensical; the caller guards that.
      if (matchesSelfAddr(addr, creds.addr)) return DC_CONTACT_ID_SELF;
      return keyContactFor(addr);
    },

    contactInvite: async () => rpc.getChatSecurejoinQrCode(accountId, null),

    introduceViaInvite: async (invite: string, expectedAddr: string) => {
      // A received envelope's invite is attacker-influencable, so gate the QR
      // KIND before acting: only a contact-verification invite may be joined.
      // Anything else (a broadcast/group invite smuggled into the field) would
      // silently subscribe/join us to something — refuse.
      const qr = await rpc.checkQr(accountId, invite).catch(() => null);
      if (!qr || qr.kind !== 'askVerifyContact') return null;
      try {
        await rpc.secureJoin(accountId, invite);
      } catch {
        return null;
      }
      // Success criterion = an e2ee-capable KEY-contact for `expectedAddr`
      // exists. This folds the mandatory post-join ADDRESS CHECK (the link is
      // self-authenticating; addr equality is the authenticator — a swapped
      // link completes against someone else and never produces this row) and
      // handshake completion into one honest probe, polled bounded (the
      // securejoin handshake is a multi-message email exchange).
      const deadline = Date.now() + 60_000;
      for (;;) {
        const id = await keyContactFor(expectedAddr);
        if (id !== null) return id;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 2000));
      }
    },

    follow: async (invite: string) => {
      const chatId = await rpc.secureJoin(accountId, invite);
      // Re-following a feed we previously `unfollow()`-ed (which calls
      // `blockChat`) hands back the *same* chat id from `secureJoin` —
      // still blocked. `acceptChat` alone does not unblock it (verified:
      // `Contact.isBlocked` stays true and the chat keeps missing from
      // `getChatlistEntries`); blocking happens at the contact level
      // (`blockChat` blocks the chat's contact(s), there is no separate
      // "unblock chat" RPC), so the fix is to detect a blocked contact on
      // this chat and call `unblockContact`. Errors are logged, not
      // swallowed — silently failing here is exactly how this bug shipped.
      try {
        const contactIds = await rpc.getChatContacts(accountId, chatId);
        const contacts = await rpc.getContactsByIds(accountId, contactIds);
        const blocked = blockedContactIds(Object.values(contacts));
        for (const contactId of blocked) {
          await rpc.unblockContact(accountId, contactId);
        }
      } catch (err) {
        console.error('failed to check/unblock re-followed feed contact:', err);
      }
      try {
        await rpc.acceptChat(accountId, chatId);
      } catch (err) {
        console.error('failed to accept re-joined feed chat:', err);
      }
      return chatId;
    },

    contact: async (contactId) => rpc.getContact(accountId, contactId).catch(() => null),

    contacts: async () => rpc.getContacts(accountId, 0, null).catch(() => []),

    setContactName: async (contactId, name) => {
      await rpc.changeContactName(accountId, contactId, name);
    },

    contactIdByAddr: async (addr) => {
      // SELF first: the daemon's own address (or its bare username) never
      // needs an RPC lookup, and core's lookup may not know SELF by addr.
      if (matchesSelfAddr(addr, creds.addr)) return DC_CONTACT_ID_SELF;
      return rpc.lookupContactIdByAddr(accountId, addr).catch(() => null);
    },

    ensureContactIdByAddr: async (addr) => {
      // SELF short-circuit, same as the lookup path.
      if (matchesSelfAddr(addr, creds.addr)) return DC_CONTACT_ID_SELF;
      // createContact is idempotent in core (returns the existing id if the
      // contact is already known), so this both finds and first-creates. An id
      // alone is NOT deliverability: sends to a never-met peer fail with "e2e
      // encryption unavailable" (securejoin is the only key-exchange path).
      return rpc.createContact(accountId, addr, null).catch(() => null);
    },

    avatarPath: async (contactId) => {
      // SELF: the raw contact's profileImage lags a freshly-set selfavatar in
      // some core versions, so read the authoritative `selfavatar` config
      // (which points at the blob DC copied the uploaded file into) directly.
      if (contactId === DC_CONTACT_ID_SELF) {
        const selfavatar = await rpc.getConfig(accountId, 'selfavatar').catch(() => null);
        if (selfavatar) return selfavatar;
      }
      const contact = await rpc.getContact(accountId, contactId).catch(() => null);
      return contact?.profileImage ?? null;
    },

    contactBadge: async (contactId) => {
      const contact = await rpc.getContact(accountId, contactId).catch(() => null);
      if (!contact) return null;
      // Same cached self-displayname override used by loadMessages/self():
      // the raw SELF contact's displayName is a placeholder ("Me").
      return badgeOf(contact, await selfDisplayName());
    },

    blobPath: async (msgId) => {
      const msg = await rpc.getMessage(accountId, msgId).catch(() => null);
      return msg?.file ?? null;
    },

    stats: async () => {
      // Both owned channels count (visibility channels): follower sets are
      // UNIONED (a locked follower usually also follows public), post counts
      // summed. The locked chat is never created here — read paths must not
      // conjure it.
      const feedChatId = await ensureFeedChat();
      const lockedChatId = await lockedChatIdIfAny();
      const chatIds = [feedChatId, ...(lockedChatId !== null ? [lockedChatId] : [])];
      const [contactLists, entries, msgIdLists] = await Promise.all([
        Promise.all(chatIds.map((id) => rpc.getChatContacts(accountId, id))),
        rpc.getChatlistEntries(accountId, null, null, null),
        Promise.all(chatIds.map((id) => rpc.getMessageIds(accountId, id, false, false))),
      ]);
      const followerIds = new Set(contactLists.flat().filter((id) => id !== DC_CONTACT_ID_SELF));
      const followers = followerIds.size;

      const chats = await Promise.all(entries.map((id) => rpc.getBasicChatInfo(accountId, id)));
      const following = chats.filter((chat) => chat.chatType === 'InBroadcast').length;

      const messages = await loadMessages(msgIdLists.flat());
      const statuses = messages.length;

      return { followers, following, statuses };
    },

    searchMessages: async (query) => rpc.searchMessages(accountId, query, null).catch(() => []),

    messageMid: resolveMid,

    sendControlDm: async (contactId, text, quotedText) => {
      const chatId = await dm1to1ChatId(contactId);
      const data: T.MessageData = {
        text,
        html: null,
        viewtype: null,
        file: null,
        filename: null,
        location: null,
        overrideSenderName: null,
        quotedMessageId: null,
        quotedText: quotedText ?? null,
      };
      await rpc.sendMsg(accountId, chatId, data);
    },

    sendContentDm: async (contactId, text, opts) => {
      const chatId = await dm1to1ChatId(contactId);
      const data: T.MessageData = {
        text,
        html: null,
        viewtype: opts?.file ? 'Image' : null,
        file: opts?.file ?? null,
        filename: null,
        location: null,
        overrideSenderName: null,
        quotedMessageId: null,
        quotedText: null,
      };
      const msgId = await rpc.sendMsg(accountId, chatId, data);
      return withSelfDisplayName(await rpc.getMessage(accountId, msgId), await selfDisplayName());
    },

    deleteMessage: async (msgId) => {
      await rpc.deleteMessagesForAll(accountId, [msgId]);
    },

    following: async () => {
      const entries = await rpc.getChatlistEntries(accountId, null, null, null);
      const chats = await Promise.all(entries.map((id) => rpc.getFullChatById(accountId, id)));
      const inBroadcasts = chats.filter((chat) => chat.chatType === 'InBroadcast');
      const results: { contactId: number; chatId: number; name: string; addr: string }[] = [];
      for (const chat of inBroadcasts) {
        // The feed owner is the only (non-SELF) contact in the InBroadcast
        // chat we joined via securejoin — checked against the shape
        // `getFullChatById` actually returns for these chats (see DEVLOG).
        const ownerId = chat.contactIds.find((id) => id !== DC_CONTACT_ID_SELF);
        if (ownerId === undefined) continue;
        const contact = await rpc.getContact(accountId, ownerId).catch(() => null);
        if (!contact) continue;
        results.push({ contactId: ownerId, chatId: chat.id, name: chat.name, addr: contact.address });
      }
      return results;
    },

    removeFollower: async (contactId) => {
      const chatIds = [await ensureFeedChat()];
      const locked = await lockedChatIdIfAny();
      if (locked !== null) chatIds.push(locked);
      for (const chatId of chatIds) {
        await rpc.removeContactFromChat(accountId, chatId, contactId).catch((err) => {
          console.error('removeFollower: removeContactFromChat failed (non-fatal):', err);
        });
      }
    },

    unfollow: async (contactId) => {
      const chatId = await inBroadcastChatFor(contactId);
      if (chatId === null) return false;
      // Broadcasts have no "leave" RPC (only `leaveGroup`, for Group chats).
      // `blockChat` (rather than `deleteChat`) is used deliberately:
      // `deleteChat`'s own doc comment says it does *not* block the contact,
      // so a later delivery to the broadcast would silently resurrect the
      // chat as a contact request. Blocking actually stops delivery.
      await rpc.blockChat(accountId, chatId);
      return true;
    },

    leaveChat: async (chatId: number) => {
      // Broadcasts (incl. thread channels joined via securejoin) have no plain
      // "leave" RPC — `blockChat` stops delivery (same as `unfollow`).
      await rpc.blockChat(accountId, chatId);
    },

    timelineFrom: async (contactId, { limit, maxId, minId }: TimelineQuery) => {
      // Our own profile: read from our own broadcasts — BOTH channels (we're
      // not a member of an InBroadcast chat for ourselves).
      let chatIds: number[];
      if (contactId === DC_CONTACT_ID_SELF) {
        const locked = await lockedChatIdIfAny();
        chatIds = [await ensureFeedChat(), ...(locked !== null ? [locked] : [])];
      } else {
        chatIds = [await inBroadcastChatFor(contactId)].filter((id): id is number => id !== null);
      }
      if (chatIds.length === 0) return [];
      const perChat = await Promise.all(
        chatIds.map((id) => rpc.getMessageIds(accountId, id, false, false)),
      );
      const ids = perChat
        .flat()
        .filter((id) => (maxId === undefined || id < maxId) && (minId === undefined || id > minId))
        .sort((a, b) => b - a)
        .slice(0, limit * 2);
      const messages = await loadMessages(ids);
      return messages.sort((a, b) => b.sortTimestamp - a.sortTimestamp || b.id - a.id).slice(0, limit);
    },

    onFollower: (handler) => {
      followerHandlers.add(handler);
      return () => followerHandlers.delete(handler);
    },
  };
};

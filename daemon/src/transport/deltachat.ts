import { startDeltaChat } from '@deltachat/stdio-rpc-server';
import type { T } from '@deltachat/jsonrpc-client';
import type { PostOptions, TimelineQuery, Transport } from './types.js';
import { initialOf } from '../mastodon/entities.js';

const DC_CONTACT_ID_SELF = 1;
const FEED_CHAT_ID_KEY = 'ui.deltanet.feed_chat_id';

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

export type ChatmailCredentials = {
  addr: string;
  password: string;
  displayName: string;
};

export type DeltaChatTransport = Transport & {
  close(): void;
  accountId: number;
  /** Resolve when a core event of `kind` matching `predicate` arrives. */
  waitForEvent<K extends T.EventType['kind']>(
    kind: K,
    timeoutMs: number,
    predicate?: (event: Extract<T.EventType, { kind: K }>) => boolean,
  ): Promise<Extract<T.EventType, { kind: K }>>;
};

export type OpenTransportOptions = {
  /**
   * Called for every message loaded via timeline/message reads, and for
   * every incoming-message core event (so DMs/messages that never hit a
   * timeline render still get ingested). Failures are logged and otherwise
   * ignored — ingestion is best-effort bookkeeping, never load-bearing for
   * serving the request that triggered it.
   */
  onMessage?: (msg: T.Message) => void | Promise<void>;
};

export const openTransport = async (
  dataDir: string,
  creds: ChatmailCredentials,
  options: OpenTransportOptions = {},
): Promise<DeltaChatTransport> => {
  const dc = startDeltaChat(dataDir, { muteStdErr: true });
  const rpc = dc.rpc;

  const accountIds = await rpc.getAllAccountIds();
  const accountId = accountIds[0] ?? (await rpc.addAccount());

  if (!(await rpc.isConfigured(accountId))) {
    await rpc.batchSetConfig(accountId, {
      addr: creds.addr,
      mail_pw: creds.password,
      displayname: creds.displayName,
    });
    await rpc.configure(accountId);
  }
  await rpc.startIo(accountId);

  // Reaction/reply control DMs from a node we don't yet have an accepted
  // 1:1 chat with land in a contact-request chat. Core suppresses
  // `IncomingMsg` for those (confirmed live: feed/broadcast messages ingest
  // fine, but contact-request DMs never fire the event) — accepting the
  // chat as soon as we see a message in it stops it being a pending request
  // so future deliveries flow through normal events. Best-effort: a failure
  // here must never block ingestion.
  const acceptIfContactRequest = async (chatId: number): Promise<void> => {
    try {
      const chat = await rpc.getBasicChatInfo(accountId, chatId);
      if (chat.isContactRequest) await rpc.acceptChat(accountId, chatId);
    } catch (err) {
      console.error('failed to accept contact-request chat (non-fatal):', err);
    }
  };

  const notifyOnMessage = async (msg: T.Message): Promise<void> => {
    if (!shouldIngest(msg)) return;
    await acceptIfContactRequest(msg.chatId);
    if (!options.onMessage) return;
    try {
      await options.onMessage(msg);
    } catch (err) {
      console.error('onMessage ingestion failed (non-fatal):', err);
    }
  };

  /** Load a message by id and pass it through `notifyOnMessage`, tagging errors with their source event. */
  const loadAndNotify = async (msgId: number, eventKind: string): Promise<void> => {
    try {
      const msg = await rpc.getMessage(accountId, msgId);
      const displayname = await selfDisplayName();
      await notifyOnMessage(withSelfDisplayName(msg, displayname));
    } catch (err) {
      console.error(`failed to load message from ${eventKind} for ingestion:`, err);
    }
  };

  // No reverse mid -> msgId RPC exists; getMessageInfoObject is the only way
  // to learn a message's rfc724Mid, so cache it in-memory once resolved.
  const midCache = new Map<number, string | null>();

  const feedChatIds = async (): Promise<number[]> => {
    const entries = await rpc.getChatlistEntries(accountId, null, null, null);
    const chats = await Promise.all(entries.map((id) => rpc.getBasicChatInfo(accountId, id)));
    return chats.filter((chat) => FEED_CHAT_TYPES.has(chat.chatType)).map((chat) => chat.id);
  };

  const ensureFeedChat = async (): Promise<number> => {
    const stored = await rpc.getConfig(accountId, FEED_CHAT_ID_KEY);
    if (stored) return Number(stored);
    const name = `${creds.displayName}'s feed`;
    const chatId = await rpc.createBroadcast(accountId, name);
    await rpc.setConfig(accountId, FEED_CHAT_ID_KEY, String(chatId));
    return chatId;
  };

  // Cached so we don't hit getConfig once per message when mapping timelines.
  let cachedDisplayName: string | null | undefined;
  const selfDisplayName = async (): Promise<string | null> => {
    if (cachedDisplayName === undefined) {
      cachedDisplayName = await rpc.getConfig(accountId, 'displayname');
    }
    return cachedDisplayName;
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

  const resolveMid = async (msgId: number): Promise<string | null> => {
    if (midCache.has(msgId)) return midCache.get(msgId) ?? null;
    const mid = await rpc
      .getMessageInfoObject(accountId, msgId)
      .then((info) => info.rfc724Mid ?? null)
      .catch(() => null);
    midCache.set(msgId, mid);
    return mid;
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
   */
  const backfill = async (): Promise<void> => {
    const chatIds = await rpc.getChatlistEntries(accountId, null, null, null);
    for (const chatId of chatIds) {
      try {
        const msgIds = await rpc.getMessageIds(accountId, chatId, false, false);
        for (let i = 0; i < msgIds.length; i += BACKFILL_BATCH_SIZE) {
          const batch = msgIds.slice(i, i + BACKFILL_BATCH_SIZE);
          const loaded = await rpc.getMessages(accountId, batch);
          const displayname = await selfDisplayName();
          const messages = Object.values(loaded)
            .filter((res): res is Extract<T.MessageLoadResult, { kind: 'message' }> => res.kind === 'message')
            .map((msg) => withSelfDisplayName(msg, displayname));
          for (const msg of messages) await notifyOnMessage(msg);
        }
      } catch (err) {
        console.error(`backfill failed for chat ${chatId} (non-fatal):`, err);
      }
    }
  };

  // Fire-and-forget: must not delay openTransport's resolution.
  void backfill().catch((err) => console.error('startup backfill failed (non-fatal):', err));

  return {
    accountId,
    close: () => dc.close(),

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
      const chatId = await ensureFeedChat();
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
        return rpc.getMessage(accountId, msgId);
      }
      const msgId = await rpc.miscSendTextMessage(accountId, chatId, text);
      return rpc.getMessage(accountId, msgId);
    },

    feedInvite: async () => {
      const chatId = await ensureFeedChat();
      return rpc.getChatSecurejoinQrCode(accountId, chatId);
    },

    follow: async (invite: string) => {
      const chatId = await rpc.secureJoin(accountId, invite);
      await rpc.acceptChat(accountId, chatId).catch(() => undefined);
      return chatId;
    },

    contact: async (contactId) => rpc.getContact(accountId, contactId).catch(() => null),

    avatarPath: async (contactId) => {
      const contact = await rpc.getContact(accountId, contactId).catch(() => null);
      return contact?.profileImage ?? null;
    },

    contactBadge: async (contactId) => {
      const contact = await rpc.getContact(accountId, contactId).catch(() => null);
      if (!contact) return null;
      return { initial: initialOf(contact.displayName), color: contact.color };
    },

    blobPath: async (msgId) => {
      const msg = await rpc.getMessage(accountId, msgId).catch(() => null);
      return msg?.file ?? null;
    },

    stats: async () => {
      const feedChatId = await ensureFeedChat();
      const [feedContacts, entries, msgIds] = await Promise.all([
        rpc.getChatContacts(accountId, feedChatId),
        rpc.getChatlistEntries(accountId, null, null, null),
        rpc.getMessageIds(accountId, feedChatId, false, false),
      ]);
      const followers = feedContacts.filter((id) => id !== DC_CONTACT_ID_SELF).length;

      const chats = await Promise.all(entries.map((id) => rpc.getBasicChatInfo(accountId, id)));
      const following = chats.filter((chat) => chat.chatType === 'InBroadcast').length;

      const messages = await loadMessages(msgIds);
      const statuses = messages.length;

      return { followers, following, statuses };
    },

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

    timelineFrom: async (contactId, { limit, maxId, minId }: TimelineQuery) => {
      // Our own profile: read from our own feed broadcast (we're not a
      // member of an InBroadcast chat for ourselves).
      const chatId = contactId === DC_CONTACT_ID_SELF ? await ensureFeedChat() : await inBroadcastChatFor(contactId);
      if (chatId === null) return [];
      const ids = (await rpc.getMessageIds(accountId, chatId, false, false))
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

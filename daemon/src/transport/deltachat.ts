import { startDeltaChat } from '@deltachat/stdio-rpc-server';
import type { T } from '@deltachat/jsonrpc-client';
import type { TimelineQuery, Transport } from './types.js';

const DC_CONTACT_ID_SELF = 1;
const FEED_CHAT_ID_KEY = 'ui.deltanet.feed_chat_id';

/** Chat types whose messages appear in the timeline. */
const FEED_CHAT_TYPES: ReadonlySet<T.ChatType> = new Set([
  'Group',
  'OutBroadcast',
  'InBroadcast',
]);

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

export const openTransport = async (
  dataDir: string,
  creds: ChatmailCredentials,
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

  const loadMessages = async (msgIds: number[]): Promise<T.Message[]> => {
    if (msgIds.length === 0) return [];
    const loaded = await rpc.getMessages(accountId, msgIds);
    return Object.values(loaded)
      .filter((res): res is Extract<T.MessageLoadResult, { kind: 'message' }> => res.kind === 'message')
      .filter((msg) => !msg.isInfo);
  };

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

    post: async (text: string) => {
      const chatId = await ensureFeedChat();
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
  };
};

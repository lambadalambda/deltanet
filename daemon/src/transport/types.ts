import type { T } from '@deltachat/jsonrpc-client';

export type TimelineQuery = {
  limit: number;
  maxId?: number;
  minId?: number;
};

export type PostOptions = {
  file?: string;
  /** Freeform quote bubble (deltanet wire convention: reply/boost embeds). */
  quotedText?: string;
  /**
   * Which owned broadcast the post goes to (visibility channels): the PUBLIC
   * feed (default — the account's original feed) or the LOCKED channel
   * (created lazily; its invite is never published, see
   * ../meta/issues/visibility-channels.md).
   */
  channel?: OwnChannel;
};

/** The two owned broadcast channels (visibility channels). */
export type OwnChannel = 'public' | 'locked';

/**
 * What the Mastodon API layer needs from the federation transport.
 * Kept narrow so the API server can be unit-tested with a fake.
 */
/** Profile fields settable via the Mastodon `update_credentials` endpoint. */
export type ProfileUpdate = {
  /** → `displayname` config. */
  displayName?: string;
  /** → `selfstatus` config (the account bio/note). May be empty to clear it. */
  bio?: string;
  /** → `selfavatar` config; `null` clears the avatar. A path is imported into DC's blob store. */
  avatarPath?: string | null;
};

export interface Transport {
  self(): Promise<T.Contact>;
  /**
   * Apply self-config profile changes (`displayname`/`selfstatus`/`selfavatar`),
   * setting only the keys present in `updates`. Invalidates any cached self
   * display name so subsequent `self()`/timeline/`contactBadge` reads reflect
   * the change immediately.
   */
  updateProfile(updates: ProfileUpdate): Promise<void>;
  /** Feed messages across all subscribed feeds, newest first. */
  timeline(query: TimelineQuery): Promise<T.Message[]>;
  message(msgId: number): Promise<T.Message | null>;
  post(text: string, opts?: PostOptions): Promise<T.Message>;
  /**
   * Invite link others use to follow (join) one of our channels. Default: the
   * PUBLIC feed. `'locked'` lazily creates the locked channel; its link is
   * meant to be handed out one-to-one (approval = sending it), never published.
   */
  feedInvite(channel?: OwnChannel): Promise<string>;
  /**
   * Export core's passphrase-encrypted backup tar into `destDir` and return
   * the written file's path. Stamps the last-backup timestamp config on
   * success (see `lastBackupAt`). NOTE: this is only the CORE half of a
   * deltanet backup — the API layer wraps it with the encrypted sidecar
   * (signing key + store) into a `.dnbk` container (see ../backup.ts).
   */
  exportBackup(destDir: string, passphrase: string): Promise<string>;
  /** ms-epoch of the last successful `exportBackup`, or null if never. */
  lastBackupAt(): Promise<number | null>;
  /** Join someone else's feed from their invite link. Returns the chat id. */
  follow(invite: string): Promise<number>;
  /**
   * Create a fresh broadcast channel with the given name and return its chatId
   * (thread-subscribe host side — mirrors how the account's own feed broadcast is
   * created at signup). Used to lazily host a per-thread channel.
   */
  createBroadcast(name: string): Promise<number>;
  /** The securejoin invite link for a SPECIFIC broadcast chat we own (a thread channel). */
  chatInvite(chatId: number): Promise<string>;
  /**
   * Post `text` to a SPECIFIC chat we own (a thread channel), rather than the
   * account feed — the republication seam. Returns the sent message. `opts` is
   * the same as `post()` (media/quotedText) though thread republication uses
   * neither today.
   */
  postToChat(chatId: number, text: string, opts?: PostOptions): Promise<T.Message>;
  /**
   * A contact id we can ACTUALLY encrypt to for `addr`, or null. Unlike
   * `contactIdByAddr`/`ensureContactIdByAddr` (which can return a KEYLESS
   * address-contact row that fails "e2e encryption unavailable" on send), this
   * probes core's e2ee availability (`e2eeAvail`) and returns an id ONLY when a
   * send would encrypt. The honest reachability signal thread-subscribe needs:
   * a subscriber can only DM the root author if it already holds a key path
   * (from a received message / securejoin). Null → the endpoint returns the
   * clean "can't reach the thread author yet" error, never a cold send.
   */
  keyContactIdForAddr(addr: string): Promise<number | null>;
  /**
   * Our own multi-use CONTACT invite link (chatId-less securejoin QR) — the
   * in-band introduction payload stamped onto outgoing content envelopes so a
   * stranger holding a post of ours can securejoin us on demand.
   */
  contactInvite(): Promise<string>;
  /**
   * Join `invite` (a CONTACT invite; any other QR kind is refused via checkQr)
   * and wait, bounded, until an e2ee-capable key-contact for `expectedAddr`
   * exists — which is simultaneously the handshake-completion signal AND the
   * mandatory post-join ADDRESS CHECK (invite links are self-authenticating; a
   * swapped link completes against someone else and never yields this row).
   * Returns that contact id, or null on refusal/failure/timeout. Callers must
   * treat this as SLOW (a securejoin is a multi-message email exchange) and
   * only invoke it on EXPLICIT need — never from plain ingest.
   */
  introduceViaInvite(invite: string, expectedAddr: string): Promise<number | null>;
  contact(contactId: number): Promise<T.Contact | null>;
  /**
   * ALL known contacts (mention-autocomplete candidate pool). The caller
   * filters/ranks (see ../mentions.ts) — single-user nodes have small
   * contact lists, so fetching all and ranking in the daemon keeps the
   * ordering fully under our control.
   */
  contacts(): Promise<T.Contact[]>;
  /**
   * Set (or clear, with '') the LOCAL name override for a contact — the
   * petname (see ../meta/issues/petnames.md). Key-bound: it lives on the
   * contact row, so it follows the cryptographic identity, not the string
   * name. `Contact.displayName` prefers it everywhere automatically.
   */
  setContactName(contactId: number, name: string): Promise<void>;
  /**
   * Resolve a contact id from an email address. Also matches SELF: if the
   * handle equals our own address (or its bare local part / username),
   * returns contact id 1. Null if no contact is known for the address.
   */
  contactIdByAddr(addr: string): Promise<number | null>;
  /**
   * Resolve a contact id from an email address, CREATING the contact if we've
   * never met them (core's `createContact`). Unlike `contactIdByAddr` (lookup
   * only), this always yields an id for a valid address. NOTE: a contact id is
   * NOT deliverability — core refuses to SEND to a peer whose PGP key it never
   * obtained ("e2e encryption unavailable"; securejoin is the substrate's only
   * key-exchange path), so callers must treat sends to such contacts as
   * best-effort. Returns SELF's id for our own address. Used by the reply
   * root-DM copy. Null only if the address is invalid / creation fails.
   *
   * KEY-CONTACTS vs ADDRESS-CONTACTS (DC core 2.x): core keeps these as
   * SEPARATE contact rows. A key-contact is derived from securejoin or a
   * received message and is e2ee-capable; an address-contact (what
   * `createContact`/`lookupContactIdByAddr` yield) is KEYLESS
   * (`e2eeAvail:false`) — sending to it fails with "e2e encryption
   * unavailable" EVEN WHEN a key-contact for the same address exists. So when
   * you hold a message from the peer, always send to the MESSAGE-DERIVED id
   * (`msg.fromId` / `msg.sender.id`) — as the reply DM copy
   * (`target.sender.id`) and the backfill request (`QueuedRef.peerContactId`)
   * do — and reach for this method only for genuinely address-only targets.
   */
  ensureContactIdByAddr(addr: string): Promise<number | null>;
  avatarPath(contactId: number): Promise<string | null>;
  /** Initial + stable color for the avatar placeholder; null if the contact is unknown. */
  contactBadge(contactId: number): Promise<{ initial: string; color: string } | null>;
  blobPath(msgId: number): Promise<string | null>;
  /** Real follower/following/post counts for the self account. */
  stats(): Promise<{ followers: number; following: number; statuses: number }>;
  /**
   * Core's full-text message search across ALL chats (search feature). Returns
   * msg ids; the caller filters to content messages and dedupes copies.
   */
  searchMessages(query: string): Promise<number[]>;
  /** The message's global email Message-ID (rfc724Mid), or null if it can't be resolved. */
  messageMid(msgId: number): Promise<string | null>;
  /** Send a 1:1 DM to a contact (creating the chat if needed), e.g. the reply-notify copy. */
  sendControlDm(contactId: number, text: string, quotedText?: string): Promise<void>;
  /**
   * Send user-visible content through a 1:1 chat and return our local message
   * copy. Unlike control DMs this supports media and is status-addressable.
   */
  sendContentDm(contactId: number, text: string, opts?: Pick<PostOptions, 'file'>): Promise<T.Message>;
  /** Delete a message for all recipients (used to implement unreblog). */
  deleteMessage(msgId: number): Promise<void>;
  /** Feeds we've joined (InBroadcast chats), one entry per followed account. */
  following(): Promise<{ contactId: number; chatId: number; name: string; addr: string }[]>;
  /**
   * Stop receiving a followed feed. Returns false if we weren't following
   * that contact (no InBroadcast chat found for them).
   */
  unfollow(contactId: number): Promise<boolean>;
  /**
   * Revoke a FOLLOWER: remove the contact from BOTH owned broadcast channels
   * (public feed + locked, when it exists). Stops FUTURE delivery only —
   * already-delivered posts stay on their device (documented honest limit).
   */
  removeFollower(contactId: number): Promise<void>;
  /**
   * Leave a specific chat by id (block it, stopping delivery) — used to
   * unsubscribe from a thread channel. Same `blockChat` mechanism as `unfollow`
   * (broadcasts have no plain "leave"); best-effort.
   */
  leaveChat(chatId: number): Promise<void>;
  /** All messages from a specific contact's feed chat(s), newest first. */
  timelineFrom(contactId: number, query: TimelineQuery): Promise<T.Message[]>;
  /**
   * Subscribe to new-follower events (securejoin completing on our feed,
   * from the inviter's/our own point of view). Returns an unsubscribe
   * function.
   */
  onFollower(handler: (contactId: number) => void): () => void;
}

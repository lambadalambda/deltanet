import type { T } from '@deltachat/jsonrpc-client';

export type TimelineQuery = {
  limit: number;
  maxId?: number;
  minId?: number;
};

/**
 * What the Mastodon API layer needs from the federation transport.
 * Kept narrow so the API server can be unit-tested with a fake.
 */
export interface Transport {
  self(): Promise<T.Contact>;
  /** Feed messages across all subscribed feeds, newest first. */
  timeline(query: TimelineQuery): Promise<T.Message[]>;
  message(msgId: number): Promise<T.Message | null>;
  post(text: string): Promise<T.Message>;
  /** Invite link others use to follow (join) our feed. */
  feedInvite(): Promise<string>;
  /** Join someone else's feed from their invite link. Returns the chat id. */
  follow(invite: string): Promise<number>;
  contact(contactId: number): Promise<T.Contact | null>;
  avatarPath(contactId: number): Promise<string | null>;
  blobPath(msgId: number): Promise<string | null>;
  /** Real follower/following/post counts for the self account. */
  stats(): Promise<{ followers: number; following: number; statuses: number }>;
}

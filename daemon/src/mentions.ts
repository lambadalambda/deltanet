import type { T } from '@deltachat/jsonrpc-client';

/**
 * Body-mention grammar (see ../meta/issues/mention-addressing-autocomplete.md).
 *
 * A mention is an `@local@domain` token in the PLAIN message body — full
 * address only, because a bare `@name` cannot be delivered to on the chatmail
 * substrate. The body sits inside the signed canonical payload, so mentions
 * are signed by construction: no envelope field, no canonical-layout bump,
 * and a relayed/republished copy can't grow forged mentions. Send and
 * receive sides both parse THIS grammar, so what gets delivered/notified is
 * exactly what renders.
 */

// local part: RFC-ish pragmatic subset; domain: dotted labels with a TLD —
// `@a@localhost` is not addressable across relays and stays plain text.
// Labels allow underscores (not strict-RFC hostname, but real chatmail relays
// use them — e.g. the test relay's `_chatmail.example`). A leading
// (?<![\w@.]) guard keeps plain email addresses (no @ prefix) and `@a@@b`
// junk from matching.
const MENTION_PATTERN =
  /(?<![\w@.])@([A-Za-z0-9._%+-]+@[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*\.[A-Za-z]{2,})(?![\w@.-])/g;

/**
 * Rank a contact against an autocomplete query. Petname (MY name for them)
 * wins over their own name, which wins over the address — and a prefix match
 * beats a substring match within each field. Null = no match. Pure.
 */
const matchRank = (
  contact: Pick<T.Contact, 'name' | 'authName' | 'displayName' | 'address'>,
  query: string,
): number | null => {
  const fields = [contact.name, contact.authName || contact.displayName, contact.address];
  for (let i = 0; i < fields.length; i++) {
    const value = (fields[i] ?? '').toLowerCase();
    if (!value) continue;
    if (value.startsWith(query)) return i * 2;
    if (value.includes(query)) return i * 2 + 1;
  }
  return null;
};

/**
 * The mention-autocomplete candidate list: KNOWN key-contacts (never SELF,
 * never keyless address rows — those can't be delivered to) matching `query`,
 * best rank first, capped at `limit`. Pure over the contact list, so the
 * endpoint stays a thin wrapper.
 */
export const rankedContactMatches = (
  contacts: T.Contact[],
  query: string,
  limit: number,
): T.Contact[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return contacts
    .filter((contact) => contact.id !== 1 && contact.isKeyContact)
    .map((contact) => ({ contact, rank: matchRank(contact, q) }))
    .filter((entry): entry is { contact: T.Contact; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.contact);
};

/**
 * All addresses mentioned in `body`, lowercased and deduped, in first-seen
 * order. Pure.
 */
export const parseBodyMentions = (body: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const addr = match[1]!.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
};

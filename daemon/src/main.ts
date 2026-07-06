import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { serve } from '@hono/node-server';
import { readAccounts, writeAccount } from './config.js';
import { createApp, type AppContext } from './server.js';
import { registerAccount } from './signup.js';
import { openTransport, type ChatmailCredentials, type IngestPhase } from './transport/deltachat.js';
import type { Transport } from './transport/types.js';
import { createStore } from './store.js';
import { deriveOnIngest } from './ingest.js';
import type { T } from '@deltachat/jsonrpc-client';

const PORT = Number(process.env['PORT'] ?? 4030);
const ACCOUNT = process.env['DELTANET_ACCOUNT'] ?? 'main';
const DATA_DIR = process.env['DELTANET_DATA'] ?? `data/${ACCOUNT}`;
const BASE_URL = process.env['DELTANET_BASE_URL'] ?? `http://localhost:${PORT}`;
const ACCOUNTS_FILE = process.env['DELTANET_ACCOUNTS'] ?? 'accounts.local.json';
const STATIC_DIR_CONFIG = process.env['DELTANET_STATIC'] ?? '../frontend/build';
const STATIC_DIR = resolve(process.cwd(), STATIC_DIR_CONFIG);

// One deltanet wire-convention store per account data dir, shared between
// the transport's ingestion hook (timeline loads + IncomingMsg events) and
// the API layer's mapping/context assembly.
const store = createStore(join(DATA_DIR, 'deltanet-store.json'));

const announce = async (transport: Transport) => {
  const self = await transport.self();
  console.log(`logged in as ${self.displayName} <${self.address}>`);
  console.log(`your feed invite: ${await transport.feedInvite()}`);
};

let transport: Transport | null = null;

// Takes the resolved `mid` as an argument instead of calling back into the
// module-level `transport` variable below. `openTransport` fires its
// startup backfill sweep (and may deliver live core events) *before* it
// resolves, but `transport` is only assigned after `await openTransport(...)`
// returns — so a `transport === null` guard here would silently drop every
// message the backfill sweep or an early event delivered. See DEVLOG.
//
// `phase` distinguishes the transport's two ingestion modes (see
// `IngestPhase`): live events and ordinary timeline/message loads always
// pass `'combined'`, doing both halves below in one call, exactly as before
// `phase` existed. Only the startup backfill sweep splits the same message
// into two separate calls — `'index'` (mid/msgId bookkeeping only) across
// *every* backfilled message, then `'derive'` (notification/reaction side
// effects) across all of them again — so that derivation for any one
// message never runs before every other backfilled message (regardless of
// chat sweep order) has already updated the store's `ownMids` index. See
// DEVLOG for the notification-loss bug this fixes.
//
// `store.ingestMessage`'s own `ingestedMsgIds` dedupe only guards the index
// half (re-running `'index'` for an already-ingested msgId is a no-op by
// design); it must never also suppress the `'derive'` call for that same
// msgId, or the second backfill pass would derive nothing. Calling
// `deriveOnIngest` unconditionally (outside any ingested-check) keeps that
// guard scoped to indexing only — derivation has its own, separate dedupe
// (`notificationDedupeKeys`).
const ingestOnMessage = async (
  msg: T.Message,
  isFeedMessage: boolean,
  mid: string | null,
  phase: IngestPhase,
) => {
  if (!mid) return;
  if (phase === 'combined' || phase === 'index') {
    store.ingestMessage(msg, mid, isFeedMessage);
  }
  if (phase === 'combined' || phase === 'derive') {
    deriveOnIngest(store, msg, mid);
  }
};

/** New-follower notification: SecurejoinInviterProgress===1000 means someone just joined our feed broadcast. */
const notifyFollower = async (contactId: number) => {
  const t = transport;
  if (!t) return;
  const contact = await t.contact(contactId).catch(() => null);
  if (!contact) return;
  store.addNotification({ type: 'follow', accountAddr: contact.address, accountContactId: contactId });
};

const creds = readAccounts(ACCOUNTS_FILE)[ACCOUNT];
if (creds) {
  console.log(`configuring ${creds.addr} (data: ${DATA_DIR}) ...`);
  transport = await openTransport(DATA_DIR, creds, { onMessage: ingestOnMessage });
  transport.onFollower(notifyFollower);
  await announce(transport);
} else {
  console.log(
    `no account "${ACCOUNT}" configured yet — POST /api/deltanet/signup to create one`,
  );
}

const ctx: AppContext = {
  getTransport: () => transport,
  signup: async (displayName, relay) => {
    const { addr, password } = await registerAccount(relay);
    const newCreds: ChatmailCredentials = { addr, password, displayName };
    writeAccount(ACCOUNTS_FILE, ACCOUNT, newCreds);
    const opened = await openTransport(DATA_DIR, newCreds, { onMessage: ingestOnMessage });
    opened.onFollower(notifyFollower);
    transport = opened;
    await announce(opened);
    return opened;
  },
};

const staticDir = existsSync(STATIC_DIR) ? STATIC_DIR : undefined;
if (staticDir) console.log(`serving static frontend from ${staticDir}`);

serve({ fetch: createApp(ctx, { baseUrl: BASE_URL, staticDir, store }).fetch, port: PORT });
console.log(`deltanet: mastodon api on ${BASE_URL}`);

import { serve } from '@hono/node-server';
import { readAccounts } from './config.js';
import { createApp } from './server.js';
import { openTransport } from './transport/deltachat.js';

const PORT = Number(process.env['PORT'] ?? 4030);
const ACCOUNT = process.env['DELTANET_ACCOUNT'] ?? 'main';
const DATA_DIR = process.env['DELTANET_DATA'] ?? `data/${ACCOUNT}`;
const BASE_URL = process.env['DELTANET_BASE_URL'] ?? `http://localhost:${PORT}`;

const creds = readAccounts()[ACCOUNT];
if (!creds) {
  console.error(`no account "${ACCOUNT}" in accounts.local.json`);
  process.exit(1);
}

console.log(`configuring ${creds.addr} (data: ${DATA_DIR}) ...`);
const transport = await openTransport(DATA_DIR, creds);
const self = await transport.self();
console.log(`logged in as ${self.displayName} <${self.address}>`);
console.log(`your feed invite: ${await transport.feedInvite()}`);

serve({ fetch: createApp(transport, { baseUrl: BASE_URL }).fetch, port: PORT });
console.log(`deltanet: mastodon api on ${BASE_URL}`);

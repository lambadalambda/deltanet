/**
 * Registers a fresh chatmail account and stores it in accounts.local.json.
 * Usage: pnpm setup-account [name] [displayName] [chatmail-relay-url]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [name = 'main', displayName = name, relay = 'https://nine.testrun.org'] =
  process.argv.slice(2);

const FILE = 'accounts.local.json';
const accounts = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
if (accounts[name]) {
  console.error(`account "${name}" already exists in ${FILE}`);
  process.exit(1);
}

const res = await fetch(`${relay}/new`, { method: 'POST' });
if (!res.ok) {
  console.error(`registration failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { email, password } = (await res.json()) as { email: string; password: string };

accounts[name] = { addr: email, password, displayName };
writeFileSync(FILE, JSON.stringify(accounts, null, 2) + '\n');
console.log(`registered ${email} as "${name}" in ${FILE}`);

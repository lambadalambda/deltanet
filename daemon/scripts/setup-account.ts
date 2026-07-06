/**
 * Registers a fresh chatmail account and stores it in accounts.local.json.
 * Usage: pnpm setup-account [name] [displayName] [chatmail-relay-url]
 */
import { readAccounts, writeAccount } from '../src/config.js';
import { registerAccount } from '../src/signup.js';

const [name = 'main', displayName = name, relay = 'https://nine.testrun.org'] =
  process.argv.slice(2);

const FILE = 'accounts.local.json';
if (readAccounts(FILE)[name]) {
  console.error(`account "${name}" already exists in ${FILE}`);
  process.exit(1);
}

const { addr, password } = await registerAccount(relay).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

writeAccount(FILE, name, { addr, password, displayName });
console.log(`registered ${addr} as "${name}" in ${FILE}`);

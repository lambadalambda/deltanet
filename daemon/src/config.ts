import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ChatmailCredentials } from './transport/deltachat.js';

export type AccountsFile = Record<string, ChatmailCredentials>;

/** Reads the accounts file; an absent file just means "no accounts yet". */
export const readAccounts = (path = 'accounts.local.json'): AccountsFile =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};

/** Persists (or overwrites) one named account's credentials. */
export const writeAccount = (
  path: string,
  name: string,
  creds: ChatmailCredentials,
): void => {
  const accounts = readAccounts(path);
  accounts[name] = creds;
  writeFileSync(path, JSON.stringify(accounts, null, 2) + '\n');
};

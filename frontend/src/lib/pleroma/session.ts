import { normalizeInstanceUrl } from './http';
import type { PendingPleromaOAuth, PleromaAuthState, PleromaOAuthClientRegistration, PleromaScope, PleromaSession } from './types';

export type PleromaStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const PLEROMA_SESSION_KEY = 'deltanet.session';
export const PLEROMA_PENDING_OAUTH_KEY = 'deltanet.oauth.pending';
export const PLEROMA_OAUTH_CLIENT_KEY_PREFIX = 'deltanet.oauth.client.';
export const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;

export const createMemoryPleromaStorage = (): PleromaStorage => {
	const values = new Map<string, string>();

	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key)
	};
};

const parseStoredValue = <Value>(storage: PleromaStorage, key: string) => {
	const raw = storage.getItem(key);
	if (!raw) return null;

	try {
		return JSON.parse(raw) as Value;
	} catch {
		storage.removeItem(key);
		return null;
	}
};

export const pleromaOAuthClientStorageKey = (instanceUrl: string) =>
	`${PLEROMA_OAUTH_CLIENT_KEY_PREFIX}${encodeURIComponent(normalizeInstanceUrl(instanceUrl))}`;

export const storePleromaOAuthClient = (
	storage: PleromaStorage,
	client: PleromaOAuthClientRegistration
) => {
	const normalized = { ...client, instanceUrl: normalizeInstanceUrl(client.instanceUrl) };
	storage.setItem(pleromaOAuthClientStorageKey(normalized.instanceUrl), JSON.stringify(normalized));
};

export const readPleromaOAuthClient = (
	storage: PleromaStorage,
	input: { instanceUrl: string; redirectUri: string; scopes: readonly PleromaScope[] }
) => {
	const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
	const key = pleromaOAuthClientStorageKey(instanceUrl);
	const client = parseStoredValue<PleromaOAuthClientRegistration>(storage, key);
	const valid = client &&
		client.instanceUrl === instanceUrl &&
		typeof client.clientId === 'string' && client.clientId.length > 0 &&
		typeof client.clientSecret === 'string' && client.clientSecret.length > 0 &&
		client.redirectUri === input.redirectUri &&
		Array.isArray(client.scopes) &&
		client.scopes.length === input.scopes.length &&
		client.scopes.every((scope, index) => scope === input.scopes[index]) &&
		typeof client.createdAt === 'number';
	if (valid) return client;
	if (client) storage.removeItem(key);
	return null;
};

export const removePleromaOAuthClient = (storage: PleromaStorage, instanceUrl: string) => {
	storage.removeItem(pleromaOAuthClientStorageKey(instanceUrl));
};

export const storePendingOAuth = (storage: PleromaStorage, pending: PendingPleromaOAuth) => {
	storage.setItem(PLEROMA_PENDING_OAUTH_KEY, JSON.stringify(pending));
};

export const readPendingOAuth = (storage: PleromaStorage, now = Date.now()) => {
	const pending = parseStoredValue<PendingPleromaOAuth>(storage, PLEROMA_PENDING_OAUTH_KEY);
	if (!pending) return null;

	if (typeof pending.createdAt !== 'number' || now - pending.createdAt > PENDING_OAUTH_TTL_MS) {
		clearPendingOAuth(storage);
		return null;
	}

	return pending;
};

export const clearPendingOAuth = (storage: PleromaStorage) => {
	storage.removeItem(PLEROMA_PENDING_OAUTH_KEY);
};

export const writePleromaSession = (storage: PleromaStorage, session: PleromaSession) => {
	storage.setItem(PLEROMA_SESSION_KEY, JSON.stringify(session));
};

export const storePleromaSession = (storage: PleromaStorage, session: PleromaSession) => {
	writePleromaSession(storage, session);
	clearPendingOAuth(storage);
};

export const readPleromaSession = (storage: PleromaStorage) =>
	parseStoredValue<PleromaSession>(storage, PLEROMA_SESSION_KEY);

export const signOutPleroma = (storage: PleromaStorage) => {
	storage.removeItem(PLEROMA_SESSION_KEY);
	clearPendingOAuth(storage);
};

export const readPleromaAuthState = (storage: PleromaStorage): PleromaAuthState => {
	const session = readPleromaSession(storage);
	if (session) return { status: 'authenticated', session };

	const pending = readPendingOAuth(storage);
	if (pending) return { status: 'authenticating', pending };

	return { status: 'unauthenticated' };
};

export const readSplitPleromaAuthState = ({
	sessionStorage,
	pendingStorage,
	now = Date.now()
}: {
	sessionStorage: PleromaStorage;
	pendingStorage: PleromaStorage;
	now?: number;
}): PleromaAuthState => {
	const session = readPleromaSession(sessionStorage);
	if (session) {
		try {
			readPendingOAuth(pendingStorage, now);
		} catch {
			// Pending OAuth cleanup should not mask a valid persisted session.
		}

		return { status: 'authenticated', session };
	}

	const pending = readPendingOAuth(pendingStorage, now);
	if (pending) return { status: 'authenticating', pending };

	return { status: 'unauthenticated' };
};

import { normalizeInstanceUrl } from './http';
import type { PendingPleromaOAuth, PleromaAuthState, PleromaOAuthClientRegistration, PleromaScope, PleromaSession } from './types';

export type PleromaStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const PLEROMA_SESSION_KEY = 'headwater.session';
export const PLEROMA_PENDING_OAUTH_KEY = 'headwater.oauth.pending';
export const PLEROMA_OAUTH_CLIENT_KEY_PREFIX = 'headwater.oauth.client.';
const LEGACY_SESSION_KEY = 'deltanet.session';
const LEGACY_PENDING_OAUTH_KEY = 'deltanet.oauth.pending';
const LEGACY_OAUTH_CLIENT_KEY_PREFIX = 'deltanet.oauth.client.';
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

const removeLegacyItem = (storage: PleromaStorage, key: string) => {
	try {
		storage.removeItem(key);
	} catch {
		// A successful authoritative write/read must survive blocked legacy cleanup.
	}
};

const writeLegacyItem = (storage: PleromaStorage, key: string, value: string) => {
	try {
		storage.setItem(key, value);
	} catch {
		// The Headwater key is authoritative; rollback compatibility is best-effort.
	}
};

const readMigratedValue = <Value>(
	storage: PleromaStorage,
	key: string,
	legacyKey: string,
	isValid: (value: Value) => boolean
) => {
	const current = parseStoredValue<Value>(storage, key);
	if (current && isValid(current)) return current;
	if (current) storage.removeItem(key);

	const legacy = parseStoredValue<Value>(storage, legacyKey);
	if (!legacy || !isValid(legacy)) {
		if (legacy) storage.removeItem(legacyKey);
		return null;
	}

	storage.setItem(key, JSON.stringify(legacy));
	return legacy;
};

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string');

const isPendingOAuth = (value: PendingPleromaOAuth) =>
	Boolean(value && typeof value === 'object') &&
	typeof value.instanceUrl === 'string' &&
	typeof value.clientId === 'string' && value.clientId.length > 0 &&
	typeof value.clientSecret === 'string' && value.clientSecret.length > 0 &&
	typeof value.redirectUri === 'string' &&
	isStringArray(value.scopes) &&
	typeof value.state === 'string' && value.state.length > 0 &&
	typeof value.createdAt === 'number';

const isSession = (value: PleromaSession) =>
	Boolean(value && typeof value === 'object') &&
	typeof value.instanceUrl === 'string' &&
	typeof value.accessToken === 'string' && value.accessToken.length > 0 &&
	typeof value.tokenType === 'string' &&
	typeof value.scope === 'string' &&
	typeof value.createdAt === 'number';

export const pleromaOAuthClientStorageKey = (instanceUrl: string) =>
	`${PLEROMA_OAUTH_CLIENT_KEY_PREFIX}${encodeURIComponent(normalizeInstanceUrl(instanceUrl))}`;

const legacyPleromaOAuthClientStorageKey = (instanceUrl: string) =>
	`${LEGACY_OAUTH_CLIENT_KEY_PREFIX}${encodeURIComponent(normalizeInstanceUrl(instanceUrl))}`;

export const storePleromaOAuthClient = (
	storage: PleromaStorage,
	client: PleromaOAuthClientRegistration
) => {
	const normalized = { ...client, instanceUrl: normalizeInstanceUrl(client.instanceUrl) };
	const encoded = JSON.stringify(normalized);
	storage.setItem(pleromaOAuthClientStorageKey(normalized.instanceUrl), encoded);
	writeLegacyItem(storage, legacyPleromaOAuthClientStorageKey(normalized.instanceUrl), encoded);
};

export const readPleromaOAuthClient = (
	storage: PleromaStorage,
	input: { instanceUrl: string; redirectUri: string; scopes: readonly PleromaScope[] }
) => {
	const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
	const key = pleromaOAuthClientStorageKey(instanceUrl);
	const isValid = (client: PleromaOAuthClientRegistration) => Boolean(client &&
		client.instanceUrl === instanceUrl &&
		typeof client.clientId === 'string' && client.clientId.length > 0 &&
		typeof client.clientSecret === 'string' && client.clientSecret.length > 0 &&
		client.redirectUri === input.redirectUri &&
		Array.isArray(client.scopes) &&
		client.scopes.length === input.scopes.length &&
		client.scopes.every((scope, index) => scope === input.scopes[index]) &&
		typeof client.createdAt === 'number');
	return readMigratedValue(storage, key, legacyPleromaOAuthClientStorageKey(instanceUrl), isValid);
};

export const removePleromaOAuthClient = (storage: PleromaStorage, instanceUrl: string) => {
	storage.removeItem(pleromaOAuthClientStorageKey(instanceUrl));
	removeLegacyItem(storage, legacyPleromaOAuthClientStorageKey(instanceUrl));
};

export const storePendingOAuth = (storage: PleromaStorage, pending: PendingPleromaOAuth) => {
	const encoded = JSON.stringify(pending);
	storage.setItem(PLEROMA_PENDING_OAUTH_KEY, encoded);
	writeLegacyItem(storage, LEGACY_PENDING_OAUTH_KEY, encoded);
};

export const readPendingOAuth = (storage: PleromaStorage, now = Date.now()) => {
	const pending = readMigratedValue(storage, PLEROMA_PENDING_OAUTH_KEY, LEGACY_PENDING_OAUTH_KEY, isPendingOAuth);
	if (!pending) return null;

	if (typeof pending.createdAt !== 'number' || now - pending.createdAt > PENDING_OAUTH_TTL_MS) {
		clearPendingOAuth(storage);
		return null;
	}

	return pending;
};

export const clearPendingOAuth = (storage: PleromaStorage) => {
	storage.removeItem(PLEROMA_PENDING_OAUTH_KEY);
	removeLegacyItem(storage, LEGACY_PENDING_OAUTH_KEY);
};

export const writePleromaSession = (storage: PleromaStorage, session: PleromaSession) => {
	const encoded = JSON.stringify(session);
	storage.setItem(PLEROMA_SESSION_KEY, encoded);
	writeLegacyItem(storage, LEGACY_SESSION_KEY, encoded);
};

export const storePleromaSession = (storage: PleromaStorage, session: PleromaSession) => {
	writePleromaSession(storage, session);
	clearPendingOAuth(storage);
};

export const readPleromaSession = (storage: PleromaStorage) =>
	readMigratedValue(storage, PLEROMA_SESSION_KEY, LEGACY_SESSION_KEY, isSession);

export const signOutPleroma = (storage: PleromaStorage) => {
	storage.removeItem(PLEROMA_SESSION_KEY);
	removeLegacyItem(storage, LEGACY_SESSION_KEY);
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

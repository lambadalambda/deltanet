import type { FetchLike } from './http';

export type DeltanetStatus = { configured: boolean; address: string | null };
export type DeltanetSignupInput = { displayName: string; relay?: string };
export type DeltanetSignupResult = { acct: string };
export type DeltanetSignupError =
	| { kind: 'conflict'; message: string }
	| { kind: 'invalid'; message: string }
	| { kind: 'network'; message: string };
export type DeltanetFollowResult = { chatId: number };
export type DeltanetFollowError = { kind: 'invalid'; message: string } | { kind: 'network'; message: string };

const DEFAULT_RELAY = 'https://nine.testrun.org';

export const DELTANET_DEFAULT_RELAY = DEFAULT_RELAY;

export const defaultDeltanetInstanceUrl = ({
	windowOrigin,
	publicInstanceUrl,
	fallback = 'http://localhost:4030'
}: {
	windowOrigin?: string;
	publicInstanceUrl?: string;
	fallback?: string;
}) => windowOrigin || publicInstanceUrl || fallback;

const readJsonBody = async (response: Response) => {
	const text = await response.text();
	if (!text) return null;

	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
};

const errorMessage = (payload: unknown, fallback: string) => {
	if (payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error: unknown }).error === 'string') {
		return (payload as { error: string }).error;
	}

	return fallback;
};

export const fetchDeltanetStatus = async ({
	instanceUrl,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	fetch?: FetchLike;
}): Promise<DeltanetStatus> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for deltanet requests.');

	const response = await requestFetch(new URL('/api/deltanet/status', instanceUrl).toString(), {
		headers: { accept: 'application/json' }
	});
	const payload = await readJsonBody(response);
	if (!response.ok || !payload || typeof payload !== 'object') {
		throw new Error('Could not read this node’s account status.');
	}

	const body = payload as { configured?: unknown; address?: unknown };
	return {
		configured: Boolean(body.configured),
		address: typeof body.address === 'string' ? body.address : null
	};
};

export const signupDeltanet = async ({
	instanceUrl,
	displayName,
	relay,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	fetch?: FetchLike;
} & DeltanetSignupInput): Promise<DeltanetSignupResult> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for deltanet requests.');

	let response: Response;
	try {
		response = await requestFetch(new URL('/api/deltanet/signup', instanceUrl).toString(), {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify({ display_name: displayName, ...(relay ? { relay } : {}) })
		});
	} catch (cause) {
		throw {
			kind: 'network',
			message: cause instanceof Error ? cause.message : 'Could not reach this node to create an account.'
		} satisfies DeltanetSignupError;
	}

	const payload = await readJsonBody(response);
	if (response.status === 409) {
		throw {
			kind: 'conflict',
			message: 'This node already has an account — sign in instead.'
		} satisfies DeltanetSignupError;
	}
	if (response.status === 422) {
		throw {
			kind: 'invalid',
			message: errorMessage(payload, 'That display name was not accepted.')
		} satisfies DeltanetSignupError;
	}
	if (!response.ok) {
		throw {
			kind: 'network',
			message: errorMessage(payload, 'Could not create an account on this node.')
		} satisfies DeltanetSignupError;
	}

	const account = payload && typeof payload === 'object' ? (payload as { account?: { acct?: unknown } }).account : null;
	const acct = account && typeof account.acct === 'string' ? account.acct : '';
	return { acct };
};

export const fetchDeltanetInvite = async ({
	instanceUrl,
	accessToken,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	fetch?: FetchLike;
}): Promise<string> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for deltanet requests.');

	const response = await requestFetch(new URL('/api/deltanet/invite', instanceUrl).toString(), {
		headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
	});
	const payload = await readJsonBody(response);
	if (!response.ok || !payload || typeof payload !== 'object' || typeof (payload as { invite?: unknown }).invite !== 'string') {
		throw new Error('Could not load your invite link.');
	}

	return (payload as { invite: string }).invite;
};

export type DeltanetBackupInfo = { lastBackupAt: number | null };
export type DeltanetRestoreError =
	| { kind: 'conflict'; message: string }
	| { kind: 'invalid'; message: string }
	| { kind: 'network'; message: string };

/** ~1 month: past this (or with no backup at all) the settings card nags. */
export const BACKUP_NAG_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const backupNagState = (lastBackupAt: number | null, now: number): 'never' | 'stale' | 'fresh' =>
	lastBackupAt === null ? 'never' : now - lastBackupAt > BACKUP_NAG_AFTER_MS ? 'stale' : 'fresh';

export const fetchDeltanetBackupInfo = async ({
	instanceUrl,
	accessToken,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	fetch?: FetchLike;
}): Promise<DeltanetBackupInfo> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for deltanet requests.');

	const response = await requestFetch(new URL('/api/deltanet/backup', instanceUrl).toString(), {
		headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
	});
	const payload = await readJsonBody(response);
	if (!response.ok || !payload || typeof payload !== 'object') {
		throw new Error('Could not read this node’s backup status.');
	}
	const at = (payload as { last_backup_at?: unknown }).last_backup_at;
	return { lastBackupAt: typeof at === 'number' ? at : null };
};

export const exportDeltanetBackup = async ({
	instanceUrl,
	accessToken,
	passphrase,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	passphrase: string;
	fetch?: FetchLike;
}): Promise<{ blob: Blob; filename: string }> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for deltanet requests.');

	const response = await requestFetch(new URL('/api/deltanet/backup/export', instanceUrl).toString(), {
		method: 'POST',
		headers: {
			accept: 'application/octet-stream',
			'content-type': 'application/json',
			authorization: `Bearer ${accessToken}`
		},
		body: JSON.stringify({ passphrase })
	});
	if (!response.ok) {
		const payload = await readJsonBody(response);
		throw new Error(errorMessage(payload, 'Could not export a backup from this node.'));
	}
	const disposition = response.headers.get('content-disposition') ?? '';
	const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'deltanet-backup.dnbk';
	return { blob: await response.blob(), filename };
};

export const restoreDeltanet = async ({
	instanceUrl,
	file,
	passphrase,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	file: File;
	passphrase: string;
	fetch?: FetchLike;
}): Promise<{ acct: string }> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for deltanet requests.');

	const form = new FormData();
	form.append('file', file);
	form.append('passphrase', passphrase);
	let response: Response;
	try {
		response = await requestFetch(new URL('/api/deltanet/restore', instanceUrl).toString(), {
			method: 'POST',
			headers: { accept: 'application/json' },
			body: form
		});
	} catch (cause) {
		throw {
			kind: 'network',
			message: cause instanceof Error ? cause.message : 'Could not reach this node to restore.'
		} satisfies DeltanetRestoreError;
	}

	const payload = await readJsonBody(response);
	if (response.status === 409) {
		throw {
			kind: 'conflict',
			message: 'This node already has an account — sign in instead.'
		} satisfies DeltanetRestoreError;
	}
	if (response.status === 422) {
		throw {
			kind: 'invalid',
			message: errorMessage(payload, 'That backup file or passphrase was not accepted.')
		} satisfies DeltanetRestoreError;
	}
	if (!response.ok) {
		throw {
			kind: 'network',
			message: errorMessage(payload, 'Could not restore a backup on this node.')
		} satisfies DeltanetRestoreError;
	}

	const account = payload && typeof payload === 'object' ? (payload as { account?: { acct?: unknown } }).account : null;
	const acct = account && typeof account.acct === 'string' ? account.acct : '';
	return { acct };
};

export const isFeedInvite = (value: string) => {
	const trimmed = value.trim();
	return trimmed.startsWith('https://i.delta.chat/') || trimmed.toUpperCase().startsWith('OPENPGP4FPR:');
};

export const followDeltanetInvite = async ({
	instanceUrl,
	accessToken,
	invite,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	invite: string;
	fetch?: FetchLike;
}): Promise<DeltanetFollowResult> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for deltanet requests.');

	let response: Response;
	try {
		response = await requestFetch(new URL('/api/deltanet/follow', instanceUrl).toString(), {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
			body: JSON.stringify({ invite })
		});
	} catch (cause) {
		throw {
			kind: 'network',
			message: cause instanceof Error ? cause.message : 'Could not reach this node to follow that feed.'
		} satisfies DeltanetFollowError;
	}

	const payload = await readJsonBody(response);
	if (response.status === 422) {
		throw {
			kind: 'invalid',
			message: errorMessage(payload, 'That invite link was not accepted.')
		} satisfies DeltanetFollowError;
	}
	if (!response.ok) {
		throw {
			kind: 'network',
			message: errorMessage(payload, 'Could not follow that feed.')
		} satisfies DeltanetFollowError;
	}

	const chatId = payload && typeof payload === 'object' ? (payload as { chat_id?: unknown }).chat_id : undefined;
	return { chatId: typeof chatId === 'number' ? chatId : 0 };
};

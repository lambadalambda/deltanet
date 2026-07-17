import type { FetchLike } from './http';

export type HeadwaterStatus = { configured: boolean; address: string | null };
export type HeadwaterSignupInput = { displayName: string; relay?: string; enrollmentCode?: string };
export type HeadwaterSignupResult = { acct: string };
export type HeadwaterSignupError =
	| { kind: 'conflict'; message: string }
	| { kind: 'invalid'; message: string }
	| { kind: 'network'; message: string };
export type HeadwaterFollowResult = { chatId: number };
export type HeadwaterFollowError = { kind: 'invalid'; message: string } | { kind: 'network'; message: string };

const DEFAULT_RELAY = 'https://nine.testrun.org';

export const HEADWATER_DEFAULT_RELAY = DEFAULT_RELAY;

export const defaultHeadwaterInstanceUrl = ({
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

export const fetchHeadwaterStatus = async ({
	instanceUrl,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	fetch?: FetchLike;
}): Promise<HeadwaterStatus> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	const response = await requestFetch(new URL('/api/headwater/status', instanceUrl).toString(), {
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

export const signupHeadwater = async ({
	instanceUrl,
	displayName,
	relay,
	enrollmentCode,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	fetch?: FetchLike;
} & HeadwaterSignupInput): Promise<HeadwaterSignupResult> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	let response: Response;
	try {
		response = await requestFetch(new URL('/api/headwater/signup', instanceUrl).toString(), {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify({
				display_name: displayName,
				...(relay ? { relay } : {}),
				...(enrollmentCode ? { enrollment_code: enrollmentCode } : {})
			})
		});
	} catch (cause) {
		throw {
			kind: 'network',
			message: cause instanceof Error ? cause.message : 'Could not reach this node to create an account.'
		} satisfies HeadwaterSignupError;
	}

	const payload = await readJsonBody(response);
	if (response.status === 409) {
		throw {
			kind: 'conflict',
			message: 'This node already has an account — sign in instead.'
		} satisfies HeadwaterSignupError;
	}
	if (response.status === 422) {
		throw {
			kind: 'invalid',
			message: errorMessage(payload, 'That display name was not accepted.')
		} satisfies HeadwaterSignupError;
	}
	if (!response.ok) {
		throw {
			kind: 'network',
			message: errorMessage(payload, 'Could not create an account on this node.')
		} satisfies HeadwaterSignupError;
	}

	const account = payload && typeof payload === 'object' ? (payload as { account?: { acct?: unknown } }).account : null;
	const acct = account && typeof account.acct === 'string' ? account.acct : '';
	return { acct };
};

export const fetchHeadwaterInvite = async ({
	instanceUrl,
	accessToken,
	channel,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	/** 'locked' fetches the followers-only channel's invite (share one-to-one, never publish). */
	channel?: 'public' | 'locked';
	fetch?: FetchLike;
}): Promise<string> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	const url = new URL('/api/headwater/invite', instanceUrl);
	if (channel === 'locked') url.searchParams.set('channel', 'locked');
	const response = await requestFetch(url.toString(), {
		headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
	});
	const payload = await readJsonBody(response);
	if (!response.ok || !payload || typeof payload !== 'object' || typeof (payload as { invite?: unknown }).invite !== 'string') {
		throw new Error('Could not load your invite link.');
	}

	return (payload as { invite: string }).invite;
};

export type HeadwaterBackupInfo = { lastBackupAt: number | null };
export type HeadwaterRestoreError =
	| { kind: 'conflict'; message: string }
	| { kind: 'invalid'; message: string }
	| { kind: 'network'; message: string };

/** ~1 month: past this (or with no backup at all) the settings card nags. */
export const BACKUP_NAG_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const backupNagState = (lastBackupAt: number | null, now: number): 'never' | 'stale' | 'fresh' =>
	lastBackupAt === null ? 'never' : now - lastBackupAt > BACKUP_NAG_AFTER_MS ? 'stale' : 'fresh';

export const fetchHeadwaterBackupInfo = async ({
	instanceUrl,
	accessToken,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	fetch?: FetchLike;
}): Promise<HeadwaterBackupInfo> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	const response = await requestFetch(new URL('/api/headwater/backup', instanceUrl).toString(), {
		headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
	});
	const payload = await readJsonBody(response);
	if (!response.ok || !payload || typeof payload !== 'object') {
		throw new Error('Could not read this node’s backup status.');
	}
	const at = (payload as { last_backup_at?: unknown }).last_backup_at;
	return { lastBackupAt: typeof at === 'number' ? at : null };
};

export const exportHeadwaterBackup = async ({
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
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	const response = await requestFetch(new URL('/api/headwater/backup/export', instanceUrl).toString(), {
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
	const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'headwater-backup.dnbk';
	return { blob: await response.blob(), filename };
};

export const restoreHeadwater = async ({
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
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	const form = new FormData();
	form.append('file', file);
	form.append('passphrase', passphrase);
	let response: Response;
	try {
		response = await requestFetch(new URL('/api/headwater/restore', instanceUrl).toString(), {
			method: 'POST',
			headers: { accept: 'application/json' },
			body: form
		});
	} catch (cause) {
		throw {
			kind: 'network',
			message: cause instanceof Error ? cause.message : 'Could not reach this node to restore.'
		} satisfies HeadwaterRestoreError;
	}

	const payload = await readJsonBody(response);
	if (response.status === 409) {
		throw {
			kind: 'conflict',
			message: 'This node already has an account — sign in instead.'
		} satisfies HeadwaterRestoreError;
	}
	if (response.status === 422) {
		throw {
			kind: 'invalid',
			message: errorMessage(payload, 'That backup file or passphrase was not accepted.')
		} satisfies HeadwaterRestoreError;
	}
	if (!response.ok) {
		throw {
			kind: 'network',
			message: errorMessage(payload, 'Could not restore a backup on this node.')
		} satisfies HeadwaterRestoreError;
	}

	const account = payload && typeof payload === 'object' ? (payload as { account?: { acct?: unknown } }).account : null;
	const acct = account && typeof account.acct === 'string' ? account.acct : '';
	return { acct };
};

/**
 * Set (or clear, with '') MY local petname for a contact
 * (meta/issues/petnames.md). Returns the updated raw account payload so the
 * caller can re-adapt profile/relationship state.
 */
export const setHeadwaterPetname = async ({
	instanceUrl,
	accessToken,
	contactId,
	petname,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	contactId: string;
	petname: string;
	fetch?: FetchLike;
}): Promise<unknown> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	const response = await requestFetch(
		new URL(`/api/headwater/contacts/${encodeURIComponent(contactId)}/petname`, instanceUrl).toString(),
		{
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				authorization: `Bearer ${accessToken}`
			},
			body: JSON.stringify({ petname })
		}
	);
	const payload = await readJsonBody(response);
	if (!response.ok) {
		throw new Error(errorMessage(payload, 'Could not save the petname.'));
	}
	return payload;
};

/**
 * Ask a contact for access to their followers-only (locked) channel
 * (visibility channels 1B). Their owner approves via the follow-request UI;
 * the grant then auto-joins on this node.
 */
export const requestHeadwaterLockedAccess = async ({
	instanceUrl,
	accessToken,
	contactId,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	contactId: string;
	fetch?: FetchLike;
}): Promise<void> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	const response = await requestFetch(
		new URL(`/api/headwater/contacts/${encodeURIComponent(contactId)}/request-locked`, instanceUrl).toString(),
		{
			method: 'POST',
			headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
		}
	);
	if (!response.ok) {
		const payload = await readJsonBody(response);
		throw new Error(errorMessage(payload, 'Could not request followers-only access.'));
	}
};

export const isFeedInvite = (value: string) => {
	const trimmed = value.trim();
	return trimmed.startsWith('https://i.delta.chat/') || trimmed.toUpperCase().startsWith('OPENPGP4FPR:');
};

export const followHeadwaterInvite = async ({
	instanceUrl,
	accessToken,
	invite,
	fetch: fetchImpl
}: {
	instanceUrl: string;
	accessToken: string;
	invite: string;
	fetch?: FetchLike;
}): Promise<HeadwaterFollowResult> => {
	const requestFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (!requestFetch) throw new Error('A fetch implementation is required for Headwater requests.');

	let response: Response;
	try {
		response = await requestFetch(new URL('/api/headwater/follow', instanceUrl).toString(), {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
			body: JSON.stringify({ invite })
		});
	} catch (cause) {
		throw {
			kind: 'network',
			message: cause instanceof Error ? cause.message : 'Could not reach this node to follow that feed.'
		} satisfies HeadwaterFollowError;
	}

	const payload = await readJsonBody(response);
	if (response.status === 422) {
		throw {
			kind: 'invalid',
			message: errorMessage(payload, 'That invite link was not accepted.')
		} satisfies HeadwaterFollowError;
	}
	if (!response.ok) {
		throw {
			kind: 'network',
			message: errorMessage(payload, 'Could not follow that feed.')
		} satisfies HeadwaterFollowError;
	}

	const chatId = payload && typeof payload === 'object' ? (payload as { chat_id?: unknown }).chat_id : undefined;
	return { chatId: typeof chatId === 'number' ? chatId : 0 };
};

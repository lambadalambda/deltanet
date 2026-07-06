import { expect, test } from '@playwright/test';
import { createPleromaClient, parseTimelinePaginationLinkHeader } from './client';
import { pleromaFixtures } from './fixtures';
import { normalizeInstanceUrl } from './http';
import {
	buildAuthorizationUrl,
	createOAuthState,
	exchangeOAuthCode,
	parseOAuthCallback,
	registerOAuthApp
} from './oauth';
import { createPleromaResource } from './resource';
import {
	createMemoryPleromaStorage,
	PENDING_OAUTH_TTL_MS,
	readPendingOAuth,
	readPleromaAuthState,
	readSplitPleromaAuthState,
	signOutPleroma,
	storePendingOAuth,
	storePleromaSession
} from './session';
import { buildPleromaStreamingUrl, openPleromaTimelineStream, parsePleromaStreamingMessage } from './streaming';

type RecordedRequest = {
	method: string;
	url: URL;
	authorization: string | null;
	body: string;
	bodyKind: string;
};

type MockResponse = { status?: number; body: unknown; headers?: Record<string, string> };

const createJsonFetch = (handler: (request: RecordedRequest) => MockResponse) => {
	const requests: RecordedRequest[] = [];
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body instanceof URLSearchParams ? init.body.toString() : init?.body instanceof FormData ? 'FORMDATA' : String(init?.body ?? '');
		const request: RecordedRequest = {
			method: init?.method ?? 'GET',
			url: new URL(String(input)),
			authorization: init?.headers instanceof Headers ? init.headers.get('authorization') : null,
			body,
			bodyKind: init?.body instanceof FormData ? 'form-data' : init?.body instanceof URLSearchParams ? 'url-search-params' : typeof init?.body
		};

		requests.push(request);
		const response = handler(request);

		return new Response(JSON.stringify(response.body), {
			status: response.status ?? 200,
			headers: { 'content-type': 'application/json', ...response.headers }
		});
	};

	return { fetchImpl, requests };
};

const expectPath = (request: RecordedRequest, path: string) => {
	expect(`${request.url.origin}${request.url.pathname}`).toBe(`https://pleroma.example${path}`);
};

test('Pleroma client isolates typed endpoints and authorization headers', async () => {
	const { fetchImpl, requests } = createJsonFetch((request) => {
		expect(request.authorization).toBe('Bearer access-token');

		if (request.url.pathname === '/api/v1/timelines/home') return { body: pleromaFixtures.timelines.home };
		if (request.url.pathname === '/api/v1/timelines/public') return { body: pleromaFixtures.timelines.public };
		if (request.url.pathname === '/api/v1/statuses/status-1') return { body: pleromaFixtures.status };
		if (request.url.pathname === '/api/v1/statuses/status-1/context') return { body: pleromaFixtures.context };
		if (request.url.pathname === '/api/v1/accounts/account-1') return { body: pleromaFixtures.account };
		if (request.url.pathname === '/api/v1/accounts/account-1/statuses') return { body: pleromaFixtures.timelines.home };
		if (request.url.pathname === '/api/v1/accounts/relationships') return { body: [pleromaFixtures.relationship] };
		if (request.url.pathname === '/api/v1/accounts/search') return { body: [pleromaFixtures.account] };
		if (request.url.pathname === '/api/v1/custom_emojis') return { body: pleromaFixtures.customEmojis };
		if (request.url.pathname === '/api/v2/instance') return { body: pleromaFixtures.instance };
		if (request.url.pathname === '/api/v2/search') return { body: pleromaFixtures.search };
		if (request.url.pathname === '/api/v1/trends/tags') return { body: pleromaFixtures.trends };
		if (request.url.pathname === '/api/v1/accounts/verify_credentials') return { body: pleromaFixtures.account };
		if (request.url.pathname === '/api/v1/media') return { body: pleromaFixtures.mediaAttachment };

		return { status: 404, body: { error: 'missing fixture' } };
	});

	const client = createPleromaClient({
		instanceUrl: 'https://pleroma.example/',
		accessToken: 'access-token',
		fetch: fetchImpl
	});

	const home = await client.getHomeTimeline({ limit: 2, maxId: '10' });
	const local = await client.getLocalTimeline({ onlyMedia: true });
	const federated = await client.getFederatedTimeline({ minId: '1' });
	const status = await client.getStatus('status-1');
	const context = await client.getStatusContext('status-1');
	const account = await client.getAccount('account-1');
	const accountStatuses = await client.getAccountStatusesPage('account-1', { limit: 3, excludeReplies: true, pinned: true, onlyMedia: true });
	const relationships = await client.getAccountRelationships(['account-1']);
	const accountMatches = await client.searchAccounts({ q: 'quiet', limit: 5, resolve: true });
	const customEmojis = await client.getCustomEmojis();
	const ownAccount = await client.getOwnAccount();
	const instance = await client.getInstance();
	const search = await client.search({ q: 'small web', type: 'statuses', limit: 5 });
	const trends = await client.getTrendingTags({ limit: 4 });
	const upload = await client.uploadMedia(new File(['pixels'], 'cat.png', { type: 'image/png' }), { description: 'cat alt' });

	expect(home[0].pleroma.local).toBe(true);
	expect(local).toHaveLength(1);
	expect(federated[0].account.acct).toContain('@');
	expect(status.pleroma.content?.['text/plain']).toContain('quiet');
	expect(context.ancestors[0].id).toBe('ancestor-1');
	expect(account.pleroma.is_admin).toBe(false);
	expect(accountStatuses.items[0].account.id).toBe('account-1');
	expect(relationships[0].following).toBe(true);
	expect(accountMatches[0].acct).toBe('quietadmin@pleroma.example');
	expect(customEmojis[0].shortcode).toBe('blobcat');
	expect(ownAccount.id).toBe('account-1');
	expect(instance.pleroma.metadata.features).toContain('pleroma_api');
	expect(search.statuses[0].id).toBe('status-1');
	expect(trends[0].name).toBe('smallweb');
	expect(upload.id).toBe('media-1');

	expectPath(requests[0], '/api/v1/timelines/home');
	expect(requests[0].url.searchParams.get('limit')).toBe('2');
	expect(requests[0].url.searchParams.get('max_id')).toBe('10');
	expect(requests[1].url.searchParams.get('local')).toBe('true');
	expect(requests[1].url.searchParams.get('only_media')).toBe('true');
	expect(requests[2].url.searchParams.get('min_id')).toBe('1');
	expectPath(requests[3], '/api/v1/statuses/status-1');
	expectPath(requests[4], '/api/v1/statuses/status-1/context');
	expectPath(requests[5], '/api/v1/accounts/account-1');
	expectPath(requests[6], '/api/v1/accounts/account-1/statuses');
	expect(requests[6].url.searchParams.get('limit')).toBe('3');
	expect(requests[6].url.searchParams.get('exclude_replies')).toBe('true');
	expect(requests[6].url.searchParams.get('pinned')).toBe('true');
	expect(requests[6].url.searchParams.get('only_media')).toBe('true');
	expectPath(requests[7], '/api/v1/accounts/relationships');
	expect(requests[7].url.searchParams.getAll('id[]')).toEqual(['account-1']);
	expectPath(requests[8], '/api/v1/accounts/search');
	expect(requests[8].url.searchParams.get('q')).toBe('quiet');
	expect(requests[8].url.searchParams.get('limit')).toBe('5');
	expect(requests[8].url.searchParams.get('resolve')).toBe('true');
	expectPath(requests[9], '/api/v1/custom_emojis');
	expectPath(requests[10], '/api/v1/accounts/verify_credentials');
	expectPath(requests[11], '/api/v2/instance');
	expect(requests[12].url.searchParams.get('q')).toBe('small web');
	expect(requests[12].url.searchParams.get('type')).toBe('statuses');
	expect(requests[13].url.searchParams.get('limit')).toBe('4');
	expectPath(requests[14], '/api/v1/media');
	expect(requests[14].method).toBe('POST');
	expect(requests[14].bodyKind).toBe('form-data');
});

test('Pleroma client sends media ids on status creation', async () => {
	const { fetchImpl, requests } = createJsonFetch((request) => {
		if (request.url.pathname === '/api/v1/statuses') return { body: pleromaFixtures.status };
		return { status: 404, body: { error: 'missing fixture' } };
	});
	const client = createPleromaClient({ instanceUrl: 'https://pleroma.example', accessToken: 'access-token', fetch: fetchImpl });

	await client.createStatus({ status: 'with image', mediaIds: ['media-1', 'media-2'] });

	expect(requests[0].body).toContain('status=with+image');
	expect(requests[0].body).toContain('media_ids%5B%5D=media-1');
	expect(requests[0].body).toContain('media_ids%5B%5D=media-2');
});

test('Pleroma client converts timeline Link headers into cursor data', async () => {
	const cursors = parseTimelinePaginationLinkHeader(
		'<https://pleroma.example/api/v1/timelines/home?max_id=status-2>; rel="next", <https://pleroma.example/api/v1/timelines/home?min_id=status-9>; rel="prev"'
	);
	expect(cursors).toEqual({
		next: { maxId: 'status-2' },
		previous: { minId: 'status-9' }
	});

	const { fetchImpl, requests } = createJsonFetch(() => ({
		body: pleromaFixtures.timelines.home,
		headers: {
			link: '<https://pleroma.example/api/v1/timelines/home?max_id=status-2>; rel="next"'
		}
	}));
	const client = createPleromaClient({
		instanceUrl: 'https://pleroma.example',
		accessToken: 'access-token',
		fetch: fetchImpl
	});

	const page = await client.getHomeTimelinePage({ limit: 2 });

	expect(page.items[0].id).toBe('status-1');
	expect(page.cursors).toEqual({ next: { maxId: 'status-2' }, previous: null });
	expect(requests[0].url.searchParams.get('limit')).toBe('2');
});

test('Pleroma client fetches authenticated notifications with cursor query', async () => {
	const { fetchImpl, requests } = createJsonFetch((request) => {
		if (request.url.pathname === '/api/v1/notifications') return { body: pleromaFixtures.notifications };

		return { status: 404, body: { error: 'missing fixture' } };
	});
	const client = createPleromaClient({
		instanceUrl: 'https://pleroma.example',
		accessToken: 'access-token',
		fetch: fetchImpl
	});

	const notifications = await client.getNotifications({ limit: 20, sinceId: 'notif-old' });

	expect(notifications.map((notification) => notification.id)).toEqual(['notif-mention', 'notif-follow', 'notif-fav', 'notif-boost', 'notif-reaction', 'notif-unknown']);
	expectPath(requests[0], '/api/v1/notifications');
	expect(requests[0].authorization).toBe('Bearer access-token');
	expect(requests[0].url.searchParams.get('limit')).toBe('20');
	expect(requests[0].url.searchParams.get('since_id')).toBe('notif-old');
});

test('Pleroma streaming helpers build WebSocket URLs and parse user stream events', () => {
	expect(buildPleromaStreamingUrl({ instanceUrl: 'https://pleroma.example', accessToken: 'access-token' })).toBe(
		'wss://pleroma.example/api/v1/streaming/?stream=user&access_token=access-token'
	);
	expect(buildPleromaStreamingUrl({ instanceUrl: 'http://localhost:4000', accessToken: 'local-token', stream: 'public:local' })).toBe(
		'ws://localhost:4000/api/v1/streaming/?stream=public%3Alocal&access_token=local-token'
	);

	const message = parsePleromaStreamingMessage(JSON.stringify({
		event: 'update',
		payload: JSON.stringify(pleromaFixtures.status)
	}));

	expect(message?.event).toBe('update');
	expect(message?.status?.id).toBe('status-1');
	const notificationMessage = parsePleromaStreamingMessage(JSON.stringify({
		event: 'notification',
		payload: JSON.stringify(pleromaFixtures.notifications[0])
	}));

	expect(notificationMessage?.event).toBe('notification');
	expect(notificationMessage?.notification?.id).toBe('notif-mention');
	expect(parsePleromaStreamingMessage(JSON.stringify({ event: 'update', payload: '{}' }))?.status).toBeUndefined();
	expect(parsePleromaStreamingMessage(JSON.stringify({ event: 'notification', payload: '{}' }))?.notification).toBeUndefined();
	expect(parsePleromaStreamingMessage('not json')).toBeNull();
});

test('Pleroma streaming lifecycle handles unavailable and closed sockets', () => {
	const originalWebSocket = globalThis.WebSocket;
	try {
		let unavailableError: unknown;
		Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: undefined });
		openPleromaTimelineStream({
			instanceUrl: 'https://pleroma.example',
			accessToken: 'access-token',
			onUpdate: () => undefined,
			onError: (error) => (unavailableError = error)
		}).close();
		expect(unavailableError).toBeInstanceOf(Error);

		let constructorError: unknown;
		const ThrowingSocket = function () {
			throw new Error('socket blocked');
		} as unknown as new (url: string) => {
			onmessage: ((event: { data: unknown }) => void) | null;
			onopen: ((event: Event) => void) | null;
			onerror: ((event: Event) => void) | null;
			onclose: ((event: Event) => void) | null;
			close: () => void;
		};
		openPleromaTimelineStream({
			instanceUrl: 'https://pleroma.example',
			accessToken: 'access-token',
			WebSocketImpl: ThrowingSocket,
			onUpdate: () => undefined,
			onError: (error) => (constructorError = error)
		}).close();
		expect(constructorError).toBeInstanceOf(Error);

		type TestSocket = {
			url: string;
			closeCount: number;
			onmessage: ((event: { data: unknown }) => void) | null;
			onopen: ((event: Event) => void) | null;
			onerror: ((event: Event) => void) | null;
			onclose: ((event: Event) => void) | null;
			close: () => void;
		};
		const sockets: TestSocket[] = [];
		const SocketImpl = function (_url: string) {
			const socket: TestSocket = {
				url: _url,
				closeCount: 0,
				onmessage: null,
				onopen: null,
				onerror: null,
				onclose: null,
				close() {
					this.closeCount += 1;
				}
			};
			sockets.push(socket);
			return socket;
		} as unknown as new (url: string) => TestSocket;
		const updates: string[] = [];
		const notifications: string[] = [];
		let openCount = 0;
		let errorCount = 0;
		let closeCount = 0;
		const stream = openPleromaTimelineStream({
			instanceUrl: 'https://pleroma.example',
			accessToken: 'access-token',
			WebSocketImpl: SocketImpl,
			onUpdate: (status) => updates.push(status.id),
			onNotification: (notification) => notifications.push(notification.id),
			onOpen: () => (openCount += 1),
			onError: () => (errorCount += 1),
			onClose: () => (closeCount += 1)
		});

		const socket = sockets[0];
		expect(socket.url).toBe('wss://pleroma.example/api/v1/streaming/?stream=user&access_token=access-token');
		socket.onopen?.(new Event('open'));
		socket.onmessage?.({ data: JSON.stringify({ event: 'update', payload: JSON.stringify({ ...pleromaFixtures.status, id: 'status-open' }) }) });
		socket.onmessage?.({ data: JSON.stringify({ event: 'notification', payload: JSON.stringify({ ...pleromaFixtures.notifications[0], id: 'notif-open' }) }) });
		expect(openCount).toBe(1);
		expect(updates).toEqual(['status-open']);
		expect(notifications).toEqual(['notif-open']);
		socket.onerror?.(new Event('error'));
		socket.onclose?.(new Event('close'));
		expect(errorCount).toBe(1);
		expect(closeCount).toBe(1);

		const retainedMessage = socket.onmessage;
		const retainedError = socket.onerror;
		const retainedClose = socket.onclose;
		stream.close();
		stream.close();
		expect(socket.closeCount).toBe(1);
		expect(socket.onmessage).toBeNull();
		expect(socket.onopen).toBeNull();
		expect(socket.onerror).toBeNull();
		expect(socket.onclose).toBeNull();

		retainedMessage?.({ data: JSON.stringify({ event: 'update', payload: JSON.stringify({ ...pleromaFixtures.status, id: 'status-after-close' }) }) });
		retainedError?.(new Event('error'));
		retainedClose?.(new Event('close'));
		expect(updates).toEqual(['status-open']);
		expect(errorCount).toBe(1);
		expect(closeCount).toBe(1);
	} finally {
		Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
	}
});

test('Pleroma client covers mutations, unauthenticated state, and API errors', async () => {
	const { fetchImpl, requests } = createJsonFetch((request) => {
		if (request.url.pathname === '/api/v1/statuses/bad/favourite') {
			return { status: 422, body: { error: 'status already favourited' } };
		}

		if (request.url.pathname.endsWith('/follow') || request.url.pathname.endsWith('/unfollow')) {
			return { body: pleromaFixtures.relationship };
		}

		if (request.url.pathname === '/api/v1/accounts/update_credentials') {
			return { body: { ...pleromaFixtures.account, display_name: 'quiet admin' } };
		}

		if (request.url.pathname === '/api/v1/statuses') {
			return { body: { ...pleromaFixtures.status, id: 'created-status' } };
		}

		return { body: pleromaFixtures.status };
	});

	const unauthenticated = createPleromaClient({ instanceUrl: 'https://pleroma.example', fetch: fetchImpl });
	await expect(unauthenticated.getHomeTimeline()).rejects.toMatchObject({ kind: 'unauthenticated' });
	await expect(unauthenticated.favoriteStatus('status-1')).rejects.toMatchObject({ kind: 'unauthenticated' });
	await expect(unauthenticated.createStatus({ status: 'no token' })).rejects.toMatchObject({ kind: 'unauthenticated' });

	const client = createPleromaClient({
		instanceUrl: 'https://pleroma.example',
		accessToken: 'access-token',
		fetch: fetchImpl
	});

	await client.favoriteStatus('status-1');
	await client.unfavoriteStatus('status-1');
	await client.boostStatus('status-1');
	await client.unboostStatus('status-1');
	await client.bookmarkStatus('status-1');
	await client.unbookmarkStatus('status-1');
	await client.deleteStatus('status-1');
	await client.muteAccount('account-1');
	await client.unmuteAccount('account-1');
	await client.blockAccount('account-1');
	await client.unblockAccount('account-1');
	await client.getFollowRequests();
	await client.authorizeFollowRequest('account-1');
	await client.rejectFollowRequest('account-1');
	await client.getPoll('poll-1');
	await client.votePoll('poll-1', [0, 2]);
	await client.updateMedia('media-1', { description: 'quiet alt text' });
	await client.getChats({ limit: 3 });
	await client.getOrCreateChat('account-1');
	await client.getChatMessages('chat-1', { maxId: 'msg-5' });
	await client.sendChatMessage('chat-1', { content: 'hello there', mediaId: 'media-9' });
	await client.markChatRead('chat-1', 'msg-9');
	await client.deleteChatMessage('chat-1', 'msg-9');
	const createdStatus = await client.createStatus({
		status: 'new post from client',
		visibility: 'unlisted',
		spoilerText: 'quiet spoiler',
		inReplyToId: 'status-1',
		poll: {
			options: ['warm cassette', 'cold terminal'],
			expiresIn: 3600,
			multiple: true,
			hideTotals: false
		}
	});
	await client.followAccount('account-1');
	await client.unfollowAccount('account-1');
	const account = await client.updateAccountProfile({ displayName: 'quiet admin', note: 'no ads' });

	expect(createdStatus.id).toBe('created-status');
	expect(account.display_name).toBe('quiet admin');
	expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
		'POST /api/v1/statuses/status-1/favourite',
		'POST /api/v1/statuses/status-1/unfavourite',
		'POST /api/v1/statuses/status-1/reblog',
		'POST /api/v1/statuses/status-1/unreblog',
		'POST /api/v1/statuses/status-1/bookmark',
		'POST /api/v1/statuses/status-1/unbookmark',
		'DELETE /api/v1/statuses/status-1',
		'POST /api/v1/accounts/account-1/mute',
		'POST /api/v1/accounts/account-1/unmute',
		'POST /api/v1/accounts/account-1/block',
		'POST /api/v1/accounts/account-1/unblock',
		'GET /api/v1/follow_requests',
		'POST /api/v1/follow_requests/account-1/authorize',
		'POST /api/v1/follow_requests/account-1/reject',
		'GET /api/v1/polls/poll-1',
		'POST /api/v1/polls/poll-1/votes',
		'PUT /api/v1/media/media-1',
		'GET /api/v2/pleroma/chats',
		'POST /api/v1/pleroma/chats/by-account-id/account-1',
		'GET /api/v1/pleroma/chats/chat-1/messages',
		'POST /api/v1/pleroma/chats/chat-1/messages',
		'POST /api/v1/pleroma/chats/chat-1/read',
		'DELETE /api/v1/pleroma/chats/chat-1/messages/msg-9',
		'POST /api/v1/statuses',
		'POST /api/v1/accounts/account-1/follow',
		'POST /api/v1/accounts/account-1/unfollow',
		'PATCH /api/v1/accounts/update_credentials'
	]);
	const voteBody = new URLSearchParams(requests[15].body);
	expect(voteBody.getAll('choices[]')).toEqual(['0', '2']);
	expect(requests[16].body).toContain('quiet alt text');
	expect(requests[17].url.searchParams.get('limit')).toBe('3');
	expect(requests[19].url.searchParams.get('max_id')).toBe('msg-5');
	expect(JSON.parse(requests[20].body ?? '{}')).toMatchObject({ content: 'hello there', media_id: 'media-9' });
	expect(JSON.parse(requests[21].body ?? '{}')).toMatchObject({ last_read_id: 'msg-9' });
	const createBody = new URLSearchParams(requests[23].body);
	expect(createBody.get('status')).toBe('new post from client');
	expect(createBody.get('visibility')).toBe('unlisted');
	expect(createBody.get('spoiler_text')).toBe('quiet spoiler');
	expect(createBody.get('in_reply_to_id')).toBe('status-1');
	expect(createBody.getAll('poll[options][]')).toEqual(['warm cassette', 'cold terminal']);
	expect(createBody.get('poll[expires_in]')).toBe('3600');
	expect(createBody.get('poll[multiple]')).toBe('true');
	expect(createBody.get('poll[hide_totals]')).toBe('false');
	expect(requests[26].body).toContain('display_name');
	expect(requests[26].body).toContain('quiet admin');

	await expect(client.favoriteStatus('bad')).rejects.toMatchObject({
		kind: 'http',
		status: 422,
		message: 'status already favourited'
	});
});

test('OAuth boundary registers apps, builds redirects, parses callbacks, and stores sessions', async () => {
	const { fetchImpl, requests } = createJsonFetch((request) => {
		if (request.url.pathname === '/api/v1/apps') return { body: pleromaFixtures.oauthApp };
		if (request.url.pathname === '/oauth/token') return { body: pleromaFixtures.token };

		return { status: 404, body: { error: 'missing fixture' } };
	});

	const redirectUri = 'http://localhost:4173/auth/callback';
	const scopes = ['read', 'write', 'follow'] as const;
	const app = await registerOAuthApp({
		instanceUrl: 'https://pleroma.example',
		clientName: 'DeltaNet',
		redirectUri,
		scopes,
		website: 'https://deltanet.example',
		fetch: fetchImpl
	});

	expect(app.clientId).toBe('client-id');
	expect(requests[0].method).toBe('POST');
	expectPath(requests[0], '/api/v1/apps');
	expect(requests[0].body).toContain('client_name=DeltaNet');
	expect(requests[0].body).toContain('scopes=read+write+follow');

	const authorizeUrl = buildAuthorizationUrl({
		instanceUrl: 'https://pleroma.example/',
		clientId: app.clientId,
		redirectUri,
		scopes,
		state: 'state-1'
	});
	const authorize = new URL(authorizeUrl);
	expect(authorize.origin).toBe('https://pleroma.example');
	expect(authorize.pathname).toBe('/oauth/authorize');
	expect(authorize.searchParams.get('response_type')).toBe('code');
	expect(authorize.searchParams.get('scope')).toBe('read write follow');

	expect(parseOAuthCallback(`${redirectUri}?code=oauth-code&state=state-1`)).toEqual({
		status: 'success',
		code: 'oauth-code',
		state: 'state-1'
	});
	expect(parseOAuthCallback(`${redirectUri}?error=access_denied&error_description=Denied&state=state-1`)).toEqual({
		status: 'error',
		error: 'access_denied',
		description: 'Denied',
		state: 'state-1'
	});

	const token = await exchangeOAuthCode({
		instanceUrl: 'https://pleroma.example',
		clientId: app.clientId,
		clientSecret: app.clientSecret,
		redirectUri,
		code: 'oauth-code',
		fetch: fetchImpl
	});
	expect(token.accessToken).toBe('access-token');
	expect(requests[1].body).toContain('grant_type=authorization_code');
	expect(requests[1].body).toContain('code=oauth-code');

	const storage = createMemoryPleromaStorage();
	storePendingOAuth(storage, {
		instanceUrl: 'https://pleroma.example',
		clientId: app.clientId,
		clientSecret: app.clientSecret,
		redirectUri,
		scopes,
		state: 'state-1',
		createdAt: Date.now()
	});
	expect(readPendingOAuth(storage)?.state).toBe('state-1');
	expect(readPleromaAuthState(storage)).toMatchObject({ status: 'authenticating' });

	storePleromaSession(storage, {
		instanceUrl: 'https://pleroma.example',
		accessToken: token.accessToken,
		tokenType: token.tokenType,
		scope: token.scope,
		createdAt: 1700000001000
	});
	expect(readPleromaAuthState(storage)).toMatchObject({ status: 'authenticated' });
	expect(storage.getItem('deltanet.session')).not.toContain('password');
	signOutPleroma(storage);
	expect(readPleromaAuthState(storage)).toEqual({ status: 'unauthenticated' });

	const pendingStorage = createMemoryPleromaStorage();
	const sessionStorage = createMemoryPleromaStorage();
	storePendingOAuth(pendingStorage, {
		instanceUrl: 'https://pleroma.example',
		clientId: app.clientId,
		clientSecret: app.clientSecret,
		redirectUri,
		scopes,
		state: 'state-2',
		createdAt: Date.now()
	});
	expect(readSplitPleromaAuthState({ sessionStorage, pendingStorage })).toMatchObject({ status: 'authenticating' });
	storePleromaSession(sessionStorage, {
		instanceUrl: 'https://pleroma.example',
		accessToken: token.accessToken,
		tokenType: token.tokenType,
		scope: token.scope,
		createdAt: 1700000001000
	});
	expect(readSplitPleromaAuthState({ sessionStorage, pendingStorage })).toMatchObject({ status: 'authenticated' });
});

test('auth helpers reject unsafe instances, expire stale pending OAuth, and generate strong state', () => {
	expect(normalizeInstanceUrl('pleroma.example/some/path')).toBe('https://pleroma.example');
	expect(normalizeInstanceUrl('https://user:pass@pleroma.example/some/path')).toBe('https://pleroma.example');
	expect(normalizeInstanceUrl('http://localhost:4000/callback')).toBe('http://localhost:4000');
	expect(normalizeInstanceUrl('http://[::1]:4000/callback')).toBe('http://[::1]:4000');
	expect(() => normalizeInstanceUrl('http://pleroma.example')).toThrow(/HTTPS/);

	const storage = createMemoryPleromaStorage();
	storePendingOAuth(storage, {
		instanceUrl: 'https://pleroma.example',
		clientId: 'client-id',
		clientSecret: 'client-secret',
		redirectUri: 'http://localhost:4173/auth/callback',
		scopes: ['read'],
		state: 'stale-state',
		createdAt: Date.now() - PENDING_OAUTH_TTL_MS - 1
	});
	expect(readPendingOAuth(storage)).toBeNull();
	expect(readPleromaAuthState(storage)).toEqual({ status: 'unauthenticated' });

	const state = createOAuthState();
	expect(state).toHaveLength(43);
	expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('resource helper exposes loading, success, and error states without Svelte coupling', async () => {
	let resolveTimeline: (value: typeof pleromaFixtures.timelines.home) => void = () => undefined;
	const timelinePromise = new Promise<typeof pleromaFixtures.timelines.home>((resolve) => {
		resolveTimeline = resolve;
	});
	const resource = createPleromaResource<typeof pleromaFixtures.timelines.home>();

	const loading = resource.load(() => timelinePromise);
	expect(resource.getState()).toEqual({ status: 'loading' });
	resolveTimeline(pleromaFixtures.timelines.home);
	await loading;
	expect(resource.getState()).toMatchObject({ status: 'success', data: pleromaFixtures.timelines.home });

	await resource.load(async () => {
		throw { kind: 'http', status: 500, message: 'server sad' };
	});
	expect(resource.getState()).toMatchObject({
		status: 'error',
		error: { kind: 'http', status: 500, message: 'server sad' }
	});
});

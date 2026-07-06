import { expect, test, type Page, type Route } from '@playwright/test';
import { NOTIFICATION_POLL_EVENT, notificationLastSeenStorageKey } from '../lib/pleroma/notifications';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import type { PleromaAccount, PleromaNotification, PleromaStatus } from '../lib/pleroma/types';
import { expectNoHorizontalOverflow, mockRightRailApis, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const authenticateWithSession = async (page: Page, storedSession: unknown) => {
	await mockRightRailApis(page);
	await page.addInitScript((storedSession) => {
		type MockSocket = {
			url: string;
			closeCalled: boolean;
			onopen: ((event: Event) => void) | null;
			onmessage: ((event: { data: string }) => void) | null;
			onerror: ((event: Event) => void) | null;
			onclose: ((event: Event) => void) | null;
			close: () => void;
		};
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		if (!testWindow.__deltanetSockets) {
			testWindow.__deltanetSockets = [];
			const MockWebSocket = function (url: string) {
				const socket: MockSocket = {
					url,
					closeCalled: false,
					onopen: null,
					onmessage: null,
					onerror: null,
					onclose: null,
					close() {
						this.closeCalled = true;
					}
				};
				testWindow.__deltanetSockets?.push(socket);
				return socket;
			} as unknown as new (url: string) => MockSocket;

			Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
		}

		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, storedSession);
};

const authenticate = async (page: Page) => {
	await authenticateWithSession(page, session);
};

const authenticateTokenOnly = async (page: Page) => {
	await authenticateWithSession(page, {
		instanceUrl: session.instanceUrl,
		accessToken: session.accessToken,
		tokenType: session.tokenType,
		scope: session.scope,
		createdAt: session.createdAt
	});
};

const accountWithName = (id: string, displayName: string, acct: string): PleromaAccount => ({
	...pleromaFixtures.account,
	id,
	username: acct.split('@')[0],
	acct,
	display_name: displayName,
	url: `https://pleroma.example/users/${id}`,
	avatar: `https://pleroma.example/${id}.png`,
	avatar_static: `https://pleroma.example/${id}.png`
});

const statusWithText = (id: string, text: string, account = pleromaFixtures.account): PleromaStatus => ({
	...pleromaFixtures.status,
	id,
	uri: `https://pleroma.example/objects/${id}`,
	url: `https://pleroma.example/notice/${id}`,
	account,
	content: `<p>${text}</p>`,
	created_at: '2026-05-18T12:00:00.000Z',
	pleroma: {
		...pleromaFixtures.status.pleroma,
		content: { 'text/plain': text },
		spoiler_text: { 'text/plain': '' }
	}
});

const notification = (id: string, type: string, account: PleromaAccount, createdAt: string, status?: PleromaStatus): PleromaNotification => ({
	id,
	type,
	created_at: createdAt,
	account,
	status: status ?? null,
	pleroma: {}
});

const mentionActor = accountWithName('account-mention', 'orbit', 'orbit@spacebear.net');
const followActor = accountWithName('account-follow', 'static.gif', 'staticgif@modem.zone');
const favActor = accountWithName('account-fav', 'kestrel', 'kestrel@audio.garden');
const boostActor = accountWithName('account-boost', 'lumen', 'lumen@candle.house');
const unknownActor = accountWithName('account-unknown', 'relay bot', 'relay@pleroma.example');
const mentionStatus = statusWithText('status-mention', 'hey @quietadmin, this carries through notifications.', mentionActor);
const favStatus = statusWithText('status-fav', 'a placeholder is more honest than a guess.');
const boostStatus = statusWithText('status-boost', 'living in a soft world. quietly federating.');
const reactionActor = accountWithName('account-reaction', 'ember', 'ember@drift.fm');
const initialNotifications = [
	notification('notif-mention', 'mention', mentionActor, '2026-05-18T12:02:00.000Z', mentionStatus),
	notification('notif-follow', 'follow', followActor, '2026-05-18T12:01:00.000Z'),
	notification('notif-fav', 'favourite', favActor, '2026-05-18T12:00:00.000Z', favStatus),
	notification('notif-boost', 'reblog', boostActor, '2026-05-18T11:59:00.000Z', boostStatus),
	{ ...notification('notif-reaction', 'pleroma:emoji_reaction', reactionActor, '2026-05-18T11:58:30.000Z', favStatus), emoji: '🔥' },
	notification('notif-unknown', 'pleroma:chat_mention', unknownActor, '2026-05-18T11:58:00.000Z', favStatus)
];

const fulfillJson = async (route: Route, body: unknown, status = 200) => {
	await route.fulfill({
		status,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});
};

const mockHomeTimeline = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => {
		await fulfillJson(route, pleromaFixtures.timelines.home);
	});
};

const mockThread = async (page: Page, status: PleromaStatus) => {
	await page.route(`https://pleroma.example/api/v1/statuses/${status.id}`, async (route) => {
		await fulfillJson(route, status);
	});
	await page.route(`https://pleroma.example/api/v1/statuses/${status.id}/context`, async (route) => {
		await fulfillJson(route, { ancestors: [], descendants: [] });
	});
};

const mockNotifications = async (page: Page, body: () => PleromaNotification[] | Promise<PleromaNotification[]>) => {
	let requests = 0;
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => {
		requests += 1;
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, await body());
	});
	return () => requests;
};

const mockOwnAccount = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/accounts/verify_credentials', async (route) => {
		await fulfillJson(route, pleromaFixtures.account);
	});
};

const openLatestStream = async (page: Page) => {
	await expect.poll(() => page.evaluate(() => {
		const testWindow = window as typeof window & { __deltanetSockets?: unknown[] };
		return testWindow.__deltanetSockets?.length ?? 0;
	})).toBeGreaterThan(0);
	await page.evaluate(() => {
		type MockSocket = { onopen: ((event: Event) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.at(-1);
		socket?.onopen?.(new Event('open'));
	});
};

const emitStreamNotification = async (page: Page, nextNotification: PleromaNotification) => {
	await page.evaluate((notification) => {
		type MockSocket = { onmessage: ((event: { data: string }) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.at(-1);
		socket?.onmessage?.({ data: JSON.stringify({ event: 'notification', payload: JSON.stringify(notification) }) });
	}, nextNotification);
};

const closeLatestStream = async (page: Page) => {
	await page.evaluate(() => {
		type MockSocket = { onclose: ((event: Event) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.at(-1);
		socket?.onclose?.(new Event('close'));
	});
};

const notificationBadge = (page: Page) => page.getByTestId('left-sidebar').getByRole('link', { name: /Notifications/ }).locator('.count');
const headerBell = (page: Page) => page.getByTestId('app-header').getByRole('button', { name: /Notifications/ });

test('real notifications route renders mocked API notifications and navigates by target', async ({ page }) => {
	await authenticate(page);
	await mockThread(page, mentionStatus);
	await mockThread(page, favStatus);
	await mockNotifications(page, () => initialNotifications);
	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');

	await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	await expect(page.getByTestId('notifications-list')).toContainText('orbit mentioned you');
	await expect(page.getByTestId('notifications-list')).toContainText('static.gif followed you');
	await expect(page.getByTestId('notifications-list')).toContainText('kestrel favorited your post');
	await expect(page.getByTestId('notifications-list')).toContainText('lumen boosted your post');
	await expect(page.getByTestId('notifications-list')).toContainText('ember reacted with 🔥 to your post');
	await expect(page.getByTestId('notifications-list')).toContainText('relay bot sent a notification');
	await expect(page.getByTestId('notifications-list').getByRole('button', { name: /relay bot sent a notification/ })).toHaveCount(0);
	await expect(notificationBadge(page)).toHaveText('6');

	await page.getByTestId('notifications-list').getByText('orbit mentioned you').click();
	await expect(page).toHaveURL('/app/thread/status-mention');
	await expect(page.getByTestId('focused-post')).toContainText('hey @quietadmin');

	await page.goto('/app/notifications');
	await page.getByTestId('notifications-list').getByText('kestrel favorited your post').click();
	await expect(page).toHaveURL('/app/thread/status-fav');

	await page.goto('/app/notifications');
	await page.getByTestId('notifications-list').getByText('static.gif followed you').click();
	await expect(page).toHaveURL('/app/profiles/staticgif%40modem.zone');

	await page.goto('/app/notifications');
	await page.getByTestId('notifications-list').getByText('ember reacted with').click();
	await expect(page).toHaveURL('/app/thread/status-fav');

	await page.goto('/app/notifications');
	await page.getByTestId('notifications-list').getByText('relay bot sent a notification').click();
	await expect(page).toHaveURL('/app/notifications');
	await expectNoHorizontalOverflow(page);
});

test('header bell opens real notifications popover with filters and read actions', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockNotifications(page, () => initialNotifications);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(headerBell(page).locator('.badge')).toHaveText('6');
	await headerBell(page).click();
	const popover = page.getByTestId('header-notifications-popover');
	await expect(popover).toBeVisible();
	await expect(popover).toContainText('orbit mentioned you');
	await expect(popover).toContainText('static.gif followed you');
	await expect(popover.locator('.notif-pop-count')).toHaveText('6 new');

	await popover.getByRole('button', { name: 'Favorites' }).click();
	await expect(popover).toContainText('kestrel favorited your post');
	await expect(popover).toContainText('ember reacted with');
	await expect(popover).not.toContainText('orbit mentioned you');

	await popover.getByRole('button', { name: 'Mark all read' }).click();
	await expect(headerBell(page).locator('.badge')).toHaveCount(0);
	await expect(popover.locator('.notif-pop-count')).toHaveCount(0);
	await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), notificationLastSeenStorageKey(session))).toBe('2026-05-18T12:02:00.000Z');

	await popover.getByRole('button', { name: /See all notifications/ }).click();
	await expect(page).toHaveURL('/app/notifications');
	await expect(popover).toHaveCount(0);
});

test('header notification rows navigate by target and close the popover', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockThread(page, mentionStatus);
	await mockNotifications(page, () => initialNotifications);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await headerBell(page).click();
	const popover = page.getByTestId('header-notifications-popover');
	await expect(popover).toContainText('orbit mentioned you');
	await popover.getByText('orbit mentioned you').click();

	await expect(page).toHaveURL('/app/thread/status-mention');
	await expect(popover).toHaveCount(0);
});

test('notification badge updates on polling and mark-read state persists locally', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	let response = initialNotifications.slice(0, 1);
	const requests = await mockNotifications(page, () => response);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(notificationBadge(page)).toHaveText('1');
	response = [notification('notif-new', 'mention', mentionActor, '2026-05-18T12:03:00.000Z', mentionStatus), ...response];
	await page.evaluate((eventName) => window.dispatchEvent(new Event(eventName)), NOTIFICATION_POLL_EVENT);
	await expect(notificationBadge(page)).toHaveText('2');
	expect(requests()).toBe(2);

	await page.getByTestId('left-sidebar').getByRole('link', { name: /Notifications/ }).click();
	await page.getByRole('button', { name: 'Mark all read' }).click();
	await expect(notificationBadge(page)).toHaveCount(0);
	await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), notificationLastSeenStorageKey(session))).toBe('2026-05-18T12:03:00.000Z');

	await page.reload();
	await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	await expect(notificationBadge(page)).toHaveCount(0);
});

test('websocket notification updates the badge and popover without polling', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	const requests = await mockNotifications(page, () => initialNotifications.slice(0, 1));
	const streamActor = accountWithName('account-stream', 'nova', 'nova@moon.example');
	const streamStatus = statusWithText('status-stream', 'a websocket notification arrived.', streamActor);
	const streamNotification = notification('notif-stream', 'mention', streamActor, '2026-05-18T12:04:00.000Z', streamStatus);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(notificationBadge(page)).toHaveText('1');

	await openLatestStream(page);
	await emitStreamNotification(page, streamNotification);
	await expect(notificationBadge(page)).toHaveText('2');
	await page.evaluate((eventName) => window.dispatchEvent(new Event(eventName)), NOTIFICATION_POLL_EVENT);
	await page.waitForTimeout(50);
	expect(requests()).toBe(1);

	await headerBell(page).click();
	await expect(page.getByTestId('header-notifications-popover')).toContainText('nova mentioned you');
});

test('notification polling fallback refreshes after the websocket closes', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	let response = initialNotifications.slice(0, 1);
	const requests = await mockNotifications(page, () => response);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(notificationBadge(page)).toHaveText('1');
	await openLatestStream(page);

	response = [
		notification('notif-fallback', 'follow', followActor, '2026-05-18T12:05:00.000Z'),
		...response
	];
	await closeLatestStream(page);

	await expect(notificationBadge(page)).toHaveText('2');
	expect(requests()).toBe(2);
});

test('notification read state waits for account hydration before choosing a storage key', async ({ page }) => {
	await authenticateTokenOnly(page);
	await mockOwnAccount(page);
	await mockNotifications(page, () => initialNotifications.slice(0, 1));
	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');

	await expect(page.getByTestId('notifications-list')).toContainText('orbit mentioned you');
	await page.getByRole('button', { name: 'Mark all read' }).click();
	await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), notificationLastSeenStorageKey(session))).toBe('2026-05-18T12:02:00.000Z');
	expect(await page.evaluate((key) => window.localStorage.getItem(key), `deltanet.notifications.lastSeenAt.${session.instanceUrl}.self`)).toBeNull();
});

test('token-only notification route surfaces account hydration failures', async ({ page }) => {
	await authenticateTokenOnly(page);
	await page.route('https://pleroma.example/api/v1/accounts/verify_credentials', async (route) => {
		await fulfillJson(route, { error: 'verify failed' }, 500);
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');

	await expect(page.getByRole('heading', { name: 'Pleroma server error' })).toBeVisible();
	await expect(page.getByText('verify failed')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Retry notifications' })).toBeVisible();
	await expect(page.getByTestId('notifications-list')).toHaveCount(0);
});

test('mark all read is not undone by an in-flight notification poll', async ({ page }) => {
	await authenticate(page);
	let requests = 0;
	let resolvePendingPoll: () => void = () => undefined;
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => {
		requests += 1;
		if (requests > 1) {
			await new Promise<void>((resolve) => {
				resolvePendingPoll = resolve;
			});
		}
		await fulfillJson(route, initialNotifications.slice(0, 1));
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');
	await expect(notificationBadge(page)).toHaveText('1');

	await page.evaluate((eventName) => window.dispatchEvent(new Event(eventName)), NOTIFICATION_POLL_EVENT);
	await expect.poll(() => requests).toBe(2);
	await page.evaluate((eventName) => window.dispatchEvent(new Event(eventName)), NOTIFICATION_POLL_EVENT);
	await page.waitForTimeout(50);
	expect(requests).toBe(2);
	await page.getByRole('button', { name: 'Mark all read' }).click();
	await expect(notificationBadge(page)).toHaveCount(0);
	resolvePendingPoll();
	await page.waitForTimeout(50);
	await expect(notificationBadge(page)).toHaveCount(0);
});

test('foreground notification route load supersedes a hung background poll', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	let requests = 0;
	let resolveHungRequest: () => void = () => undefined;
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => {
		requests += 1;
		if (requests === 1) {
			await new Promise<void>((resolve) => {
				resolveHungRequest = resolve;
			});
		}
		await fulfillJson(route, initialNotifications.slice(0, 1));
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect.poll(() => requests).toBe(1);

	await page.goto('/app/notifications');
	await expect.poll(() => requests).toBe(2);
	await expect(page.getByTestId('notifications-list')).toContainText('orbit mentioned you');
	resolveHungRequest();
});

test('notification polling pauses after the session is removed', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	const requests = await mockNotifications(page, () => initialNotifications.slice(0, 1));
	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(notificationBadge(page)).toHaveText('1');
	const beforeSignOutPoll = requests();

	await page.evaluate(() => window.localStorage.removeItem('deltanet.session'));
	await page.evaluate((eventName) => window.dispatchEvent(new Event(eventName)), NOTIFICATION_POLL_EVENT);
	await page.waitForTimeout(50);

	expect(requests()).toBe(beforeSignOutPoll);
	await expect(notificationBadge(page)).toHaveCount(0);
});

test('notification rows render name custom emoji and media-only excerpts', async ({ page }) => {
	await authenticate(page);
	const emojiActor: PleromaAccount = {
		...accountWithName('account-tux', 'James Randson :tux:', 'james@linux.example'),
		emojis: [{ shortcode: 'tux', url: 'https://cdn.example/emoji/tux.png', static_url: 'https://cdn.example/emoji/tux.png' }]
	};
	const imageOnlyStatus: PleromaStatus = {
		...statusWithText('status-image-only', ''),
		content: '',
		media_attachments: [
			{ id: 'media-1', type: 'image', url: 'https://cdn.example/only.png', preview_url: 'https://cdn.example/only-thumb.png', description: null },
			{ id: 'media-2', type: 'image', url: 'https://cdn.example/only-2.png', preview_url: 'https://cdn.example/only-2-thumb.png', description: null }
		]
	};
	const videoOnlyStatus: PleromaStatus = {
		...statusWithText('status-video-only', ''),
		content: '',
		media_attachments: [{ id: 'media-3', type: 'video', url: 'https://cdn.example/clip.mp4', description: null }]
	};
	await mockNotifications(page, () => [
		notification('notif-emoji-fav', 'favourite', emojiActor, '2026-05-18T12:03:00.000Z', imageOnlyStatus),
		notification('notif-video-boost', 'reblog', boostActor, '2026-05-18T12:02:00.000Z', videoOnlyStatus)
	]);
	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');

	const list = page.getByTestId('notifications-list');
	await expect(list).toContainText('James Randson');
	await expect(list.locator('.notif-names img[alt=":tux:"]').first()).toBeVisible();
	await expect(list.locator('.notif-names').first()).not.toContainText(':tux:');

	const favRow = list.locator('.notif-row').filter({ hasText: 'favorited your post' });
	await expect(favRow.locator('.notif-row-quote')).toContainText('[2 images]');
	const boostRow = list.locator('.notif-row').filter({ hasText: 'boosted your post' });
	await expect(boostRow.locator('.notif-row-quote')).toContainText('[video]');
});

test('reaction notifications render custom emoji images with alt text', async ({ page }) => {
	await authenticate(page);
	const customReaction = {
		...notification('notif-custom-reaction', 'pleroma:emoji_reaction', accountWithName('account-blob', 'blobfan', 'blobfan@blob.cat'), '2026-05-18T12:04:00.000Z', favStatus),
		emoji: ':blobcat:',
		emoji_url: 'https://cdn.example/emoji/blobcat.png'
	};
	await mockNotifications(page, () => [customReaction]);
	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');

	const list = page.getByTestId('notifications-list');
	await expect(list).toContainText('blobfan reacted with');
	await expect(list.locator('img.notif-reaction-emoji[alt=":blobcat:"]')).toBeVisible();
	await expect(list).toContainText('a placeholder is more honest than a guess.');
});

test('follow request notifications accept and decline through the API', async ({ page }) => {
	await authenticate(page);
	const requester = accountWithName('account-requester', 'quiet.stranger', 'stranger@locked.zone');
	const decliner = accountWithName('account-decliner', 'noisy.stranger', 'noisy@locked.zone');
	await mockNotifications(page, () => [
		notification('notif-req-accept', 'follow_request', requester, '2026-05-18T12:05:00.000Z'),
		notification('notif-req-decline', 'follow_request', decliner, '2026-05-18T12:04:00.000Z')
	]);
	let authorizeMethod = '';
	let rejectMethod = '';
	await page.route('https://pleroma.example/api/v1/follow_requests/account-requester/authorize', async (route) => {
		authorizeMethod = route.request().method();
		await fulfillJson(route, { ...pleromaFixtures.relationship, id: 'account-requester', followed_by: true });
	});
	await page.route('https://pleroma.example/api/v1/follow_requests/account-decliner/reject', async (route) => {
		rejectMethod = route.request().method();
		await fulfillJson(route, { ...pleromaFixtures.relationship, id: 'account-decliner', followed_by: false });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');

	const list = page.getByTestId('notifications-list');
	await expect(list).toContainText('quiet.stranger requested to follow you');

	const acceptRow = list.locator('.notif-row').filter({ hasText: 'quiet.stranger requested to follow you' });
	await acceptRow.getByRole('button', { name: 'Accept' }).click();
	await expect(acceptRow.getByText('Accepted')).toBeVisible();
	await expect(acceptRow.getByRole('button', { name: 'Accept' })).toHaveCount(0);
	expect(authorizeMethod).toBe('POST');

	const declineRow = list.locator('.notif-row').filter({ hasText: 'noisy.stranger requested to follow you' });
	await declineRow.getByRole('button', { name: 'Decline' }).click();
	await expect(declineRow.getByText('Declined')).toBeVisible();
	expect(rejectMethod).toBe('POST');
});

test('follow request accept surfaces failures and keeps the buttons', async ({ page }) => {
	await authenticate(page);
	const requester = accountWithName('account-req-fail', 'flaky.peer', 'flaky@locked.zone');
	await mockNotifications(page, () => [notification('notif-req-fail', 'follow_request', requester, '2026-05-18T12:06:00.000Z')]);
	await page.route('https://pleroma.example/api/v1/follow_requests/account-req-fail/authorize', async (route) => {
		await fulfillJson(route, { error: 'could not authorize' }, 500);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/notifications');

	const row = page.getByTestId('notifications-list').locator('.notif-row').filter({ hasText: 'flaky.peer requested to follow you' });
	await row.getByRole('button', { name: 'Accept' }).click();
	await expect(page.getByTestId('post-control-toast')).toContainText('Accept failed');
	await expect(row.getByRole('button', { name: 'Accept' })).toBeEnabled();
});

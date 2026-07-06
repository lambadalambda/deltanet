import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { expectNoHorizontalOverflow, mockRightRailApis, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};
const timelineUrl = 'https://pleroma.example/api/v1/timelines/public';
const customEmojisUrl = 'https://pleroma.example/api/v1/custom_emojis';
const notificationsUrl = 'https://pleroma.example/api/v1/notifications**';

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	await page.route(customEmojisUrl, async (route) => {
		await fulfillTimeline(route, pleromaFixtures.customEmojis);
	});
	await page.route(notificationsUrl, async (route) => {
		await fulfillTimeline(route, pleromaFixtures.notifications);
	});
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
	}, session);
};

const fulfillTimeline = async (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) => {
	await route.fulfill({
		status,
		contentType: 'application/json',
		headers: headers.link ? { 'access-control-expose-headers': 'link', ...headers } : headers,
		body: JSON.stringify(body)
	});
};

const statusWithText = (id: string, text: string) => ({
	...pleromaFixtures.status,
	id,
	uri: `https://pleroma.example/objects/${id}`,
	url: `https://pleroma.example/notice/${id}`,
	content: `<p>${text}</p>`,
	pleroma: {
		...pleromaFixtures.status.pleroma,
		content: { 'text/plain': text }
	}
});

const mockAppPublicTimeline = async (page: Page, handler: (route: Route, url: URL) => Promise<void>) => {
	await page.route(`${timelineUrl}**`, async (route) => {
		await handler(route, new URL(route.request().url()));
	});
};

const streamSocketUrls = async (page: Page) => page.evaluate(() => {
	const testWindow = window as typeof window & { __deltanetSockets?: Array<{ url: string }> };
	return testWindow.__deltanetSockets?.map((socket) => socket.url) ?? [];
});

const streamSockets = async (page: Page, stream: 'public' | 'public:local') => page.evaluate((streamName) => {
	type MockSocket = { url: string; closeCalled: boolean };
	const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
	return (testWindow.__deltanetSockets ?? [])
		.filter((socket) => new URL(socket.url).searchParams.get('stream') === streamName)
		.map((socket) => ({ url: socket.url, closeCalled: socket.closeCalled }));
}, stream);

const emitStreamUpdate = async (page: Page, stream: 'public' | 'public:local', status: unknown) => {
	await page.evaluate(({ streamName, nextStatus }) => {
		type MockSocket = { url: string; onmessage: ((event: { data: string }) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.find((candidate) => new URL(candidate.url).searchParams.get('stream') === streamName);
		socket?.onmessage?.({ data: JSON.stringify({ event: 'update', payload: JSON.stringify(nextStatus) }) });
	}, { streamName: stream, nextStatus: status });
};

const emitStreamError = async (page: Page, stream: 'public' | 'public:local') => {
	await page.evaluate((streamName) => {
		type MockSocket = { url: string; onerror: ((event: Event) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.find((candidate) => new URL(candidate.url).searchParams.get('stream') === streamName);
		socket?.onerror?.(new Event('error'));
	}, stream);
};

test('authenticated local and federated app timelines load public data through the API client', async ({ page }) => {
	await authenticate(page);
	const requests: Array<{ local: string | null; authorization: string | null }> = [];
	await mockAppPublicTimeline(page, async (route, url) => {
		requests.push({ local: url.searchParams.get('local'), authorization: route.request().headers().authorization ?? null });
		await fulfillTimeline(
			route,
			url.searchParams.get('local') === 'true'
				? [statusWithText('status-local-app', 'local app timeline post from the instance')]
				: [statusWithText('status-federated-app', 'federated app timeline post from the network')]
		);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	await expect(page.getByTestId('app-content').getByRole('heading', { name: 'Local timeline' })).toHaveCount(0);
	await expect(page.getByTestId('app-content')).not.toContainText('Posts from this Pleroma instance');
	await expect(page.getByRole('tab', { name: 'Local' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('app-public-timeline-list')).toContainText('local app timeline post from the instance');
	expect(requests[0]).toEqual({ local: 'true', authorization: 'Bearer access-token' });

	await page.getByRole('tab', { name: 'Federated' }).click();
	await expect(page).toHaveURL('/app/federated');
	await expect(page.getByTestId('app-content').getByRole('heading', { name: 'Federated timeline' })).toHaveCount(0);
	await expect(page.getByTestId('app-content')).not.toContainText('Public posts from across the federation');
	await expect(page.getByRole('tab', { name: 'Federated' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('app-public-timeline-list')).toContainText('federated app timeline post from the network');
	expect(requests[1]).toEqual({ local: null, authorization: 'Bearer access-token' });
	await expectNoHorizontalOverflow(page);
});

test('app public timelines use the home feed surface and stream newer posts', async ({ page }) => {
	await authenticate(page);
	await mockAppPublicTimeline(page, async (route, url) => {
		await fulfillTimeline(
			route,
			url.searchParams.get('local') === 'true'
				? [statusWithText('status-local-start', 'local app first streamed baseline')]
				: [statusWithText('status-federated-start', 'federated app first streamed baseline')]
		);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const list = page.getByTestId('app-public-timeline-list');
	await expect(page.getByRole('tablist', { name: 'Timeline sections' })).toBeVisible();
	await expect(page.getByTestId('app-content').getByRole('heading', { name: /timeline/i })).toHaveCount(0);
	await expect(list).toContainText('local app first streamed baseline');
	await expect.poll(() => streamSocketUrls(page)).toContain('wss://pleroma.example/api/v1/streaming/?stream=public%3Alocal&access_token=access-token');

	await emitStreamUpdate(page, 'public:local', statusWithText('status-local-stream', 'fresh local stream post'));
	const localIndicator = page.getByTestId('timeline-header-actions').getByRole('button', { name: '1 new posts' });
	await expect(localIndicator).toBeVisible();
	await expect(page.getByRole('tablist', { name: 'Timeline sections' }).getByRole('button', { name: '1 new posts' })).toHaveCount(0);
	await expect(list).not.toContainText('fresh local stream post');
	await localIndicator.click();
	await expect(list).toContainText('fresh local stream post');

	await page.getByRole('tab', { name: 'Federated' }).click();
	await expect(page).toHaveURL('/app/federated');
	await expect(page.getByTestId('app-content').getByRole('heading', { name: /timeline/i })).toHaveCount(0);
	await expect(page.getByTestId('app-public-timeline-list')).toContainText('federated app first streamed baseline');
	await expect.poll(() => streamSocketUrls(page)).toContain('wss://pleroma.example/api/v1/streaming/?stream=public&access_token=access-token');

	await emitStreamUpdate(page, 'public', statusWithText('status-federated-stream', 'fresh federated stream post'));
	const federatedIndicator = page.getByTestId('timeline-header-actions').getByRole('button', { name: '1 new posts' });
	await expect(federatedIndicator).toBeVisible();
	await federatedIndicator.click();
	await expect(page.getByTestId('app-public-timeline-list')).toContainText('fresh federated stream post');
});

test('app public timeline reconnects streams after failures', async ({ page }) => {
	await page.clock.install();
	await authenticate(page);
	await mockAppPublicTimeline(page, async (route) => {
		await fulfillTimeline(route, [statusWithText('status-local-reconnect', 'local reconnect baseline')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	await expect(page.getByTestId('app-public-timeline-list')).toContainText('local reconnect baseline');
	await expect.poll(async () => (await streamSockets(page, 'public:local')).length).toBe(1);
	await emitStreamError(page, 'public:local');
	await expect.poll(async () => (await streamSockets(page, 'public:local'))[0]?.closeCalled).toBe(true);

	await page.clock.fastForward(60_000);
	await expect.poll(async () => (await streamSockets(page, 'public:local')).length).toBe(2);
});

test('app public timeline new-post header action fits mobile', async ({ page }) => {
	await authenticate(page);
	await mockAppPublicTimeline(page, async (route, url) => {
		await fulfillTimeline(
			route,
			url.searchParams.get('local') === 'true'
				? [statusWithText('status-local-mobile', 'local mobile baseline')]
				: [statusWithText('status-federated-mobile', 'federated mobile baseline')]
		);
	});

	await setViewport(page, 'mobile');
	await page.goto('/app/local');

	await expect(page.getByTestId('app-public-timeline-list')).toContainText('local mobile baseline');
	await emitStreamUpdate(page, 'public:local', statusWithText('status-local-mobile-stream', 'fresh local mobile stream post'));
	await expect(page.getByTestId('timeline-header-actions').getByRole('button', { name: '1 new posts' })).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await page.goto('/app/federated');
	await expect(page.getByRole('tab', { name: 'Federated' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('app-public-timeline-list')).toContainText('federated mobile baseline');
	await emitStreamUpdate(page, 'public', statusWithText('status-federated-mobile-stream', 'fresh federated mobile stream post'));
	await expect(page.getByTestId('timeline-header-actions').getByRole('button', { name: '1 new posts' })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Federated' })).toBeInViewport();
	await expectNoHorizontalOverflow(page);
});

test('app public timelines load older pages and deduplicate overlapping statuses', async ({ page }) => {
	await authenticate(page);
	const requestedMaxIds: Array<string | null> = [];
	const requestedLocalParams: Array<string | null> = [];
	await mockAppPublicTimeline(page, async (route, url) => {
		const maxId = url.searchParams.get('max_id');
		requestedMaxIds.push(maxId);
		requestedLocalParams.push(url.searchParams.get('local'));

		if (maxId === 'status-local-app-1') {
			await fulfillTimeline(route, [
				statusWithText('status-local-app-1', 'local app first page post'),
				statusWithText('status-local-app-2', 'older local app pagination post')
			]);
			return;
		}

		await fulfillTimeline(route, [statusWithText('status-local-app-1', 'local app first page post')], 200, {
			link: `<${timelineUrl}?local=true&max_id=status-local-app-1>; rel="next"`
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const list = page.getByTestId('app-public-timeline-list');
	await expect(list).toContainText('local app first page post');
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(list).toContainText('older local app pagination post');
	await expect(page.locator('[data-status-id="status-local-app-1"]')).toHaveCount(1);
	await expect(page.locator('[data-status-id="status-local-app-2"]')).toHaveCount(1);
	expect(requestedMaxIds).toEqual([null, 'status-local-app-1']);
	expect(requestedLocalParams).toEqual(['true', 'true']);
});

test('app public timeline action failures rollback while pagination is loading', async ({ page }) => {
	await authenticate(page);
	const actionStatus = { ...statusWithText('status-local-action', 'rollback local timeline favorite'), favourites_count: 9 };
	let resolveFavorite: () => void = () => undefined;
	let releaseNextPage: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});
	const nextPagePending = new Promise<void>((resolve) => {
		releaseNextPage = resolve;
	});

	await mockAppPublicTimeline(page, async (route, url) => {
		if (url.searchParams.get('max_id') === 'status-local-action') {
			await nextPagePending;
			await fulfillTimeline(route, [statusWithText('status-local-older-action', 'older local post after action failure')]);
			return;
		}

		await fulfillTimeline(route, [actionStatus], 200, {
			link: `<${timelineUrl}?local=true&max_id=status-local-action>; rel="next"`
		});
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-local-action/favourite', async (route) => {
		await favoritePending;
		await fulfillTimeline(route, { error: 'favorite failed during pagination' }, 503);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const list = page.getByTestId('app-public-timeline-list');
	const post = page.locator('[data-status-id="status-local-action"]');
	await expect(list).toContainText('rollback local timeline favorite');
	await post.getByRole('button', { name: 'Favorite 9' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByRole('status', { name: 'Timeline pagination status' })).toContainText('Loading older posts');

	resolveFavorite();
	await expect(post.getByRole('button', { name: 'Favorite 9' })).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByRole('alert')).toContainText('favorite failed during pagination');
	releaseNextPage();
	await expect(list).toContainText('older local post after action failure');
});

test('app public timelines render empty state from mocked API response', async ({ page }) => {
	await authenticate(page);
	await mockAppPublicTimeline(page, async (route) => {
		await fulfillTimeline(route, []);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/federated');

	await expect(page.getByText('No federated posts yet')).toBeVisible();
	await expect(page.getByText('This Pleroma timeline returned no statuses for this slice.')).toBeVisible();
});

test('app public timelines render retryable API errors and retry with a token', async ({ page }) => {
	await authenticate(page);
	let attempts = 0;
	await mockAppPublicTimeline(page, async (route) => {
		attempts += 1;
		expect(route.request().headers().authorization).toBe('Bearer access-token');

		if (attempts === 1) {
			await fulfillTimeline(route, { error: 'maintenance' }, 503);
			return;
		}

		await fulfillTimeline(route, [statusWithText('status-local-retry', 'local app timeline recovers after retry')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	await expect(page.getByText('Pleroma server error')).toBeVisible();
	await page.getByRole('button', { name: 'Retry request' }).click();
	await expect(page.getByTestId('app-public-timeline-list')).toContainText('local app timeline recovers after retry');
	expect(attempts).toBe(2);
});

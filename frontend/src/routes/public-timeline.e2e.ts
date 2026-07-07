import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { normalizeInstanceUrl } from '../lib/pleroma/http';
import { expectNoHorizontalOverflow, setViewport, viewports } from '../test/playwright';

const publicInstanceUrl = normalizeInstanceUrl(process.env.PUBLIC_PLEROMA_INSTANCE_URL ?? 'https://pleroma.social');
const timelineUrl = `${publicInstanceUrl}/api/v1/timelines/public`;

const fulfillJson = async (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) => {
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

const mockPublicTimeline = async (page: Page, handler: (route: Route, url: URL) => Promise<void>) => {
	await page.route(`${timelineUrl}**`, async (route) => {
		await handler(route, new URL(route.request().url()));
	});
};

test('anonymous public route loads the public timeline through the API client', async ({ page }) => {
	const requests: Array<{ authorization: string | null }> = [];
	await mockPublicTimeline(page, async (route) => {
		requests.push({ authorization: route.request().headers().authorization ?? null });
		await fulfillJson(route, pleromaFixtures.timelines.public);
	});

	await setViewport(page, 'desktop');
	await page.goto('/public');

	await expect(page.getByRole('heading', { name: 'Public timeline' })).toBeVisible();
	await expect(page.getByTestId('public-timeline-list')).toContainText('@datagram@retro.social');
	await expect(requests[0]).toEqual({ authorization: null });
	await expectNoHorizontalOverflow(page);
});

test('public timeline loads a next cursor page and deduplicates overlapping statuses', async ({ page }) => {
	const requestedMaxIds: Array<string | null> = [];
	await mockPublicTimeline(page, async (route, url) => {
		const maxId = url.searchParams.get('max_id');
		requestedMaxIds.push(maxId);

		if (maxId === 'status-1') {
			await fulfillJson(route, [pleromaFixtures.status, statusWithText('status-public-2', 'older public pagination post')]);
			return;
		}

		await fulfillJson(route, [pleromaFixtures.status], 200, {
			link: `<${timelineUrl}?max_id=status-1>; rel="next"`
		});
	});

	await page.goto('/public');

	const list = page.getByTestId('public-timeline-list');
	await expect(list).toContainText('quiet CSS can still carry the voice.');
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(list).toContainText('older public pagination post');
	await expect(page.locator('[data-status-id="status-1"]')).toHaveCount(1);
	await expect(page.locator('[data-status-id="status-public-2"]')).toHaveCount(1);
	await expect(page.locator('[data-action-status-id="status-public-2"]')).toHaveCount(1);
	expect(requestedMaxIds).toEqual([null, 'status-1']);
});

test('public timeline retries load-more errors with the same cursor', async ({ page }) => {
	let nextAttempts = 0;
	const requestedMaxIds: Array<string | null> = [];
	await mockPublicTimeline(page, async (route, url) => {
		const maxId = url.searchParams.get('max_id');
		requestedMaxIds.push(maxId);

		if (maxId !== 'status-1') {
			await fulfillJson(route, [pleromaFixtures.status], 200, {
				link: `<${timelineUrl}?max_id=status-1>; rel="next"`
			});
			return;
		}

		nextAttempts += 1;
		if (nextAttempts === 1) {
			await fulfillJson(route, { error: 'maintenance' }, 503);
			return;
		}

		await fulfillJson(route, [statusWithText('status-public-retry', 'older public post after retry')]);
	});

	await page.goto('/public');

	const list = page.getByTestId('public-timeline-list');
	await expect(list).toContainText('quiet CSS can still carry the voice.');
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByText('Pleroma server error')).toBeVisible();
	await expect(list).toContainText('quiet CSS can still carry the voice.');
	await page.getByRole('button', { name: 'Retry load more' }).click();
	await expect(list).toContainText('older public post after retry');
	expect(nextAttempts).toBe(2);
	expect(requestedMaxIds).toEqual([null, 'status-1', 'status-1']);
});

test('public timeline renders empty state from mocked API response', async ({ page }) => {
	await mockPublicTimeline(page, async (route) => {
		await fulfillJson(route, []);
	});

	await page.goto('/public');

	await expect(page.getByText('No public posts yet')).toBeVisible();
	await expect(page.getByText('This Pleroma timeline returned no statuses for this slice.')).toBeVisible();
});

test('public timeline renders loading state while a request is pending', async ({ page }) => {
	let releaseRequest: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await mockPublicTimeline(page, async (route) => {
		await pending;
		await fulfillJson(route, [pleromaFixtures.status]);
	});

	await page.goto('/public');
	await expect(page.getByRole('status', { name: 'Request status' })).toContainText('Loading Pleroma data');
	releaseRequest();
	await expect(page.getByTestId('public-timeline-list')).toContainText('quiet CSS can still carry the voice.');
});

test('public timeline ignores stale responses from a superseded request', async ({ page }) => {
	// Regression coverage for the request-id guard: a slow first response must not
	// clobber state after a later request has already resolved.
	let releaseFirst: () => void = () => undefined;
	const firstPending = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let requestCount = 0;
	await mockPublicTimeline(page, async (route) => {
		requestCount += 1;
		if (requestCount === 1) {
			await firstPending;
			await fulfillJson(route, [pleromaFixtures.status]);
			return;
		}

		await fulfillJson(route, pleromaFixtures.timelines.public);
	});

	await page.goto('/public');
	await page.reload();
	await expect(page.getByTestId('public-timeline-list')).toContainText('@datagram@retro.social');
	releaseFirst();
	await expect(page.getByTestId('public-timeline-list')).toContainText('@datagram@retro.social');
});

test('public timeline stays anonymous even when OAuth storage contains a session', async ({ page }) => {
	let authorization: string | undefined;
	await page.addInitScript(() => {
		window.localStorage.setItem(
			'deltanet.session',
			JSON.stringify({ instanceUrl: 'https://pleroma.example', accessToken: 'access-token', tokenType: 'Bearer', scope: 'read', createdAt: Date.now() })
		);
	});
	await mockPublicTimeline(page, async (route) => {
		authorization = route.request().headers().authorization;
		await fulfillJson(route, [pleromaFixtures.status]);
	});

	await page.goto('/public');

	await expect(page.getByTestId('public-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	expect(authorization).toBeUndefined();
});

test('public timeline renders retryable API errors and retries without a token', async ({ page }) => {
	let attempts = 0;
	await mockPublicTimeline(page, async (route) => {
		attempts += 1;
		expect(route.request().headers().authorization).toBeUndefined();

		if (attempts === 1) {
			await fulfillJson(route, { error: 'maintenance' }, 503);
			return;
		}

		await fulfillJson(route, [pleromaFixtures.status]);
	});

	await page.goto('/public');

	await expect(page.getByText('Pleroma server error')).toBeVisible();
	await page.getByRole('button', { name: 'Retry request' }).click();
	await expect(page.getByTestId('public-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	expect(attempts).toBe(2);
});

test('public timeline is available without OAuth storage and stays responsive', async ({ page }) => {
	await mockPublicTimeline(page, async (route) => {
		await fulfillJson(route, [pleromaFixtures.status]);
	});

	for (const viewport of [viewports.desktop, viewports.tablet, viewports.mobile]) {
		await page.setViewportSize(viewport);
		await page.goto('/public');

		await expect(page).toHaveURL('/public');
		await expect(page.getByRole('heading', { name: 'Public timeline' })).toBeVisible();
		await expect(page.getByTestId('public-timeline-list')).toBeVisible();
		await expectNoHorizontalOverflow(page);
	}
});

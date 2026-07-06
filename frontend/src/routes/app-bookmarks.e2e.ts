import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import type { PleromaStatus } from '../lib/pleroma/types';
import { fulfillJson, mockRightRailApis, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => fulfillJson(route, []));
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const bookmarkStatus = (id: string, text: string): PleromaStatus => ({
	...pleromaFixtures.status,
	id,
	uri: `https://pleroma.example/objects/${id}`,
	url: `https://pleroma.example/notice/${id}`,
	content: `<p>${text}</p>`,
	bookmarked: true,
	pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': text } }
});

test('bookmarks route lists saved posts from the API', async ({ page }) => {
	await authenticate(page);
	let authorization: string | undefined;
	await page.route('https://pleroma.example/api/v1/bookmarks**', async (route: Route) => {
		authorization = route.request().headers().authorization;
		await fulfillJson(route, [bookmarkStatus('bm-1', 'saved for later'), bookmarkStatus('bm-2', 'another keeper')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/bookmarks');

	await expect(page.getByRole('heading', { name: 'Bookmarks' })).toBeVisible();
	const list = page.getByTestId('bookmarks-list');
	await expect(list).toContainText('saved for later');
	await expect(list).toContainText('another keeper');
	expect(authorization).toBe('Bearer access-token');
});

test('bookmarks route shows an empty state', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/bookmarks**', async (route: Route) => fulfillJson(route, []));

	await setViewport(page, 'desktop');
	await page.goto('/app/bookmarks');

	await expect(page.getByTestId('bookmarks-panel')).toContainText('No bookmarks yet');
	await expect(page.getByTestId('bookmarks-list')).toHaveCount(0);
});

test('bookmarks route surfaces an API error', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/bookmarks**', async (route: Route) => fulfillJson(route, { error: 'bookmarks unavailable' }, 500));

	await setViewport(page, 'desktop');
	await page.goto('/app/bookmarks');

	await expect(page.getByTestId('bookmarks-panel')).toContainText('bookmarks unavailable');
});

test('removing a bookmark from the bookmarks list drops the post', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/bookmarks**', async (route: Route) => {
		await fulfillJson(route, [bookmarkStatus('bm-1', 'saved for later'), bookmarkStatus('bm-2', 'another keeper')]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/bm-1/unbookmark', async (route: Route) => {
		expect(route.request().method()).toBe('POST');
		await fulfillJson(route, { ...bookmarkStatus('bm-1', 'saved for later'), bookmarked: false });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/bookmarks');

	const list = page.getByTestId('bookmarks-list');
	const first = list.locator('.post').filter({ hasText: 'saved for later' });
	await first.getByRole('button', { name: 'More post actions' }).click();
	await first.getByRole('menuitem', { name: 'Remove bookmark' }).click();
	await expect(list).not.toContainText('saved for later');
	await expect(list).toContainText('another keeper');
});

test('removing the last bookmark collapses to the empty state', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/bookmarks**', async (route: Route) => {
		await fulfillJson(route, [bookmarkStatus('bm-only', 'the only keeper')]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/bm-only/unbookmark', async (route: Route) => {
		await fulfillJson(route, { ...bookmarkStatus('bm-only', 'the only keeper'), bookmarked: false });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/bookmarks');

	const post = page.getByTestId('bookmarks-list').locator('.post').filter({ hasText: 'the only keeper' });
	await post.getByRole('button', { name: 'More post actions' }).click();
	await post.getByRole('menuitem', { name: 'Remove bookmark' }).click();

	await expect(page.getByTestId('bookmarks-list')).toHaveCount(0);
	await expect(page.getByTestId('bookmarks-panel')).toContainText('No bookmarks yet');
});

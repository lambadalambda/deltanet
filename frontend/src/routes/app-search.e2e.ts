import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import type { PleromaAccount, PleromaRelationship, PleromaSearchResult, PleromaStatus } from '../lib/pleroma/types';
import { expectNoHorizontalOverflow, fulfillJson, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const authenticate = async (page: Page, recents: string[] = []) => {
	await page.addInitScript(({ storedSession, storedRecents }) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
		if (storedRecents.length > 0) window.localStorage.setItem('pn-search-recents', JSON.stringify(storedRecents));
	}, { storedSession: session, storedRecents: recents });
};

const accountResult = (id: string, displayName: string, acct: string): PleromaAccount => ({
	...pleromaFixtures.account,
	id,
	username: acct.split('@')[0] ?? acct,
	acct,
	display_name: displayName,
	note: '<p>slow web field notes and tiny servers</p>',
	url: `https://pleroma.example/users/${id}`,
	avatar: `https://pleroma.example/${id}.png`,
	avatar_static: `https://pleroma.example/${id}.png`,
	followers_count: 412,
	statuses_count: 870
});

const statusResult = (id: string, text: string, account: PleromaAccount = pleromaFixtures.account): PleromaStatus => ({
	...pleromaFixtures.status,
	id,
	uri: `https://pleroma.example/objects/${id}`,
	url: `https://pleroma.example/notice/${id}`,
	account,
	content: `<p>${text}</p>`,
	pleroma: {
		...pleromaFixtures.status.pleroma,
		content: { 'text/plain': text }
	}
});

const relationshipResult = (id: string, overrides: Partial<PleromaRelationship> = {}): PleromaRelationship => ({
	...pleromaFixtures.relationship,
	id,
	following: false,
	followed_by: false,
	requested: false,
	blocking: false,
	...overrides
});

const searchAccount = accountResult('account-search', 'gridwave', 'gridwave@retro.social');
const searchStatus = statusResult('status-search', 'the slow web is people taking their time on purpose.');
const searchRelationship = relationshipResult(searchAccount.id, { following: true });
const searchResponse: PleromaSearchResult = {
	accounts: [searchAccount],
	statuses: [searchStatus],
	hashtags: [{ name: 'slowweb', url: 'https://pleroma.example/tags/slowweb' }]
};

const mockSearchRelationships = async (page: Page, relationships: PleromaRelationship[] = [searchRelationship]) => {
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, relationships);
	});
};

const mockSearch = async (page: Page, body: PleromaSearchResult = searchResponse) => {
	const requests: URL[] = [];
	await mockSearchRelationships(page);
	await page.route('https://pleroma.example/api/v2/search**', async (route: Route) => {
		requests.push(new URL(route.request().url()));
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, body);
	});
	return requests;
};

const mockHomeTimeline = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => {
		await fulfillJson(route, pleromaFixtures.timelines.home);
	});
};

test('header search opens the full search page with people and post results', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	const requests = await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.getByRole('combobox', { name: 'Search DeltaNet' }).fill('slow web');
	await page.keyboard.press('Enter');

	await expect(page).toHaveURL(/\/app\/search\?q=slow\+web$/);
	await expect(page.getByRole('heading', { name: 'Search' })).toHaveCount(0);
	await expect(page.getByTestId('right-rail')).not.toBeVisible();
	await expect(page.getByText('Profile preview')).not.toBeVisible();
	await expect.poll(async () => (await page.getByTestId('search-pageframe').boundingBox())?.width ?? 0).toBeGreaterThan(800);
	await expect(page.getByTestId('search-pageframe').getByRole('button', { name: 'Search' })).toHaveCount(0);
	await expect(page.getByTestId('search-results')).toContainText('gridwave');
	await expect(page.getByTestId('search-results')).toContainText('@gridwave@retro.social');
	await expect(page.getByTestId('search-results')).toContainText('Following');
	await expect(page.getByTestId('search-results')).not.toContainText('View');
	await expect(page.getByTestId('search-results')).toContainText('the slow web is people taking their time');
	await expect(page.getByTestId('search-results')).not.toContainText('#slowweb');
	await expect.poll(() => requests[0]?.searchParams.get('q')).toBe('slow web');
	await expect.poll(() => requests[0]?.searchParams.get('limit')).toBe('20');
});

test('header search shows live dropdown results and dismisses with Escape', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.getByRole('combobox', { name: 'Search DeltaNet' }).fill('slow web');

	const dropdown = page.getByTestId('header-search-dropdown');
	await expect(dropdown).toContainText('People');
	await expect(dropdown).toContainText('gridwave');
	await expect(dropdown).toContainText('Posts');
	await expect(dropdown).toContainText('the slow web is people taking their time');

	await page.keyboard.press('Escape');
	await expect(dropdown).not.toBeVisible();
});

test('header search dropdown mouse clicks open results instead of submitting search', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.getByRole('combobox', { name: 'Search DeltaNet' }).fill('slow web');
	await page.getByTestId('header-search-dropdown').getByRole('option', { name: /gridwave/ }).click();

	await expect(page).toHaveURL(/\/app\/profiles\/gridwave%40retro\.social$/);

	await page.goto('/app/home');
	await page.getByRole('combobox', { name: 'Search DeltaNet' }).fill('slow web');
	await page.getByTestId('header-search-dropdown').getByRole('option', { name: /the slow web is people/ }).click();

	await expect(page).toHaveURL(/\/app\/thread\/status-search$/);
});

test('search avatars fall back when remote avatar images fail', async ({ page }) => {
	const deadAccount = {
		...searchAccount,
		avatar: 'https://pleroma.example/dead-search-account.png',
		avatar_static: 'https://pleroma.example/dead-search-account.png'
	};
	const deadPostAccount = accountResult('dead-search-post-account', 'dead relay', 'dead@relay.invalid');
	deadPostAccount.avatar = 'https://pleroma.example/dead-search-post.png';
	deadPostAccount.avatar_static = 'https://pleroma.example/dead-search-post.png';
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockSearch(page, {
		accounts: [deadAccount],
		statuses: [statusResult('dead-search-post', 'a result from a sleeping instance', deadPostAccount)],
		hashtags: []
	});
	await page.route('https://pleroma.example/dead-search-*.png', async (route) => {
		await route.abort();
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.getByRole('combobox', { name: 'Search DeltaNet' }).fill('sleeping instance');

	const dropdown = page.getByTestId('header-search-dropdown');
	await expect(dropdown.locator('.se-dd-av.avatar-fallback').first()).toBeVisible();
	await expect(dropdown.locator('img[src="https://pleroma.example/dead-search-account.png"]')).toHaveClass(/avatar-img-failed/);
	await expect(dropdown.locator('img[src="https://pleroma.example/dead-search-post.png"]')).toHaveClass(/avatar-img-failed/);

	await page.keyboard.press('Enter');
	const results = page.getByTestId('search-results');
	await expect(results.locator('.se-row-av.avatar-fallback').first()).toBeVisible();
	await expect(results.locator('img[src="https://pleroma.example/dead-search-account.png"]')).toHaveClass(/avatar-img-failed/);
	await expect(results.locator('img[src="https://pleroma.example/dead-search-post.png"]')).toHaveClass(/avatar-img-failed/);
});

test('header search dropdown supports arrow navigation and Enter activation', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.getByRole('combobox', { name: 'Search DeltaNet' }).fill('slow web');

	const dropdown = page.getByTestId('header-search-dropdown');
	const accountRow = dropdown.getByRole('option', { name: /gridwave/ }).first();
	const postRow = dropdown.getByRole('option', { name: /the slow web is people/ });
	await expect(postRow).toBeVisible();

	await page.keyboard.press('ArrowDown');
	await expect(accountRow).toHaveClass(/sel/);
	await page.keyboard.press('ArrowDown');
	await expect(postRow).toHaveClass(/sel/);
	await page.keyboard.press('ArrowUp');
	await expect(accountRow).toHaveClass(/sel/);
	await page.keyboard.press('Enter');

	await expect(page).toHaveURL(/\/app\/profiles\/gridwave%40retro\.social$/);
});

test('header search dropdown Tab refines the query with the selected handle', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const input = page.getByRole('combobox', { name: 'Search DeltaNet' });
	await input.fill('slow web');
	const accountRow = page.getByTestId('header-search-dropdown').getByRole('option', { name: /gridwave/ }).first();
	await expect(accountRow).toBeVisible();
	await page.keyboard.press('ArrowDown');
	await expect(accountRow).toHaveClass(/sel/);
	await page.keyboard.press('Tab');

	await expect(page).toHaveURL(/\/app\/home$/);
	await expect(input).toBeFocused();
	await expect(input).toHaveValue('@gridwave@retro.social ');
});

test('header search dropdown closes when clicking outside', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.getByRole('combobox', { name: 'Search DeltaNet' }).fill('slow web');
	const dropdown = page.getByTestId('header-search-dropdown');
	await expect(dropdown).toBeVisible();

	await page.getByTestId('app-content').click({ position: { x: 10, y: 10 } });
	await expect(dropdown).not.toBeVisible();
});

test('header search ignores stale live results after clearing input', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockSearchRelationships(page);
	const deferredSearch: { release: (() => void) | null } = { release: null };
	await page.route('https://pleroma.example/api/v2/search**', async (route: Route) => {
		await new Promise<void>((resolve) => {
			deferredSearch.release = () => {
				void fulfillJson(route, searchResponse).then(resolve);
			};
		});
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const input = page.getByRole('combobox', { name: 'Search DeltaNet' });
	await input.fill('slow web');
	await expect.poll(() => Boolean(deferredSearch.release)).toBe(true);
	await input.fill('');
	await expect(page.getByTestId('header-search-dropdown')).toContainText('Search across DeltaNet');

	deferredSearch.release?.();
	await page.waitForTimeout(50);
	await expect(page.getByTestId('header-search-dropdown')).not.toContainText('gridwave');
});

test('header search shows and clears recent queries', async ({ page }) => {
	await authenticate(page, ['slow web', 'gridwave']);
	await mockHomeTimeline(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const input = page.getByRole('combobox', { name: 'Search DeltaNet' });
	await input.focus();
	const dropdown = page.getByTestId('header-search-dropdown');
	await expect(dropdown).toContainText('Recent');
	await expect(dropdown).toContainText('slow web');
	await expect(dropdown).toContainText('gridwave');

	await page.getByLabel('Remove slow web from recent searches').click();
	await expect(dropdown).not.toContainText('slow web');
	await expect(dropdown).toContainText('gridwave');

	await dropdown.getByRole('button', { name: 'Clear all' }).click();
	await expect(dropdown).toContainText('Search across DeltaNet');
	await expect(dropdown).not.toContainText('gridwave');
});

test('explore search box opens the full search page', async ({ page }) => {
	await authenticate(page);
	await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/explore');

	await page.getByRole('searchbox', { name: 'Search topics, people, and posts' }).fill('gridwave');
	await page.getByTestId('app-content').getByRole('button', { name: 'Search', exact: true }).click();

	await expect(page).toHaveURL(/\/app\/search\?q=gridwave$/);
	await expect(page.getByTestId('search-results')).toContainText('gridwave');
});

test('full search page filters people and posts without showing hashtags', async ({ page }) => {
	await authenticate(page);
	await mockSearch(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/search?q=slow%20web');

	const tabs = page.getByRole('tablist', { name: 'Search result types' });
	await expect(tabs.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('search-results')).toContainText('gridwave');
	await expect(page.getByTestId('search-results')).toContainText('the slow web is people');

	await tabs.getByRole('tab', { name: /People/ }).click();
	await expect(page).toHaveURL(/tab=people/);
	await expect(tabs.getByRole('tab', { name: /People/ })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('search-results')).toContainText('gridwave');
	await expect(page.getByTestId('search-results')).not.toContainText('the slow web is people');

	await tabs.getByRole('tab', { name: /Posts/ }).click();
	await expect(tabs.getByRole('tab', { name: /Posts/ })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('search-results')).not.toContainText('gridwave@retro.social');
	await expect(page.getByTestId('search-results')).toContainText('the slow web is people');

	await page.getByRole('button', { name: /More filters/ }).click();
	await expect(page.getByRole('button', { name: /Hide filters/ })).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByTestId('search-filter-sidebar')).toContainText('Source');
	await expect(page.getByTestId('search-filter-sidebar')).toContainText('Date');
	await expect(page.getByTestId('search-filter-sidebar')).toContainText('From user');
	await expect(page.getByTestId('search-filter-sidebar')).toContainText('Has media');
	await expect(page.getByTestId('search-filter-sidebar')).toContainText('Sort');
	await expect(page.getByTestId('search-filter-sidebar')).toContainText('Filter controls are preview-only for now');
});

test('full search all tab shows top people before posts without burying posts', async ({ page }) => {
	const accounts = [
		accountResult('account-alpha', 'alpha grid', 'alpha@retro.social'),
		accountResult('account-beta', 'beta grid', 'beta@retro.social'),
		accountResult('account-gamma', 'gamma grid', 'gamma@retro.social')
	];
	await authenticate(page);
	await mockSearch(page, {
		accounts,
		statuses: [searchStatus],
		hashtags: []
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/search?q=slow%20web');

	const results = page.getByTestId('search-results');
	await expect(results).toContainText('alpha grid');
	await expect(results).toContainText('beta grid');
	await expect(results).not.toContainText('gamma grid');
	await expect(results).toContainText('the slow web is people taking their time');

	await page.getByRole('tab', { name: /People/ }).click();
	await expect(results).toContainText('gamma grid');
});

test('full search page keeps filters usable on mobile', async ({ page }) => {
	await authenticate(page);
	await mockSearch(page);
	await setViewport(page, 'mobile');
	await page.goto('/app/search?q=slow%20web');

	await page.getByRole('button', { name: /More filters/ }).click();

	await expect(page.getByTestId('search-filter-sidebar')).toBeVisible();
	await expect(page.getByTestId('search-results')).toContainText('the slow web is people');
	await expectNoHorizontalOverflow(page);
});

test('full search page shows no-results and API error states', async ({ page }) => {
	await authenticate(page);
	let fail = false;
	await page.route('https://pleroma.example/api/v2/search**', async (route) => {
		if (fail) {
			await fulfillJson(route, { error: 'search unavailable' }, 503);
			return;
		}
		await fulfillJson(route, { accounts: [], statuses: [], hashtags: [{ name: 'ignored', url: 'https://pleroma.example/tags/ignored' }] });
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/search?q=nope');

	await expect(page.getByRole('heading', { name: 'No results for nope' })).toBeVisible();
	fail = true;
	await page.getByRole('searchbox', { name: 'Search this instance and federation' }).fill('broken');
	await expect(page).toHaveURL(/q=broken/);

	await expect(page.getByRole('heading', { name: 'Pleroma server error' })).toBeVisible();
	await expect(page.getByText('search unavailable')).toBeVisible();
});

test('search result snippets fall back to media placeholders for media-only posts', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	const mediaOnlyStatus = {
		...statusResult('status-media-only', ''),
		content: '',
		media_attachments: [
			{ id: 'm1', type: 'image', url: 'https://cdn.example/one.png', description: null },
			{ id: 'm2', type: 'image', url: 'https://cdn.example/two.png', description: null }
		]
	};
	await mockSearch(page, { accounts: [], statuses: [mediaOnlyStatus], hashtags: [] });
	await setViewport(page, 'desktop');
	await page.goto('/app/search?q=media');

	const snippet = page.locator('.se-row-snippet').first();
	await expect(snippet).toContainText('[2 images]');
});

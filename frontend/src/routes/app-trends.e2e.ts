import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import type { PleromaInstance, PleromaTag } from '../lib/pleroma/types';
import { setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const authenticate = async (page: Page) => {
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const fulfillJson = async (route: Route, body: unknown, status = 200) => {
	await route.fulfill({
		status,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});
};

const mockNotifications = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => {
		await fulfillJson(route, []);
	});
};

const mockRailApis = async (page: Page, options: { trends: PleromaTag[]; instance: PleromaInstance; suggestions?: unknown[] }) => {
	let trendsAuthorization: string | undefined;
	let trendsLimit: string | null = null;
	let instanceAuthorization: string | undefined;
	let suggestionsAuthorization: string | undefined;
	await page.route('https://pleroma.example/api/v1/trends/tags**', async (route) => {
		trendsAuthorization = route.request().headers().authorization;
		trendsLimit = new URL(route.request().url()).searchParams.get('limit');
		await fulfillJson(route, options.trends);
	});
	await page.route('https://pleroma.example/api/v2/instance', async (route) => {
		instanceAuthorization = route.request().headers().authorization;
		await fulfillJson(route, options.instance);
	});
	await page.route('https://pleroma.example/api/v2/suggestions**', async (route) => {
		suggestionsAuthorization = route.request().headers().authorization;
		await fulfillJson(route, options.suggestions ?? []);
	});

	return {
		trendsAuthorization: () => trendsAuthorization,
		trendsLimit: () => trendsLimit,
		instanceAuthorization: () => instanceAuthorization,
		suggestionsAuthorization: () => suggestionsAuthorization
	};
};

test('right rail loads trends and instance metadata from Pleroma', async ({ page }) => {
	await authenticate(page);
	await mockNotifications(page);
	const requests = await mockRailApis(page, {
		trends: pleromaFixtures.trends,
		instance: {
			...pleromaFixtures.instance,
			configuration: { statuses: { max_characters: 5000 } }
		}
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const rail = page.getByTestId('right-rail');
	await expect(rail.getByTestId('trends-card')).toContainText('#smallweb');
	await expect(rail.getByTestId('trends-card')).toContainText('24 posts');
	await expect(rail.getByTestId('trends-card')).toContainText('#fedidevs');
	await expect(rail.getByTestId('instance-status-card')).toHaveCount(0);
	await expect(rail).not.toContainText('Instance status');
	await expect(rail).not.toContainText('Shortcuts');
	expect(requests.trendsAuthorization()).toBe('Bearer access-token');
	expect(requests.trendsLimit()).toBe('5');
	expect(requests.instanceAuthorization()).toBe('Bearer access-token');
});

test('right rail shows loading states while trend and instance requests are pending', async ({ page }) => {
	await authenticate(page);
	await mockNotifications(page);
	await page.route('https://pleroma.example/api/v1/trends/tags**', async () => new Promise(() => undefined));
	await page.route('https://pleroma.example/api/v2/instance', async () => new Promise(() => undefined));
	await page.route('https://pleroma.example/api/v2/suggestions**', async () => new Promise(() => undefined));

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const rail = page.getByTestId('right-rail');
	await expect(rail.getByTestId('trends-card')).toContainText('Loading trends');
	await expect(rail).not.toContainText('Who to follow');
});

test('right rail handles empty trend and metadata responses', async ({ page }) => {
	await authenticate(page);
	await mockNotifications(page);
	await mockRailApis(page, {
		trends: [],
		instance: {
			...pleromaFixtures.instance,
			domain: '',
			title: '',
			version: '',
			description: '',
			usage: undefined,
			pleroma: { metadata: { features: [] } }
		}
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const rail = page.getByTestId('right-rail');
	await expect(rail.getByTestId('trends-card')).toContainText('No trends available');
	await expect(rail).not.toContainText('Who to follow');
});

test('right rail degrades when trends or instance metadata are unavailable', async ({ page }) => {
	await authenticate(page);
	await mockNotifications(page);
	await page.route('https://pleroma.example/api/v1/trends/tags**', async (route) => {
		await fulfillJson(route, { error: 'trends disabled' }, 404);
	});
	await page.route('https://pleroma.example/api/v2/instance', async (route) => {
		await fulfillJson(route, { error: 'instance metadata disabled' }, 404);
	});
	await page.route('https://pleroma.example/api/v2/suggestions**', async (route) => {
		await fulfillJson(route, { error: 'suggestions disabled' }, 404);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const rail = page.getByTestId('right-rail');
	await expect(rail.getByTestId('trends-card')).toContainText('Trends unavailable');
	await expect(rail).not.toContainText('Who to follow');
});

test('right rail renders trend and instance request errors', async ({ page }) => {
	await authenticate(page);
	await mockNotifications(page);
	await page.route('https://pleroma.example/api/v1/trends/tags**', async (route) => {
		await fulfillJson(route, { error: 'trend server exploded' }, 500);
	});
	await page.route('https://pleroma.example/api/v2/instance', async (route) => {
		await fulfillJson(route, { error: 'instance server exploded' }, 500);
	});
	await page.route('https://pleroma.example/api/v2/suggestions**', async (route) => {
		await fulfillJson(route, { error: 'suggestion server exploded' }, 500);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/local');

	const rail = page.getByTestId('right-rail');
	await expect(rail.getByTestId('trends-card')).toContainText('trend server exploded');
	await expect(rail).not.toContainText('Who to follow');
});

test('right rail shows who to follow only when the backend returns suggestions', async ({ page }) => {
	await authenticate(page);
	await mockNotifications(page);
	const suggestedAccount = {
		...pleromaFixtures.account,
		id: 'account-suggested',
		username: 'nyan.binary',
		acct: 'nyan@catgirl.cloud',
		display_name: 'nyan.binary :sparkle:',
		emojis: [{ shortcode: 'sparkle', url: 'https://cdn.example/emoji/sparkle.png', static_url: 'https://cdn.example/emoji/sparkle.png' }],
		avatar: 'https://cdn.example/nyan.png',
		avatar_static: 'https://cdn.example/nyan.png'
	};
	const requests = await mockRailApis(page, {
		trends: pleromaFixtures.trends,
		instance: pleromaFixtures.instance,
		suggestions: [{ source: 'staff', account: suggestedAccount }]
	});
	let followRequests = 0;
	await page.route('https://pleroma.example/api/v1/accounts/account-suggested/follow', async (route) => {
		followRequests += 1;
		await fulfillJson(route, { ...pleromaFixtures.relationship, id: 'account-suggested', following: true, followed_by: false });
	});

	await setViewport(page, 'wide');
	await page.goto('/app/local');

	const rail = page.getByTestId('right-rail');
	const card = rail.getByTestId('who-to-follow-card');
	await expect(card).toBeVisible();
	await expect(card).toContainText('nyan.binary');
	await expect(card).toContainText('@nyan@catgirl.cloud');
	await expect(card.locator('img[alt=":sparkle:"]')).toBeVisible();
	await expect(card).not.toContainText('View more suggestions');
	expect(requests.suggestionsAuthorization()).toBe('Bearer access-token');

	await card.getByRole('button', { name: 'Follow', exact: true }).click();
	await expect(card.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
	expect(followRequests).toBe(1);
});

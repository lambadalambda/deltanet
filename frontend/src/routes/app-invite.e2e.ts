import { expect, test, type Page } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { fulfillJson, setViewport } from '../test/playwright';

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
		window.localStorage.setItem('headwater.session', JSON.stringify(storedSession));
	}, session);
};

const mockHomeTimeline = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => {
		await fulfillJson(route, pleromaFixtures.timelines.home);
	});
};

const mockInvite = async (page: Page, invite = 'https://i.delta.chat/#abc123') => {
	await page.route('https://pleroma.example/api/headwater/invite', async (route) => {
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, { invite });
	});
};

const grantClipboardPermission = async (page: Page) => {
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
};

test('share-your-feed card shows the invite link and copies it to the clipboard', async ({ page, browserName }) => {
	test.skip(browserName !== 'chromium', 'clipboard permission grants are chromium-only');
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockInvite(page);
	await grantClipboardPermission(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const card = page.getByTestId('invite-card');
	await expect(card).toContainText('Share your feed');
	await expect(card).toContainText('https://i.delta.chat/#abc123');

	await card.getByRole('button', { name: /copy/i }).click();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toBe('https://i.delta.chat/#abc123');
	await expect(page.getByTestId('post-control-toast')).toContainText(/copied/i);
});

test('share-your-feed card surfaces a failure state when the invite cannot be loaded', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await page.route('https://pleroma.example/api/headwater/invite', async (route) => {
		await fulfillJson(route, { error: 'not configured' }, 500);
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const card = page.getByTestId('invite-card');
	await expect(card).toContainText(/could not load/i);
});

test('header search detects a feed invite link and offers to follow it', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	let followBody: unknown;
	await page.route('https://pleroma.example/api/headwater/follow', async (route) => {
		followBody = JSON.parse(route.request().postData() ?? '{}');
		await fulfillJson(route, { chat_id: 42 });
	});

	const searchInput = page.getByRole('combobox', { name: 'Search Headwater' });
	await searchInput.fill('https://i.delta.chat/#invite-token');

	const dropdown = page.getByTestId('header-search-dropdown');
	await expect(dropdown).toContainText(/follow this feed/i);
	await dropdown.getByRole('button', { name: /follow this feed/i }).click();

	await expect(page.getByTestId('post-control-toast')).toContainText(/followed/i);
	expect(followBody).toMatchObject({ invite: 'https://i.delta.chat/#invite-token' });
});

test('header search detects an OPENPGP4FPR invite and surfaces a follow failure toast', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.route('https://pleroma.example/api/headwater/follow', async (route) => {
		await fulfillJson(route, { error: 'invalid invite' }, 422);
	});

	const searchInput = page.getByRole('combobox', { name: 'Search Headwater' });
	await searchInput.fill('OPENPGP4FPR:deadbeef#a=example.org&n=Someone');

	const dropdown = page.getByTestId('header-search-dropdown');
	await expect(dropdown).toContainText(/follow this feed/i);
	await dropdown.getByRole('button', { name: /follow this feed/i }).click();

	await expect(page.getByTestId('post-control-toast')).toContainText(/could not follow/i);
});

test('the followers-only invite is hidden behind an explicit reveal with a sharing warning', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockInvite(page);
	await page.route('https://pleroma.example/api/headwater/invite?channel=locked', async (route) => {
		await fulfillJson(route, { invite: 'https://i.delta.chat/#locked456' });
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const card = page.getByTestId('invite-card');
	// Never shown by default — revealing is a deliberate act.
	await expect(card.getByTestId('locked-invite-link')).toHaveCount(0);
	await card.getByTestId('reveal-locked-invite').click();
	await expect(card.getByTestId('locked-invite-link')).toContainText('locked456');
	await expect(card.getByTestId('locked-invite-note')).toContainText('GRANTS access');
});

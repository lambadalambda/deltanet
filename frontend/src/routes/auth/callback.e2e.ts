import { expect, test } from '@playwright/test';
import { pleromaFixtures } from '../../lib/pleroma/fixtures';

const createPendingOAuth = () => ({
	instanceUrl: 'https://pleroma.example',
	clientId: 'client-id',
	clientSecret: 'client-secret',
	redirectUri: 'http://localhost:4173/auth/callback',
	scopes: ['read', 'write', 'follow', 'push'],
	state: 'oauth-state',
	createdAt: Date.now()
});

const seedPendingOAuth = async (page: import('@playwright/test').Page) => {
	await page.goto('/');
	await page.evaluate((pending) => {
		window.sessionStorage.setItem('headwater.oauth.pending', JSON.stringify(pending));
	}, createPendingOAuth());
};

test('OAuth callback exchanges code and stores token without passwords', async ({ page }) => {
	await page.route('https://pleroma.example/oauth/token', async (route) => {
		const request = route.request();
		expect(request.method()).toBe('POST');
		expect(request.postData()).toContain('code=oauth-code');

		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				access_token: 'access-token',
				token_type: 'Bearer',
				scope: 'read write follow push',
				created_at: 1700000001
			})
		});
	});
	await page.route('https://pleroma.example/api/v1/accounts/verify_credentials', async (route) => {
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(pleromaFixtures.account)
		});
	});
	await seedPendingOAuth(page);

	await page.goto('/auth/callback?code=oauth-code&state=oauth-state');

	await expect(page.getByRole('heading', { name: 'Signed in to pleroma.example' })).toBeVisible();
	await expect(page).toHaveURL('/auth/callback');
	await expect(page.getByText('Headwater stored an OAuth token from your server.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open Headwater' })).toHaveAttribute('href', '/app/home');
	await expect(page.locator('input[type="password"]')).toHaveCount(0);

	const session = await page.evaluate(() => window.localStorage.getItem('headwater.session'));
	expect(session).toContain('access-token');
	expect(session).not.toContain('password');
	await expect.poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem('headwater.session') ?? '{}').account?.display_name)).toBe('quiet admin');
	await expect(page.evaluate(() => window.sessionStorage.getItem('headwater.oauth.pending'))).resolves.toBeNull();
});

test('OAuth callback keeps the token when account enrichment fails', async ({ page }) => {
	await page.route('https://pleroma.example/oauth/token', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				access_token: 'access-token',
				token_type: 'Bearer',
				scope: 'read write follow push',
				created_at: 1700000001
			})
		});
	});
	await page.route('https://pleroma.example/api/v1/accounts/verify_credentials', async (route) => {
		await route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'temporarily unavailable' })
		});
	});
	await seedPendingOAuth(page);

	await page.goto('/auth/callback?code=oauth-code&state=oauth-state');

	await expect(page.getByRole('heading', { name: 'Signed in to pleroma.example' })).toBeVisible();
	const session = await page.evaluate(() => JSON.parse(window.localStorage.getItem('headwater.session') ?? '{}'));
	expect(session.accessToken).toBe('access-token');
	expect(session.account).toBeUndefined();
	await expect(page.evaluate(() => window.sessionStorage.getItem('headwater.oauth.pending'))).resolves.toBeNull();
});

test('OAuth callback surfaces cancelled and missing pending states', async ({ page }) => {
	await seedPendingOAuth(page);

	await page.goto('/auth/callback?error=access_denied&error_description=The+server+declined&state=oauth-state');

	await expect(page.getByRole('heading', { name: 'Authorization was cancelled' })).toBeVisible();
	await expect(page).toHaveURL('/auth/callback');
	await expect(page.getByText('The server declined')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Return to sign in' })).toHaveAttribute('href', '/#oauth');
	await expect(page.evaluate(() => window.sessionStorage.getItem('headwater.oauth.pending'))).resolves.toBeNull();

	await page.goto('/auth/callback?code=oauth-code&state=oauth-state');
	await expect(page.getByRole('heading', { name: 'No pending Pleroma authorization' })).toBeVisible();
});

test('OAuth callback clears pending auth when the code is missing', async ({ page }) => {
	await seedPendingOAuth(page);

	await page.goto('/auth/callback?state=oauth-state');

	await expect(page.getByRole('heading', { name: 'Authorization code was missing' })).toBeVisible();
	await expect(page.evaluate(() => window.sessionStorage.getItem('headwater.oauth.pending'))).resolves.toBeNull();
});

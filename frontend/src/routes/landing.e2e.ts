import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, fulfillJson, setViewport } from '../test/playwright';

const mockHeadwaterStatus = async (page: Page, body: { configured: boolean; address: string | null }) => {
	await page.route('**/api/headwater/status', async (route) => {
		await fulfillJson(route, body);
	});
};

const mockOAuthAppRegistration = async (page: Page, origin: string) => {
	let body = '';
	await page.route(`${origin}/api/v1/apps`, async (route) => {
		body = route.request().postData() ?? '';
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: `${origin}-app`,
				name: 'Headwater',
				website: origin,
				redirect_uri: `${origin}/auth/callback`,
				client_id: `${origin}-client`,
				client_secret: `${origin}-secret`
			})
		});
	});

	return () => body;
};

test('signed-out landing explains the encrypted-email federation model and avoids passwords', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: true, address: null });
	await page.goto('/');

	await expect(page.getByRole('banner')).toContainText('Headwater');
	const brandMark = page.getByRole('link', { name: 'Headwater home' }).locator('.brand-mark');
	await expect(brandMark.locator('svg')).toBeVisible();
	await expect(brandMark.locator('svg > rect')).toHaveCount(0);
	await expect(brandMark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(page.getByRole('link', { name: 'Browse public' })).toHaveAttribute('href', '/public');
	await expect(page.getByRole('link', { name: 'Open public timeline' })).toHaveAttribute('href', '/public');
	await expect(page.getByRole('heading', { name: /A quieter corner of the social web/ })).toBeVisible();
	await expect(page.getByText(/encrypted email/i).first()).toBeVisible();
	await expect(page.getByText(/chatmail/i).first()).toBeVisible();
	await expect(page.getByText(/invite link/i).first()).toBeVisible();
	await expect(page.getByText('Headwater never sees your password')).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test('home server field defaults to the current origin and is tucked behind an advanced affordance', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: true, address: null });
	await page.goto('/');

	await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('textbox', { name: 'Your home server' })).toHaveCount(0);
	await page.getByRole('button', { name: /advanced/i }).click();
	await expect(page.getByRole('textbox', { name: 'Your home server' })).toHaveValue(new URL(page.url()).origin);
	await expectNoHorizontalOverflow(page);
});

test('status configured:true defaults to sign in and starts the OAuth redirect on this origin', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: true, address: null });
	await page.goto('/');
	const origin = new URL(page.url()).origin;
	const appRegistrationBody = await mockOAuthAppRegistration(page, origin);

	await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('textbox', { name: 'One-time enrollment code' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
	await page.getByRole('textbox', { name: 'One-time enrollment code' }).fill('terminal-code');
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page.getByText(`Redirecting to ${origin}`)).toBeVisible();
	const authorizationLink = page.getByRole('link', { name: /Open .*authorization/ });
	await expect(authorizationLink).toHaveAttribute('href', new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/oauth/authorize\\?`));
	expect(appRegistrationBody()).toContain('client_name=Headwater');
	expect(appRegistrationBody()).toContain('scopes=read+write+follow+push');
	expect(appRegistrationBody()).toContain('enrollment_code=terminal-code');
	const storedClient = await page.evaluate((key) => window.localStorage.getItem(key), `headwater.oauth.client.${encodeURIComponent(origin)}`);
	expect(storedClient).toContain(`${origin}-client`);

	const pending = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('headwater.oauth.pending') ?? 'null'));
	expect(pending).toMatchObject({ instanceUrl: origin, clientId: `${origin}-client`, scopes: ['read', 'write', 'follow', 'push'], state: expect.any(String) });

	await page.getByRole('button', { name: 'Cancel redirect' }).click();
	await expect(page.getByText('Headwater never sees your password')).toBeVisible();
});

test('normal sign-in migrates and reuses a legacy paired client without consuming another enrollment code', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: true, address: null });
	await page.goto('/');
	const origin = new URL(page.url()).origin;
	await page.evaluate(({ key, client }) => window.localStorage.setItem(key, JSON.stringify(client)), {
		key: `deltanet.oauth.client.${encodeURIComponent(origin)}`,
		client: {
			instanceUrl: origin,
			clientId: 'persisted-client',
			clientSecret: 'persisted-secret',
			redirectUri: `${origin}/auth/callback`,
			scopes: ['read', 'write', 'follow', 'push'],
			createdAt: Date.now()
		}
	});
	await page.reload();
	await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), `headwater.oauth.client.${encodeURIComponent(origin)}`)).toContain('persisted-client');
	expect(await page.evaluate((key) => window.localStorage.getItem(key), `deltanet.oauth.client.${encodeURIComponent(origin)}`)).toContain('persisted-client');

	let registrationRequests = 0;
	await page.route(`${origin}/api/v1/apps`, async (route) => {
		registrationRequests += 1;
		await route.abort();
	});
	await expect(page.getByText(/reuse this browser's registered client/i)).toBeVisible();
	await page.getByRole('button', { name: 'Continue' }).click();

	const link = page.getByRole('link', { name: /Open .*authorization/ });
	await expect(link).toHaveAttribute('href', /client_id=persisted-client/);
	expect(registrationRequests).toBe(0);
});

test('status configured:false defaults to the create-account tab', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');

	await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
});

test('signup happy path registers the account and continues into OAuth sign-in', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');
	const origin = new URL(page.url()).origin;
	await mockOAuthAppRegistration(page, origin);

	let signupBody: unknown;
	await page.route('**/api/headwater/signup', async (route) => {
		signupBody = JSON.parse(route.request().postData() ?? '{}');
		await fulfillJson(route, {
			account: { acct: 'quietfox@nine.testrun.org' }
		});
	});

	await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
	await page.getByRole('textbox', { name: 'Display name' }).fill('Quiet Fox');
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByText('quietfox@nine.testrun.org')).toBeVisible();
	expect(signupBody).toMatchObject({ display_name: 'Quiet Fox' });
	await expect(page.getByText(/new one-time enrollment code printed by the daemon/i)).toBeVisible();
	await page.getByRole('textbox', { name: 'One-time enrollment code' }).fill('post-signup-code');
	await page.getByRole('button', { name: 'Continue to sign in' }).click();
	await expect(page.getByText(`Redirecting to ${origin}`)).toBeVisible();
	const authorizationLink = page.getByRole('link', { name: /Open .*authorization/ });
	await expect(authorizationLink).toHaveAttribute('href', /\/oauth\/authorize\?/);
});

test('signup lets the relay be changed behind an advanced affordance, defaulting to nine.testrun.org', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');

	await page.getByRole('button', { name: /advanced/i }).click();
	const relay = page.getByRole('textbox', { name: 'Relay', exact: true });
	await expect(relay).toHaveValue('https://nine.testrun.org');
	await expect(page.getByText(/mail relay hosting your address/i)).toBeVisible();
	await relay.fill('https://NINE.TESTRUN.ORG:443/');
	await expect(page.getByRole('textbox', { name: 'Custom relay enrollment code' })).toHaveCount(0);

	await relay.fill('https://relay.example');
	await expect(page.getByRole('textbox', { name: 'Custom relay enrollment code' })).toBeVisible();
	await page.getByRole('textbox', { name: 'Display name' }).fill('Quiet Fox');
	await expect(page.getByRole('button', { name: 'Create account' })).toBeDisabled();

	let signupBody: Record<string, unknown> = {};
	await page.route('**/api/headwater/signup', async (route) => {
		signupBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
		await fulfillJson(route, { account: { acct: 'quietfox@relay.example' } });
	});
	await page.getByRole('textbox', { name: 'Custom relay enrollment code' }).fill('terminal-proof');
	await page.getByRole('button', { name: 'Create account' }).click();
	expect(signupBody).toMatchObject({
		display_name: 'Quiet Fox',
		relay: 'https://relay.example',
		enrollment_code: 'terminal-proof'
	});
});

test('signup 409 tells the user this node already has an account and switches to sign in', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');

	await page.route('**/api/headwater/signup', async (route) => {
		await fulfillJson(route, { error: 'already configured' }, 409);
	});

	await page.getByRole('textbox', { name: 'Display name' }).fill('Quiet Fox');
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByText(/already has an account/i)).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
});

test('signup 422 surfaces a validation error on the display name field', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');

	await page.route('**/api/headwater/signup', async (route) => {
		await fulfillJson(route, { error: 'display_name is invalid' }, 422);
	});

	await page.getByRole('textbox', { name: 'Display name' }).fill('x');
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByText('display_name is invalid')).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
});

test('signed-out landing remains usable on mobile', async ({ page }) => {
	await setViewport(page, 'mobile');
	await mockHeadwaterStatus(page, { configured: true, address: null });
	await page.goto('/');

	await expect(page.getByRole('heading', { name: /A quieter corner of the social web/ })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Browse public' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('signup tab warns about the 90-day expiry and offers restore-from-backup', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');

	await expect(page.getByText(/90 days/).first()).toBeVisible();
	await page.getByRole('button', { name: 'Restore from a backup instead' }).click();
	await expect(page.getByLabel('Backup file')).toBeVisible();
	await expect(page.getByLabel('Backup passphrase')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Restore this node' })).toBeDisabled();

	await page.getByRole('button', { name: 'Back to creating a new account' }).click();
	await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
});

test('restore happy path uploads the backup and continues into OAuth sign-in', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');
	const origin = new URL(page.url()).origin;
	await mockOAuthAppRegistration(page, origin);

	let restoreBody = '';
	await page.route('**/api/headwater/restore', async (route) => {
		restoreBody = route.request().postData() ?? '';
		await fulfillJson(route, { account: { acct: 'restored@nine.testrun.org' } });
	});

	await page.getByRole('button', { name: 'Restore from a backup instead' }).click();
	await page.getByLabel('Backup file').setInputFiles({
		name: 'headwater-backup.dnbk',
		mimeType: 'application/octet-stream',
		buffer: Buffer.from('DNBK1\nfake')
	});
	await page.getByLabel('Backup passphrase').fill('correct horse');
	await page.getByRole('button', { name: 'Restore this node' }).click();

	await expect(page.getByText('restored@nine.testrun.org')).toBeVisible();
	expect(restoreBody).toContain('name="passphrase"');
	expect(restoreBody).toContain('correct horse');
	expect(restoreBody).toContain('filename="headwater-backup.dnbk"');
	await page.getByRole('textbox', { name: 'One-time enrollment code' }).fill('post-restore-code');
	await page.getByRole('button', { name: 'Continue to sign in' }).click();
	await expect(page.getByText(`Redirecting to ${origin}`)).toBeVisible();
});

test('restore surfaces a wrong-passphrase error and stays on the form', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockHeadwaterStatus(page, { configured: false, address: null });
	await page.goto('/');

	await page.route('**/api/headwater/restore', async (route) => {
		await fulfillJson(route, { error: 'wrong passphrase or corrupted backup file' }, 422);
	});

	await page.getByRole('button', { name: 'Restore from a backup instead' }).click();
	await page.getByLabel('Backup file').setInputFiles({
		name: 'headwater-backup.dnbk',
		mimeType: 'application/octet-stream',
		buffer: Buffer.from('DNBK1\nfake')
	});
	await page.getByLabel('Backup passphrase').fill('wrong');
	await page.getByRole('button', { name: 'Restore this node' }).click();

	await expect(page.getByText('wrong passphrase or corrupted backup file')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Restore this node' })).toBeVisible();
});

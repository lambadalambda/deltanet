import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, fulfillJson, setViewport } from '../test/playwright';

const mockDeltanetStatus = async (page: Page, body: { configured: boolean; address: string | null }) => {
	await page.route('**/api/deltanet/status', async (route) => {
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
				name: 'DeltaNet',
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
	await mockDeltanetStatus(page, { configured: true, address: null });
	await page.goto('/');

	await expect(page.getByRole('banner')).toContainText('DeltaNet');
	await expect(page.getByRole('link', { name: 'Browse public' })).toHaveAttribute('href', '/public');
	await expect(page.getByRole('link', { name: 'Open public timeline' })).toHaveAttribute('href', '/public');
	await expect(page.getByRole('heading', { name: /A quieter corner of the social web/ })).toBeVisible();
	await expect(page.getByText(/encrypted email/i).first()).toBeVisible();
	await expect(page.getByText(/chatmail/i).first()).toBeVisible();
	await expect(page.getByText(/invite link/i).first()).toBeVisible();
	await expect(page.getByText('DeltaNet never sees your password')).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test('home server field defaults to the current origin and is tucked behind an advanced affordance', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockDeltanetStatus(page, { configured: true, address: null });
	await page.goto('/');

	await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('textbox', { name: 'Your home server' })).toHaveCount(0);
	await page.getByRole('button', { name: /advanced/i }).click();
	await expect(page.getByRole('textbox', { name: 'Your home server' })).toHaveValue(new URL(page.url()).origin);
	await expectNoHorizontalOverflow(page);
});

test('status configured:true defaults to sign in and starts the OAuth redirect on this origin', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockDeltanetStatus(page, { configured: true, address: null });
	await page.goto('/');
	const origin = new URL(page.url()).origin;
	const appRegistrationBody = await mockOAuthAppRegistration(page, origin);

	await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page.getByText(`Redirecting to ${origin}`)).toBeVisible();
	const authorizationLink = page.getByRole('link', { name: /Open .*authorization/ });
	await expect(authorizationLink).toHaveAttribute('href', new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/oauth/authorize\\?`));
	expect(appRegistrationBody()).toContain('client_name=DeltaNet');

	const pending = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('deltanet.oauth.pending') ?? 'null'));
	expect(pending).toMatchObject({ instanceUrl: origin, clientId: `${origin}-client`, state: expect.any(String) });

	await page.getByRole('button', { name: 'Cancel redirect' }).click();
	await expect(page.getByText('DeltaNet never sees your password')).toBeVisible();
});

test('status configured:false defaults to the create-account tab', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockDeltanetStatus(page, { configured: false, address: null });
	await page.goto('/');

	await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
});

test('signup happy path registers the account and continues into OAuth sign-in', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockDeltanetStatus(page, { configured: false, address: null });
	await page.goto('/');
	const origin = new URL(page.url()).origin;
	await mockOAuthAppRegistration(page, origin);

	let signupBody: unknown;
	await page.route('**/api/deltanet/signup', async (route) => {
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

	await expect(page.getByText(`Redirecting to ${origin}`)).toBeVisible();
	const authorizationLink = page.getByRole('link', { name: /Open .*authorization/ });
	await expect(authorizationLink).toHaveAttribute('href', /\/oauth\/authorize\?/);
});

test('signup lets the relay be changed behind an advanced affordance, defaulting to nine.testrun.org', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockDeltanetStatus(page, { configured: false, address: null });
	await page.goto('/');

	await page.getByRole('button', { name: /advanced/i }).click();
	await expect(page.getByRole('textbox', { name: /relay/i })).toHaveValue('https://nine.testrun.org');
	await expect(page.getByText(/mail relay hosting your address/i)).toBeVisible();
});

test('signup 409 tells the user this node already has an account and switches to sign in', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockDeltanetStatus(page, { configured: false, address: null });
	await page.goto('/');

	await page.route('**/api/deltanet/signup', async (route) => {
		await fulfillJson(route, { error: 'already configured' }, 409);
	});

	await page.getByRole('textbox', { name: 'Display name' }).fill('Quiet Fox');
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByText(/already has an account/i)).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
});

test('signup 422 surfaces a validation error on the display name field', async ({ page }) => {
	await setViewport(page, 'desktop');
	await mockDeltanetStatus(page, { configured: false, address: null });
	await page.goto('/');

	await page.route('**/api/deltanet/signup', async (route) => {
		await fulfillJson(route, { error: 'display_name is invalid' }, 422);
	});

	await page.getByRole('textbox', { name: 'Display name' }).fill('x');
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page.getByText('display_name is invalid')).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
});

test('signed-out landing remains usable on mobile', async ({ page }) => {
	await setViewport(page, 'mobile');
	await mockDeltanetStatus(page, { configured: true, address: null });
	await page.goto('/');

	await expect(page.getByRole('heading', { name: /A quieter corner of the social web/ })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Browse public' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

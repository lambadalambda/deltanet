import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { expectNoHorizontalOverflow, fulfillJson, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const updatedAccount = {
	...pleromaFixtures.account,
	display_name: 'dreambyte archive',
	fields: [
		{ name: 'home', value: 'small web', verified_at: null },
		{
			name: 'Website',
			value: '<a href="https://deltanet.example/~dreambyte">deltanet.example/~dreambyte</a>',
			verified_at: null
		},
		{ name: 'Location', value: 'low orbit', verified_at: null }
	],
	pleroma: { ...pleromaFixtures.account.pleroma, hide_followers_count: true },
	source: {
		note: 'keeping the lights low',
		fields: [
			{ name: 'home', value: 'small web' },
			{ name: 'Website', value: 'https://deltanet.example/~dreambyte' },
			{ name: 'Location', value: 'low orbit' }
		]
	}
};

const authenticate = async (page: Page) => {
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

test('real settings route populates the form from the session account', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');
	await page.goto('/app/settings');

	await expect(page.getByRole('heading', { name: 'Profile settings' })).toBeVisible();
	await expect(page.getByText('Settings / Profile')).toBeVisible();
	await expect(page.getByTestId('settings-save-state')).toContainText('Saved');

	await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('quiet admin');
	await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue('quietadmin');
	await expect(page.getByRole('textbox', { name: 'Username' })).toBeDisabled();
	await expect(page.getByRole('textbox', { name: 'Bio' })).toHaveValue('keeping the lights low');
	await expect(page.getByText('22 / 160')).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Website' })).toHaveValue('');
	await expect(page.getByRole('textbox', { name: 'Location' })).toHaveValue('');
	await expect(page.getByRole('switch', { name: 'Discoverable profile' })).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('switch', { name: 'Show follower count' })).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('switch', { name: 'Allow search indexing' })).toHaveCount(0);

	const rail = page.getByTestId('right-rail');
	await expect(rail).toBeVisible();
	await expect(rail.getByTestId('profile-preview-card')).toBeVisible();
	await expect(rail.getByTestId('profile-tips-card')).toBeVisible();
	await expect(rail.getByTestId('profile-preview-card')).toContainText('This is how your profile appears to other users.');
	await expect(rail.getByTestId('profile-preview-card')).toContainText('@quietadmin@pleroma.example');
	await expect(page.getByTestId('app-content').getByTestId('profile-preview-card')).toHaveCount(0);
});

test('real settings route saves through the account update API and reconciles the session', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	const updateBodies: unknown[] = [];
	await page.route('https://pleroma.example/api/v1/accounts/update_credentials', async (route: Route) => {
		updateBodies.push(route.request().postDataJSON());
		await fulfillJson(route, updatedAccount);
	});

	await page.goto('/app/settings');
	const rail = page.getByTestId('right-rail');

	await page.getByRole('textbox', { name: 'Display name' }).fill('dreambyte archive');
	await page.getByRole('textbox', { name: 'Website' }).fill('https://deltanet.example/~dreambyte');
	await page.getByRole('textbox', { name: 'Location' }).fill('low orbit');
	await page.getByRole('switch', { name: 'Show follower count' }).click();

	await expect(page.getByTestId('settings-save-state')).toContainText('Unsaved changes');
	await expect(rail.getByTestId('profile-preview-card')).toContainText('dreambyte archive');

	await page.getByRole('button', { name: 'Save profile settings' }).click();
	await expect(page.getByTestId('settings-save-state')).toContainText('Saved just now');

	expect(updateBodies).toHaveLength(1);
	expect(updateBodies[0]).toMatchObject({
		display_name: 'dreambyte archive',
		note: 'keeping the lights low',
		discoverable: true,
		hide_followers_count: true,
		fields_attributes: [
			{ name: 'home', value: 'small web' },
			{ name: 'Website', value: 'https://deltanet.example/~dreambyte' },
			{ name: 'Location', value: 'low orbit' }
		]
	});

	await expect(page.getByRole('button', { name: 'dreambyte archive account menu' })).toBeVisible();
	const storedSession = await page.evaluate(() =>
		JSON.parse(window.localStorage.getItem('deltanet.session') ?? 'null')
	);
	expect(storedSession?.account?.display_name).toBe('dreambyte archive');

	await page.getByRole('textbox', { name: 'Display name' }).fill('temporary name');
	await expect(page.getByTestId('settings-save-state')).toContainText('Unsaved changes');
	await page.getByRole('button', { name: 'Reset profile settings' }).click();
	await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('dreambyte archive');
	await expect(page.getByRole('textbox', { name: 'Website' })).toHaveValue('https://deltanet.example/~dreambyte');
	await expect(page.getByTestId('settings-save-state')).toContainText('Saved');
});

test('real settings route keeps the draft and shows an error when saving fails', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	await page.route('https://pleroma.example/api/v1/accounts/update_credentials', async (route: Route) => {
		await fulfillJson(route, { error: 'Internal server error' }, 500);
	});

	await page.goto('/app/settings');
	await page.getByRole('textbox', { name: 'Display name' }).fill('dreambyte archive');
	await page.getByRole('button', { name: 'Save profile settings' }).click();

	await expect(page.getByTestId('settings-save-error')).toBeVisible();
	await expect(page.getByTestId('settings-save-state')).toContainText('Unsaved changes');
	await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('dreambyte archive');
});

test('real settings route signs out and redirects when the save is unauthorized', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	await page.route('https://pleroma.example/api/v1/accounts/update_credentials', async (route: Route) => {
		await fulfillJson(route, { error: 'The access token is invalid' }, 401);
	});

	await page.goto('/app/settings');
	await page.getByRole('textbox', { name: 'Display name' }).fill('dreambyte archive');
	await page.getByRole('button', { name: 'Save profile settings' }).click();

	await page.waitForURL('/');
	const storedSession = await page.evaluate(() => window.localStorage.getItem('deltanet.session'));
	expect(storedSession).toBeNull();
});

test('real settings route stays touch-friendly on mobile', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'mobile');
	await page.goto('/app/settings');

	await expect(page.getByRole('heading', { name: 'Profile settings' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Choose avatar' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Choose banner' })).toBeVisible();
	await expect(page.getByTestId('right-rail')).toBeHidden();

	const saveBox = await page.getByRole('button', { name: 'Save profile settings' }).boundingBox();
	const toggleBox = await page.getByRole('switch', { name: 'Discoverable profile' }).boundingBox();

	expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(40);
	expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(40);
	await expectNoHorizontalOverflow(page);
});

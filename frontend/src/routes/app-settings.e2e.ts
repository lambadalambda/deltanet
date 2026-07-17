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
			value: '<a href="https://headwater.example/~dreambyte">headwater.example/~dreambyte</a>',
			verified_at: null
		},
		{ name: 'Location', value: 'low orbit', verified_at: null }
	],
	pleroma: { ...pleromaFixtures.account.pleroma, hide_followers_count: true },
	source: {
		note: 'keeping the lights low',
		fields: [
			{ name: 'home', value: 'small web' },
			{ name: 'Website', value: 'https://headwater.example/~dreambyte' },
			{ name: 'Location', value: 'low orbit' }
		]
	}
};

const authenticate = async (page: Page) => {
	await page.route('https://pleroma.example/api/v2/instance', async (route) => {
		await fulfillJson(route, pleromaFixtures.instance);
	});
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('headwater.session', JSON.stringify(storedSession));
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
	await page.getByRole('textbox', { name: 'Website' }).fill('https://headwater.example/~dreambyte');
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
			{ name: 'Website', value: 'https://headwater.example/~dreambyte' },
			{ name: 'Location', value: 'low orbit' }
		]
	});

	await expect(page.getByRole('button', { name: 'dreambyte archive account menu' })).toBeVisible();
	const storedSession = await page.evaluate(() =>
		JSON.parse(window.localStorage.getItem('headwater.session') ?? 'null')
	);
	expect(storedSession?.account?.display_name).toBe('dreambyte archive');

	await page.getByRole('textbox', { name: 'Display name' }).fill('temporary name');
	await expect(page.getByTestId('settings-save-state')).toContainText('Unsaved changes');
	await page.getByRole('button', { name: 'Reset profile settings' }).click();
	await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('dreambyte archive');
	await expect(page.getByRole('textbox', { name: 'Website' })).toHaveValue('https://headwater.example/~dreambyte');
	await expect(page.getByTestId('settings-save-state')).toContainText('Saved');
});

const avatarUpdatedAccount = {
	...pleromaFixtures.account,
	avatar: 'https://pleroma.example/headwater/avatar/account-1.png',
	avatar_static: 'https://pleroma.example/headwater/avatar/account-1.png',
	header: 'https://pleroma.example/headwater/header/account-1.png'
};

const pngBuffer = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

test('choosing an avatar shows a preview and saves it as multipart form-data', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	let capturedContentType = '';
	let capturedPostData = '';
	await page.route('https://pleroma.example/api/v1/accounts/update_credentials', async (route: Route) => {
		capturedContentType = route.request().headers()['content-type'] ?? '';
		capturedPostData = route.request().postData() ?? '';
		await fulfillJson(route, avatarUpdatedAccount);
	});

	await page.goto('/app/settings');

	await expect(page.getByTestId('avatar-preview')).toHaveCount(0);
	await page.getByLabel('Choose avatar file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: pngBuffer });
	await expect(page.getByTestId('avatar-preview')).toBeVisible();
	await expect(page.getByTestId('settings-save-state')).toContainText('Unsaved changes');

	await page.getByRole('button', { name: 'Save profile settings' }).click();
	await expect(page.getByTestId('settings-save-state')).toContainText('Saved just now');

	expect(capturedContentType).toContain('multipart/form-data');
	expect(capturedPostData).toContain('name="avatar"');
	expect(capturedPostData).toContain('filename="me.png"');
	expect(capturedPostData).toContain('name="display_name"');

	const storedSession = await page.evaluate(() =>
		JSON.parse(window.localStorage.getItem('headwater.session') ?? 'null')
	);
	// Avatar URLs are stable per contact id, so the client appends a
	// cache-busting query param so the new image repaints in-place.
	expect(storedSession?.account?.avatar).toMatch(
		/^https:\/\/pleroma\.example\/headwater\/avatar\/account-1\.png\?_cb=\d+$/
	);

	await expect(page.getByTestId('avatar-preview')).toHaveCount(0);
});

test('choosing a banner shows a preview and saves it as multipart form-data', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	let capturedPostData = '';
	await page.route('https://pleroma.example/api/v1/accounts/update_credentials', async (route: Route) => {
		capturedPostData = route.request().postData() ?? '';
		await fulfillJson(route, avatarUpdatedAccount);
	});

	await page.goto('/app/settings');

	await page.getByLabel('Choose banner file').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: pngBuffer });
	await expect(page.getByTestId('banner-preview')).toBeVisible();

	await page.getByRole('button', { name: 'Save profile settings' }).click();
	await expect(page.getByTestId('settings-save-state')).toContainText('Saved just now');

	expect(capturedPostData).toContain('name="header"');
	expect(capturedPostData).toContain('filename="wide.png"');

	const storedSession = await page.evaluate(() =>
		JSON.parse(window.localStorage.getItem('headwater.session') ?? 'null')
	);
	expect(storedSession?.account?.header).toMatch(
		/^https:\/\/pleroma\.example\/headwater\/header\/account-1\.png\?_cb=\d+$/
	);
});

test('a pending avatar choice can be discarded before saving', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	await page.goto('/app/settings');

	await page.getByLabel('Choose avatar file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: pngBuffer });
	await expect(page.getByTestId('avatar-preview')).toBeVisible();

	await page.getByRole('button', { name: 'Discard avatar' }).click();
	await expect(page.getByTestId('avatar-preview')).toHaveCount(0);
});

test('the save request stays JSON when no image files are pending', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	let capturedContentType = '';
	await page.route('https://pleroma.example/api/v1/accounts/update_credentials', async (route: Route) => {
		capturedContentType = route.request().headers()['content-type'] ?? '';
		await fulfillJson(route, updatedAccount);
	});

	await page.goto('/app/settings');
	await page.getByRole('textbox', { name: 'Display name' }).fill('dreambyte archive');
	await page.getByRole('button', { name: 'Save profile settings' }).click();
	await expect(page.getByTestId('settings-save-state')).toContainText('Saved just now');

	expect(capturedContentType).toContain('application/json');
});

test('an oversized image shows an error and does not submit', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	let requestCount = 0;
	await page.route('https://pleroma.example/api/v1/accounts/update_credentials', async (route: Route) => {
		requestCount += 1;
		await fulfillJson(route, updatedAccount);
	});

	await page.goto('/app/settings');

	// 41 MB > COMPOSER_MAX_UPLOAD_BYTES (40 MB).
	const bigBuffer = Buffer.alloc(41 * 1024 * 1024, 0);
	await page.getByLabel('Choose avatar file').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: bigBuffer });

	await expect(page.getByTestId('post-control-toast')).toContainText('40 MB');
	await expect(page.getByTestId('avatar-preview')).toHaveCount(0);

	expect(requestCount).toBe(0);
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
	const storedSession = await page.evaluate(() => window.localStorage.getItem('headwater.session'));
	expect(storedSession).toBeNull();
});

test('real settings route stays touch-friendly on mobile', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'mobile');
	await page.goto('/app/settings');

	await expect(page.getByRole('heading', { name: 'Profile settings' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Choose avatar', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Choose banner', exact: true })).toBeVisible();
	await expect(page.getByTestId('right-rail')).toBeHidden();

	const saveBox = await page.getByRole('button', { name: 'Save profile settings' }).boundingBox();
	const toggleBox = await page.getByRole('switch', { name: 'Discoverable profile' }).boundingBox();

	expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(40);
	expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(40);
	await expectNoHorizontalOverflow(page);
});

test('backup card nags when no backup exists and downloads an encrypted backup', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	await page.route('https://pleroma.example/api/headwater/backup', async (route: Route) => {
		await fulfillJson(route, { last_backup_at: null });
	});
	let exportBody: unknown;
	await page.route('https://pleroma.example/api/headwater/backup/export', async (route: Route) => {
		exportBody = route.request().postDataJSON();
		await route.fulfill({
			status: 200,
			contentType: 'application/octet-stream',
			headers: {
				// Mirrors the daemon: Content-Disposition must be CORS-exposed or a
				// cross-origin frontend can't read the filename.
				'access-control-allow-origin': '*',
				'access-control-expose-headers': 'Content-Disposition',
				'content-disposition': 'attachment; filename="headwater-backup-quietadmin-2026-07-07.dnbk"'
			},
			body: Buffer.from('DNBK1\nfake-container-bytes')
		});
	});

	await page.goto('/app/settings');

	const card = page.getByTestId('backup-card');
	await expect(card.getByRole('heading', { name: 'Backup & identity' })).toBeVisible();
	await expect(card).toContainText('90 days');
	await expect(page.getByTestId('backup-status')).toContainText('No backup has ever been made');

	const exportButton = page.getByRole('button', { name: 'Download encrypted backup' });
	await expect(exportButton).toBeDisabled();
	await page.getByLabel('Backup passphrase').fill('correct horse battery');

	const downloadPromise = page.waitForEvent('download');
	await exportButton.click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('headwater-backup-quietadmin-2026-07-07.dnbk');
	expect(exportBody).toMatchObject({ passphrase: 'correct horse battery' });

	await expect(page.getByTestId('backup-saved')).toContainText('headwater-backup-quietadmin-2026-07-07.dnbk');
	await expect(page.getByTestId('backup-status')).toContainText('Last backup');
	// The passphrase field clears after a successful export.
	await expect(page.getByLabel('Backup passphrase')).toHaveValue('');
});

test('backup card nags about a stale backup and surfaces export failures', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'wide');

	const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
	await page.route('https://pleroma.example/api/headwater/backup', async (route: Route) => {
		await fulfillJson(route, { last_backup_at: sixtyDaysAgo });
	});
	await page.route('https://pleroma.example/api/headwater/backup/export', async (route: Route) => {
		await fulfillJson(route, { error: 'backup export exploded' }, 500);
	});

	await page.goto('/app/settings');

	await expect(page.getByTestId('backup-status')).toContainText('over a month ago');

	await page.getByLabel('Backup passphrase').fill('pw');
	await page.getByRole('button', { name: 'Download encrypted backup' }).click();
	await expect(page.getByTestId('backup-error')).toContainText('backup export exploded');
});

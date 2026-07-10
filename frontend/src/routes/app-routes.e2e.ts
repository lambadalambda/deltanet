import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { expectNoHorizontalOverflow, mockRightRailApis, setViewport, viewports } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};
const alternateSession = {
	...session,
	account: {
		...pleromaFixtures.account,
		id: 'account-dreambyte',
		username: 'dreambyte',
		acct: 'dreambyte@soft.example',
		display_name: 'dreambyte',
		avatar: 'https://pleroma.example/dreambyte.png',
		avatar_static: 'https://pleroma.example/dreambyte.png'
	}
};

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const authenticateAsAlternateAccount = async (page: Page) => {
	await mockRightRailApis(page);
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, alternateSession);
};

const mockHomeTimeline = async (page: Page) => {
	const homeUrl = 'https://pleroma.example/api/v1/timelines/home**';
	await page.route(homeUrl, async (route: Route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(pleromaFixtures.timelines.home)
		});
	});
};

const mockAppPublicTimeline = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/timelines/public**', async (route: Route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(pleromaFixtures.timelines.public)
		});
	});
};

const mockProfileRoute = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/accounts/account-1/statuses**', async (route: Route) => {
		const url = new URL(route.request().url());
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(url.searchParams.get('pinned') === 'true' ? [] : pleromaFixtures.timelines.home)
		});
	});
};

test('signed-out users are redirected away from authenticated app routes', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: /quieter corner of the social web/i })).toBeVisible();
});

test('authenticated users are redirected from the landing page into the real app', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockProfileRoute(page);
	await setViewport(page, 'desktop');
	await page.goto('/');

	await expect(page).toHaveURL('/app/home');
	await expect(page.getByTestId('app-header')).toBeVisible();
	await expect(page.getByRole('tablist', { name: 'Timeline sections' })).toBeVisible();
	await expect(page.getByRole('form', { name: 'Composer' })).toBeVisible();
});

test('real app routes render shell, deep links, and browser history', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await page.setViewportSize({ width: 1360, height: 900 });
	await page.goto('/app/home');

	await expect(page.getByTestId('app-header')).toBeVisible();
	const header = page.getByTestId('app-header');
	await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
	await expect(header.getByTestId('brand-tag')).toContainText('A federatedsocial web');
	const sidebar = page.getByTestId('left-sidebar');
	for (const label of ['Home', 'Explore']) {
		await expect(sidebar.getByRole('link', { name: label })).toBeVisible();
	}
	await expect(header.getByPlaceholder('Search...')).toBeVisible();
	await expect(header.getByText('⌘K')).toBeVisible();
	await expect(page.getByTestId('left-sidebar')).toBeVisible();
	await expect(page.getByTestId('right-rail')).toContainText('Trends & Activity');
	await expect(page.getByTestId('app-content')).toContainText('quiet CSS can still carry the voice.');

	await page.getByTestId('left-sidebar').getByRole('link', { name: 'Explore' }).click();
	await expect(page).toHaveURL('/app/explore');
	await expect(page.getByRole('heading', { name: 'Explore the network' })).toBeVisible();
	await expect(page.getByTestId('right-rail')).toContainText('Discover');

	await page.getByTestId('left-sidebar').getByRole('link', { name: 'Settings' }).click();
	await expect(page).toHaveURL('/app/settings');
	await expect(page.getByRole('heading', { name: 'Profile settings' })).toBeVisible();
	await expect(page.getByTestId('settings-subnav')).toBeVisible();

	await page.goBack();
	await expect(page).toHaveURL('/app/explore');
	await page.goBack();
	await expect(page).toHaveURL('/app/home');
	await page.goForward();
	await expect(page).toHaveURL('/app/explore');
	await expectNoHorizontalOverflow(page);
});

test('real app left sidebar keeps profile stats and full settings subnav', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const profileMini = page.getByTestId('profile-mini');
	await expect(profileMini).toContainText('quiet admin');
	await expect(profileMini).toContainText('@quietadmin@pleroma.example');
	await expect(profileMini).toContainText('keeping the lights low');
	await expect(profileMini).toContainText('Posts');
	await expect(profileMini).toContainText('512');
	await expect(profileMini).toContainText('Following');
	await expect(profileMini).toContainText('64');
	await expect(profileMini).toContainText('Followers');
	await expect(profileMini).toContainText('128');

	await page.getByTestId('left-sidebar').getByRole('link', { name: 'Settings' }).click();
	await expect(page.getByTestId('settings-subnav')).toContainText('Import / Export');
	await expect(page.getByTestId('settings-subnav')).toContainText('Development');
});

test('real app header uses the authenticated account identity', async ({ page }) => {
	await authenticateAsAlternateAccount(page);
	await mockHomeTimeline(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const chip = page.getByTestId('app-header').getByRole('button', { name: 'dreambyte account menu' });
	await expect(chip).toContainText('dreambyte');
	await expect(chip).not.toContainText('quiet admin');
	await expect(chip.locator('.user-chip-av img')).toHaveAttribute('src', 'https://pleroma.example/dreambyte.png');
});

test('real app hydrates profile data for existing token-only sessions', async ({ page }) => {
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, {
		instanceUrl: session.instanceUrl,
		accessToken: session.accessToken,
		tokenType: session.tokenType,
		scope: session.scope,
		createdAt: session.createdAt
	});
	await page.route('https://pleroma.example/api/v1/accounts/verify_credentials', async (route) => {
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(pleromaFixtures.account)
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/explore');

	const profileMini = page.getByTestId('profile-mini');
	await expect(profileMini).toContainText('quiet admin');
	await expect(profileMini).toContainText('@quietadmin@pleroma.example');
	expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('deltanet.session') ?? '{}').account?.display_name)).toBe('quiet admin');
});

test('real app right rail keeps timeline and explore card stacks', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await page.setViewportSize({ width: 1360, height: 900 });
	await page.goto('/app/home');

	const rail = page.getByTestId('right-rail');
	await expect(rail).toContainText('Trends & Activity');
	await expect(rail).not.toContainText('Who to follow');
	await expect(rail).not.toContainText('Shortcuts');
	await expect(rail).not.toContainText('Instance status');

	await page.getByTestId('left-sidebar').getByRole('link', { name: 'Explore' }).click();
	await expect(page).toHaveURL('/app/explore');
	await expect(page.getByLabel('Quick search Explore')).toBeVisible();
	await expect(rail).toContainText('Known instances');
	await expect(rail).toContainText('Discovery mode');
});

test('app route guard revalidates when session disappears during client navigation', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.getByTestId('app-header')).toBeVisible();

	await page.evaluate(() => window.localStorage.removeItem('deltanet.session'));
	await page.getByTestId('left-sidebar').getByRole('link', { name: 'Explore' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: /quieter corner of the social web/i })).toBeVisible();
});

test('timeline, thread, profile, notification, and placeholder routes deep link in the real shell', async ({ page }) => {
	await authenticate(page);
	await mockAppPublicTimeline(page);
	await mockProfileRoute(page);
	await setViewport(page, 'desktop');

	const cases = [
		['/app/public', 'Public timeline'],
		['/app/thread/status-1', 'Thread'],
		['/app/profiles/quietadmin@pleroma.example', 'quiet admin'],
		['/app/notifications', 'Notifications']
	] as const;

	for (const [path, heading] of cases) {
		await page.goto(path);
		await expect(page.getByTestId('app-header')).toBeVisible();
		await expect(page.getByTestId('app-content').getByRole('heading', { name: heading })).toBeVisible();
		await expectNoHorizontalOverflow(page);
	}

});

test('real app shell stays responsive across desktop, medium, tablet, and mobile', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await page.setViewportSize({ width: 1360, height: 900 });
	await page.goto('/app/home');
	await expect(page.getByTestId('left-sidebar')).toBeVisible();
	await expect(page.getByTestId('right-rail')).toBeVisible();
	await expectNoHorizontalOverflow(page);

	for (const [name, viewport] of Object.entries(viewports)) {
		await page.setViewportSize(viewport);
		await page.goto('/app/home');

		await expect(page.getByTestId('app-header')).toBeVisible();
		if (name === 'wide') {
			await expect(page.getByTestId('left-sidebar')).toBeVisible();
			await expect(page.getByTestId('right-rail')).toBeVisible();
		} else if (name === 'desktop' || name === 'medium') {
			await expect(page.getByTestId('left-sidebar')).toBeVisible();
			await expect(page.getByTestId('right-rail')).toBeHidden();
		} else {
			await expect(page.getByTestId('left-sidebar')).toBeHidden();
			await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible();
		}

		await expectNoHorizontalOverflow(page);
	}
});

test('real app user menu switches themes and closes with escape', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const accountMenuButton = page.getByRole('button', { name: 'quiet admin account menu' });
	await accountMenuButton.click();
	const menu = page.getByTestId('user-menu');
	await expect(menu).toBeVisible();
	await expect(menu).toContainText('quiet admin');
	await expect(menu).toContainText('@quietadmin@pleroma.example');
	await expect(menu).toContainText('512');
	await expect(menu).toContainText('Posts');
	await expect(menu).toContainText('64');
	await expect(menu).toContainText('Following');
	await expect(menu).toContainText('128');
	await expect(menu).toContainText('Followers');
	for (const label of ['View profile', 'Bookmarks', 'Favorites', 'Lists', 'Drafts & scheduled', 'Appearance', 'Settings', 'Keyboard shortcuts', 'About this instance', 'Switch account', 'Sign out']) {
		await expect(menu).toContainText(label);
	}
	await expect(menu.locator('.user-menu-badge')).toHaveText('2');
	await expect(menu).toContainText('DeltaNet™');
	await page.getByRole('button', { name: 'Simoun' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'simoun');
	await expect(menu).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('user-menu')).toBeHidden();
	await expect(accountMenuButton).toBeFocused();
});

test('real app user menu disables profile navigation until token-only sessions hydrate', async ({ page }) => {
	let resolveCredentials = () => {};
	const credentialsReady = new Promise<void>((resolve) => {
		resolveCredentials = resolve;
	});
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, {
		instanceUrl: session.instanceUrl,
		accessToken: session.accessToken,
		tokenType: session.tokenType,
		scope: session.scope,
		createdAt: session.createdAt
	});
	await mockRightRailApis(page);
	await mockHomeTimeline(page);
	await page.route('https://pleroma.example/api/v1/accounts/verify_credentials', async (route) => {
		await credentialsReady;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(pleromaFixtures.account)
		});
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.getByRole('button', { name: 'Account account menu' }).click();
	const viewProfile = page.getByTestId('user-menu').getByRole('button', { name: /View profile/ });
	await expect(viewProfile).toBeDisabled();

	resolveCredentials();
	await expect(page.getByRole('button', { name: 'quiet admin account menu' })).toBeVisible();
	await expect(viewProfile).toBeEnabled();
});

test('real app user menu opens profile, settings, and signs out by forgetting this browser', async ({ page }) => {
	await authenticate(page);
	await page.addInitScript(() => {
		const key = `deltanet.oauth.client.${encodeURIComponent('https://pleroma.example')}`;
		window.localStorage.setItem(key, JSON.stringify({
			instanceUrl: 'https://pleroma.example',
			clientId: 'persisted-client',
			clientSecret: 'persisted-secret',
			redirectUri: `${window.location.origin}/auth/callback`,
			scopes: ['read', 'write', 'follow', 'push'],
			createdAt: Date.now()
		}));
	});
	await mockHomeTimeline(page);
	await mockProfileRoute(page);
	await page.route('https://pleroma.example/api/deltanet/streaming/token', async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'signout-ticket', expires_at: Date.now() + 30_000 }) });
	});
	await page.addInitScript(() => {
		const testWindow = window as typeof window & { __signoutSockets?: Array<{ closeCalled: boolean }> };
		testWindow.__signoutSockets = [];
		const MockWebSocket = function () {
			const socket = {
				closeCalled: false,
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				close() { this.closeCalled = true; }
			};
			testWindow.__signoutSockets?.push(socket);
			return socket;
		};
		Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
	});
	let revokedToken = '';
	let releaseRevoke = () => {};
	const revokeReleased = new Promise<void>((resolve) => { releaseRevoke = resolve; });
	await page.route('https://pleroma.example/oauth/revoke', async (route) => {
		revokedToken = new URLSearchParams(route.request().postData() ?? '').get('token') ?? '';
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await revokeReleased;
		await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.getByRole('button', { name: 'quiet admin account menu' }).click();
	await page.getByTestId('user-menu').getByRole('button', { name: /View profile/ }).click();
	await expect(page).toHaveURL('/app/profiles/quietadmin%40pleroma.example');

	await page.getByRole('button', { name: 'quiet admin account menu' }).click();
	await page.getByTestId('user-menu').getByRole('button', { name: /Settings/ }).click();
	await expect(page).toHaveURL('/app/settings');

	await page.getByRole('button', { name: 'quiet admin account menu' }).click();
	await expect(page.getByTestId('user-menu')).toContainText('Next sign-in needs a fresh terminal enrollment code.');
	await page.getByTestId('user-menu').getByRole('button', { name: 'Sign out & forget this browser' }).click();
	await expect(page).toHaveURL('/');
	expect(await page.evaluate(() => window.localStorage.getItem('deltanet.session'))).toBeNull();
	expect(await page.evaluate(() => window.localStorage.getItem(`deltanet.oauth.client.${encodeURIComponent('https://pleroma.example')}`))).toBeNull();
	await expect.poll(() => revokedToken).toBe('access-token');
	expect(await page.evaluate(() => {
		const testWindow = window as typeof window & { __signoutSockets?: Array<{ closeCalled: boolean }> };
		return testWindow.__signoutSockets?.every((socket) => socket.closeCalled) ?? false;
	})).toBe(true);
	releaseRevoke();
});

test('mobile real app shell opens drawer and details sheet', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await setViewport(page, 'mobile');
	await page.goto('/app/home');

	await page.getByRole('button', { name: 'Open navigation menu' }).click();
	await expect(page.getByTestId('mobile-drawer')).toBeVisible();
	await page.getByTestId('mobile-drawer').getByRole('link', { name: 'Explore' }).click();
	await expect(page).toHaveURL('/app/explore');
	await expect(page.getByTestId('mobile-drawer')).toBeHidden();

	await page.getByTestId('mobile-bottom-nav').getByRole('button', { name: 'More' }).click();
	await expect(page.getByTestId('mobile-sheet')).toBeVisible();
	await page.getByRole('button', { name: 'Close details sheet' }).click();
	await expect(page.getByTestId('mobile-sheet')).toBeHidden();
	await expectNoHorizontalOverflow(page);
});

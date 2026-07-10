import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { expectElementIsTruncatedWithinParent, expectNoHorizontalOverflow, fulfillJson, mockRightRailApis, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const homeUrl = 'https://pleroma.example/api/v1/timelines/home**';
const instanceUrl = 'https://pleroma.example/api/v2/instance';
const accountSearchUrl = 'https://pleroma.example/api/v1/accounts/search**';
const customEmojisUrl = 'https://pleroma.example/api/v1/custom_emojis';

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	let streamTicket = 0;
	await page.route('https://pleroma.example/api/deltanet/streaming/token', async (route) => {
		expect(route.request().headers().authorization).toMatch(/^Bearer .+-token$/);
		streamTicket += 1;
		await fulfillHome(route, { ticket: `stream-ticket-${streamTicket}`, expires_at: Date.now() + 30_000 });
	});
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => {
		await fulfillHome(route, []);
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});
	await page.addInitScript((storedSession) => {
			type MockSocket = {
				url: string;
				closeCalled: boolean;
				onmessage: ((event: { data: string }) => void) | null;
				onerror: ((event: Event) => void) | null;
				onclose: ((event: Event) => void) | null;
				close: () => void;
			};
		const testWindow = window as typeof window & {
			__deltanetSockets?: MockSocket[];
		};

		if (!testWindow.__deltanetSockets) {
			testWindow.__deltanetSockets = [];
			const MockWebSocket = function (url: string) {
				const socket: MockSocket = {
					url,
					closeCalled: false,
					onmessage: null,
					onerror: null,
					onclose: null,
					close() {
						this.closeCalled = true;
					}
				};
				testWindow.__deltanetSockets?.push(socket);
				return socket;
			} as unknown as new (url: string) => MockSocket;

			Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
		}

		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const authenticateWithThrowingWebSocket = async (page: Page) => {
	await mockRightRailApis(page);
	await page.route('https://pleroma.example/api/deltanet/streaming/token', async (route) => {
		await fulfillHome(route, { ticket: 'stream-ticket', expires_at: Date.now() + 30_000 });
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});
	await page.addInitScript((storedSession) => {
		const ThrowingWebSocket = function () {
			throw new Error('socket blocked');
		};
		Object.defineProperty(window, 'WebSocket', { configurable: true, value: ThrowingWebSocket });
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const mockHomeTimeline = async (page: Page, handler: (route: Route) => Promise<void>) => {
	await page.route(homeUrl, handler);
};

const mockInstance = async (page: Page, instance = pleromaFixtures.instance) => {
	await page.route(instanceUrl, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(instance)
		});
	});
};

const fulfillHome = async (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) => {
	await route.fulfill({
		status,
		contentType: 'application/json',
		headers: headers.link ? { 'access-control-expose-headers': 'link', ...headers } : headers,
		body: JSON.stringify(body)
	});
};

const primeVideoMetadata = async (video: Locator) => video.evaluate((node: HTMLVideoElement) => {
	let currentTime = 0;
	Object.defineProperty(node, 'duration', { configurable: true, value: 42 });
	Object.defineProperty(node, 'currentTime', {
		configurable: true,
		get: () => currentTime,
		set: (value: number) => {
			currentTime = value;
		}
	});
	node.dispatchEvent(new Event('loadedmetadata'));
	return node.currentTime;
});

const startPrimedVideo = async (video: Locator) => video.evaluate((node: HTMLVideoElement) => {
	node.dispatchEvent(new Event('play'));
	return node.currentTime;
});

const statusWithText = (id: string, text: string) => ({
	...pleromaFixtures.status,
	id,
	uri: `https://pleroma.example/objects/${id}`,
	url: `https://pleroma.example/notice/${id}`,
	content: `<p>${text}</p>`,
	pleroma: {
		...pleromaFixtures.status.pleroma,
		content: { 'text/plain': text }
	}
});

const emitStreamUpdate = async (page: Page, status: unknown) => {
	await page.evaluate((nextStatus) => {
		type MockSocket = { onmessage: ((event: { data: string }) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.at(-1);
		socket?.onmessage?.({ data: JSON.stringify({ event: 'update', payload: JSON.stringify(nextStatus) }) });
	}, status);
};

const emitStreamError = async (page: Page) => {
	await page.evaluate(() => {
		type MockSocket = { onerror: ((event: Event) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.at(-1);
		socket?.onerror?.(new Event('error'));
	});
};

const emitStreamNotification = async (page: Page, notification: unknown) => {
	await page.evaluate((nextNotification) => {
		type MockSocket = { onmessage: ((event: { data: string }) => void) | null };
		const testWindow = window as typeof window & { __deltanetSockets?: MockSocket[] };
		const socket = testWindow.__deltanetSockets?.at(-1);
		socket?.onmessage?.({ data: JSON.stringify({ event: 'notification', payload: JSON.stringify(nextNotification) }) });
	}, notification);
};

test('authenticated home timeline loads and renders posts through adapters', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});
	await page.route('https://pleroma.example/avatar.png', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'image/svg+xml',
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page.getByTestId('app-header')).toBeVisible();
	await expect(page.getByRole('tablist', { name: 'Timeline sections' })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('form', { name: 'Composer' })).toBeVisible();
	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	await expect(page.getByTestId('home-timeline-list')).toContainText('@quietadmin@pleroma.example');
	await expect(page.getByTestId('home-timeline-list')).toContainText('@datagram@retro.social');
	const avatar = page.getByTestId('home-timeline-list').getByRole('img', { name: 'quiet admin avatar' }).first();
	await expect(avatar).toHaveAttribute('src', 'https://pleroma.example/avatar.png');
	expect(await avatar.evaluate((node) => node.parentElement?.className ?? '')).not.toContain('av-orb');
	await expectNoHorizontalOverflow(page);
});

test('home timeline renders post timestamps as relative labels', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-05-22T12:00:00.000Z') });
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [{ ...statusWithText('status-relative-time', 'relative time should be readable.'), created_at: '2026-05-22T11:50:00.000Z' }]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const timestamp = page.locator('[data-status-id="status-relative-time"] .post-time');
	await expect(timestamp).toHaveText('10 minutes ago');
	await page.clock.fastForward(60_000);
	await expect(timestamp).toHaveText('11 minutes ago');
});

test('home surfaces use avatar placeholders when remote avatar images fail', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});
	await page.route('https://pleroma.example/avatar.png', async (route) => {
		await route.abort();
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page.locator('.user-chip .user-chip-av.avatar-fallback')).toBeVisible();
	await expect(page.getByTestId('profile-mini').locator('.profile-mini-avatar.avatar-fallback')).toBeVisible();
	await expect(page.locator('form.composer .composer-av.avatar-fallback')).toBeVisible();
	const postAvatar = page.locator('[data-status-id="status-1"] .post-av.avatar-fallback').first();
	await expect(postAvatar).toBeVisible();
	await expect(postAvatar.locator('img[alt="quiet admin avatar"]')).toHaveClass(/avatar-img-failed/);
});

test('home timeline autolinks safe URLs in post bodies', async ({ page }) => {
	await authenticate(page);
	const url = 'https://news.ycombinator.com/item?id=47637828';
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [statusWithText('status-link', `${url} neat project`)]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const list = page.getByTestId('home-timeline-list');
	const link = list.getByRole('link', { name: url });
	await expect(list).toContainText(`${url} neat project`);
	await expect(link).toHaveAttribute('href', url);
	await expect(link).toHaveAttribute('target', '_blank');
	await expect(link).toHaveAttribute('rel', 'ugc noopener noreferrer');
});

test('home timeline breaks unbroken status text inside the post body', async ({ page }) => {
	await authenticate(page);
	const longToken = 'fediverse'.repeat(80);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [statusWithText('status-long-token', longToken)]);
	});

	await setViewport(page, 'mobile');
	await page.goto('/app/home');

	const body = page.locator('[data-status-id="status-long-token"] .post-body');
	await expect(body).toContainText(longToken);
	const dimensions = await body.evaluate((node) => ({
		clientWidth: node.clientWidth,
		scrollWidth: node.scrollWidth,
		parentWidth: node.parentElement?.clientWidth ?? 0
	}));
	expect(dimensions.clientWidth).toBeLessThanOrEqual(dimensions.parentWidth);
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
	await expectNoHorizontalOverflow(page);
});

test('home timeline sends the OAuth token in the request', async ({ page }) => {
	await authenticate(page);
	let authorization: string | undefined;
	await mockHomeTimeline(page, async (route) => {
		authorization = route.request().headers().authorization;
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	expect(authorization).toBe('Bearer access-token');
});

test('home timeline composer uses the instance status character limit', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page, {
		...pleromaFixtures.instance,
		configuration: { statuses: { max_characters: 5000 } }
	});
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.locator('.composer .composer-av img')).toHaveAttribute('src', pleromaFixtures.account.avatar);
	await expect(page.locator('.composer-count')).toHaveText('5000');
	await page.getByRole('textbox', { name: 'Post text' }).fill('hello from a long-post instance');
	await expect(page.locator('.composer-count')).toHaveText('4969');
});

test('home timeline composer creates statuses through Pleroma', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	let createMethod: string | undefined;
	let createAuthorization: string | undefined;
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createMethod = route.request().method();
		createAuthorization = route.request().headers().authorization;
		createBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-home-status', 'posting through Pleroma composer'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');

	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('posting through Pleroma composer');
	await page.getByRole('button', { name: 'Content warning', exact: true }).click();
	await expect(composer).toContainText('posting through Pleroma composer');
	await expect(page.getByRole('button', { name: 'Content warning', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('textbox', { name: 'Content warning text' })).toBeFocused();
	await page.getByRole('textbox', { name: 'Content warning text' }).fill('soft spoiler');
	await page.getByRole('button', { name: 'Post', exact: true }).click();

	await expect(page.locator('[data-status-id="created-home-status"]')).toContainText('posting through Pleroma composer');
	await expect(composer).toBeEmpty();
	await expect(page.getByRole('textbox', { name: 'Content warning text' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Content warning', exact: true })).toHaveAttribute('aria-pressed', 'false');
	expect(createMethod).toBe('POST');
	expect(createAuthorization).toBe('Bearer access-token');
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('posting through Pleroma composer');
	expect(params.get('visibility')).toBe('public');
	expect(params.get('spoiler_text')).toBe('soft spoiler');
});

test('home timeline composer submits with keyboard shortcut', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-shortcut-status', 'shortcut post'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('shortcut post');
	await composer.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');

	await expect(page.locator('[data-status-id="created-shortcut-status"]')).toContainText('shortcut post');
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('shortcut post');
});

test('home timeline composer uploads media and submits media ids', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	let uploadAuthorization: string | undefined;
	let uploadMethod: string | undefined;
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		uploadAuthorization = route.request().headers().authorization;
		uploadMethod = route.request().method();
		await fulfillHome(route, {
			id: 'media-1',
			type: 'image',
			url: 'https://cdn.example/uploads/cat.png',
			preview_url: 'https://cdn.example/uploads/cat-thumb.png',
			description: null
		});
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-media-status', 'image attached'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('image attached');
	await page.getByLabel('Attach media').setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('cat') });

	await expect(page.getByText('cat.png')).toBeVisible();
	await expect(page.getByText('100%')).toBeVisible();
	await page.getByRole('button', { name: 'Post', exact: true }).click();

	expect(uploadMethod).toBe('POST');
	expect(uploadAuthorization).toBe('Bearer access-token');
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('image attached');
	expect(params.getAll('media_ids[]')).toEqual(['media-1']);
	await expect(page.locator('[data-status-id="created-media-status"]')).toContainText('image attached');
	await expect(page.getByText('cat.png')).toHaveCount(0);
});

test('home timeline composer can post attachments without text', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		await fulfillHome(route, {
			id: 'media-only',
			type: 'image',
			url: 'https://cdn.example/uploads/media-only.png',
			preview_url: 'https://cdn.example/uploads/media-only-thumb.png',
			description: null
		});
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-media-only-status', ''));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.getByLabel('Attach media').setInputFiles({ name: 'media-only.png', mimeType: 'image/png', buffer: Buffer.from('cat') });

	await expect(page.getByText('100%')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Post', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Post', exact: true }).click();

	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('');
	expect(params.getAll('media_ids[]')).toEqual(['media-only']);
	await expect(page.locator('[data-status-id="created-media-only-status"]')).toBeVisible();
});

test('home timeline composer only shows the drop zone while dragging files over it', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.locator('form.composer');

	await expect(composer).not.toContainText('Drag & drop');
	await expect(page.getByTestId('composer-dropzone')).toHaveCount(0);

	await composer.evaluate((node) => {
		const file = new File(['hover'], 'hover.png', { type: 'image/png' });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(file);
		node.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }));
		node.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
	});

	await expect(composer).toHaveClass(/is-drag-over/);
	await expect(page.getByTestId('composer-dropzone')).toBeVisible();
	await expect(page.getByTestId('composer-dropzone')).toContainText('Drop to attach');
	await expect(page.getByTestId('composer-dropzone')).toContainText('Max 8 files · 40 MB each');

	await composer.evaluate((node) => {
		node.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
	});

	await expect(composer).not.toHaveClass(/is-drag-over/);
	await expect(page.getByTestId('composer-dropzone')).toHaveCount(0);
});

test('home timeline composer blocks submit while uploads are pending and shows rejected files', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	let releaseUpload!: () => void;
	const uploadReleased = new Promise<void>((resolve) => {
		releaseUpload = resolve;
	});
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		await uploadReleased;
		await fulfillHome(route, {
			id: 'media-delayed',
			type: 'image',
			url: 'https://cdn.example/uploads/delayed.png',
			preview_url: 'https://cdn.example/uploads/delayed-thumb.png',
			description: null
		});
	});
	let createCount = 0;
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createCount += 1;
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-delayed-media-status', 'pending guarded'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('pending guarded');
	await page.getByLabel('Attach media').setInputFiles([
		{ name: 'delayed.png', mimeType: 'image/png', buffer: Buffer.from('cat') },
		{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('nope') }
	]);

	await expect(page.getByText('delayed.png')).toBeVisible();
	await expect(page.getByText('notes.txt', { exact: true })).toBeVisible();
	await expect(page.getByText('Could not attach notes.txt · only photos, audio, and video.')).toBeVisible();
	await composer.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
	expect(createCount).toBe(0);
	await expect(page.getByRole('button', { name: 'Post', exact: true })).toBeDisabled();

	releaseUpload();
	await expect(page.getByText('100%')).toBeVisible();
	await page.getByRole('button', { name: 'Remove notes.txt' }).click();
	await page.getByRole('button', { name: 'Post', exact: true }).click();

	expect(createCount).toBe(1);
	const params = new URLSearchParams(createdBody);
	expect(params.getAll('media_ids[]')).toEqual(['media-delayed']);
});

test('home timeline composer rejects oversize and over-limit uploads', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	let uploadCount = 0;
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		uploadCount += 1;
		await fulfillHome(route, {
			id: `media-${uploadCount}`,
			type: 'image',
			url: `https://cdn.example/uploads/${uploadCount}.png`,
			preview_url: `https://cdn.example/uploads/${uploadCount}-thumb.png`,
			description: null
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const validFiles = Array.from({ length: 8 }, (_, index) => ({ name: `ok-${index + 1}.png`, mimeType: 'image/png', buffer: Buffer.from('ok') }));
	await page.getByLabel('Attach media').setInputFiles([
		...validFiles,
		{ name: 'too-big.png', mimeType: 'image/png', buffer: Buffer.alloc(40 * 1024 * 1024 + 1) },
		{ name: 'ninth.png', mimeType: 'image/png', buffer: Buffer.from('extra') }
	]);

	await expect(page.getByText('ok-1.png')).toBeVisible();
	await expect(page.getByText('too-big.png', { exact: true })).toBeVisible();
	await expect(page.getByText('ninth.png', { exact: true })).toBeVisible();
	await expect(page.getByText('Could not attach too-big.png · 40 MB limit per file.')).toBeVisible();
	await expect(page.getByText('Could not attach ninth.png · 8 file limit.')).toBeVisible();
	expect(uploadCount).toBe(8);
});

test('home timeline composer attaches pasted and dropped files without editing text', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	let uploadCount = 0;
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		uploadCount += 1;
		await fulfillHome(route, {
			id: `media-interaction-${uploadCount}`,
			type: 'image',
			url: `https://cdn.example/uploads/interaction-${uploadCount}.png`,
			preview_url: `https://cdn.example/uploads/interaction-${uploadCount}-thumb.png`,
			description: null
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('keep text');
	await composer.evaluate((node) => {
		const file = new File(['paste'], 'pasted.png', { type: 'image/png' });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(file);
		const event = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true });
		node.dispatchEvent(event);
	});

	await expect(page.getByText('pasted.png')).toBeVisible();
	await expect(composer).toContainText('keep text');
	await expect(composer).not.toContainText('pasted.png');

	await page.locator('form.composer').evaluate((node) => {
		const file = new File(['drop'], 'dropped.png', { type: 'image/png' });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(file);
		node.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
		node.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
	});

	await expect(page.getByText('dropped.png')).toBeVisible();
	// Poll: the filename row renders before the upload POST necessarily lands;
	// a sync assertion raced it on slow CI runners (flaked once, 2026-07-09).
	await expect.poll(() => uploadCount).toBe(2);
});

test('home timeline composer autocompletes mentions and custom emoji before posting', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	await page.route(accountSearchUrl, async (route) => {
		await fulfillHome(route, [{
			...pleromaFixtures.account,
			id: 'soft-hertz',
			username: 'soft.hertz',
			acct: 'soft.hertz@kolektiva.social',
			display_name: 'soft.hertz ✦'
		}]);
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-autocomplete-status', 'hello @soft.hertz@kolektiva.social :blobcat:'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });

	await composer.click();
	await composer.pressSequentially('hello @so', { delay: 20 });
	await expect(page.getByRole('listbox', { name: 'Mention suggestions' })).toBeVisible();
	await expect(page.getByRole('option', { name: /soft.hertz/ })).toBeVisible();
	await expect(page.getByRole('option', { name: /soft.hertz.*Tab/ })).toBeVisible();
	await expect(page.locator('img[alt="soft.hertz ✦ avatar"]').first()).toHaveAttribute('src', 'https://pleroma.example/avatar.png');
	await composer.press('Enter');
	await expect(composer).toContainText('@soft.hertz');
	await expect(composer.locator('.me-pill img[alt="soft.hertz ✦ avatar"]')).toHaveAttribute('src', 'https://pleroma.example/avatar.png');

	await composer.pressSequentially(':bl');
	await expect(page.getByRole('listbox', { name: 'Emoji suggestions' })).toBeVisible();
	await expect(page.getByRole('option', { name: /:blobcat:/ })).toBeVisible();
	await expect(page.getByRole('option', { name: /:blobcat:.*Tab/ })).toBeVisible();
	await composer.press('Enter');
	await expect(composer.locator('.me-emoji img[alt=":blobcat:"]')).toBeVisible();

	await page.getByTestId('app-content').getByRole('button', { name: 'Post', exact: true }).click();
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('hello @soft.hertz@kolektiva.social :blobcat:');
	await expect(page.locator('[data-status-id="created-autocomplete-status"]')).toContainText('hello @soft.hertz@kolektiva.social :blobcat:');
	await expect(composer).toBeEmpty();
});

test('composer mention avatars fall back when remote avatar images fail', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	await page.route(accountSearchUrl, async (route) => {
		await fulfillHome(route, [{
			...pleromaFixtures.account,
			id: 'soft-hertz-dead-avatar',
			username: 'soft.hertz',
			acct: 'soft.hertz@kolektiva.social',
			display_name: 'soft.hertz ✦',
			avatar: 'https://pleroma.example/dead-mention-avatar.png',
			avatar_static: 'https://pleroma.example/dead-mention-avatar.png'
		}]);
	});
	await page.route('https://pleroma.example/dead-mention-avatar.png', async (route) => {
		await route.abort();
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });

	await composer.click();
	await expect(composer).toBeFocused();
	await composer.pressSequentially('@so', { delay: 20 });
	// Wait on the content-bearing option first: the listbox container is
	// zero-height (treated as hidden) until the mocked search resolves.
	await expect(page.getByRole('option', { name: /soft\.hertz/ })).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('listbox', { name: 'Mention suggestions' })).toBeVisible();
	const suggestionFallbackApplied = await page.evaluate(async () => {
		const row = document.querySelector('.me-pop .me-row');
		if (!row) throw new Error('mention suggestion row missing');
		const img = document.querySelector('.me-pop .me-row-av img[alt="soft.hertz ✦ avatar"]');
		if (!img) throw new Error('mention suggestion avatar missing');
		img.dispatchEvent(new Event('error'));
		await new Promise(requestAnimationFrame);
		const fallbackApplied = Boolean(document.querySelector('.me-pop .me-row-av.avatar-fallback'));
		row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		return fallbackApplied;
	});
	expect(suggestionFallbackApplied).toBe(true);

	const pillImg = composer.locator('.me-pill img[alt="soft.hertz ✦ avatar"]');
	await expect(pillImg).toHaveAttribute('src', 'https://pleroma.example/dead-mention-avatar.png');
	await page.evaluate(() => {
		const img = document.querySelector('.me-pill img[alt="soft.hertz ✦ avatar"]');
		if (!img) throw new Error('mention pill avatar missing');
		img.dispatchEvent(new Event('error'));
	});
	await expect(composer.locator('.me-pill-av.avatar-fallback')).toBeVisible();
	await expect(pillImg).toHaveClass(/avatar-img-failed/);
});

test('home timeline composer inserts custom emoji from picker before posting', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-picker-status', 'picker :blobcat:'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });

	await composer.fill('picker ');
	await page.getByRole('button', { name: 'Emoji' }).click();
	await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toBeVisible();
	await page.getByRole('textbox', { name: 'Search emoji' }).fill('cat');
	await page.getByRole('button', { name: ':blobcat:' }).click();
	await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toBeHidden();
	await expect(composer.locator('.me-emoji img[alt=":blobcat:"]')).toBeVisible();

	await page.getByTestId('app-content').getByRole('button', { name: 'Post', exact: true }).click();
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('picker :blobcat:');
	await expect(page.locator('[data-status-id="created-picker-status"]')).toContainText('picker :blobcat:');
});

test('home timeline emoji picker supports keyboard navigation and escape', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('keyboard ');
	await page.getByRole('button', { name: 'Emoji' }).click();
	const picker = page.getByRole('dialog', { name: 'Emoji picker' });
	await expect(picker).toBeVisible();
	const search = page.getByRole('textbox', { name: 'Search emoji' });
	await expect(search).toBeFocused();
	await search.fill('cat');
	await search.press('ArrowDown');
	await expect(page.getByRole('button', { name: ':blobcat:' })).toHaveAttribute('aria-pressed', 'true');
	await search.press('Enter');
	await expect(picker).toBeHidden();
	await expect(composer.locator('.me-emoji img[alt=":blobcat:"]')).toBeVisible();

	await page.getByRole('button', { name: 'Emoji' }).click();
	await expect(picker).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(picker).toBeHidden();
});

test('home timeline composer toggles poll editor and submits poll fields', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-poll-status', 'poll attached to this post'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('poll attached to this post');
	await page.getByRole('button', { name: 'Poll', exact: true }).click();
	await expect(composer).toContainText('poll attached to this post');
	await expect(page.getByRole('button', { name: 'Poll', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.composer-poll')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Post', exact: true })).toBeDisabled();

	await page.getByRole('textbox', { name: 'Poll choice 1' }).fill('warm cassette');
	await page.getByRole('textbox', { name: 'Poll choice 2' }).fill('cold terminal');
	await expect(page.getByRole('button', { name: 'Post', exact: true })).toBeEnabled();
	await expect(page.getByRole('textbox', { name: /Poll choice/ })).toHaveCount(3);
	await page.getByRole('button', { name: 'Add choice' }).click();
	await page.getByRole('button', { name: 'Add choice' }).click();
	await page.getByRole('button', { name: 'Add choice' }).click();
	await expect(page.getByRole('textbox', { name: /Poll choice/ })).toHaveCount(6);
	await expect(page.getByRole('button', { name: 'Add choice' })).toBeDisabled();
	await page.getByRole('button', { name: 'Remove choice 6' }).click();
	await page.getByRole('button', { name: 'Remove choice 5' }).click();
	await page.getByRole('button', { name: 'Remove choice 4' }).click();
	await page.getByRole('button', { name: 'Remove choice 3' }).click();
	await expect(page.getByRole('textbox', { name: /Poll choice/ })).toHaveCount(2);
	await expect(page.getByRole('button', { name: 'Remove choice 1' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Remove choice 2' })).toBeDisabled();

	await page.getByRole('button', { name: 'Content warning', exact: true }).click();
	await expect(composer).toContainText('poll attached to this post');
	await page.getByRole('textbox', { name: 'Content warning text' }).fill('poll spoiler');
	await page.getByLabel('Duration').selectOption('1h');
	await page.getByLabel('Voting').selectOption('multi');
	await page.getByRole('button', { name: 'Hide totals until poll ends' }).click();
	await expect(page.getByRole('button', { name: 'Hide totals until poll ends' })).toHaveAttribute('aria-pressed', 'false');
	await setViewport(page, 'mobile');
	await expect(page.locator('.composer-poll')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await setViewport(page, 'desktop');
	await page.getByRole('button', { name: 'Post', exact: true }).click();

	await expect(page.locator('[data-status-id="created-poll-status"]')).toContainText('poll attached to this post');
	await expect(composer).toBeEmpty();
	await expect(page.locator('.composer-poll')).toHaveCount(0);
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('poll attached to this post');
	expect(params.get('spoiler_text')).toBe('poll spoiler');
	expect(params.getAll('poll[options][]')).toEqual(['warm cassette', 'cold terminal']);
	expect(params.get('poll[expires_in]')).toBe('3600');
	expect(params.get('poll[multiple]')).toBe('true');
	expect(params.get('poll[hide_totals]')).toBe('false');
});

test('home timeline composer preserves drafts and shows inline errors on status creation failure', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillHome(route, { error: 'composer backend is tired' }, 503);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('keep this draft when posting fails');
	await page.getByRole('button', { name: 'Content warning', exact: true }).click();
	const warning = page.getByRole('textbox', { name: 'Content warning text' });
	await warning.fill('draft warning');
	await page.getByRole('button', { name: 'Post', exact: true }).click();

	await expect(page.getByRole('alert')).toContainText('Pleroma server error');
	await expect(composer).toContainText('keep this draft when posting fails');
	await expect(warning).toHaveValue('draft warning');
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('keep this draft when posting fails');
	expect(params.get('spoiler_text')).toBe('draft warning');
});

test('home timeline inline reply composer creates a reply for the selected post', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const targetStatus = { ...statusWithText('status-inline-reply', 'reply inline from the timeline'), replies_count: 0, visibility: 'unlisted' };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [targetStatus]);
	});

	let createAuthorization = '';
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createAuthorization = route.request().headers().authorization ?? '';
		createBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			...statusWithText('created-inline-reply', 'timeline inline reply body'),
			in_reply_to_id: 'status-inline-reply'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-inline-reply"]');
	const replyButton = post.getByRole('button', { name: 'Reply 0' });
	await expect(replyButton).toHaveAttribute('aria-expanded', 'false');
	await replyButton.click();
	// The pill leads with the chosen display name (chatmail handles are random
	// registration strings); the handle stays as the chip tooltip.
	const replyForm = page.getByRole('form', { name: 'Inline reply to quiet admin' });
	await expect(replyForm).toBeVisible();
	await expect(replyButton).toHaveAttribute('aria-expanded', 'true');
	await expect(replyButton).toHaveAttribute('aria-controls', await replyForm.getAttribute('id') ?? 'missing-inline-reply-id');
	await expect(replyForm).toContainText('Replying to');
	await expect(replyForm).toContainText('quiet admin');
	await expect(replyForm.locator('.thread-inline-reply-addr-chip')).toHaveAttribute('title', '@quietadmin');
	await expect(replyForm.getByRole('img', { name: 'quiet admin avatar' })).toHaveAttribute('src', 'https://pleroma.example/avatar.png');
	await replyForm.getByRole('textbox', { name: 'Reply text' }).fill('timeline inline reply body');
	await replyForm.getByRole('textbox', { name: 'Reply text' }).press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	await expect(post.getByRole('button', { name: 'Reply 1' })).toHaveAttribute('aria-expanded', 'false');
	expect(createAuthorization).toBe('Bearer access-token');
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('timeline inline reply body');
	expect(params.get('in_reply_to_id')).toBe('status-inline-reply');
	expect(params.get('visibility')).toBe('unlisted');
});

test('home timeline inline reply composer submits content warnings', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const targetStatus = { ...statusWithText('status-inline-cw', 'reply cw target'), visibility: 'unlisted' as const, replies_count: 0 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [targetStatus]);
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			...statusWithText('created-inline-cw-reply', 'reply with warning'),
			in_reply_to_id: 'status-inline-cw'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.locator('[data-status-id="status-inline-cw"]').getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to quiet admin' });
	const cwButton = replyForm.getByRole('button', { name: 'Content warning', exact: true });
	await cwButton.click();
	await expect(cwButton).toHaveAttribute('aria-pressed', 'true');
	const warning = replyForm.getByRole('textbox', { name: 'Content warning text' });
	await expect(warning).toBeFocused();
	await warning.fill('inline spoiler');
	await cwButton.click();
	await expect(replyForm.getByRole('textbox', { name: 'Content warning text' })).toHaveCount(0);
	await expect(cwButton).toHaveAttribute('aria-pressed', 'false');
	await cwButton.click();
	await replyForm.getByRole('textbox', { name: 'Content warning text' }).fill('inline spoiler');
	await replyForm.getByRole('textbox', { name: 'Reply text' }).fill('reply with warning');
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('reply with warning');
	expect(params.get('in_reply_to_id')).toBe('status-inline-cw');
	expect(params.get('visibility')).toBe('unlisted');
	expect(params.get('spoiler_text')).toBe('inline spoiler');
});

test('home timeline inline reply composer submits poll fields', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const targetStatus = { ...statusWithText('status-inline-poll', 'reply poll target'), visibility: 'unlisted' as const, replies_count: 0 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [targetStatus]);
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			...statusWithText('created-inline-poll-reply', 'reply poll'),
			in_reply_to_id: 'status-inline-poll'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.locator('[data-status-id="status-inline-poll"]').getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to quiet admin' });
	const pollButton = replyForm.getByRole('button', { name: 'Poll', exact: true });
	await replyForm.getByRole('textbox', { name: 'Reply text' }).fill('reply poll');
	await pollButton.click();
	await expect(pollButton).toHaveAttribute('aria-pressed', 'true');
	await expect(replyForm.locator('.composer-poll')).toBeVisible();
	await expect(replyForm.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
	await replyForm.getByRole('textbox', { name: 'Poll choice 1' }).fill('warm cassette');
	await replyForm.getByRole('textbox', { name: 'Poll choice 2' }).fill('cold terminal');
	await expect(replyForm.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
	await replyForm.getByLabel('Duration').selectOption('1h');
	await replyForm.getByLabel('Voting').selectOption('multi');
	await replyForm.getByRole('button', { name: 'Hide totals until poll ends' }).click();
	await expect(replyForm.getByRole('button', { name: 'Hide totals until poll ends' })).toHaveAttribute('aria-pressed', 'false');
	await pollButton.click();
	await expect(replyForm.locator('.composer-poll')).toHaveCount(0);
	await expect(pollButton).toHaveAttribute('aria-pressed', 'false');
	await pollButton.click();
	await replyForm.getByRole('textbox', { name: 'Poll choice 1' }).fill('warm cassette');
	await replyForm.getByRole('textbox', { name: 'Poll choice 2' }).fill('cold terminal');
	await replyForm.getByLabel('Duration').selectOption('1h');
	await replyForm.getByLabel('Voting').selectOption('multi');
	await replyForm.getByRole('button', { name: 'Hide totals until poll ends' }).click();
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('reply poll');
	expect(params.get('in_reply_to_id')).toBe('status-inline-poll');
	expect(params.get('visibility')).toBe('unlisted');
	expect(params.getAll('poll[options][]')).toEqual(['warm cassette', 'cold terminal']);
	expect(params.get('poll[expires_in]')).toBe('3600');
	expect(params.get('poll[multiple]')).toBe('true');
	expect(params.get('poll[hide_totals]')).toBe('false');
});

test('home timeline inline reply composer autocompletes mentions and custom emoji', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const targetStatus = { ...statusWithText('status-inline-autocomplete', 'reply autocomplete target'), replies_count: 0 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [targetStatus]);
	});
	await page.route(accountSearchUrl, async (route) => {
		await fulfillHome(route, [{
			...pleromaFixtures.account,
			id: 'soft-hertz',
			username: 'soft.hertz',
			acct: 'soft.hertz@kolektiva.social',
			display_name: 'soft.hertz ✦'
		}]);
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			...statusWithText('created-inline-autocomplete', 'reply @soft.hertz@kolektiva.social :blobcat:'),
			in_reply_to_id: 'status-inline-autocomplete'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.locator('[data-status-id="status-inline-autocomplete"]').getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to quiet admin' });
	const replyEditor = replyForm.getByRole('textbox', { name: 'Reply text' });
	await replyEditor.click();
	await replyEditor.pressSequentially('reply @so', { delay: 20 });
	await expect(replyForm.getByRole('listbox', { name: 'Mention suggestions' })).toBeVisible();
	await expect(replyForm.getByRole('option', { name: /soft.hertz.*Tab/ })).toBeVisible();
	await replyEditor.press('Enter');
	await expect(replyEditor).toContainText('@soft.hertz');
	await replyEditor.pressSequentially(':bl');
	await expect(replyForm.getByRole('listbox', { name: 'Emoji suggestions' })).toBeVisible();
	await expect(replyForm.getByRole('option', { name: /:blobcat:.*Tab/ })).toBeVisible();
	await replyEditor.press('Enter');
	await expect(replyEditor.locator('.me-emoji img[alt=":blobcat:"]')).toBeVisible();
	await replyEditor.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('reply @soft.hertz@kolektiva.social :blobcat:');
	expect(params.get('in_reply_to_id')).toBe('status-inline-autocomplete');
});

test('home timeline inline reply composer uploads media-only replies', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const targetStatus = { ...statusWithText('status-inline-media', 'reply media target'), replies_count: 0 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [targetStatus]);
	});
	let uploadAuthorization: string | undefined;
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		uploadAuthorization = route.request().headers().authorization;
		await fulfillHome(route, {
			id: 'reply-media-1',
			type: 'image',
			url: 'https://cdn.example/uploads/reply-cat.png',
			preview_url: 'https://cdn.example/uploads/reply-cat-thumb.png',
			description: null
		});
	});
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			...statusWithText('created-inline-media-reply', ''),
			in_reply_to_id: 'status-inline-media'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.locator('[data-status-id="status-inline-media"]').getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to quiet admin' });
	await expect(replyForm.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
	await replyForm.getByLabel('Attach reply media').setInputFiles({ name: 'reply-cat.png', mimeType: 'image/png', buffer: Buffer.from('cat') });

	await expect(replyForm.getByText('reply-cat.png')).toBeVisible();
	await expect(replyForm.getByRole('progressbar', { name: 'Upload progress for reply-cat.png' })).toHaveAttribute('aria-valuenow', '100');
	await expect(replyForm.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	expect(uploadAuthorization).toBe('Bearer access-token');
	const params = new URLSearchParams(createdBody);
	expect(params.get('status')).toBe('');
	expect(params.get('in_reply_to_id')).toBe('status-inline-media');
	expect(params.getAll('media_ids[]')).toEqual(['reply-media-1']);
});

test('home timeline inline reply composer inserts custom emoji from picker', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const targetStatus = { ...statusWithText('status-inline-picker', 'reply picker target'), replies_count: 0 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [targetStatus]);
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});
	let createCount = 0;
	let createdBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createCount += 1;
		createdBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			...statusWithText('created-inline-picker-reply', 'picker :blobcat:'),
			in_reply_to_id: 'status-inline-picker'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.locator('[data-status-id="status-inline-picker"]').getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to quiet admin' });
	const replyEditor = replyForm.getByRole('textbox', { name: 'Reply text' });
	await replyEditor.fill('picker ');
	await replyForm.getByRole('button', { name: 'Emoji' }).click();
	const picker = page.getByRole('dialog', { name: 'Emoji picker' });
	await expect(picker).toBeVisible();
	const search = page.getByRole('textbox', { name: 'Search emoji' });
	await search.fill('zzzz-no-results');
	await search.press('Enter');
	await expect(replyForm).toBeVisible();
	await expect(picker).toBeVisible();
	expect(createCount).toBe(0);
	await search.fill('cat');
	await page.getByRole('button', { name: ':blobcat:' }).click();
	await expect(picker).toBeHidden();
	await expect(replyEditor.locator('.me-emoji img[alt=":blobcat:"]')).toBeVisible();
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	const params = new URLSearchParams(createdBody);
	expect(createCount).toBe(1);
	expect(params.get('status')).toBe('picker :blobcat:');
	expect(params.get('in_reply_to_id')).toBe('status-inline-picker');
});

test('home timeline inline reply composer moves between targets and cancels', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const firstStatus = { ...statusWithText('status-inline-first', 'first inline target'), replies_count: 0 };
	const secondStatus = {
		...statusWithText('status-inline-second', 'second inline target'),
		account: { ...pleromaFixtures.account, id: 'account-2', username: 'datagram', acct: 'datagram@retro.social', display_name: 'datagram' },
		replies_count: 0
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [firstStatus, secondStatus]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const firstPost = page.locator('[data-status-id="status-inline-first"]');
	await firstPost.getByRole('button', { name: 'Reply 0' }).click();
	const firstForm = page.getByRole('form', { name: 'Inline reply to quiet admin' });
	await expect(firstForm).toBeVisible();
	await firstForm.getByRole('textbox', { name: 'Reply text' }).fill('draft that should close');
	await firstPost.getByRole('button', { name: 'Reply 0' }).click();
	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);

	await firstPost.getByRole('button', { name: 'Reply 0' }).click();
	await firstForm.getByRole('textbox', { name: 'Reply text' }).fill('draft that should not move');
	await page.locator('[data-status-id="status-inline-second"]').getByRole('button', { name: 'Reply 0' }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(1);
	const movedForm = page.getByRole('form', { name: 'Inline reply to datagram' });
	await expect(movedForm).toBeVisible();
	await expect(movedForm.getByRole('textbox', { name: 'Reply text' })).toBeEmpty();
	await movedForm.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
});

test('home timeline favorite and boost actions reconcile with Pleroma responses', async ({ page }) => {
	await authenticate(page);
	const actionStatus = { ...statusWithText('status-action', 'wire this post to real actions'), favourites_count: 9, reblogs_count: 4 };
	let favoriteAuthorization = '';
	let boostAuthorization = '';
	let unfavoriteAuthorization = '';
	let unboostAuthorization = '';
	let resolveFavorite: () => void = () => undefined;
	let resolveBoost: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});
	const boostPending = new Promise<void>((resolve) => {
		resolveBoost = resolve;
	});

	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [actionStatus]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action/favourite', async (route) => {
		favoriteAuthorization = route.request().headers().authorization ?? '';
		await favoritePending;
		await fulfillHome(route, { ...actionStatus, favourited: true, favourites_count: 12 });
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action/reblog', async (route) => {
		boostAuthorization = route.request().headers().authorization ?? '';
		await boostPending;
		await fulfillHome(route, { ...actionStatus, reblogged: true, reblogs_count: 7 });
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action/unfavourite', async (route) => {
		unfavoriteAuthorization = route.request().headers().authorization ?? '';
		await fulfillHome(route, { ...actionStatus, favourited: false, favourites_count: 11 });
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action/unreblog', async (route) => {
		unboostAuthorization = route.request().headers().authorization ?? '';
		await fulfillHome(route, { ...actionStatus, reblogged: false, reblogs_count: 6 });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-action"]');
	await post.getByRole('button', { name: 'Favorite 9' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => favoriteAuthorization).toBe('Bearer access-token');
	resolveFavorite();
	await expect(post.getByRole('button', { name: 'Favorite 12' })).toHaveAttribute('aria-pressed', 'true');
	await post.getByRole('button', { name: 'Favorite 12' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 11' })).toHaveAttribute('aria-pressed', 'false');
	await expect.poll(() => unfavoriteAuthorization).toBe('Bearer access-token');

	await post.getByRole('button', { name: 'Boost 4' }).click();
	await expect(post.getByRole('button', { name: 'Boost 5' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => boostAuthorization).toBe('Bearer access-token');
	resolveBoost();
	await expect(post.getByRole('button', { name: 'Boost 7' })).toHaveAttribute('aria-pressed', 'true');
	await post.getByRole('button', { name: 'Boost 7' }).click();
	await expect(post.getByRole('button', { name: 'Boost 6' })).toHaveAttribute('aria-pressed', 'false');
	await expect.poll(() => unboostAuthorization).toBe('Bearer access-token');
});

test('home timeline status action failures rollback the optimistic state', async ({ page }) => {
	await authenticate(page);
	const actionStatus = { ...statusWithText('status-action-failure', 'rollback this favorite'), favourites_count: 9 };
	let resolveFavorite: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});

	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [actionStatus]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-failure/favourite', async (route) => {
		await favoritePending;
		await fulfillHome(route, { error: 'favorite failed temporarily' }, 503);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-action-failure"]');
	await post.getByRole('button', { name: 'Favorite 9' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');
	resolveFavorite();
	await expect(post.getByRole('button', { name: 'Favorite 9' })).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByRole('alert')).toContainText('favorite failed temporarily');
});

test('home timeline keeps separate scoped errors for multiple failed actions', async ({ page }) => {
	await authenticate(page);
	const favoriteStatus = { ...statusWithText('status-action-error-a', 'first failed action'), favourites_count: 2 };
	const boostStatus = { ...statusWithText('status-action-error-b', 'second failed action'), reblogs_count: 3 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [favoriteStatus, boostStatus]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-error-a/favourite', async (route) => {
		await fulfillHome(route, { error: 'first favorite failed' }, 503);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-error-b/reblog', async (route) => {
		await fulfillHome(route, { error: 'second boost failed' }, 503);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.locator('[data-status-id="status-action-error-a"]').getByRole('button', { name: 'Favorite 2' }).click();
	await expect(page.getByText('first favorite failed')).toBeVisible();
	await page.locator('[data-status-id="status-action-error-b"]').getByRole('button', { name: 'Boost 3' }).click();

	await expect(page.getByText('first favorite failed')).toBeVisible();
	await expect(page.getByText('second boost failed')).toBeVisible();
});

test('home timeline keeps independent action state across out-of-order responses', async ({ page }) => {
	await authenticate(page);
	const actionStatus = { ...statusWithText('status-action-race', 'race these actions'), favourites_count: 9, reblogs_count: 4 };
	let resolveFavorite: () => void = () => undefined;
	let resolveBoost: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});
	const boostPending = new Promise<void>((resolve) => {
		resolveBoost = resolve;
	});

	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [actionStatus]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-race/favourite', async (route) => {
		await favoritePending;
		await fulfillHome(route, { ...actionStatus, favourited: true, favourites_count: 12, reblogged: false, reblogs_count: 4 });
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-race/reblog', async (route) => {
		await boostPending;
		await fulfillHome(route, { ...actionStatus, favourited: false, favourites_count: 9, reblogged: true, reblogs_count: 7 });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-action-race"]');
	await post.getByRole('button', { name: 'Favorite 9' }).click();
	await post.getByRole('button', { name: 'Boost 4' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');
	await expect(post.getByRole('button', { name: 'Boost 5' })).toHaveAttribute('aria-pressed', 'true');

	resolveFavorite();
	await expect(post.getByRole('button', { name: 'Favorite 12' })).toHaveAttribute('aria-pressed', 'true');
	await expect(post.getByRole('button', { name: 'Boost 5' })).toHaveAttribute('aria-pressed', 'true');

	resolveBoost();
	await expect(post.getByRole('button', { name: 'Boost 7' })).toHaveAttribute('aria-pressed', 'true');
	await expect(post.getByRole('button', { name: 'Favorite 12' })).toHaveAttribute('aria-pressed', 'true');
});

test('home timeline status action failure after navigation does not clobber thread state', async ({ page }) => {
	await authenticate(page);
	const actionStatus = { ...statusWithText('status-action-navigation', 'keep the thread after failure'), favourites_count: 9 };
	const threadLoadedStatus = { ...actionStatus, favourited: true, favourites_count: 14 };
	let resolveFavorite: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});

	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [actionStatus]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-navigation/favourite', async (route) => {
		await favoritePending;
		await fulfillHome(route, { error: 'favorite failed after navigation' }, 503);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-navigation', async (route) => {
		await fulfillHome(route, threadLoadedStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-navigation/context', async (route) => {
		await fulfillHome(route, { ancestors: [], descendants: [] });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const post = page.locator('[data-status-id="status-action-navigation"]');
	await post.getByRole('button', { name: 'Favorite 9' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');
	await post.locator('.post-body').click();
	await expect(page).toHaveURL('/app/thread/status-action-navigation');
	const focused = page.getByTestId('focused-post');
	await expect(focused).toContainText('keep the thread after failure');
	await expect(focused.getByRole('button', { name: 'Favorite 14' })).toHaveAttribute('aria-pressed', 'true');

	const favoriteResponse = page.waitForResponse('https://pleroma.example/api/v1/statuses/status-action-navigation/favourite');
	resolveFavorite();
	await favoriteResponse;
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	await expect(focused).toContainText('keep the thread after failure');
	await expect(focused.getByRole('button', { name: 'Favorite 14' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page).toHaveURL('/app/thread/status-action-navigation');
	await expect(page.getByText('favorite failed after navigation')).toHaveCount(0);
});

test('home timeline status action auth failures sign out and redirect', async ({ page }) => {
	await authenticate(page);
	const actionStatus = { ...statusWithText('status-action-auth', 'expired token action'), favourites_count: 9 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [actionStatus]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-auth/favourite', async (route) => {
		await fulfillHome(route, { error: 'The access token is invalid' }, 401);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.locator('[data-status-id="status-action-auth"]').getByRole('button', { name: 'Favorite 9' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: /quieter corner of the social web/i })).toBeVisible();
});

test('home timeline clears stale pending actions after session changes', async ({ page }) => {
	await authenticate(page);
	const nextSession = { ...session, accessToken: 'second-token', createdAt: 1700000002000 };
	const actionStatus = { ...statusWithText('status-action-session-change', 'clear stale pending actions'), favourites_count: 9 };
	const favoriteAuthorizations: string[] = [];
	let resolveFirstFavorite: () => void = () => undefined;
	const firstFavoritePending = new Promise<void>((resolve) => {
		resolveFirstFavorite = resolve;
	});

	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [actionStatus]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-action-session-change/favourite', async (route) => {
		favoriteAuthorizations.push(route.request().headers().authorization ?? '');
		if (favoriteAuthorizations.length === 1) {
			await firstFavoritePending;
			await fulfillHome(route, { ...actionStatus, favourited: true, favourites_count: 10 });
			return;
		}

		await fulfillHome(route, { ...actionStatus, favourited: true, favourites_count: 12 });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const post = page.locator('[data-status-id="status-action-session-change"]');
	await post.getByRole('button', { name: 'Favorite 9' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => favoriteAuthorizations.join('|')).toContain('Bearer access-token');

	await page.evaluate((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, nextSession);
	await page.getByRole('link', { name: 'Explore' }).first().click();
	await expect(page).toHaveURL('/app/explore');
	await page.getByRole('link', { name: 'Home' }).first().click();
	await expect(page).toHaveURL('/app/home');
	await page.locator('[data-status-id="status-action-session-change"]').getByRole('button', { name: 'Favorite 9' }).click();

	await expect.poll(() => favoriteAuthorizations.join('|')).toContain('Bearer second-token');
	resolveFirstFavorite();
});

test('home timeline renders repeated mention separators without duplicate keyed blocks', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-repeated-separators',
				content: '<p>@one  @two  @three</p>',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': '@one  @two  @three' }
				}
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page.getByTestId('home-timeline-list')).toContainText('@one  @two  @three');
});

test('home timeline renders custom emoji in post names and body text', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-custom-emoji',
				account: {
					...pleromaFixtures.status.account,
					display_name: 'zonk :fatteratte:',
					emojis: [
						{
							shortcode: 'fatteratte',
							url: 'https://cdn.example/emoji/fatteratte.png',
							static_url: 'https://cdn.example/emoji/fatteratte-static.png',
							visible_in_picker: false
						}
					]
				},
				content: 'brainfrot :blobcat:',
				emojis: [
					{
						shortcode: 'blobcat',
						url: 'https://cdn.example/emoji/blobcat.png',
						static_url: 'https://cdn.example/emoji/blobcat-static.png',
						visible_in_picker: true
					}
				],
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': 'brainfrot :blobcat:' }
				}
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const post = page.locator('[data-status-id="status-custom-emoji"]');
	await expect(post).toContainText('zonk');
	await expect(post).toContainText('brainfrot');
	await expect(post.locator('.post-name img[alt=":fatteratte:"]')).toHaveAttribute('src', 'https://cdn.example/emoji/fatteratte.png');
	await expect(post.locator('.post-body img[alt=":blobcat:"]')).toHaveAttribute('src', 'https://cdn.example/emoji/blobcat.png');
});

test('home timeline moves leading reply recipients into parent and cc chips', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-leading-recipients',
				in_reply_to_id: 'parent-status',
				in_reply_to_account_id: 'account-2',
				content: '<p>@dtluna@retro.social @feld@queer.party qwen 0.5b can handle it. has @lain tried it?</p>',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': '@dtluna@retro.social @feld@queer.party qwen 0.5b can handle it. has @lain tried it?' }
				}
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'qwen 0.5b can handle it.' }).first();
	await expect(post.locator('.post-body')).toHaveText('qwen 0.5b can handle it. has @lain tried it?');
	await expect(post.locator('.post-pinged-l')).toHaveText('Replying to');
	await expect(post.locator('.post-pinged-chip-parent .post-pinged-handle')).toHaveText('@dtluna');
	await expect(post.locator('.post-pinged-chip-parent')).toHaveAttribute('title', '@dtluna@retro.social');
	await expect(post.locator('.post-pinged-chip-parent svg')).toBeVisible();
	await expect(post.locator('.post-pinged-also')).toContainText('also');
	await expect(post.locator('.post-pinged-chip')).toHaveText('@feld');
	await expect(post.locator('.post-pinged-chip')).toHaveAttribute('title', '@feld@queer.party');
	await expect(post.locator('.post-pinged-list')).not.toContainText('@dtluna@retro.social');
	await expect(post.locator('.post-pinged-list')).not.toContainText('@feld@queer.party');
});

test('home timeline shows reply pill from metadata when the body has no leading mention', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-metadata-reply',
				in_reply_to_id: 'parent-status',
				in_reply_to_account_id: 'parent-account',
				content: 'amazing look',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': 'amazing look' },
					in_reply_to_account_acct: 'mischievoustomato@tsundere.love'
				},
				mentions: [
					{
						id: 'parent-account',
						url: 'https://tsundere.love/users/mischievoustomato',
						username: 'mischievoustomato',
						acct: 'mischievoustomato@tsundere.love'
					}
				]
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'amazing look' }).first();
	await expect(post.locator('.post-body')).toHaveText('amazing look');
	await expect(post.locator('.post-pinged-l')).toHaveText('Replying to');
	await expect(post.locator('.post-pinged-chip-parent .post-pinged-handle')).toHaveText('@mischievoustomato');
	await expect(post.locator('.post-pinged-chip-parent')).toHaveAttribute('title', '@mischievoustomato@tsundere.love');
	await expect(post.locator('.post-pinged-chip-parent')).toHaveAttribute('href', '/app/profiles/mischievoustomato%40tsundere.love');
	await expect(post.locator('.post-pinged-also')).toHaveCount(0);
});

test('home timeline reply pill shows the chosen display name for deltanet mentions', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-named-reply',
				in_reply_to_id: 'parent-status',
				in_reply_to_account_id: 'carol-account',
				content: 'welcome to the network!',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': 'welcome to the network!' },
					// Chatmail addresses have random local parts — useless as labels.
					in_reply_to_account_acct: 'zbie604yz@nine.testrun.org'
				},
				mentions: [
					{
						id: 'carol-account',
						url: 'https://pleroma.example/deltanet/contact/12',
						username: 'zbie604yz',
						acct: 'zbie604yz@nine.testrun.org',
						// deltanet's non-standard mention field: the chosen name.
						display_name: 'Carol Sparkle'
					}
				]
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'welcome to the network!' }).first();
	await expect(post.locator('.post-pinged-l')).toHaveText('Replying to');
	await expect(post.locator('.post-pinged-chip-parent .post-pinged-handle')).toHaveText('Carol Sparkle');
	// The full address stays reachable as the tooltip; the random local part
	// never renders as the label.
	await expect(post.locator('.post-pinged-chip-parent')).toHaveAttribute('title', '@zbie604yz@nine.testrun.org');
	await expect(post.locator('.post-pinged-list')).not.toContainText('zbie604yz');
});

test('home timeline shows reply pill from in_reply_to_account_id and mentions alone, without in_reply_to_account_acct', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-mentions-only-reply',
				in_reply_to_id: 'parent-status',
				in_reply_to_account_id: 'parent-account',
				content: 'the daemon filled this in without a leading mention',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': 'the daemon filled this in without a leading mention' }
				},
				mentions: [
					{
						id: 'parent-account',
						url: 'https://tsundere.love/users/mischievoustomato',
						username: 'mischievoustomato',
						acct: 'mischievoustomato@tsundere.love'
					}
				]
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'the daemon filled this in without a leading mention' }).first();
	await expect(post.locator('.post-body')).toHaveText('the daemon filled this in without a leading mention');
	await expect(post.locator('.post-pinged-l')).toHaveText('Replying to');
	await expect(post.locator('.post-pinged-chip-parent .post-pinged-handle')).toHaveText('@mischievoustomato');
	await expect(post.locator('.post-pinged-chip-parent')).toHaveAttribute('title', '@mischievoustomato@tsundere.love');
	await expect(post.locator('.post-pinged-chip-parent')).toHaveAttribute('href', '/app/profiles/mischievoustomato%40tsundere.love');
	await expect(post.locator('.post-pinged-also')).toHaveCount(0);
});

test('home timeline post menu copies raw post JSON for bug reports', async ({ page }) => {
	await authenticate(page);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					window.localStorage.setItem('deltanet.copied-post-json', text);
				}
			}
		});
	});
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'quiet CSS can still carry the voice.' }).first();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await post.getByRole('menuitem', { name: 'Copy post JSON' }).click();

	const copied = await page.evaluate(() => window.localStorage.getItem('deltanet.copied-post-json'));
	expect(copied).not.toBeNull();
	expect(JSON.parse(copied ?? '')).toMatchObject({
		id: 'status-1',
		content: '<p>quiet CSS can still carry the voice.</p>',
		pleroma: {
			content: { 'text/plain': 'quiet CSS can still carry the voice.' }
		}
	});
	await expect(post.getByRole('status', { name: 'Post JSON copy status' })).toHaveText('Copied post JSON');
});

test('home timeline truncates long account names without wrapping the post header', async ({ page }) => {
	await authenticate(page);
	const longDisplayName = "Khamenei's Top Guy Katze Kattepus :crusaderkitty: ".repeat(4).trim();
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-long-account-name',
				created_at: '2026-05-15T09:32:25.000Z',
				account: {
					...pleromaFixtures.account,
					display_name: longDisplayName,
					username: 'nerthos',
					acct: 'nerthos@shitposter.world'
				},
				content: '<p>Joseph was always on the side of the good guys.</p>',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': 'Joseph was always on the side of the good guys.' }
				}
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'Joseph was always on the side of the good guys.' }).first();
	const name = post.locator('.post-name');
	const time = post.locator('.post-time');
	const nameBox = await name.boundingBox();
	const timeBox = await time.boundingBox();
	expect(nameBox).not.toBeNull();
	expect(timeBox).not.toBeNull();
	expect(Math.abs((nameBox?.y ?? 0) - (timeBox?.y ?? 0))).toBeLessThanOrEqual(2);
	expect(await name.evaluate((node) => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis')).toBe(true);
	await expectNoHorizontalOverflow(page);
});

test('home timeline renders real media attachments from Pleroma statuses', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-photo-attachment',
				content: '<p>photo attached</p>',
				pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'photo attached' } },
				media_attachments: [
					{ id: 'photo-1', type: 'image', url: 'https://cdn.example/media/photo.jpg', preview_url: 'https://cdn.example/media/photo-preview.jpg', description: 'two cats in a window' }
				]
			},
			{
				...pleromaFixtures.status,
				id: 'status-video-attachment',
				content: '<p>video attached</p>',
				pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'video attached' } },
				media_attachments: [
					{ id: 'video-1', type: 'video', url: 'https://cdn.example/media/clip.mp4', preview_url: 'https://cdn.example/media/clip.jpg', description: 'short clip' }
				]
			},
			{
				...pleromaFixtures.status,
				id: 'status-audio-attachment',
				content: '<p>audio attached</p>',
				pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'audio attached' } },
				media_attachments: [
					{ id: 'audio-1', type: 'audio', url: 'https://cdn.example/media/field.mp3', description: 'field recording' }
				]
			},
			{
				...pleromaFixtures.status,
				id: 'status-mixed-video-attachment',
				content: '<p>mixed video attached</p>',
				pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'mixed video attached' } },
				media_attachments: [
					{ id: 'photo-2', type: 'image', url: 'https://cdn.example/media/second-photo.jpg', preview_url: 'https://cdn.example/media/second-photo-preview.jpg', description: 'second photo' },
					{ id: 'video-2', type: 'video', url: 'https://cdn.example/media/second-clip.mp4', preview_url: 'https://cdn.example/media/blank-video-preview.jpg', description: 'second clip' }
				]
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const list = page.getByTestId('home-timeline-list');
	await expect(page.locator('filter#duotoneCream')).toHaveCount(1);
	await expect(list.locator('.post-photos img[alt="two cats in a window"]')).toHaveAttribute('src', 'https://cdn.example/media/photo.jpg');
	const photo = list.locator('.post-photos img[alt="two cats in a window"]');
	const duotoneOverlay = list.locator('.post-photos .ph-duotone').first();
	expect(await photo.evaluate((node) => getComputedStyle(node).filter)).toBe('none');
	expect(await duotoneOverlay.evaluate((node) => getComputedStyle(node).filter)).toContain('duotoneCream');
	expect(await duotoneOverlay.evaluate((node) => {
		const style = getComputedStyle(node);
		return style.transitionProperty.includes('opacity') && style.transitionDuration === '0.6s';
	})).toBe(true);
	const photoVisual = list.locator('.post-photos .ph-visual').first();
	expect(await photoVisual.evaluate((node) => {
		const style = getComputedStyle(node);
		return style.transitionProperty.includes('transform') && style.transitionDuration === '0.6s';
	})).toBe(true);
	await list.locator('.post-photos .ph').first().hover();
	await expect(photo).toHaveCSS('transform', 'none');
	await expect(photoVisual).toHaveCSS('transform', /matrix\(1\.015/);
	const videoPost = list.locator('[data-status-id="status-video-attachment"]');
	const inlineVideo = videoPost.locator('.pv-native');
	await expect(inlineVideo).toHaveAttribute('src', 'https://cdn.example/media/clip.mp4');
	await expect(inlineVideo).toHaveAttribute('poster', 'https://cdn.example/media/clip.jpg');
	expect(await primeVideoMetadata(inlineVideo)).toBe(1);
	expect(await inlineVideo.getAttribute('poster')).toBeNull();
	const videoOverlay = videoPost.locator('.pv-duotone');
	expect(await inlineVideo.evaluate((node) => getComputedStyle(node).filter)).toBe('none');
	expect(await videoOverlay.evaluate((node) => {
		const style = getComputedStyle(node);
		return style.filter.includes('duotoneCream') && style.transitionProperty.includes('opacity') && style.transitionDuration === '0.6s';
	})).toBe(true);
	await expect(videoOverlay).toHaveCSS('opacity', '1');
	await videoPost.locator('.post-video').hover();
	await expect(videoOverlay).toHaveCSS('opacity', '0');
	await page.mouse.move(0, 0);
	await expect(videoOverlay).toHaveCSS('opacity', '1');
	expect(await startPrimedVideo(inlineVideo)).toBe(0);
	await expect(videoOverlay).toHaveCSS('opacity', '0');
	const audioPost = list.locator('[data-status-id="status-audio-attachment"]');
	const audioSource = audioPost.locator('audio');
	const audioWaveform = audioPost.getByRole('slider', { name: 'Seek audio' });
	await expect(audioPost.locator('.post-audio')).toBeVisible();
	await expect(audioWaveform).toBeVisible();
	await expect(audioPost.locator('.pa-bar')).toHaveCount(56);
	await expect(audioPost.locator('.pa-title')).toHaveText('field recording');
	await expect(audioSource).toHaveAttribute('src', 'https://cdn.example/media/field.mp3');
	expect(await audioSource.getAttribute('controls')).toBeNull();
	await expect(audioWaveform).toHaveAttribute('aria-valuenow', '0');
	await audioSource.evaluate((node) => {
		const media = node as HTMLMediaElement;
		const calls = { play: 0, pause: 0 };
		(window as Window & { __audioPlaybackCalls?: typeof calls }).__audioPlaybackCalls = calls;
		Object.defineProperty(media, 'duration', { configurable: true, get: () => 124 });
		Object.defineProperty(media, 'currentTime', { configurable: true, writable: true, value: 0 });
		Object.defineProperty(media, 'play', {
			configurable: true,
			value: () => {
				calls.play += 1;
				media.dispatchEvent(new Event('play'));
				return Promise.resolve();
			}
		});
		Object.defineProperty(media, 'pause', {
			configurable: true,
			value: () => {
				calls.pause += 1;
				media.dispatchEvent(new Event('pause'));
			}
		});
		media.dispatchEvent(new Event('loadedmetadata'));
	});
	await expect(audioPost.locator('.pa-time')).toHaveText('0:00 / 2:04');
	await audioPost.locator('.pa-cover').click();
	await expect(audioPost.locator('.pa-cover')).toHaveAttribute('aria-label', 'Pause');
	expect(await page.evaluate(() => (window as unknown as { __audioPlaybackCalls: { play: number; pause: number } }).__audioPlaybackCalls)).toEqual({ play: 1, pause: 0 });
	await audioPost.locator('.pa-cover').click();
	await expect(audioPost.locator('.pa-cover')).toHaveAttribute('aria-label', 'Play');
	expect(await page.evaluate(() => (window as unknown as { __audioPlaybackCalls: { play: number; pause: number } }).__audioPlaybackCalls)).toEqual({ play: 1, pause: 1 });
	const waveformBox = await audioWaveform.boundingBox();
	expect(waveformBox).not.toBeNull();
	await audioWaveform.click({ position: { x: (waveformBox?.width ?? 2) / 2, y: (waveformBox?.height ?? 2) / 2 } });
	const midpointTime = await audioSource.evaluate((node) => (node as HTMLMediaElement).currentTime);
	expect(midpointTime).toBeGreaterThan(50);
	expect(midpointTime).toBeLessThan(75);
	await audioWaveform.focus();
	await page.keyboard.press('Home');
	await expect(audioWaveform).toHaveAttribute('aria-valuenow', '0');
	await page.keyboard.press('ArrowRight');
	const keyboardTime = await audioSource.evaluate((node) => (node as HTMLMediaElement).currentTime);
	expect(keyboardTime).toBeGreaterThan(5);
	expect(keyboardTime).toBeLessThan(7);
	const mixedPost = list.locator('[data-status-id="status-mixed-video-attachment"]');
	const stripVideo = mixedPost.locator('.media-strip-tile .media-strip-preview');
	await expect(stripVideo).toHaveAttribute('src', 'https://cdn.example/media/second-clip.mp4');
	await expect(stripVideo).toHaveAttribute('poster', 'https://cdn.example/media/blank-video-preview.jpg');
	expect(await primeVideoMetadata(stripVideo)).toBe(1);
	expect(await stripVideo.getAttribute('poster')).toBeNull();
	const stripVideoOverlay = mixedPost.locator('.media-strip-tile.mst-video .media-strip-duotone');
	expect(await stripVideo.evaluate((node) => getComputedStyle(node).filter)).toBe('none');
	expect(await stripVideoOverlay.evaluate((node) => {
		const style = getComputedStyle(node);
		return style.filter.includes('duotoneCream') && style.transitionProperty.includes('opacity') && style.transitionDuration === '0.6s';
	})).toBe(true);
	await expect(stripVideoOverlay).toHaveCSS('opacity', '1');
	await mixedPost.locator('.media-strip-tile.mst-video').hover();
	await expect(stripVideoOverlay).toHaveCSS('opacity', '0');
	await expect(list.locator('.post-media')).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test('home timeline renders poll attachments below media without opening the thread', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [{
			...pleromaFixtures.status,
			id: 'status-media-poll',
			content: '<p>which side wins?</p>',
			pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'which side wins?' } },
			media_attachments: [
				{ id: 'poll-photo', type: 'image', url: 'https://cdn.example/media/poll-photo.jpg', preview_url: 'https://cdn.example/media/poll-photo-preview.jpg', description: 'poll photo' }
			],
			poll: {
				id: 'poll-home',
				options: [
					{ title: 'warm cassette', votes_count: 142 },
					{ title: 'cold terminal', votes_count: 38 },
					{ title: 'spinning vinyl', votes_count: 214 }
				],
				votes_count: 394,
				multiple: false,
				expired: false,
				ends_in: '6h 12m',
				own_votes: []
			}
		}]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-media-poll"]');
	await expect(post.locator('.post-photos img[alt="poll photo"]')).toHaveAttribute('src', 'https://cdn.example/media/poll-photo.jpg');
	await expect(post.locator('.post-poll')).toContainText('warm cassette');
	const boxes = await post.evaluate((node) => {
		const photo = node.querySelector('.post-photos')?.getBoundingClientRect();
		const poll = node.querySelector('.post-poll')?.getBoundingClientRect();
		return photo && poll ? { photoBottom: photo.bottom, pollTop: poll.top } : null;
	});
	expect(boxes).not.toBeNull();
	expect(boxes?.pollTop ?? 0).toBeGreaterThanOrEqual(boxes?.photoBottom ?? 0);

	await post.locator('.post-poll-vote-row').filter({ hasText: 'warm cassette' }).click();
	await expect(post.getByRole('radio', { name: 'warm cassette' })).toBeChecked();
	await expect(post.getByRole('button', { name: 'Vote' })).toBeEnabled();
	await expect(post.locator('.post-poll-row')).toHaveCount(0);
	await expect(post.locator('.post-poll')).not.toContainText('you voted');
	await expect(page).toHaveURL('/app/home');

	await post.locator('.post-photos button').click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('.lightbox-photo')).toHaveAttribute('src', 'https://cdn.example/media/poll-photo.jpg');
	await expect(dialog).toContainText('1 of 1');
	await expect(dialog).not.toContainText('warm cassette');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('home timeline folds content warnings around body and media until revealed', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [{
			...statusWithText('status-cw-media', 'hidden timeline words with attached proof'),
			spoiler_text: 'timeline spoiler',
			pleroma: {
				...pleromaFixtures.status.pleroma,
				content: { 'text/plain': 'hidden timeline words with attached proof' },
				spoiler_text: { 'text/plain': 'timeline spoiler' }
			},
			media_attachments: [
				{ id: 'cw-photo', type: 'image', url: 'https://cdn.example/media/cw-photo.jpg', preview_url: 'https://cdn.example/media/cw-photo-preview.jpg', description: 'cw hidden photo' }
			]
		}]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-cw-media/favourite', async (route) => {
		await fulfillHome(route, { ...statusWithText('status-cw-media', 'hidden timeline words with attached proof'), favourited: true, favourites_count: 10 });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-cw-media"]');
	await expect(post.locator('.post-cw-card')).toContainText('timeline spoiler');
	await expect(post.locator('.post-cw-meta-chip')).toContainText(['1 photo', '~6 words']);
	await expect(post).not.toContainText('hidden timeline words');
	await expect(post.locator('.post-photos')).toHaveCount(0);
	await post.getByRole('button', { name: 'Favorite 9' }).click();
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');

	await post.getByRole('button', { name: 'Show post' }).click();
	await expect(post).toContainText('hidden timeline words with attached proof');
	await expect(post.locator('.post-photos img[alt="cw hidden photo"]')).toHaveAttribute('src', 'https://cdn.example/media/cw-photo.jpg');
	await expect(page).toHaveURL('/app/home');
	await post.getByRole('button', { name: 'Hide' }).click();
	await expect(post).not.toContainText('hidden timeline words');
	await expect(post.getByRole('button', { name: 'Favorite 10' })).toHaveAttribute('aria-pressed', 'true');
});

test('home timeline renders boosted Pleroma statuses with attribution and media actions', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const original = {
		...statusWithText('boosted-original', 'dusk in the city'),
		account: {
			...pleromaFixtures.account,
			id: 'orbit-account',
			username: 'orbit',
			acct: 'orbit@spacebear.net',
			display_name: 'orbit'
		},
		media_attachments: [
			{
				id: 'boost-photo',
				type: 'image',
				url: 'https://cdn.example/boost-photo.jpg',
				preview_url: 'https://cdn.example/boost-photo-preview.jpg',
				description: 'boosted photo'
			}
		]
	};
	const wrapper = {
		...statusWithText('boost-wrapper', ''),
		account: {
			...pleromaFixtures.account,
			id: 'booster-account',
			username: 'booster-with-a-very-long-unbroken-handle',
			acct: 'booster-with-a-very-long-unbroken-handle@pleroma.example',
			display_name: 'booster-with-a-very-long-unbroken-display-name-that-should-clip'
		},
		reblog: original
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [wrapper]);
	});
	let boostActionPath = '';
	await page.route('https://pleroma.example/api/v1/statuses/boosted-original/reblog', async (route) => {
		boostActionPath = new URL(route.request().url()).pathname;
		await fulfillHome(route, { ...original, reblogged: true, reblogs_count: 5 });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const boost = page.locator('.post-boost').first();
	const boostAttr = boost.locator('> .post-boost-attr');
	await expect(boost).toHaveCSS('border-left-width', '4px');
	await expect(boost.locator('> .post-boost-rail')).toHaveCount(0);
	await expect(boostAttr.locator('.post-boost-tag')).toContainText('boost');
	await expect(boostAttr.locator('.post-boost-av')).toBeVisible();
	await expect(boostAttr.locator('.post-boost-name')).toContainText('booster');
	await expect(boostAttr.locator('.post-boost-handle')).toContainText('@booster-with-a-very-long-unbroken-handle@pleroma.example');
	await expect(boostAttr.locator('.post-boost-name')).toHaveCSS('text-overflow', 'ellipsis');
	await expect(boostAttr.locator('.post-boost-handle')).toHaveCSS('text-overflow', 'ellipsis');
	await expect(boost.locator('.post')).toContainText('orbit');
	await expect(boost.locator('.post')).toContainText('dusk in the city');
	await boost.locator('.post').getByRole('button', { name: 'Boost 4' }).click();
	await expect(boost.locator('.post').getByRole('button', { name: 'Boost 5' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => boostActionPath).toBe('/api/v1/statuses/boosted-original/reblog');
	await setViewport(page, 'mobile');
	const mobileNameBox = await boostAttr.locator('.post-boost-name').boundingBox();
	const mobileHandleBox = await boostAttr.locator('.post-boost-handle').boundingBox();
	expect(mobileNameBox?.width ?? 0).toBeGreaterThan(40);
	expect(mobileHandleBox?.width ?? 0).toBeGreaterThan(40);
	await expectElementIsTruncatedWithinParent(boostAttr.locator('.post-boost-name'));
	await expectElementIsTruncatedWithinParent(boostAttr.locator('.post-boost-handle'));
	await expectNoHorizontalOverflow(page);
	await setViewport(page, 'desktop');
	await boost.locator('.post-photos button').click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('.lightbox-photo')).toHaveAttribute('src', 'https://cdn.example/boost-photo.jpg');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(dialog).toBeHidden();

	await boost.locator('.post-body').click();
	await expect(page).toHaveURL('/app/thread/boosted-original');
});

test('home timeline renders Pleroma quote posts as embedded quote cards', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const quotedStatus = {
		...statusWithText('quoted-status', 'quoted status body'),
		url: 'https://remote.example/objects/quoted-status',
		uri: 'https://remote.example/objects/quoted-status',
		account: {
			...pleromaFixtures.account,
			id: 'quoted-account',
			username: 'quoted',
			acct: 'quoted@remote.example',
			display_name: 'quoted source',
			avatar: 'https://remote.example/avatar.jpg',
			avatar_static: 'https://remote.example/avatar-static.jpg'
		},
		created_at: '2026-05-20T11:26:57.000Z',
		replies_count: 1,
		reblogs_count: 2,
		favourites_count: 3,
		media_attachments: [],
		pleroma: {
			...pleromaFixtures.status.pleroma,
			content: { 'text/plain': 'quoted status body' },
			quote: null,
			quote_visible: false
		}
	};
	const wrapper = {
		...statusWithText('quote-wrapper', 'Me and who?RT: https://remote.example/objects/quoted-status'),
		content: 'Me and who?<span class="quote-inline"><br/><br/><bdi>RT:</bdi> <a href="https://remote.example/objects/quoted-status">https://remote.example/objects/quoted-status</a></span>',
		pleroma: {
			...pleromaFixtures.status.pleroma,
			content: { 'text/plain': 'Me and who?RT: https://remote.example/objects/quoted-status' },
			quote: quotedStatus,
			quote_id: 'quoted-status',
			quote_url: 'https://remote.example/objects/quoted-status',
			quote_visible: true
		}
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [wrapper]);
	});
	await page.route('https://pleroma.example/api/v1/statuses/quoted-status', async (route) => {
		await fulfillHome(route, quotedStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/quoted-status/context', async (route) => {
		await fulfillHome(route, { ancestors: [], descendants: [] });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="quote-wrapper"]');
	await expect(post.locator('.post-body')).toContainText('Me and who?');
	await expect(post.locator('.post-body')).not.toContainText('RT: https://remote.example/objects/quoted-status');
	const quote = post.locator('.quoted-card');
	await expect(quote).toContainText('quoted source');
	await expect(quote).toContainText('@quoted@remote.example');
	await expect(quote).toContainText('quoted status body');
	await expect(quote).toContainText('↩ 1');
	await expect(quote).toContainText('↻ 2');
	await expect(quote).toContainText('★ 3');
	await expect(quote.locator('img[alt="quoted source avatar"]')).toHaveAttribute('src', 'https://remote.example/avatar.jpg');
	await expect(quote).toHaveAttribute('href', '/app/thread/quoted-status');

	await quote.getByText('view original →').click();
	await expect(page).toHaveURL('/app/thread/quoted-status');
	await expect(page.getByTestId('thread-view')).toContainText('quoted status body');

	await page.goBack();
	await expect(page).toHaveURL('/app/home');
	const quoteAfterBack = page.locator('[data-status-id="quote-wrapper"] .quoted-card');
	await quoteAfterBack.click({ position: { x: 24, y: 24 } });
	await expect(page).toHaveURL('/app/thread/quoted-status');
});

test('home timeline loads the next cursor page, deduplicates overlap, and keeps status ids', async ({ page }) => {
	await authenticate(page);
	let releaseNextPage: () => void = () => undefined;
	const nextPagePending = new Promise<void>((resolve) => {
		releaseNextPage = resolve;
	});
	const requestedMaxIds: Array<string | null> = [];
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		const maxId = url.searchParams.get('max_id');
		requestedMaxIds.push(maxId);

		if (maxId === 'status-2') {
			await nextPagePending;
			await fulfillHome(route, [pleromaFixtures.timelines.home[1], statusWithText('status-3', 'older pagination post')]);
			return;
		}

		await fulfillHome(route, pleromaFixtures.timelines.home, 200, {
			link: '<https://pleroma.example/api/v1/timelines/home?max_id=status-2>; rel="next"'
		});
	});
	let favoriteActionPath = '';
	await page.route('https://pleroma.example/api/v1/statuses/status-3/favourite', async (route) => {
		favoriteActionPath = new URL(route.request().url()).pathname;
		await fulfillHome(route, { ...statusWithText('status-3', 'older pagination post'), favourited: true, favourites_count: 10 });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('quiet CSS can still carry the voice.');
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByRole('status', { name: 'Timeline pagination status' })).toContainText('Loading older posts');
	releaseNextPage();
	await expect(list).toContainText('older pagination post');
	await expect(page.locator('[data-status-id="status-1"]')).toHaveCount(1);
	await expect(page.locator('[data-status-id="status-2"]')).toHaveCount(1);
	await expect(page.locator('[data-status-id="status-3"]')).toHaveCount(1);
	await expect(page.locator('[data-action-status-id="status-3"]')).toHaveCount(1);
	await page.locator('[data-status-id="status-3"]').getByRole('button', { name: 'Favorite 9' }).click();
	await expect.poll(() => favoriteActionPath).toBe('/api/v1/statuses/status-3/favourite');
	await expect(page.getByText('No older posts')).toBeVisible();
	expect(requestedMaxIds).toEqual([null, 'status-2']);
});

test('home timeline retries load-more errors with the same cursor', async ({ page }) => {
	await authenticate(page);
	let nextAttempts = 0;
	const requestedMaxIds: Array<string | null> = [];
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		const maxId = url.searchParams.get('max_id');
		requestedMaxIds.push(maxId);

		if (maxId !== 'status-2') {
			await fulfillHome(route, pleromaFixtures.timelines.home, 200, {
				link: '<https://pleroma.example/api/v1/timelines/home?max_id=status-2>; rel="next"'
			});
			return;
		}

		nextAttempts += 1;
		if (nextAttempts === 1) {
			await fulfillHome(route, { error: 'maintenance' }, 503);
			return;
		}

		await fulfillHome(route, [statusWithText('status-4', 'older post after retry')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('quiet CSS can still carry the voice.');
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.getByText('Pleroma server error')).toBeVisible();
	await expect(list).toContainText('quiet CSS can still carry the voice.');
	await page.getByRole('button', { name: 'Retry load more' }).click();
	await expect(list).toContainText('older post after retry');
	expect(nextAttempts).toBe(2);
	expect(requestedMaxIds).toEqual([null, 'status-2', 'status-2']);
});

test('home timeline opens a user stream and queues streamed posts behind the indicator', async ({ page }) => {
	await authenticate(page);
	const requestedSinceIds: Array<string | null> = [];
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		requestedSinceIds.push(url.searchParams.get('since_id'));
		await fulfillHome(route, [statusWithText('status-1', 'stable existing post')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('stable existing post');
	expect(await page.evaluate(() => {
		const testWindow = window as typeof window & { __deltanetSockets?: Array<{ url: string }> };
		return testWindow.__deltanetSockets?.[0]?.url;
	})).toBe('wss://pleroma.example/api/v1/streaming/?stream=user&ticket=stream-ticket-1');

	await emitStreamUpdate(page, statusWithText('status-stream', 'fresh streamed post'));
	const indicator = page.getByTestId('timeline-header-actions').getByRole('button', { name: '1 new posts' });
	await expect(page.getByRole('tablist', { name: 'Timeline sections' }).getByRole('button', { name: '1 new posts' })).toHaveCount(0);
	await expect(indicator).toBeVisible();
	await expect(list).not.toContainText('fresh streamed post');
	await indicator.click();
	await expect(list).toContainText('fresh streamed post');
	expect(requestedSinceIds).toEqual([null]);

	await page.getByRole('link', { name: 'Explore' }).first().click();
	await expect(page.getByRole('heading', { name: 'Explore the network' })).toBeVisible();
	expect(await page.evaluate(() => {
		const testWindow = window as typeof window & { __deltanetSockets?: Array<{ closeCalled: boolean }> };
		return testWindow.__deltanetSockets?.[0]?.closeCalled;
	})).toBe(true);
});

test('home timeline fallback backfills gaps behind streamed posts', async ({ page }) => {
	await authenticate(page);
	const requestedSinceIds: Array<string | null> = [];
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		const sinceId = url.searchParams.get('since_id');
		requestedSinceIds.push(sinceId);

		if (sinceId === 'status-1') {
			await fulfillHome(route, [
				statusWithText('status-3', 'streamed newest post'),
				statusWithText('status-2', 'missed gap post')
			]);
			return;
		}

		await fulfillHome(route, [statusWithText('status-1', 'stable existing post')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('stable existing post');

	await emitStreamUpdate(page, statusWithText('status-3', 'streamed newest post'));
	await expect(page.getByRole('button', { name: '1 new posts' })).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new Event('deltanet:check-home-timeline')));
	await expect.poll(() => requestedSinceIds).toEqual([null, 'status-1']);

	await page.getByRole('button', { name: /\d+ new posts/ }).click();
	await expect(list).toContainText('streamed newest post');
	await expect(list).toContainText('missed gap post');
	const renderedStatusIds = await page.locator('[data-status-id]').evaluateAll((nodes) => nodes.slice(0, 3).map((node) => node.getAttribute('data-status-id')));
	expect(renderedStatusIds).toEqual(['status-3', 'status-2', 'status-1']);
});

test('home timeline keeps loaded posts when the user stream cannot open', async ({ page }) => {
	await authenticateWithThrowingWebSocket(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [statusWithText('status-1', 'stable existing post')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page.getByTestId('home-timeline-list')).toContainText('stable existing post');
	await expect(page.getByRole('button', { name: 'Retry request' })).toHaveCount(0);
});

test('home timeline stream errors run a fallback check without dropping loaded posts', async ({ page }) => {
	await authenticate(page);
	const requestedSinceIds: Array<string | null> = [];
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		const sinceId = url.searchParams.get('since_id');
		requestedSinceIds.push(sinceId);

		if (sinceId === 'status-1') {
			await fulfillHome(route, [statusWithText('status-error-recovery', 'fresh post after stream error')]);
			return;
		}

		await fulfillHome(route, [statusWithText('status-1', 'stable existing post')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('stable existing post');

	await emitStreamError(page);
	await expect.poll(() => requestedSinceIds).toEqual([null, 'status-1']);
	await expect(list).toContainText('stable existing post');
	await page.getByRole('button', { name: '1 new posts' }).click();
	await expect(list).toContainText('fresh post after stream error');
	expect(await page.evaluate(() => {
		const testWindow = window as typeof window & { __deltanetSockets?: Array<{ closeCalled: boolean }> };
		return testWindow.__deltanetSockets?.[0]?.closeCalled;
	})).toBe(true);
});

test('home timeline ignores initial responses after leaving home while loading', async ({ page }) => {
	await authenticate(page);
	let releaseRequest: () => void = () => undefined;
	let responseFulfilled = false;
	const pending = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await mockHomeTimeline(page, async (route) => {
		await pending;
		await fulfillHome(route, [statusWithText('status-1', 'stable existing post')]);
		responseFulfilled = true;
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.getByRole('status', { name: 'Request status' })).toContainText('Loading Pleroma data');
	await page.getByRole('link', { name: 'Explore' }).first().click();
	await expect(page.getByRole('heading', { name: 'Explore the network' })).toBeVisible();
	const socketCountAfterNavigation = await page.evaluate(() => {
		const testWindow = window as typeof window & { __deltanetSockets?: unknown[] };
		return testWindow.__deltanetSockets?.length ?? 0;
	});

	releaseRequest();
	await expect.poll(() => responseFulfilled).toBe(true);
	expect(await page.evaluate(() => {
		const testWindow = window as typeof window & { __deltanetSockets?: unknown[] };
		return testWindow.__deltanetSockets?.length ?? 0;
	})).toBe(socketCountAfterNavigation);
});

test('home timeline empty-stream fallback refreshes without a stream-only cursor', async ({ page }) => {
	await authenticate(page);
	const requestedSinceIds: Array<string | null> = [];
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		requestedSinceIds.push(url.searchParams.get('since_id'));

		if (requestedSinceIds.length === 1) {
			await fulfillHome(route, []);
			return;
		}

		await fulfillHome(route, [
			statusWithText('status-3', 'streamed empty newest post'),
			statusWithText('status-2', 'missed empty gap post')
		], 200, {
			link: '<https://pleroma.example/api/v1/timelines/home?max_id=status-2>; rel="next"'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.getByText('No posts yet')).toBeVisible();

	await emitStreamUpdate(page, statusWithText('status-3', 'streamed empty newest post'));
	await page.getByRole('button', { name: '1 new posts' }).click();
	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('streamed empty newest post');

	await page.evaluate(() => window.dispatchEvent(new Event('deltanet:check-home-timeline')));
	await expect.poll(() => requestedSinceIds).toEqual([null, null]);
	await expect(list).toContainText('missed empty gap post');
	const renderedStatusIds = await page.locator('[data-status-id]').evaluateAll((nodes) => nodes.slice(0, 2).map((node) => node.getAttribute('data-status-id')));
	expect(renderedStatusIds).toEqual(['status-3', 'status-2']);
	await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
});

test('home timeline fallback trigger shows new-post indicator, prepends on activation, dedupes, and scrolls to top', async ({ page }) => {
	await authenticate(page);
	const initialStatuses = Array.from({ length: 12 }, (_, index) => statusWithText(`status-${index + 1}`, `older timeline post ${index + 1}`));
	const requestedSinceIds: Array<string | null> = [];
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		const sinceId = url.searchParams.get('since_id');
		requestedSinceIds.push(sinceId);

		if (sinceId === 'status-1') {
			await fulfillHome(route, [statusWithText('status-new', 'fresh new post from fallback check'), initialStatuses[0]]);
			return;
		}

		await fulfillHome(route, initialStatuses);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('older timeline post 1');
	await page.evaluate(() => window.scrollTo(0, 520));
	const scrollBefore = await page.evaluate(() => window.scrollY);
	expect(scrollBefore).toBeGreaterThan(0);

	await page.evaluate(() => window.dispatchEvent(new Event('deltanet:check-home-timeline')));
	const indicator = page.getByTestId('timeline-header-actions').getByRole('button', { name: '1 new posts' });
	await expect(indicator).toBeVisible();
	await expect(list).not.toContainText('fresh new post from fallback check');
	await indicator.click();

	await expect(list).toContainText('fresh new post from fallback check');
	await expect(page.locator('[data-status-id="status-new"]')).toHaveCount(1);
	await expect(page.locator('[data-status-id="status-1"]')).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
	expect(requestedSinceIds).toEqual([null, 'status-1']);
});

test('home timeline new-post check errors keep the timeline usable and recover on the next trigger', async ({ page }) => {
	await authenticate(page);
	let checkAttempts = 0;
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get('since_id') === 'status-1') {
			checkAttempts += 1;
			if (checkAttempts === 1) {
				await fulfillHome(route, { error: 'maintenance' }, 503);
				return;
			}

			await fulfillHome(route, [statusWithText('status-new-after-error', 'fresh post after retry')]);
			return;
		}

		await fulfillHome(route, [statusWithText('status-1', 'stable existing post')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const list = page.getByTestId('home-timeline-list');
	await expect(list).toContainText('stable existing post');

	await page.evaluate(() => window.dispatchEvent(new Event('deltanet:check-home-timeline')));
	await expect.poll(() => checkAttempts).toBe(1);
	await expect(list).toContainText('stable existing post');
	await expect(page.getByText('Pleroma server error')).toHaveCount(0);

	await page.evaluate(() => window.dispatchEvent(new Event('deltanet:check-home-timeline')));
	await expect(page.getByRole('button', { name: '1 new posts' })).toBeVisible();
	await page.getByRole('button', { name: '1 new posts' }).click();
	await expect(list).toContainText('fresh post after retry');
	expect(checkAttempts).toBe(2);
});

test('home timeline ignores auth errors from stale new-post checks after the session changes', async ({ page }) => {
	await authenticate(page);
	const nextSession = { ...session, accessToken: 'fresh-token', createdAt: 1700000002000 };
	let releaseCheck: () => void = () => undefined;
	let markCheckStarted: () => void = () => undefined;
	const checkStarted = new Promise<void>((resolve) => {
		markCheckStarted = resolve;
	});
	const pendingCheck = new Promise<void>((resolve) => {
		releaseCheck = resolve;
	});
	await mockHomeTimeline(page, async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get('since_id') === 'status-1') {
			markCheckStarted();
			await pendingCheck;
			await fulfillHome(route, { error: 'old token expired' }, 401);
			return;
		}

		await fulfillHome(route, [statusWithText('status-1', 'stable existing post')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.getByTestId('home-timeline-list')).toContainText('stable existing post');
	await page.evaluate(() => window.dispatchEvent(new Event('deltanet:check-home-timeline')));
	await checkStarted;
	await page.evaluate((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, nextSession);
	await page.getByRole('link', { name: 'Explore' }).first().click();
	await expect(page.getByRole('heading', { name: 'Explore the network' })).toBeVisible();

	releaseCheck();
	await expect(page).toHaveURL('/app/explore');
	expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('deltanet.session') ?? '{}').accessToken)).toBe('fresh-token');
});

test('home timeline renders empty state from mocked API response', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page.getByText('No posts yet')).toBeVisible();
	await expect(page.getByText('Your home timeline is empty. Follow accounts to see posts here.')).toBeVisible();
});

test('home timeline renders loading state while a request is pending', async ({ page }) => {
	await authenticate(page);
	let releaseRequest: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	await mockHomeTimeline(page, async (route) => {
		await pending;
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.getByRole('status', { name: 'Request status' })).toContainText('Loading Pleroma data');
	releaseRequest();
	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');
});

test('home timeline renders retryable API errors and retries with a token', async ({ page }) => {
	await authenticate(page);
	let attempts = 0;
	await mockHomeTimeline(page, async (route) => {
		attempts += 1;
		expect(route.request().headers().authorization).toBe('Bearer access-token');

		if (attempts === 1) {
			await fulfillHome(route, { error: 'maintenance' }, 503);
			return;
		}

		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page.getByText('Pleroma server error')).toBeVisible();
	await page.getByRole('button', { name: 'Retry request' }).click();
	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	expect(attempts).toBe(2);
});

test('home timeline 401 response triggers sign-out and root redirect', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, { error: 'The access token is invalid' }, 401);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: /quieter corner of the social web/i })).toBeVisible();
});

test('home timeline 403 response triggers sign-out and root redirect', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, { error: 'not authorized' }, 403);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: /quieter corner of the social web/i })).toBeVisible();
});

test('home timeline stays responsive at desktop, tablet, and mobile', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, pleromaFixtures.timelines.home);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	await expectNoHorizontalOverflow(page);

	await setViewport(page, 'tablet');
	await page.goto('/app/home');
	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	await expectNoHorizontalOverflow(page);

	await setViewport(page, 'mobile');
	await page.goto('/app/home');
	await expect(page.getByTestId('home-timeline-list')).toContainText('quiet CSS can still carry the voice.');
	await expectNoHorizontalOverflow(page);
});

test('home timeline renders emoji reaction rows and toggles reactions', async ({ page }) => {
	await authenticate(page);
	const base = statusWithText('status-react', 'react to this post');
	const reactedStatus = {
		...base,
		pleroma: {
			...base.pleroma,
			emoji_reactions: [
				{ name: '❤️', count: 3, me: true },
				{ name: 'blobcat', count: 2, me: false, url: 'https://cdn.example/emoji/blobcat.png', static_url: 'https://cdn.example/emoji/blobcat-static.png' }
			]
		}
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [reactedStatus]);
	});

	const reactionCalls: Array<{ method: string; path: string }> = [];
	await page.route(
		(url) => url.href.startsWith('https://pleroma.example/api/v1/pleroma/statuses/status-react/reactions/'),
		async (route) => {
			const method = route.request().method();
			reactionCalls.push({ method, path: new URL(route.request().url()).pathname });
			const heart = method === 'DELETE'
				? { name: '❤️', count: 2, me: false }
				: { name: '❤️', count: 3, me: true };
			await fulfillHome(route, {
				...reactedStatus,
				pleroma: {
					...reactedStatus.pleroma,
					emoji_reactions: [heart, { name: 'blobcat', count: 2, me: false, url: 'https://cdn.example/emoji/blobcat.png' }]
				}
			});
		}
	);

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const reactions = page.getByTestId('post-reactions');
	await expect(reactions).toBeVisible();
	const heartStamp = reactions.getByRole('button', { name: /❤️ · 3 reactions · you reacted/ });
	await expect(heartStamp).toHaveAttribute('aria-pressed', 'true');
	await expect(reactions.getByText('3', { exact: true })).toBeVisible();
	const customImage = reactions.locator('img[alt=":blobcat:"]');
	await expect(customImage).toBeVisible();
	await expect(reactions.getByRole('button', { name: 'Add reaction' })).toBeEnabled();

	await heartStamp.click();
	const unreactedStamp = reactions.getByRole('button', { name: /❤️ · 2 reactions$/ });
	await expect(unreactedStamp).toHaveAttribute('aria-pressed', 'false');
	expect(reactionCalls[0]?.method).toBe('DELETE');
	expect(reactionCalls[0]?.path).toContain('/reactions/');

	await unreactedStamp.click();
	await expect(reactions.getByRole('button', { name: /❤️ · 3 reactions · you reacted/ })).toHaveAttribute('aria-pressed', 'true');
	expect(reactionCalls[1]?.method).toBe('PUT');
});

test('home timeline reaction failures roll back the optimistic toggle', async ({ page }) => {
	await authenticate(page);
	const base = statusWithText('status-react-fail', 'reaction failure post');
	const reactedStatus = {
		...base,
		pleroma: {
			...base.pleroma,
			emoji_reactions: [{ name: '🔥', count: 5, me: false }]
		}
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [reactedStatus]);
	});
	await page.route(
		(url) => url.href.startsWith('https://pleroma.example/api/v1/pleroma/statuses/status-react-fail/reactions/'),
		async (route) => {
			await fulfillHome(route, { error: 'Internal server error' }, 500);
		}
	);

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const reactions = page.getByTestId('post-reactions');
	await reactions.getByRole('button', { name: /🔥 · 5 reactions$/ }).click();

	await expect(page.locator('.status-action-error')).toBeVisible();
	const rolledBack = reactions.getByRole('button', { name: /🔥 · 5 reactions$/ });
	await expect(rolledBack).toHaveAttribute('aria-pressed', 'false');
});

test('home timeline composer visibility selector scopes the created status', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [pleromaFixtures.status]);
	});
	const createBodies: string[] = [];
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBodies.push(route.request().postData() ?? '');
		await fulfillHome(route, statusWithText(`created-scoped-${createBodies.length}`, 'scoped post'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const privacyButton = page.getByRole('button', { name: 'Privacy: Public' });
	await expect(privacyButton).toHaveAttribute('aria-expanded', 'false');

	await privacyButton.click();
	const menu = page.getByRole('menu', { name: 'Post visibility' });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitemradio', { name: /Public/ })).toHaveAttribute('aria-checked', 'true');

	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();

	await privacyButton.click();
	await expect(menu).toBeVisible();
	await page.getByTestId('brand-tag').click();
	await expect(menu).toBeHidden();

	await privacyButton.click();
	await menu.getByRole('menuitemradio', { name: /Followers/ }).click();
	await expect(menu).toBeHidden();
	await expect(page.getByRole('button', { name: 'Privacy: Followers' })).toBeVisible();

	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.click();
	await composer.fill('a quieter post');
	await page.getByRole('button', { name: 'Post', exact: true }).click();
	await expect(page.getByTestId('home-timeline-list')).toContainText('scoped post');

	expect(createBodies).toHaveLength(1);
	const params = new URLSearchParams(createBodies[0]);
	expect(params.get('visibility')).toBe('private');

	await expect(page.getByRole('button', { name: 'Privacy: Followers' })).toBeVisible();
	await composer.click();
	await composer.fill('second scoped post');
	await page.getByRole('button', { name: 'Post', exact: true }).click();
	await expect.poll(() => createBodies.length).toBe(2);
	expect(new URLSearchParams(createBodies[1]).get('visibility')).toBe('private');
});

test('direct composer requires an address mention, stays out of home, and opens the returned thread', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	const directText = 'quietly for @bob@relay.example';
	const directStatus = {
		...statusWithText('created-direct', directText),
		visibility: 'direct' as const
	};
	const createBodies: string[] = [];
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBodies.push(route.request().postData() ?? '');
		await fulfillHome(route, directStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/created-direct', async (route) => {
		await fulfillHome(route, directStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/created-direct/context', async (route) => {
		await fulfillHome(route, { ancestors: [], descendants: [] });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.getByRole('button', { name: 'Privacy: Public' }).click();
	await page.getByRole('menu', { name: 'Post visibility' }).getByRole('menuitemradio', { name: /Direct/ }).click();
	await expect(page.getByRole('button', { name: 'Privacy: Direct' })).toBeVisible();

	const composer = page.getByRole('textbox', { name: 'Post text' });
	const postButton = page.getByRole('button', { name: 'Post', exact: true });
	await composer.fill('a secret without a recipient');
	await expect(postButton).toBeDisabled();
	expect(createBodies).toHaveLength(0);

	await composer.fill(directText);
	await expect(postButton).toBeEnabled();
	await postButton.click();
	await expect(page).toHaveURL(/\/app\/thread\/created-direct$/);
	await expect(page.getByTestId('focused-post')).toContainText(directText);
	expect(new URLSearchParams(createBodies[0]).get('visibility')).toBe('direct');

	await page.goto('/app/home');
	await expect(page.getByText(directText, { exact: true })).toHaveCount(0);
});

test('home timeline emoji picker scrolls long packs and offers canonical unicode groups', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	const bigPack = Array.from({ length: 60 }, (_, index) => ({
		shortcode: `blob${index + 1}`,
		url: `https://cdn.example/emoji/blob${index + 1}.png`,
		static_url: `https://cdn.example/emoji/blob${index + 1}.png`,
		visible_in_picker: true,
		tags: ['bigpack'],
		category: 'bigpack'
	}));
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, bigPack);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.getByRole('button', { name: 'Emoji' }).click();
	const picker = page.getByRole('dialog', { name: 'Emoji picker' });
	await expect(picker).toBeVisible();

	for (const label of ['Smileys & people', 'Animals & nature', 'Food & drink', 'Travel & places', 'Objects & tech']) {
		await expect(picker.getByRole('button', { name: label })).toBeVisible();
	}

	await picker.getByRole('button', { name: 'bigpack' }).click();
	await expect(picker.getByRole('button', { name: ':blob1:' })).toBeVisible();
	const scrollable = await picker.locator('.ep-grid').evaluate((grid) => ({
		scrollHeight: grid.scrollHeight,
		clientHeight: grid.clientHeight,
		scrollTop: grid.scrollTop
	}));
	expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
	expect(scrollable.clientHeight).toBeGreaterThan(0);

	const search = page.getByRole('textbox', { name: 'Search emoji' });
	await search.press('End');
	await expect(picker.getByRole('button', { name: ':blob60:' })).toHaveAttribute('aria-pressed', 'true');
	await expect(picker.getByRole('button', { name: ':blob60:' })).toBeInViewport();

	await picker.getByRole('button', { name: 'Animals & nature' }).click();
	await picker.getByRole('button', { name: '🐱', exact: true }).click();
	await expect(picker).toBeHidden();
	await expect(page.getByRole('textbox', { name: 'Post text' })).toContainText('🐱');
});

test('home timeline boost attribution renders booster custom emoji', async ({ page }) => {
	await authenticate(page);
	const booster = {
		...pleromaFixtures.account,
		id: 'account-booster',
		username: 'lumen',
		acct: 'lumen@candle.house',
		display_name: 'lumen :candle:',
		emojis: [{ shortcode: 'candle', url: 'https://cdn.example/emoji/candle.png', static_url: 'https://cdn.example/emoji/candle.png' }]
	};
	const boosted = statusWithText('status-boost-emoji', 'carried by a warm light.');
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [{
			...statusWithText('status-boost-wrap', ''),
			account: booster,
			reblog: boosted
		}]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const attribution = page.locator('.post-boost-attr');
	await expect(attribution).toContainText('lumen');
	await expect(attribution.locator('img[alt=":candle:"]')).toBeVisible();
	await expect(attribution.locator('.post-boost-name')).not.toContainText(':candle:');
});

test('home timeline add-reaction picker submits a reaction from the post action row', async ({ page }) => {
	await authenticate(page);
	const base = statusWithText('status-add-react', 'react to me from the picker');
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [base]);
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});
	const reactionCalls: Array<{ method: string; path: string }> = [];
	await page.route(
		(url) => url.href.startsWith('https://pleroma.example/api/v1/pleroma/statuses/status-add-react/reactions/'),
		async (route) => {
			reactionCalls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
			await fulfillHome(route, {
				...base,
				pleroma: { ...base.pleroma, emoji_reactions: [{ name: 'blobcat', count: 1, me: true, url: 'https://cdn.example/emoji/blobcat.png' }] }
			});
		}
	);

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.getByTestId('home-timeline-list').locator('.post').first();
	await post.getByRole('button', { name: 'Add reaction' }).click();
	const picker = page.getByRole('dialog', { name: 'Emoji picker' });
	await expect(picker).toBeVisible();
	await page.getByRole('textbox', { name: 'Search emoji' }).fill('blobcat');
	await picker.getByRole('button', { name: ':blobcat:' }).first().click();
	await expect(picker).toBeHidden();

	await expect(post.getByTestId('post-reactions').locator('img[alt=":blobcat:"]')).toBeVisible();
	expect(reactionCalls[0]?.method).toBe('PUT');
	expect(decodeURIComponent(reactionCalls[0]?.path ?? '')).toContain('/reactions/blobcat');
});

test('home timeline add-reaction picker submits a unicode reaction from the stamp', async ({ page }) => {
	await authenticate(page);
	const base = {
		...statusWithText('status-stamp-react', 'already has reactions'),
		pleroma: { ...statusWithText('status-stamp-react', 'x').pleroma, emoji_reactions: [{ name: '🔥', count: 2, me: false }] }
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [base]);
	});
	await page.route(customEmojisUrl, async (route) => {
		await fulfillHome(route, pleromaFixtures.customEmojis);
	});
	let reactionPath = '';
	await page.route(
		(url) => url.href.startsWith('https://pleroma.example/api/v1/pleroma/statuses/status-stamp-react/reactions/'),
		async (route) => {
			reactionPath = new URL(route.request().url()).pathname;
			await fulfillHome(route, {
				...base,
				pleroma: { ...base.pleroma, emoji_reactions: [{ name: '🔥', count: 2, me: false }, { name: '🐱', count: 1, me: true }] }
			});
		}
	);

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const reactions = page.getByTestId('post-reactions');
	await reactions.getByRole('button', { name: 'Add reaction' }).click();
	const picker = page.getByRole('dialog', { name: 'Emoji picker' });
	await expect(picker).toBeVisible();
	await picker.getByRole('button', { name: 'Animals & nature' }).click();
	await picker.getByRole('button', { name: '🐱', exact: true }).click();
	await expect(picker).toBeHidden();
	await expect(reactions.getByRole('button', { name: /🐱 · 1 reaction · you reacted/ })).toBeVisible();
	expect(decodeURIComponent(reactionPath)).toContain('/reactions/🐱');
});

test('home timeline bookmark button toggles and reconciles with the API', async ({ page }) => {
	await authenticate(page);
	const base = statusWithText('status-bookmark', 'save me for later');
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [base]);
	});
	const calls: string[] = [];
	await page.route('https://pleroma.example/api/v1/statuses/status-bookmark/bookmark', async (route) => {
		calls.push(route.request().method());
		await fulfillHome(route, { ...base, bookmarked: true });
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-bookmark/unbookmark', async (route) => {
		calls.push('UNBOOKMARK');
		await fulfillHome(route, { ...base, bookmarked: false });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'save me for later' }).first();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await post.getByRole('menuitem', { name: 'Bookmark' }).click();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await expect(post.getByRole('menuitem', { name: 'Remove bookmark' })).toBeVisible();
	await post.getByRole('menuitem', { name: 'Remove bookmark' }).click();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await expect(post.getByRole('menuitem', { name: 'Bookmark' })).toBeVisible();
	expect(calls[0]).toBe('POST');
	expect(calls[1]).toBe('UNBOOKMARK');
});

test('home timeline post menu copies the status link', async ({ page }) => {
	await authenticate(page);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: async (text: string) => { window.localStorage.setItem('deltanet.copied-link', text); } }
		});
	});
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [statusWithText('status-link', 'link me')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'link me' }).first();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await post.getByRole('menuitem', { name: 'Copy link to post' }).click();

	await expect(page.getByTestId('post-control-toast')).toContainText('Link copied');
	const copied = await page.evaluate(() => window.localStorage.getItem('deltanet.copied-link'));
	expect(copied).toBe('https://pleroma.example/notice/status-link');
});

test('home timeline deletes an own post after confirmation', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [statusWithText('status-own', 'delete me please')]);
	});
	let deleteMethod = '';
	await page.route('https://pleroma.example/api/v1/statuses/status-own', async (route) => {
		deleteMethod = route.request().method();
		await fulfillHome(route, statusWithText('status-own', 'delete me please'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'delete me please' }).first();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await expect(post.getByRole('menuitem', { name: 'Mute @quietadmin@pleroma.example' })).toHaveCount(0);
	await post.getByRole('menuitem', { name: 'Delete post' }).click();
	await post.getByRole('menuitem', { name: 'Confirm delete' }).click();

	expect(deleteMethod).toBe('DELETE');
	await expect(page.getByTestId('home-timeline-list')).not.toContainText('delete me please');
	await expect(page.getByTestId('post-control-toast')).toContainText('Post deleted');
});

test('home timeline mutes another author and removes their posts', async ({ page }) => {
	await authenticate(page);
	const foreign = {
		...statusWithText('status-foreign', 'noise from elsewhere'),
		account: { ...pleromaFixtures.account, id: 'account-noise', username: 'noise', acct: 'noise@static.zone', display_name: 'noise' }
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [foreign, statusWithText('status-mine', 'my own quiet post')]);
	});
	let muteCalled = false;
	await page.route('https://pleroma.example/api/v1/accounts/account-noise/mute', async (route) => {
		muteCalled = true;
		await fulfillHome(route, { ...pleromaFixtures.relationship, id: 'account-noise', muting: true });
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'noise from elsewhere' }).first();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await post.getByRole('menuitem', { name: 'Mute @noise@static.zone' }).click();

	expect(muteCalled).toBe(true);
	await expect(page.getByTestId('home-timeline-list')).not.toContainText('noise from elsewhere');
	await expect(page.getByTestId('home-timeline-list')).toContainText('my own quiet post');
	await expect(page.getByTestId('post-control-toast')).toContainText('Muted @noise@static.zone');
});

test('home timeline post menu closes on outside click and escape', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [statusWithText('status-menu-dismiss', 'dismiss my menu')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'dismiss my menu' }).first();
	await post.getByRole('button', { name: 'More post actions' }).click();
	await expect(post.getByRole('menuitem', { name: 'Copy link to post' })).toBeVisible();
	await page.getByTestId('brand-tag').click();
	await expect(post.getByRole('menuitem', { name: 'Copy link to post' })).toHaveCount(0);

	await post.getByRole('button', { name: 'More post actions' }).click();
	await expect(post.getByRole('menuitem', { name: 'Copy link to post' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(post.getByRole('menuitem', { name: 'Copy link to post' })).toHaveCount(0);
});

test('home timeline poll voting submits choices and renders results from the response', async ({ page }) => {
	await authenticate(page);
	const pollStatus = {
		...pleromaFixtures.status,
		id: 'status-votable',
		content: '<p>pick a side</p>',
		pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'pick a side' } },
		poll: {
			id: 'poll-votable',
			options: [
				{ title: 'warm cassette', votes_count: 10 },
				{ title: 'cold terminal', votes_count: 5 }
			],
			votes_count: 15,
			multiple: false,
			expired: false,
			own_votes: []
		}
	};
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [pollStatus]);
	});
	let voteBody = '';
	await page.route('https://pleroma.example/api/v1/polls/poll-votable/votes', async (route) => {
		voteBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			id: 'poll-votable',
			options: [
				{ title: 'warm cassette', votes_count: 11 },
				{ title: 'cold terminal', votes_count: 5 }
			],
			votes_count: 16,
			voted: true,
			multiple: false,
			expired: false,
			own_votes: [0]
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-votable"]');
	await post.locator('.post-poll-vote-row').filter({ hasText: 'warm cassette' }).click();
	await post.getByRole('button', { name: 'Vote', exact: true }).click();

	await expect(post.locator('.post-poll')).toContainText('you voted');
	await expect(post.locator('.post-poll-row').filter({ hasText: 'warm cassette' })).toContainText('You');
	await expect(post.locator('.post-poll')).toContainText('16 votes');
	expect(new URLSearchParams(voteBody).getAll('choices[]')).toEqual(['0']);
});

test('home timeline poll vote failure surfaces a toast and stays votable', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [{
			...pleromaFixtures.status,
			id: 'status-vote-fail',
			content: '<p>doomed poll</p>',
			pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'doomed poll' } },
			poll: {
				id: 'poll-fail',
				options: [{ title: 'only option', votes_count: 1 }],
				votes_count: 1,
				multiple: false,
				expired: false,
				own_votes: []
			}
		}]);
	});
	await page.route('https://pleroma.example/api/v1/polls/poll-fail/votes', async (route) => {
		await fulfillHome(route, { error: 'poll vote exploded' }, 422);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('[data-status-id="status-vote-fail"]');
	await post.locator('.post-poll-vote-row').filter({ hasText: 'only option' }).click();
	await post.getByRole('button', { name: 'Vote', exact: true }).click();

	await expect(page.getByTestId('post-control-toast')).toContainText('Vote failed');
	await expect(post.getByRole('button', { name: 'Vote', exact: true })).toBeVisible();
});

test('home timeline composer saves upload alt text through the media API', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		await fulfillHome(route, {
			id: 'media-alt-1',
			type: 'image',
			url: 'https://cdn.example/uploads/cat.png',
			preview_url: 'https://cdn.example/uploads/cat-thumb.png',
			description: null
		});
	});
	let altMethod: string | undefined;
	let altBody = '';
	await page.route('https://pleroma.example/api/v1/media/media-alt-1', async (route) => {
		altMethod = route.request().method();
		altBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			id: 'media-alt-1',
			type: 'image',
			url: 'https://cdn.example/uploads/cat.png',
			preview_url: 'https://cdn.example/uploads/cat-thumb.png',
			description: 'a sleepy cat on a warm keyboard'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.getByLabel('Attach media').setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('cat') });

	const altInput = page.getByRole('textbox', { name: 'Alt text for cat.png' });
	await altInput.fill('a sleepy cat on a warm keyboard');
	await altInput.blur();

	await expect(altInput).toHaveValue('a sleepy cat on a warm keyboard');
	expect(altMethod).toBe('PUT');
	expect(JSON.parse(altBody)).toMatchObject({ description: 'a sleepy cat on a warm keyboard' });
});

test('home timeline composer alt text failure surfaces a toast and keeps the draft', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, []);
	});
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		await fulfillHome(route, {
			id: 'media-alt-2',
			type: 'image',
			url: 'https://cdn.example/uploads/dog.png',
			preview_url: 'https://cdn.example/uploads/dog-thumb.png',
			description: null
		});
	});
	await page.route('https://pleroma.example/api/v1/media/media-alt-2', async (route) => {
		await fulfillHome(route, { error: 'description too long' }, 422);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const composer = page.getByRole('textbox', { name: 'Post text' });
	await composer.fill('dog picture incoming');
	await page.getByLabel('Attach media').setInputFiles({ name: 'dog.png', mimeType: 'image/png', buffer: Buffer.from('dog') });

	const altInput = page.getByRole('textbox', { name: 'Alt text for dog.png' });
	await altInput.fill('a very long description');
	await altInput.blur();

	await expect(page.getByTestId('post-control-toast')).toContainText('Alt text failed');
	await expect(composer).toContainText('dog picture incoming');
});

test('home timeline inline reply composer saves upload alt text', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	const targetStatus = { ...statusWithText('status-inline-alt', 'inline alt target'), replies_count: 0 };
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [targetStatus]);
	});
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		await fulfillHome(route, {
			id: 'reply-media-alt',
			type: 'image',
			url: 'https://cdn.example/uploads/tape.png',
			preview_url: 'https://cdn.example/uploads/tape-thumb.png',
			description: null
		});
	});
	let altBody = '';
	await page.route('https://pleroma.example/api/v1/media/reply-media-alt', async (route) => {
		altBody = route.request().postData() ?? '';
		await fulfillHome(route, {
			id: 'reply-media-alt',
			type: 'image',
			url: 'https://cdn.example/uploads/tape.png',
			preview_url: 'https://cdn.example/uploads/tape-thumb.png',
			description: 'a cassette tape'
		});
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	await page.locator('[data-status-id="status-inline-alt"]').getByRole('button', { name: /^Reply/ }).click();
	await page.getByLabel('Attach reply media').setInputFiles({ name: 'tape.png', mimeType: 'image/png', buffer: Buffer.from('tape') });

	const altInput = page.getByRole('textbox', { name: 'Alt text for tape.png' });
	await altInput.fill('a cassette tape');
	await altInput.blur();

	await expect(altInput).toHaveValue('a cassette tape');
	expect(JSON.parse(altBody)).toMatchObject({ description: 'a cassette tape' });
});

test('home timeline reconciles favourite counts and reactions from a streamed notification without refetching', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [statusWithText('status-reconcile', 'counts should update live')]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');
	const post = page.locator('[data-status-id="status-reconcile"]');
	await expect(post.getByRole('button', { name: 'Favorite 9' })).toBeVisible();
	await expect(post.locator('[data-testid="post-reactions"]')).toHaveCount(0);

	const reactorAccount = {
		...pleromaFixtures.account,
		id: 'account-reactor',
		username: 'reactor',
		acct: 'reactor@pleroma.example',
		display_name: 'reactor'
	};
	const freshStatus = {
		...pleromaFixtures.status,
		id: 'status-reconcile',
		uri: 'https://pleroma.example/objects/status-reconcile',
		url: 'https://pleroma.example/notice/status-reconcile',
		content: '<p>counts should update live</p>',
		pleroma: {
			...pleromaFixtures.status.pleroma,
			content: { 'text/plain': 'counts should update live' },
			emoji_reactions: [{ name: 'blobcat', count: 1, me: false }]
		},
		favourites_count: 12
	};
	const streamedNotification = {
		id: 'notif-reconcile-fav',
		type: 'favourite',
		created_at: '2026-05-18T12:06:00.000Z',
		account: reactorAccount,
		status: freshStatus,
		pleroma: {}
	};

	let homeTimelineRequests = 0;
	await mockHomeTimeline(page, async (route) => {
		homeTimelineRequests += 1;
		await fulfillHome(route, [statusWithText('status-reconcile', 'counts should update live')]);
	});

	await emitStreamNotification(page, streamedNotification);

	await expect(post.getByRole('button', { name: 'Favorite 12' })).toBeVisible();
	await expect(post.locator('[data-testid="post-reactions"]')).toContainText('1');
	expect(homeTimelineRequests).toBe(0);
});

test('home timeline post header renders auth name + petname chip for renamed contacts', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-petname',
				content: 'hello from carol',
				pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'hello from carol' } },
				account: {
					...pleromaFixtures.account,
					id: '12',
					username: 'zbie604yz',
					acct: 'zbie604yz@nine.testrun.org',
					// displayName prefers MY override (like core), so display_name
					// arrives as the petname; auth_name carries their chosen name.
					display_name: 'carol',
					pleroma: { ...pleromaFixtures.account.pleroma, deltanet: { auth_name: 'Carol Sparkle', petname: 'carol' } }
				}
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'hello from carol' }).first();
	// Main name = THEIR chosen name; my petname renders as chip chrome.
	await expect(post.locator('.post-name')).toHaveText('Carol Sparkle');
	await expect(post.getByTestId('petname-chip')).toContainText('carol');
});

test('home timeline reply pill shows their name plus my petname chip', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-petname-reply',
				in_reply_to_id: 'parent-status',
				in_reply_to_account_id: 'carol-account',
				content: 'agreed!',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': 'agreed!' },
					in_reply_to_account_acct: 'zbie604yz@nine.testrun.org'
				},
				mentions: [
					{
						id: 'carol-account',
						url: 'https://pleroma.example/deltanet/contact/12',
						username: 'zbie604yz',
						acct: 'zbie604yz@nine.testrun.org',
						display_name: 'carol',
						auth_name: 'Carol Sparkle',
						petname: 'carol'
					}
				]
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'agreed!' }).first();
	await expect(post.locator('.post-pinged-chip-parent .post-pinged-handle')).toHaveText('Carol Sparkle');
	await expect(post.locator('.post-pinged').getByTestId('petname-chip')).toContainText('carol');
});

test('body mention tokens render as names (petname-first) with the address as tooltip', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-body-mention',
				content: 'lunch with @zbie604yz@nine.testrun.org tomorrow',
				pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': 'lunch with @zbie604yz@nine.testrun.org tomorrow' } },
				mentions: [
					{
						id: 'carol-account',
						url: 'https://pleroma.example/deltanet/contact/12',
						username: 'zbie604yz',
						acct: 'zbie604yz@nine.testrun.org',
						display_name: 'carol',
						auth_name: 'Carol Sparkle',
						petname: 'carol'
					}
				]
			}
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const post = page.locator('.post').filter({ hasText: 'lunch with' }).first();
	const mention = post.locator('.post-mention-inline');
	await expect(mention).toHaveText('@carol');
	await expect(mention).toHaveAttribute('title', '@zbie604yz@nine.testrun.org');
	await expect(post.locator('.post-body')).not.toContainText('zbie604yz');
});

test('composer autocomplete searches contacts and inserts a full-address mention', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [pleromaFixtures.status]);
	});
	let searchQuery = '';
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route) => {
		searchQuery = new URL(route.request().url()).searchParams.get('q') ?? '';
		await fulfillJson(route, [
			{
				...pleromaFixtures.account,
				id: '12',
				username: 'zbie604yz',
				acct: 'zbie604yz@nine.testrun.org',
				display_name: 'carol',
				pleroma: { ...pleromaFixtures.account.pleroma, deltanet: { auth_name: 'Carol Sparkle', petname: 'carol' } }
			}
		]);
	});
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillHome(route, statusWithText('created-mention-post', 'hi @zbie604yz@nine.testrun.org'));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const editor = page.getByRole('textbox', { name: 'Post text' });
	await editor.click();
	await editor.pressSequentially('hi @car', { delay: 30 });

	// The popup offers carol (petname matched via the daemon search).
	const option = page.getByRole('option').filter({ hasText: 'carol' }).first();
	await expect(option).toBeVisible();
	expect(searchQuery).toBe('car');
	await option.click();

	await page.getByRole('button', { name: 'Post', exact: true }).click();
	await expect
		.poll(() => new URLSearchParams(createBody).get('status'))
		.toContain('@zbie604yz@nine.testrun.org');
});

test('an unconfirmed-author status renders the unconfirmed chip', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{
				...pleromaFixtures.status,
				id: 'status-unconfirmed',
				content: 'boosted stranger content',
				pleroma: {
					...pleromaFixtures.status.pleroma,
					content: { 'text/plain': 'boosted stranger content' },
					deltanet: { author_unconfirmed: true }
				}
			},
			{ ...statusWithText('status-confirmed', 'ordinary post') }
		]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const unconfirmed = page.locator('.post').filter({ hasText: 'boosted stranger content' }).first();
	await expect(unconfirmed.getByTestId('unconfirmed-chip')).toContainText('unconfirmed');
	await expect(unconfirmed.getByTestId('unconfirmed-chip')).toHaveAttribute('title', /not yet confirmed/);

	const ordinary = page.locator('.post').filter({ hasText: 'ordinary post' }).first();
	await expect(ordinary.getByTestId('unconfirmed-chip')).toHaveCount(0);
});

test('the boost button is disabled on followers-only posts', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page, async (route) => {
		await fulfillHome(route, [
			{ ...statusWithText('status-priv', 'followers only content'), visibility: 'private' },
			statusWithText('status-pub', 'public content')
		]);
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	const priv = page.locator('.post').filter({ hasText: 'followers only content' }).first();
	await expect(priv.locator('.post-action.boost')).toBeDisabled();
	const pub = page.locator('.post').filter({ hasText: 'public content' }).first();
	await expect(pub.locator('.post-action.boost')).toBeEnabled();
});

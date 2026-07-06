import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import type { PleromaAccount, PleromaStatus } from '../lib/pleroma/types';
import { expectNoHorizontalOverflow, mockRightRailApis, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const accountSearchUrl = 'https://pleroma.example/api/v1/accounts/search**';
const customEmojisUrl = 'https://pleroma.example/api/v1/custom_emojis';

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	await page.route(customEmojisUrl, async (route) => {
		await fulfillJson(route, pleromaFixtures.customEmojis);
	});
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const accountWithName = (id: string, displayName: string, acct: string): PleromaAccount => ({
	...pleromaFixtures.account,
	id,
	username: acct.split('@')[0],
	acct,
	display_name: displayName,
	avatar: `https://pleroma.example/${id}.png`,
	avatar_static: `https://pleroma.example/${id}.png`
});

const statusWithText = (id: string, text: string, overrides: Partial<PleromaStatus> = {}): PleromaStatus => ({
	...pleromaFixtures.status,
	id,
	uri: `https://pleroma.example/objects/${id}`,
	url: `https://pleroma.example/notice/${id}`,
	content: `<p>${text}</p>`,
	created_at: '2026-05-11T16:18:00.000Z',
	pleroma: {
		...pleromaFixtures.status.pleroma,
		content: { 'text/plain': text },
		conversation_id: 99,
		spoiler_text: { 'text/plain': '' }
	},
	...overrides
});

const threadStatus = statusWithText('status-1', 'quiet CSS can still carry the voice.', {
	application: { name: 'Pleroma Web' },
	media_attachments: [
		{ id: 'thread-photo', type: 'image', url: 'https://cdn.example/thread-photo.jpg', preview_url: 'https://cdn.example/thread-photo-preview.jpg', description: 'thread photo' }
	],
	replies_count: 2,
	reblogs_count: 12,
	favourites_count: 28
});

const threadAncestor = statusWithText('ancestor-1', 'the earlier context from gridwave', {
	account: accountWithName('gridwave', 'gridwave', 'gridwave@retro.social'),
	created_at: '2026-05-11T15:45:00.000Z',
	replies_count: 1,
	reblogs_count: 4,
	favourites_count: 18
});

const threadReply = statusWithText('reply-1', 'we used to log off. when did that stop being a thing.', {
	account: accountWithName('datagram', 'datagram', 'datagram@retro.social'),
	created_at: '2026-05-11T16:34:00.000Z',
	in_reply_to_id: 'status-1',
	in_reply_to_account_id: 'account-1',
	replies_count: 0,
	reblogs_count: 12,
	favourites_count: 64
});

const secondThreadReply = statusWithText('reply-2', 'this is the energy i needed today.', {
	account: accountWithName('lumen', 'lumen', 'lumen@example.social'),
	created_at: '2026-05-11T16:39:00.000Z',
	in_reply_to_id: 'status-1',
	in_reply_to_account_id: 'account-1',
	replies_count: 0,
	reblogs_count: 7,
	favourites_count: 39
});

const nestedThreadReply = statusWithText('reply-1-child', 'around the time the algorithm replaced the timeline.', {
	account: accountWithName('orbit', 'orbit', 'orbit@spacebear.net'),
	created_at: '2026-05-11T16:42:00.000Z',
	in_reply_to_id: 'reply-1',
	in_reply_to_account_id: 'datagram',
	replies_count: 0,
	reblogs_count: 5,
	favourites_count: 22
});

const fulfillJson = async (route: Route, body: unknown, status = 200) => {
	await route.fulfill({
		status,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});
};

const mockInstance = async (page: Page) => {
	await page.route('https://pleroma.example/api/v2/instance', async (route) => {
		await fulfillJson(route, pleromaFixtures.instance);
	});
};

const mockHomeTimeline = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => {
		await fulfillJson(route, pleromaFixtures.timelines.home);
	});
};

const mockThread = async (
	page: Page,
	focusedStatus: PleromaStatus = threadStatus,
	descendants: PleromaStatus[] = [threadReply, nestedThreadReply, secondThreadReply],
	ancestors: PleromaStatus[] = [threadAncestor]
) => {
	await mockInstance(page);
	await page.route('https://pleroma.example/api/v1/statuses/status-1', async (route) => {
		await fulfillJson(route, focusedStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-1/context', async (route) => {
		await fulfillJson(route, { ancestors, descendants });
	});
};

const expectThreadRailBridge = async (page: Page, expectedLineCount: number) => {
	const lines = page.getByTestId('thread-line');
	await expect(lines).toHaveCount(expectedLineCount);
	const lineBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
	const lineBackgrounds: string[] = [];

	for (let i = 0; i < expectedLineCount; i += 1) {
		const bridge = await lines.nth(i).evaluate((element) => {
			const lineStyles = getComputedStyle(element);
			const bridgeStyles = getComputedStyle(element, '::after');

			return {
				linePosition: lineStyles.position,
				lineBackground: lineStyles.backgroundColor,
				bridgeContent: bridgeStyles.content,
				bridgeHeight: bridgeStyles.height,
				bridgeMarginLeft: bridgeStyles.marginLeft,
				bridgeTop: bridgeStyles.top,
				bridgeWidth: bridgeStyles.width,
				bridgeBackground: bridgeStyles.backgroundColor
			};
		});
		const box = await lines.nth(i).boundingBox();

		expect(bridge.linePosition).toBe('relative');
		expect(bridge.bridgeContent).toBe('""');
		expect(bridge.bridgeHeight).toBe('24px');
		expect(bridge.bridgeMarginLeft).toBe('-1px');
		expect(Number.parseFloat(bridge.bridgeTop)).toBeCloseTo(box?.height ?? 0, 0);
		expect(bridge.bridgeWidth).toBe('2px');
		expect(bridge.bridgeBackground).toBe(bridge.lineBackground);
		expect(box).not.toBeNull();
		lineBoxes.push(box ?? { x: 0, y: 0, width: 0, height: 0 });
		lineBackgrounds.push(bridge.lineBackground);
	}

	const bridgeHeight = 24;
	const ancestorLineBox = lineBoxes.at(-1);
	const ancestors = page.getByTestId('thread-ancestor');
	const ancestorBoxes = await ancestors.evaluateAll((elements) =>
		elements.map((element) => {
			const box = element.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height };
		})
	);
	for (let i = 0; i < expectedLineCount; i += 1) {
		const boostAttr = ancestors.nth(i).locator('.post-boost > .post-boost-attr').first();
		if (!(await boostAttr.count())) continue;

		const attrBridge = await boostAttr.evaluate((element) => {
			const attrBox = element.getBoundingClientRect();
			const bridgeStyles = getComputedStyle(element, '::before');

			return {
				attrX: attrBox.x,
				bridgeContent: bridgeStyles.content,
				bridgeBackground: bridgeStyles.backgroundColor,
				bridgeBottom: bridgeStyles.bottom,
				bridgeLeft: bridgeStyles.left,
				bridgeTop: bridgeStyles.top,
				bridgeWidth: bridgeStyles.width
			};
		});

		expect(attrBridge.bridgeContent).toBe('""');
		expect(attrBridge.bridgeTop).toBe('0px');
		expect(attrBridge.bridgeBottom).toBe('-1px');
		expect(attrBridge.bridgeWidth).toBe('2px');
		expect(attrBridge.bridgeBackground).toBe(lineBackgrounds[i]);
		expect(Math.abs(attrBridge.attrX + Number.parseFloat(attrBridge.bridgeLeft) - lineBoxes[i].x)).toBeLessThanOrEqual(1);
	}
	const focusedLineBox = await page.getByTestId('focused-post').locator('.thread-line-top').boundingBox();
	expect(ancestorLineBox).toBeDefined();
	expect(focusedLineBox).not.toBeNull();
	expect(Math.abs((ancestorLineBox?.x ?? 0) - (focusedLineBox?.x ?? 0))).toBeLessThanOrEqual(1);
	expect((ancestorLineBox?.y ?? 0) + (ancestorLineBox?.height ?? 0) + bridgeHeight).toBeGreaterThanOrEqual(focusedLineBox?.y ?? 0);

	for (let i = 0; i < lineBoxes.length - 1; i += 1) {
		expect(Math.abs(lineBoxes[i].x - lineBoxes[i + 1].x)).toBeLessThanOrEqual(1);
		expect(lineBoxes[i].y + lineBoxes[i].height + bridgeHeight).toBeGreaterThanOrEqual(ancestorBoxes[i + 1].y);
	}

	const replyRail = page.locator('.post-reply .thread-line').first();
	if (await replyRail.count()) {
		const replyRailBridgeContent = await replyRail.evaluate((element) => getComputedStyle(element, '::after').content);
		expect(replyRailBridgeContent).toBe('none');
	}
};

test('real thread route loads focused status, ancestors, and replies from Pleroma', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const threadHeader = page.locator('.thread-head-title');
	const threadTitle = page.getByRole('heading', { name: 'Thread' });
	const headerBox = await threadHeader.boundingBox();
	expect(headerBox).not.toBeNull();
	expect(headerBox?.height ?? 0).toBeLessThanOrEqual(50);
	expect(await threadTitle.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBeLessThanOrEqual(14);
	await expect(page.getByTestId('thread-ancestor')).toContainText('gridwave');
	await expect(page.getByTestId('thread-ancestor')).toContainText('the earlier context from gridwave');
	await page.getByTestId('thread-ancestor').getByRole('button', { name: 'Reply 1' }).click();
	const ancestorReplyForm = page.getByRole('form', { name: 'Inline reply to @gridwave' });
	await expect(ancestorReplyForm).toBeVisible();
	await ancestorReplyForm.getByRole('button', { name: 'Cancel' }).click();
	await expect(ancestorReplyForm).toHaveCount(0);
	await expect(page.getByTestId('thread-line')).toBeVisible();
	await expect(page.getByTestId('focused-post')).toContainText('quiet CSS can still carry the voice.');
	await expect(page.getByTestId('focused-post')).toContainText('4:18 PM · May 11, 2026');
	await expect(page.getByTestId('focused-post')).toContainText('Pleroma Web');
	await expect(page.getByTestId('focused-post').locator('.post-photos img[alt="thread photo"]')).toHaveAttribute('src', 'https://cdn.example/thread-photo.jpg');
	await expect(page.getByTestId('focused-engagement')).toContainText('Boost');
	await expect(page.getByRole('form', { name: 'Thread reply' })).toHaveCount(0);
	await expect(page.getByTestId('thread-reply-count')).toContainText('3 replies');
	await expect(page.getByTestId('thread-reply').first()).toContainText('we used to log off. when did that stop being a thing.');
	await expect(page.getByTestId('thread-reply').nth(1)).toContainText('this is the energy i needed today.');
	await expect(page.getByText('around the time the algorithm replaced the timeline.')).toBeHidden();
	await expectThreadRailBridge(page, 1);
	await setViewport(page, 'mobile');
	await expectThreadRailBridge(page, 1);
	await expectNoHorizontalOverflow(page);
	await setViewport(page, 'desktop');
	await page.getByRole('button', { name: 'Show 1 reply' }).click();
	await expect(page.getByText('around the time the algorithm replaced the timeline.')).toBeVisible();
});

test('real thread route bridges multiple ancestor rails with warnings and media', async ({ page }) => {
	await authenticate(page);
	const warningAncestor = statusWithText('ancestor-warning', 'cw hidden ancestor body', {
		account: accountWithName('warning-ancestor-account', 'mistwalk', 'mistwalk@garden.cafe'),
		created_at: '2026-05-11T15:20:00.000Z',
		spoiler_text: 'thread context warning',
		pleroma: {
			...pleromaFixtures.status.pleroma,
			content: { 'text/plain': 'cw hidden ancestor body' },
			conversation_id: 99,
			spoiler_text: { 'text/plain': 'thread context warning' }
		},
		replies_count: 1,
		reblogs_count: 0,
		favourites_count: 2
	});
	const mediaAncestorOriginal = statusWithText('ancestor-media-original', 'ancestor with media still keeps the rail aligned', {
		account: accountWithName('media-ancestor-account', 'gridwave', 'gridwave@retro.social'),
		created_at: '2026-05-11T15:45:00.000Z',
		media_attachments: [
			{ id: 'ancestor-photo', type: 'image', url: 'https://cdn.example/ancestor-photo.jpg', preview_url: 'https://cdn.example/ancestor-photo-preview.jpg', description: 'ancestor photo' }
		],
		replies_count: 1,
		reblogs_count: 4,
		favourites_count: 18
	});
	const mediaAncestor = statusWithText('ancestor-media-boost', '', {
		account: accountWithName('media-ancestor-booster-account', 'orbit', 'orbit@spacebear.net'),
		created_at: '2026-05-11T15:50:00.000Z',
		reblog: mediaAncestorOriginal
	});
	await mockThread(page, threadStatus, [threadReply], [warningAncestor, mediaAncestor]);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const ancestors = page.getByTestId('thread-ancestor');
	await expect(ancestors).toHaveCount(2);
	await expect(ancestors.first().locator('.post-cw-card')).toContainText('thread context warning');
	await expect(ancestors.nth(1).locator('.post-boost > .post-boost-attr')).toBeVisible();
	await expect(ancestors.nth(1).locator('.post-boost-name')).toContainText('orbit');
	await expect(ancestors.nth(1).locator('.post-photos img[alt="ancestor photo"]')).toHaveAttribute('src', 'https://cdn.example/ancestor-photo.jpg');
	await expectThreadRailBridge(page, 2);

	await setViewport(page, 'mobile');
	await expectThreadRailBridge(page, 2);
	await expectNoHorizontalOverflow(page);
});

test('real thread route handles an empty descendant context and accepts the first reply', async ({ page }) => {
	await authenticate(page);
	await mockThread(page, { ...threadStatus, replies_count: 0 }, []);
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillJson(route, statusWithText('created-first-thread-reply', 'the first reply lands in an empty thread', {
			in_reply_to_id: 'status-1',
			in_reply_to_account_id: 'account-1',
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0
		}));
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	await expect(page.getByTestId('focused-post')).toContainText('quiet CSS can still carry the voice.');
	await expect(page.getByTestId('thread-reply-count')).toHaveCount(0);
	await expect(page.getByTestId('thread-reply')).toHaveCount(0);
	await expect(page.getByRole('group', { name: 'Reply sort' })).toHaveCount(0);

	await page.getByTestId('focused-post').getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @quietadmin' });
	await replyForm.getByRole('textbox', { name: 'Reply text' }).fill('the first reply lands in an empty thread');
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	await expect(page.getByTestId('thread-reply-count')).toContainText('1 reply');
	await expect(page.getByRole('group', { name: 'Reply sort' })).toBeVisible();
	await expect(page.getByTestId('thread-reply')).toHaveCount(1);
	await expect(page.getByText('the first reply lands in an empty thread')).toBeVisible();
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('the first reply lands in an empty thread');
	expect(params.get('in_reply_to_id')).toBe('status-1');
});

test('real thread route opens from the home timeline and returns to home', async ({ page }) => {
	await authenticate(page);
	await mockHomeTimeline(page);
	await mockThread(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/home');

	await page.locator('[data-status-id="status-1"]').click();
	await expect(page).toHaveURL('/app/thread/status-1');
	await expect(page.getByTestId('focused-post')).toContainText('quiet CSS can still carry the voice.');

	await page.getByRole('button', { name: 'Back to home timeline' }).click();
	await expect(page).toHaveURL('/app/home');
	await expect(page.getByRole('tablist', { name: 'Timeline sections' })).toBeVisible();
});

test('real thread route opens focused media in the attachment lightbox', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	await page.getByTestId('focused-post').locator('.post-photos button').click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('.lightbox-photo')).toHaveAttribute('src', 'https://cdn.example/thread-photo.jpg');
});

test('real thread route renders focused reply addressee chips', async ({ page }) => {
	await authenticate(page);
	await mockThread(page, {
		...threadStatus,
		content: '<p>@gridwave @lumen quiet CSS can still carry the voice.</p>',
		in_reply_to_id: 'ancestor-1',
		in_reply_to_account_id: 'gridwave',
		pleroma: {
			...threadStatus.pleroma,
			content: { 'text/plain': '@gridwave @lumen quiet CSS can still carry the voice.' }
		}
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const focused = page.getByTestId('focused-post');
	await expect(focused.locator('.focused-body')).toHaveText('quiet CSS can still carry the voice.');
	await expect(focused.getByRole('button', { name: /^Follow/ })).toHaveCount(0);
	await expect(focused.locator('.post-pinged-l')).toHaveText('Replying to');
	await expect(focused.locator('.post-pinged-chip-parent')).toContainText('@gridwave');
	await expect(focused.locator('.post-pinged-chip-parent svg')).toBeVisible();
	await expect(focused.locator('.post-pinged-also')).toContainText('also');
	await expect(focused.locator('.post-pinged-chip')).toContainText('@lumen');
});

test('real thread route renders boosted ancestors and replies with attribution rows', async ({ page }) => {
	await authenticate(page);
	const boostedAncestorOriginal = statusWithText('ancestor-boosted-original', 'boosted ancestor context survives the redesign', {
		account: accountWithName('ancestor-original-account', 'gridwave', 'gridwave@retro.social'),
		created_at: '2026-05-11T15:42:00.000Z',
		replies_count: 1,
		reblogs_count: 5,
		favourites_count: 9
	});
	const boostedAncestor = statusWithText('ancestor-boost-wrapper', '', {
		account: accountWithName('ancestor-booster-account', 'FiestaBun', 'FiestaBun@decayable.ink'),
		created_at: '2026-05-11T16:00:00.000Z',
		reblog: boostedAncestorOriginal
	});
	const boostedReplyBody = 'content warning still wraps a boosted thread reply';
	const boostedReplyOriginal = statusWithText('reply-boosted-original', boostedReplyBody, {
		account: accountWithName('reply-original-account', 'mossy', 'mossy@garden.cafe'),
		created_at: '2026-05-11T16:36:00.000Z',
		in_reply_to_id: 'status-1',
		in_reply_to_account_id: 'account-1',
		spoiler_text: 'boosted reply warning',
		pleroma: {
			...pleromaFixtures.status.pleroma,
			content: { 'text/plain': boostedReplyBody },
			conversation_id: 99,
			spoiler_text: { 'text/plain': 'boosted reply warning' }
		},
		replies_count: 0,
		reblogs_count: 2,
		favourites_count: 6
	});
	const boostedReply = statusWithText('reply-boost-wrapper', '', {
		account: accountWithName('reply-booster-account', 'datagram', 'datagram@retro.social'),
		created_at: '2026-05-11T16:41:00.000Z',
		reblog: boostedReplyOriginal
	});
	await mockThread(page, threadStatus, [boostedReply], [boostedAncestor]);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const ancestor = page.getByTestId('thread-ancestor');
	await expect(ancestor.locator('.post-boost > .post-boost-attr')).toBeVisible();
	await expect(ancestor.locator('.post-boost-rail')).toHaveCount(0);
	await expect(ancestor.locator('.post-boost-name')).toContainText('FiestaBun');
	await expect(ancestor).toContainText('boosted ancestor context survives the redesign');
	await expectThreadRailBridge(page, 1);

	const reply = page.getByTestId('thread-reply');
	await expect(reply.locator('.post-boost > .post-boost-attr')).toBeVisible();
	await expect(reply.locator('.post-boost-rail')).toHaveCount(0);
	await expect(reply.locator('.post-boost-name')).toContainText('datagram');
	await expect(reply.locator('.post-cw-card')).toContainText('boosted reply warning');
	await reply.getByRole('button', { name: 'Show post' }).click();
	await expect(reply).toContainText(boostedReplyBody);

	await setViewport(page, 'mobile');
	await expectNoHorizontalOverflow(page);
});

test('real thread route folds content warnings on ancestors, focused posts, replies, and nested replies', async ({ page }) => {
	await authenticate(page);
	const withContentWarning = (status: PleromaStatus, summary: string, body: string): PleromaStatus => ({
		...status,
		content: `<p>${body}</p>`,
		spoiler_text: summary,
		pleroma: {
			...status.pleroma,
			content: { 'text/plain': body },
			spoiler_text: { 'text/plain': summary }
		}
	});
	await mockInstance(page);
	await page.route('https://pleroma.example/api/v1/statuses/reply-1-child/favourite', async (route) => {
		await fulfillJson(route, { ...nestedThreadReply, favourited: true, favourites_count: 23 });
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-1', async (route) => {
		await fulfillJson(route, withContentWarning(threadStatus, 'focused warning', 'hidden focused thread body'));
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-1/context', async (route) => {
		await fulfillJson(route, {
			ancestors: [withContentWarning(threadAncestor, 'ancestor warning', 'hidden ancestor body')],
			descendants: [
				withContentWarning(threadReply, 'reply warning', 'hidden reply body'),
				withContentWarning(nestedThreadReply, 'nested warning', 'hidden nested body'),
				secondThreadReply
			]
		});
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const ancestor = page.getByTestId('thread-ancestor');
	await expect(ancestor.locator('.post-cw-card')).toContainText('ancestor warning');
	await expect(ancestor).not.toContainText('hidden ancestor body');
	await ancestor.getByRole('button', { name: 'Show post' }).click();
	await expect(ancestor).toContainText('hidden ancestor body');

	const focused = page.getByTestId('focused-post');
	await expect(focused.locator('.post-cw-card')).toContainText('focused warning');
	await expect(focused).not.toContainText('hidden focused thread body');
	await focused.getByRole('button', { name: 'Show post' }).click();
	await expect(focused).toContainText('hidden focused thread body');
	await focused.getByRole('button', { name: 'Hide' }).click();
	await expect(focused).not.toContainText('hidden focused thread body');

	const reply = page.getByTestId('thread-reply').first();
	await expect(reply.locator('.post-cw-card')).toContainText('reply warning');
	await expect(reply).not.toContainText('hidden reply body');
	await reply.getByRole('button', { name: 'Show post' }).click();
	await expect(reply).toContainText('hidden reply body');

	await page.getByRole('button', { name: 'Show 1 reply' }).click();
	const nested = page.locator('.nested-replies .post-reply').first();
	await expect(nested.locator('.post-cw-card')).toContainText('nested warning');
	await expect(nested).not.toContainText('hidden nested body');
	await nested.getByRole('button', { name: 'Show post' }).click();
	await expect(nested).toContainText('hidden nested body');
	await nested.getByRole('button', { name: 'Favorite 22' }).click();
	await expect(nested.getByRole('button', { name: 'Favorite 23' })).toHaveAttribute('aria-pressed', 'true');
	await nested.getByRole('button', { name: 'Hide' }).click();
	await expect(nested.getByRole('button', { name: 'Favorite 23' })).toHaveAttribute('aria-pressed', 'true');
});

test('real thread route reply actions update local state', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	let boostAuthorization = '';
	let favoriteAuthorization = '';
	await page.route('https://pleroma.example/api/v1/statuses/reply-1/reblog', async (route) => {
		boostAuthorization = route.request().headers().authorization ?? '';
		await fulfillJson(route, { ...threadReply, reblogged: true, reblogs_count: 13 });
	});
	await page.route('https://pleroma.example/api/v1/statuses/reply-1/favourite', async (route) => {
		favoriteAuthorization = route.request().headers().authorization ?? '';
		await fulfillJson(route, { ...threadReply, favourited: true, favourites_count: 65 });
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });

	await reply.getByRole('button', { name: 'Boost 12' }).click();
	await expect(reply.getByRole('button', { name: 'Boost 13' })).toHaveAttribute('aria-pressed', 'true');
	await expect(reply.getByRole('button', { name: 'Boost 13' })).toHaveClass(/on/);
	await expect.poll(() => boostAuthorization).toBe('Bearer access-token');

	await reply.getByRole('button', { name: 'Favorite 64' }).click();
	await expect(reply.getByRole('button', { name: 'Favorite 65' })).toHaveAttribute('aria-pressed', 'true');
	await expect(reply.getByRole('button', { name: 'Favorite 65' })).toHaveClass(/on/);
	await expect.poll(() => favoriteAuthorization).toBe('Bearer access-token');
});

test('real thread route inline reply composer submits for the focused post', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await page.route(accountSearchUrl, async (route) => {
		await fulfillJson(route, [{
			...pleromaFixtures.account,
			id: 'soft-hertz',
			username: 'soft.hertz',
			acct: 'soft.hertz@kolektiva.social',
			display_name: 'soft.hertz ✦'
		}]);
	});
	let createAuthorization = '';
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createAuthorization = route.request().headers().authorization ?? '';
		createBody = route.request().postData() ?? '';
		await fulfillJson(route, statusWithText('created-thread-inline-reply', 'replying inline @soft.hertz@kolektiva.social :blobcat:', {
			in_reply_to_id: 'status-1',
			in_reply_to_account_id: 'account-1',
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0
		}));
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const focused = page.getByTestId('focused-post');
	const focusedReplyButton = focused.getByRole('button', { name: 'Reply 2' });
	await expect(focusedReplyButton).toHaveAttribute('aria-expanded', 'false');
	await focusedReplyButton.click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @quietadmin' });
	await expect(replyForm).toBeVisible();
	await expect(focusedReplyButton).toHaveAttribute('aria-expanded', 'true');
	await expect(focusedReplyButton).toHaveAttribute('aria-controls', await replyForm.getAttribute('id') ?? 'missing-inline-reply-id');
	await expect(replyForm.getByRole('img', { name: 'quiet admin avatar' })).toHaveAttribute('src', 'https://pleroma.example/avatar.png');
	const replyEditor = replyForm.getByRole('textbox', { name: 'Reply text' });
	await replyEditor.click();
	await replyEditor.pressSequentially('replying inline @so', { delay: 20 });
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
	await expect(page.getByTestId('thread-reply-count')).toContainText('4 replies');
	await expect(page.getByText('replying inline @soft.hertz@kolektiva.social :blobcat:')).toBeVisible();
	expect(createAuthorization).toBe('Bearer access-token');
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('replying inline @soft.hertz@kolektiva.social :blobcat:');
	expect(params.get('in_reply_to_id')).toBe('status-1');
	expect(params.get('visibility')).toBe('public');
});

test('real thread route inline reply composer opens below a targeted reply and cancels', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });
	const replyButton = reply.getByRole('button', { name: 'Reply 0' });
	await expect(replyButton).toHaveAttribute('aria-expanded', 'false');
	await replyButton.click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @datagram' });
	await expect(replyForm).toBeVisible();
	await expect(replyButton).toHaveAttribute('aria-expanded', 'true');
	await expect(replyButton).toHaveAttribute('aria-controls', await replyForm.getAttribute('id') ?? 'missing-inline-reply-id');
	await expect(replyForm).toContainText('Replying to');
	await expect(replyForm).toContainText('@datagram');
	await expect(replyForm.getByRole('img', { name: 'datagram avatar' })).toHaveAttribute('src', 'https://pleroma.example/datagram.png');
	await reply.getByRole('button', { name: 'Reply 0' }).click();
	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);

	await reply.getByRole('button', { name: 'Reply 0' }).click();
	await expect(replyForm).toBeVisible();
	await replyForm.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
});

test('real thread route inline reply composer submits below a targeted reply', async ({ page }) => {
	await authenticate(page);
	const unlistedThreadReply = { ...threadReply, visibility: 'unlisted' };
	await mockThread(page, threadStatus, [unlistedThreadReply, nestedThreadReply, secondThreadReply]);
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillJson(route, statusWithText('created-nested-inline-reply', 'replying inline to a thread reply', {
			in_reply_to_id: 'reply-1',
			in_reply_to_account_id: 'datagram',
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0
		}));
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });
	await reply.getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @datagram' });
	await replyForm.getByRole('textbox', { name: 'Reply text' }).fill('replying inline to a thread reply');
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	await expect(page.getByTestId('thread-reply-count')).toContainText('4 replies');
	await expect(reply.getByRole('button', { name: 'Reply 1' })).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByText('replying inline to a thread reply')).toBeVisible();
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('replying inline to a thread reply');
	expect(params.get('in_reply_to_id')).toBe('reply-1');
	expect(params.get('visibility')).toBe('unlisted');
});

test('real thread route inline reply composer submits below an expanded nested reply', async ({ page }) => {
	await authenticate(page);
	const privateNestedThreadReply = { ...nestedThreadReply, visibility: 'private' };
	const descendants = [threadReply, privateNestedThreadReply, secondThreadReply];
	await mockThread(page, threadStatus, descendants);
	let createBody = '';
	const createdReply = statusWithText('created-deep-inline-reply', 'replying inline to a nested reply', {
		in_reply_to_id: 'reply-1-child',
		in_reply_to_account_id: 'orbit',
		replies_count: 0,
		reblogs_count: 0,
		favourites_count: 0
	});
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillJson(route, createdReply);
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	await page.getByRole('button', { name: 'Show 1 reply' }).click();
	const nested = page.locator('.nested-replies .post-reply').first();
	await nested.getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @orbit' });
	await replyForm.getByRole('textbox', { name: 'Reply text' }).fill('replying inline to a nested reply');
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	await expect(page.getByTestId('thread-reply-count')).toContainText('4 replies');
	await expect(nested.getByRole('button', { name: 'Reply 1' })).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByText('replying inline to a nested reply')).toBeVisible();
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('replying inline to a nested reply');
	expect(params.get('in_reply_to_id')).toBe('reply-1-child');
	expect(params.get('visibility')).toBe('private');

	descendants.splice(0, descendants.length, threadReply, { ...privateNestedThreadReply, replies_count: 1 }, createdReply, secondThreadReply);
	await page.reload();
	await expect(page.getByTestId('thread-reply-count')).toContainText('4 replies');
	await page.getByRole('button', { name: 'Show 1 reply' }).click();
	const reloadedNested = page.locator('.nested-replies .post-reply').filter({ hasText: 'around the time the algorithm replaced the timeline.' }).first();
	await expect(reloadedNested).toBeVisible();
	await reloadedNested.getByRole('button', { name: 'Show 1 reply' }).click();
	await expect(page.getByText('replying inline to a nested reply')).toBeVisible();
});

test('real thread route nested inline reply composer autocompletes mentions and custom emoji', async ({ page }) => {
	await authenticate(page);
	await mockThread(page, threadStatus, [threadReply, nestedThreadReply, secondThreadReply]);
	await page.route(accountSearchUrl, async (route) => {
		await fulfillJson(route, [{
			...pleromaFixtures.account,
			id: 'soft-hertz',
			username: 'soft.hertz',
			acct: 'soft.hertz@kolektiva.social',
			display_name: 'soft.hertz ✦'
		}]);
	});
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillJson(route, statusWithText('created-nested-autocomplete-reply', 'reply @soft.hertz@kolektiva.social :blobcat:', {
			in_reply_to_id: 'reply-1-child',
			in_reply_to_account_id: 'orbit',
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0
		}));
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	await page.getByRole('button', { name: 'Show 1 reply' }).click();
	const nested = page.locator('.nested-replies .post-reply').first();
	await nested.getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @orbit' });
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
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('reply @soft.hertz@kolektiva.social :blobcat:');
	expect(params.get('in_reply_to_id')).toBe('reply-1-child');
});

test('real thread route inline reply composer attaches pasted and dropped media', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	let uploadCount = 0;
	await page.route('https://pleroma.example/api/v1/media', async (route) => {
		uploadCount += 1;
		await fulfillJson(route, {
			id: `reply-interaction-${uploadCount}`,
			type: 'image',
			url: `https://cdn.example/uploads/reply-interaction-${uploadCount}.png`,
			preview_url: `https://cdn.example/uploads/reply-interaction-${uploadCount}-thumb.png`,
			description: null
		});
	});
	let createBody = '';
	await page.route('https://pleroma.example/api/v1/statuses', async (route) => {
		createBody = route.request().postData() ?? '';
		await fulfillJson(route, statusWithText('created-thread-media-reply', 'with uploads', {
			in_reply_to_id: 'status-1',
			in_reply_to_account_id: 'account-1',
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0
		}));
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	await page.getByTestId('focused-post').getByRole('button', { name: 'Reply 2' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @quietadmin' });
	const replyEditor = replyForm.getByRole('textbox', { name: 'Reply text' });
	await replyEditor.fill('with uploads');
	await replyEditor.evaluate((node) => {
		const file = new File(['paste'], 'reply-pasted.png', { type: 'image/png' });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(file);
		const event = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true });
		node.dispatchEvent(event);
	});
	await expect(replyForm.getByText('reply-pasted.png')).toBeVisible();

	await replyForm.evaluate((node) => {
		const file = new File(['drop'], 'reply-dropped.png', { type: 'image/png' });
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(file);
		node.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
		node.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
	});
	await expect(replyForm.getByText('reply-dropped.png')).toBeVisible();
	await replyForm.getByRole('button', { name: 'Reply', exact: true }).click();

	await expect(page.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);
	const params = new URLSearchParams(createBody);
	expect(params.get('status')).toBe('with uploads');
	expect(params.get('in_reply_to_id')).toBe('status-1');
	expect(params.getAll('media_ids[]')).toEqual(['reply-interaction-1', 'reply-interaction-2']);
	expect(uploadCount).toBe(2);
});

test('real thread route action failures rollback and show scoped errors', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	let resolveFavorite: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});
	await page.route('https://pleroma.example/api/v1/statuses/reply-1/favourite', async (route) => {
		await favoritePending;
		await fulfillJson(route, { error: 'thread favorite failed temporarily' }, 503);
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });
	await reply.getByRole('button', { name: 'Favorite 64' }).click();
	await expect(reply.getByRole('button', { name: 'Favorite 65' })).toHaveAttribute('aria-pressed', 'true');

	resolveFavorite();
	await expect(reply.getByRole('button', { name: 'Favorite 64' })).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByRole('alert')).toContainText('thread favorite failed temporarily');
});

test('real thread route action auth failures sign out and redirect', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await page.route('https://pleroma.example/api/v1/statuses/reply-1/reblog', async (route) => {
		await fulfillJson(route, { error: 'forbidden token' }, 403);
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });
	await reply.getByRole('button', { name: 'Boost 12' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: /quieter corner of the social web/i })).toBeVisible();
});

test('real thread route keeps independent action state across out-of-order responses', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	let resolveFavorite: () => void = () => undefined;
	let resolveBoost: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});
	const boostPending = new Promise<void>((resolve) => {
		resolveBoost = resolve;
	});
	await page.route('https://pleroma.example/api/v1/statuses/reply-1/favourite', async (route) => {
		await favoritePending;
		await fulfillJson(route, { ...threadReply, favourited: true, favourites_count: 70, reblogged: false, reblogs_count: 12 });
	});
	await page.route('https://pleroma.example/api/v1/statuses/reply-1/reblog', async (route) => {
		await boostPending;
		await fulfillJson(route, { ...threadReply, favourited: false, favourites_count: 64, reblogged: true, reblogs_count: 14 });
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });
	await reply.getByRole('button', { name: 'Favorite 64' }).click();
	await reply.getByRole('button', { name: 'Boost 12' }).click();
	await expect(reply.getByRole('button', { name: 'Favorite 65' })).toHaveAttribute('aria-pressed', 'true');
	await expect(reply.getByRole('button', { name: 'Boost 13' })).toHaveAttribute('aria-pressed', 'true');

	resolveBoost();
	await expect(reply.getByRole('button', { name: 'Boost 14' })).toHaveAttribute('aria-pressed', 'true');
	await expect(reply.getByRole('button', { name: 'Favorite 65' })).toHaveAttribute('aria-pressed', 'true');

	resolveFavorite();
	await expect(reply.getByRole('button', { name: 'Favorite 70' })).toHaveAttribute('aria-pressed', 'true');
	await expect(reply.getByRole('button', { name: 'Boost 14' })).toHaveAttribute('aria-pressed', 'true');
});

test('real thread route does not leak action failures across thread id changes', async ({ page }) => {
	await authenticate(page);
	const secondThreadStatus = statusWithText('status-2', 'a different thread should not inherit action errors', {
		replies_count: 0,
		reblogs_count: 1,
		favourites_count: 5
	});
	let resolveFavorite: () => void = () => undefined;
	const favoritePending = new Promise<void>((resolve) => {
		resolveFavorite = resolve;
	});
	await mockInstance(page);
	await page.route('https://pleroma.example/api/v1/statuses/status-1', async (route) => {
		await fulfillJson(route, threadStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-1/context', async (route) => {
		await fulfillJson(route, { ancestors: [threadAncestor], descendants: [threadReply] });
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-2', async (route) => {
		await fulfillJson(route, secondThreadStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-2/context', async (route) => {
		await fulfillJson(route, { ancestors: [], descendants: [] });
	});
	await page.route('https://pleroma.example/api/v1/statuses/reply-1/favourite', async (route) => {
		await favoritePending;
		await fulfillJson(route, { error: 'late thread favorite failed' }, 503);
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });
	await reply.getByRole('button', { name: 'Favorite 64' }).click();
	await expect(reply.getByRole('button', { name: 'Favorite 65' })).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => {
		window.history.pushState({}, '', '/app/thread/status-2');
		window.dispatchEvent(new PopStateEvent('popstate'));
	});
	await expect(page).toHaveURL('/app/thread/status-2');
	await expect(page.getByTestId('focused-post')).toContainText('a different thread should not inherit action errors');

	const favoriteResponse = page.waitForResponse('https://pleroma.example/api/v1/statuses/reply-1/favourite');
	resolveFavorite();
	await favoriteResponse;
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	await expect(page.getByText('late thread favorite failed')).toHaveCount(0);
	await expect(page.getByTestId('focused-post').getByRole('button', { name: 'Favorite 5' })).toHaveAttribute('aria-pressed', 'false');
});

test('real thread route reply sort changes selected state and order', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const replies = page.getByTestId('thread-reply');
	await expect(page.getByRole('group', { name: 'Reply sort' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true');
	await expect(replies.first()).toContainText('we used to log off. when did that stop being a thing.');

	await page.getByRole('button', { name: 'Newest' }).click();
	await expect(page.getByRole('button', { name: 'Newest' })).toHaveAttribute('aria-pressed', 'true');
	await expect(replies.first()).toContainText('this is the energy i needed today.');
});

test('real thread route renders an API error state and retries', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	let attempts = 0;
	await page.route('https://pleroma.example/api/v1/statuses/status-1', async (route) => {
		attempts += 1;
		await fulfillJson(route, attempts === 1 ? { error: 'try again' } : threadStatus, attempts === 1 ? 503 : 200);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-1/context', async (route) => {
		await fulfillJson(route, { ancestors: [threadAncestor], descendants: [threadReply] });
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	await expect(page.getByText('Pleroma server error')).toBeVisible();
	await page.getByRole('button', { name: 'Retry thread' }).click();
	await expect(page.getByTestId('focused-post')).toContainText('quiet CSS can still carry the voice.');
});

test('real thread route ignores stale status responses after moving to a no-id thread route', async ({ page }) => {
	await authenticate(page);
	await mockInstance(page);
	let releaseStatus: () => void = () => undefined;
	const statusPending = new Promise<void>((resolve) => {
		releaseStatus = resolve;
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-1', async (route) => {
		await statusPending;
		await fulfillJson(route, threadStatus);
	});
	await page.route('https://pleroma.example/api/v1/statuses/status-1/context', async (route) => {
		await fulfillJson(route, { ancestors: [threadAncestor], descendants: [threadReply] });
	});
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');
	await page.goto('/app/thread');
	await expect(page.getByText('Thread unavailable')).toBeVisible();

	releaseStatus();
	await expect(page.getByText('DeltaNet needs a status id to load a thread.')).toBeVisible();
	await expect(page.getByTestId('focused-post')).toHaveCount(0);
});

test('real thread layout remains readable on mobile without horizontal overflow', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await setViewport(page, 'mobile');
	await page.goto('/app/thread/status-1');

	await expect(page.getByTestId('thread-view')).toBeVisible();
	await expect(page.getByTestId('focused-post')).toBeVisible();
	await expect(page.getByRole('form', { name: 'Thread reply' })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test('real thread inline reply composer remains usable on mobile', async ({ page }) => {
	await authenticate(page);
	await mockThread(page);
	await setViewport(page, 'mobile');
	await page.goto('/app/thread/status-1');

	await page.getByTestId('focused-post').getByRole('button', { name: 'Reply 2' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @quietadmin' });
	await expect(replyForm).toBeVisible();
	await expect(replyForm.getByRole('textbox', { name: 'Reply text' })).toBeVisible();
	await expect(replyForm.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
	await expectNoHorizontalOverflow(page);
});

test('real thread nested inline reply composer remains usable on mobile', async ({ page }) => {
	await authenticate(page);
	const deepNestedReply = statusWithText('reply-1-grandchild', 'one more nested reply for mobile layout', {
		account: accountWithName('pixel', 'pixel', 'pixel@tiny.social'),
		in_reply_to_id: 'reply-1-child',
		in_reply_to_account_id: 'orbit',
		replies_count: 1,
		reblogs_count: 0,
		favourites_count: 0
	});
	const cappedNestedReply = statusWithText('reply-1-greatgrandchild', 'the fourth nested mobile reply still fits', {
		account: accountWithName('wavelet', 'wavelet', 'wavelet@tiny.social'),
		in_reply_to_id: 'reply-1-grandchild',
		in_reply_to_account_id: 'pixel',
		replies_count: 0,
		reblogs_count: 0,
		favourites_count: 0
	});
	await mockThread(page, threadStatus, [threadReply, { ...nestedThreadReply, replies_count: 1 }, deepNestedReply, cappedNestedReply, secondThreadReply]);
	await setViewport(page, 'mobile');
	await page.goto('/app/thread/status-1');

	await page.getByRole('button', { name: 'Show 1 reply' }).click();
	const nested = page.locator('.nested-replies .post-reply').filter({ hasText: 'around the time the algorithm replaced the timeline.' }).first();
	await nested.getByRole('button', { name: 'Show 1 reply' }).click();
	const deepNested = page.locator('.nested-replies .nested-replies .post-reply').filter({ hasText: 'one more nested reply for mobile layout' }).first();
	await deepNested.getByRole('button', { name: 'Show 1 reply' }).click();
	const cappedNested = page.locator('.nested-replies .nested-replies .nested-replies .post-reply').filter({ hasText: 'the fourth nested mobile reply still fits' }).first();
	await cappedNested.getByRole('button', { name: 'Reply 0' }).click();
	const replyForm = page.getByRole('form', { name: 'Inline reply to @wavelet' });
	await expect(replyForm).toBeVisible();
	await expect(replyForm.getByRole('textbox', { name: 'Reply text' })).toBeVisible();
	await expect(replyForm.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
	await expectNoHorizontalOverflow(page);
});

test('real thread route renders the focused post emoji reaction row and toggles reactions', async ({ page }) => {
	await authenticate(page);
	const reactedThreadStatus = {
		...threadStatus,
		pleroma: {
			...threadStatus.pleroma,
			emoji_reactions: [
				{ name: '❤️', count: 4, me: false },
				{ name: 'blobcat', count: 2, me: true, url: 'https://cdn.example/emoji/blobcat.png' }
			]
		}
	};
	await mockThread(page, reactedThreadStatus);
	await page.route(
		(url) => url.href.startsWith('https://pleroma.example/api/v1/pleroma/statuses/status-1/reactions/'),
		async (route) => {
			await fulfillJson(route, {
				...reactedThreadStatus,
				pleroma: {
					...reactedThreadStatus.pleroma,
					emoji_reactions: [
						{ name: '❤️', count: 5, me: true },
						{ name: 'blobcat', count: 2, me: true, url: 'https://cdn.example/emoji/blobcat.png' }
					]
				}
			});
		}
	);

	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const focused = page.getByTestId('focused-post');
	const reactions = focused.getByTestId('post-reactions');
	await expect(reactions).toBeVisible();
	await expect(reactions.locator('img[alt=":blobcat:"]')).toBeVisible();
	await expect(reactions.getByRole('button', { name: /:blobcat: · 2 reactions · you reacted/ })).toHaveAttribute('aria-pressed', 'true');

	await reactions.getByRole('button', { name: /❤️ · 4 reactions$/ }).click();
	await expect(reactions.getByRole('button', { name: /❤️ · 5 reactions · you reacted/ })).toHaveAttribute('aria-pressed', 'true');
});

test('real thread route renders emoji reaction chips on ancestors and descendants', async ({ page }) => {
	await authenticate(page);
	const reactedAncestor = {
		...threadAncestor,
		pleroma: {
			...threadAncestor.pleroma,
			emoji_reactions: [{ name: '❤️', count: 1, me: false }]
		}
	};
	const reactedReply = {
		...threadReply,
		pleroma: {
			...threadReply.pleroma,
			emoji_reactions: [
				{ name: '❤️', count: 3, me: false },
				{ name: 'blobcat', count: 2, me: true, url: 'https://cdn.example/emoji/blobcat.png' }
			]
		}
	};
	await mockThread(page, threadStatus, [reactedReply, nestedThreadReply, secondThreadReply], [reactedAncestor]);
	await page.route(
		(url) => url.href.startsWith('https://pleroma.example/api/v1/pleroma/statuses/ancestor-1/reactions/'),
		async (route) => {
			await fulfillJson(route, {
				...reactedAncestor,
				pleroma: {
					...reactedAncestor.pleroma,
					emoji_reactions: [{ name: '❤️', count: 2, me: true }]
				}
			});
		}
	);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const ancestor = page.getByTestId('thread-ancestor');
	const ancestorReactions = ancestor.getByTestId('post-reactions');
	await expect(ancestorReactions).toBeVisible();
	await expect(ancestorReactions.getByRole('button', { name: /❤️ · 1 reaction$/ })).toHaveAttribute('aria-pressed', 'false');

	const reply = page.getByTestId('thread-reply').filter({ hasText: 'we used to log off. when did that stop being a thing.' });
	const replyReactions = reply.getByTestId('post-reactions');
	await expect(replyReactions).toBeVisible();
	await expect(replyReactions.locator('img[alt=":blobcat:"]')).toBeVisible();
	await expect(replyReactions.getByRole('button', { name: /:blobcat: · 2 reactions · you reacted/ })).toHaveAttribute('aria-pressed', 'true');
	await expect(replyReactions.getByRole('button', { name: /❤️ · 3 reactions$/ })).toHaveAttribute('aria-pressed', 'false');

	await ancestorReactions.getByRole('button', { name: /❤️ · 1 reaction$/ }).click();
	await expect(ancestorReactions.getByRole('button', { name: /❤️ · 2 reactions · you reacted/ })).toHaveAttribute('aria-pressed', 'true');
});

test('real thread route links reply chips and body mentions to full federated handles', async ({ page }) => {
	await authenticate(page);
	const remoteReply: PleromaStatus = {
		...threadStatus,
		content: '<p>@merc glad it landed. cc @lain</p>',
		in_reply_to_id: 'ancestor-1',
		in_reply_to_account_id: 'account-merc',
		mentions: [
			{ id: 'account-merc', username: 'merc', acct: 'merc@stereophonic.space', url: 'https://stereophonic.space/users/merc' },
			{ id: 'account-lain', username: 'lain', acct: 'lain@lain.com', url: 'https://lain.com/users/lain' }
		],
		pleroma: {
			...threadStatus.pleroma,
			content: { 'text/plain': '@merc glad it landed. cc @lain' }
		}
	};
	await mockThread(page, remoteReply);
	await setViewport(page, 'desktop');
	await page.goto('/app/thread/status-1');

	const focused = page.getByTestId('focused-post');
	const parentChip = focused.locator('.post-pinged-chip-parent');
	await expect(parentChip).toContainText('@merc');
	await expect(parentChip).not.toContainText('@merc@stereophonic.space');
	await expect(parentChip).toHaveAttribute('href', '/app/profiles/merc%40stereophonic.space');

	const bodyMention = focused.locator('.focused-body a', { hasText: '@lain' });
	await expect(bodyMention).toHaveAttribute('href', '/app/profiles/lain%40lain.com');
});

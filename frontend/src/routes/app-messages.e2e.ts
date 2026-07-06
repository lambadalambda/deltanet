import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import type { PleromaAccount } from '../lib/pleroma/types';
import { fulfillJson, mockRightRailApis, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => fulfillJson(route, []));
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const partner: PleromaAccount = {
	...pleromaFixtures.account,
	id: 'account-tape',
	username: 'tapewitch',
	acct: 'tapewitch@retro.social',
	display_name: 'tape witch',
	avatar: '',
	avatar_static: ''
};

const chatFixture = (overrides: Record<string, unknown> = {}) => ({
	id: 'chat-1',
	account: partner,
	unread: 2,
	updated_at: '2026-07-06T08:00:00.000Z',
	last_message: {
		id: 'msg-2',
		content: 'did you find the cassette?',
		chat_id: 'chat-1',
		account_id: partner.id,
		created_at: '2026-07-06T08:00:00.000Z',
		attachment: null,
		emojis: [],
		unread: true
	},
	...overrides
});

const chatMessages = () => [
	{
		id: 'msg-2',
		content: 'did you find the cassette?',
		chat_id: 'chat-1',
		account_id: partner.id,
		created_at: '2026-07-06T08:00:00.000Z',
		attachment: null,
		emojis: [],
		unread: true
	},
	{
		id: 'msg-1',
		content: 'still digging through the archive',
		chat_id: 'chat-1',
		account_id: pleromaFixtures.account.id,
		created_at: '2026-07-06T07:00:00.000Z',
		attachment: null,
		emojis: [],
		unread: false
	}
];

test('messages route lists chats with unread badges and nav count', async ({ page }) => {
	await authenticate(page);
	let authorization: string | undefined;
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => {
		authorization = route.request().headers().authorization;
		await fulfillJson(route, [chatFixture()]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/messages');

	await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
	const list = page.getByTestId('chat-list');
	await expect(list).toContainText('tape witch');
	await expect(list).toContainText('did you find the cassette?');
	await expect(list.locator('.chat-row-unread')).toHaveText('2');
	expect(authorization).toBe('Bearer access-token');

	const navMessages = page.locator('.side-nav-item', { hasText: 'Messages' }).first();
	await expect(navMessages).toContainText('2');
});

test('messages route shows an empty state', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => fulfillJson(route, []));

	await setViewport(page, 'desktop');
	await page.goto('/app/messages');

	await expect(page.getByTestId('messages-panel')).toContainText('No conversations yet');
	await expect(page.getByTestId('chat-list')).toHaveCount(0);
});

test('opening a chat loads messages, marks it read, and aligns own messages', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => fulfillJson(route, [chatFixture()]));
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/messages**', async (route: Route) => fulfillJson(route, chatMessages()));
	let readBody = '';
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/read', async (route: Route) => {
		readBody = route.request().postData() ?? '';
		await fulfillJson(route, chatFixture({ unread: 0 }));
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/messages');
	await page.getByTestId('chat-list').locator('.chat-row').click();

	await expect(page).toHaveURL('/app/messages/chat-1');
	const thread = page.getByTestId('chat-thread');
	await expect(thread).toContainText('still digging through the archive');
	await expect(thread).toContainText('did you find the cassette?');
	await expect(thread.locator('.chat-msg.own')).toContainText('still digging through the archive');
	await expect(thread.locator('.chat-msg').first()).toContainText('still digging through the archive');
	await expect.poll(() => readBody).toContain('msg-2');
	expect(JSON.parse(readBody)).toMatchObject({ last_read_id: 'msg-2' });
});

test('sending a chat message posts the content and appends the reply', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => fulfillJson(route, [chatFixture({ unread: 0 })]));
	let sendBody = '';
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/messages**', async (route: Route) => {
		if (route.request().method() === 'POST') {
			sendBody = route.request().postData() ?? '';
			await fulfillJson(route, {
				id: 'msg-3',
				content: 'found it in the b-side crate',
				chat_id: 'chat-1',
				account_id: pleromaFixtures.account.id,
				created_at: '2026-07-06T09:00:00.000Z',
				attachment: null,
				emojis: [],
				unread: false
			});
			return;
		}
		await fulfillJson(route, chatMessages());
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/messages/chat-1');

	const thread = page.getByTestId('chat-thread');
	await thread.getByRole('textbox', { name: 'Message text' }).fill('found it in the b-side crate');
	await thread.getByRole('button', { name: 'Send' }).click();

	await expect(thread.locator('.chat-msg.own').last()).toContainText('found it in the b-side crate');
	expect(JSON.parse(sendBody)).toMatchObject({ content: 'found it in the b-side crate' });
	await expect(thread.getByRole('textbox', { name: 'Message text' })).toHaveValue('');
});

test('a failed send surfaces the error and keeps the draft', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => fulfillJson(route, [chatFixture({ unread: 0 })]));
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/messages**', async (route: Route) => {
		if (route.request().method() === 'POST') {
			await fulfillJson(route, { error: 'chat is frozen' }, 422);
			return;
		}
		await fulfillJson(route, chatMessages());
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/messages/chat-1');

	const thread = page.getByTestId('chat-thread');
	await thread.getByRole('textbox', { name: 'Message text' }).fill('is this thing on?');
	await thread.getByRole('button', { name: 'Send' }).click();

	await expect(thread).toContainText('chat is frozen');
	await expect(thread.getByRole('textbox', { name: 'Message text' })).toHaveValue('is this thing on?');
});

test('deleting an own chat message removes it from the thread', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => fulfillJson(route, [chatFixture({ unread: 0 })]));
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/messages**', async (route: Route) => fulfillJson(route, chatMessages()));
	let deleteMethod: string | undefined;
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/messages/msg-1', async (route: Route) => {
		deleteMethod = route.request().method();
		await fulfillJson(route, chatMessages()[1]);
	});

	await setViewport(page, 'desktop');
	await page.goto('/app/messages/chat-1');

	const thread = page.getByTestId('chat-thread');
	await expect(thread).toContainText('still digging through the archive');
	await expect(thread.locator('.chat-msg:not(.own) .chat-msg-delete')).toHaveCount(0);
	await thread.locator('.chat-msg.own').getByRole('button', { name: 'Delete message' }).click();

	await expect(thread).not.toContainText('still digging through the archive');
	expect(deleteMethod).toBe('DELETE');
});

test('messages panel surfaces a chats API error', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => fulfillJson(route, { error: 'chats offline' }, 500));

	await setViewport(page, 'desktop');
	await page.goto('/app/messages');

	await expect(page.getByTestId('messages-panel')).toContainText('chats offline');
});

test('messages route works on mobile without horizontal overflow', async ({ page }) => {
	await authenticate(page);
	await page.route('https://pleroma.example/api/v2/pleroma/chats**', async (route: Route) => fulfillJson(route, [chatFixture()]));
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/messages**', async (route: Route) => fulfillJson(route, chatMessages()));
	await page.route('https://pleroma.example/api/v1/pleroma/chats/chat-1/read', async (route: Route) => fulfillJson(route, chatFixture({ unread: 0 })));

	await setViewport(page, 'mobile');
	await page.goto('/app/messages');

	await expect(page.getByTestId('chat-list')).toContainText('tape witch');
	const listOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(listOverflow).toBeLessThanOrEqual(0);

	await page.goto('/app/messages/chat-1');
	await expect(page.getByTestId('chat-thread')).toContainText('did you find the cassette?');
	const threadOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(threadOverflow).toBeLessThanOrEqual(0);
});

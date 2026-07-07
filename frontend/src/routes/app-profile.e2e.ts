import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import type { PleromaAccount, PleromaRelationship, PleromaStatus } from '../lib/pleroma/types';
import { expectNoHorizontalOverflow, fulfillJson, mockRightRailApis, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const profileAccount: PleromaAccount = {
	...pleromaFixtures.account,
	id: 'account-soft',
	username: 'soft.hertz',
	acct: 'soft.hertz@kolektiva.social',
	display_name: 'soft.hertz ✦',
	note: '<p>field recordings + slow web · cassette decks · taipei.</p><script>alert("bio")</script>',
	url: 'https://kolektiva.social/users/soft.hertz',
	avatar: 'https://cdn.example/soft-hertz.png',
	avatar_static: 'https://cdn.example/soft-hertz.png',
	header: 'https://cdn.example/soft-hertz-header.png',
	header_static: 'https://cdn.example/soft-hertz-header.png',
	locked: false,
	bot: true,
	followers_count: 1921,
	following_count: 312,
	statuses_count: 2148,
	fields: [
		{ name: 'Pronouns', value: 'they / them', verified_at: null },
		{ name: 'Web', value: '<a href="https://softhertz.land">softhertz.land</a><img src=x onerror=alert(1)>', verified_at: '2026-01-01T00:00:00.000Z' },
		{ name: 'Instance', value: 'kolektiva.social', verified_at: null }
	],
	pleroma: {
		...pleromaFixtures.account.pleroma,
		relationship: {
			...pleromaFixtures.relationship,
			id: 'account-soft',
			following: true,
			followed_by: true
		},
		tags: ['field-recordist']
	}
};

const datagramAccount: PleromaAccount = {
	...profileAccount,
	id: 'account-datagram',
	username: 'datagram',
	acct: 'datagram@retro.social',
	display_name: 'datagram',
	locked: false,
	bot: false,
	fields: [],
	pleroma: { ...profileAccount.pleroma, relationship: undefined }
};

const relationshipFor = (id: string, overrides: Partial<PleromaRelationship> = {}): PleromaRelationship => ({
	...pleromaFixtures.relationship,
	id,
	following: false,
	followed_by: false,
	requested: false,
	blocking: false,
	...overrides
});

const statusForProfile = (id: string, text: string, options: Partial<PleromaStatus> = {}): PleromaStatus => ({
	...pleromaFixtures.status,
	id,
	uri: `https://kolektiva.social/objects/${id}`,
	url: `https://kolektiva.social/notice/${id}`,
	account: profileAccount,
	content: `<p>${text}</p>`,
	created_at: options.created_at ?? '2026-05-19T12:00:00.000Z',
	favourited: options.favourited ?? false,
	favourites_count: options.favourites_count ?? 12,
	in_reply_to_account_id: options.in_reply_to_account_id ?? null,
	in_reply_to_id: options.in_reply_to_id ?? null,
	media_attachments: options.media_attachments ?? [],
	pinned: options.pinned ?? false,
	pleroma: {
		...pleromaFixtures.status.pleroma,
		content: { 'text/plain': text },
		local: false,
		spoiler_text: { 'text/plain': options.spoiler_text ?? '' }
	},
	reblogged: options.reblogged ?? false,
	reblogs_count: options.reblogs_count ?? 4,
	replies_count: options.replies_count ?? 2,
	sensitive: options.sensitive ?? false,
	spoiler_text: options.spoiler_text ?? '',
	tags: [],
	visibility: options.visibility ?? 'public'
});

const pinnedStatuses = [
	statusForProfile('pin-1', "the algorithm doesn't care about you. the timeline doesn't either. but the people in it do, and that's worth keeping.", { pinned: true, favourites_count: 891, reblogs_count: 312, replies_count: 142 }),
	statusForProfile('pin-2', 'follow whoever you want. mute liberally. block when you need to. the timeline is yours to tend.', { pinned: true, favourites_count: 612, reblogs_count: 124, replies_count: 38 })
];
const postStatuses = [
	statusForProfile('soft-post-1', "rain recording from this morning's walk — 11 minutes, two takes, the kettle made it onto the second one.", {
		media_attachments: [{ id: 'audio-1', type: 'audio', url: 'https://cdn.example/rain.wav', description: 'rain on glass · take 2', meta: { duration: 702 } }]
	}),
	statusForProfile('soft-post-2', "thinking about how the slow web isn't really slow — it's just the pace at which a person can actually pay attention.")
];
const replyStatuses = [
	statusForProfile('soft-reply-1', 'reply from the margins, still part of the shape.', { in_reply_to_id: 'parent-1', in_reply_to_account_id: 'account-parent' }),
	...postStatuses
];
const mediaStatuses = [
	postStatuses[0],
	statusForProfile('soft-media-2', 'dusk in the alley behind the apartment.', {
		media_attachments: [{ id: 'photo-1', type: 'image', url: 'https://cdn.example/cat-door.webp', preview_url: 'https://cdn.example/cat-door-thumb.webp', description: 'door with cat at dusk' }]
	}),
	statusForProfile('soft-media-hidden', 'private contact sheet.', {
		media_attachments: [{ id: 'photo-hidden', type: 'image', url: 'https://cdn.example/private.webp', preview_url: 'https://cdn.example/private-thumb.webp', description: 'hidden sensitive frame' }],
		sensitive: true,
		spoiler_text: 'contact sheet'
	})
];

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => fulfillJson(route, []));
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('deltanet.session', JSON.stringify(storedSession));
	}, session);
};

const mockProfileApis = async (page: Page, account: PleromaAccount = profileAccount) => {
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		const url = new URL(route.request().url());
		expect(url.searchParams.get('q')).toBe(account.acct);
		expect(url.searchParams.get('resolve')).toBe('true');
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, [account]);
	});
	await page.route(`https://pleroma.example/api/v1/accounts/${account.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		const body = url.searchParams.get('pinned') === 'true'
			? pinnedStatuses
			: url.searchParams.get('only_media') === 'true'
				? mediaStatuses
				: url.searchParams.get('exclude_replies') === 'true'
					? postStatuses
					: replyStatuses;
		await fulfillJson(route, body.map((status) => ({ ...status, account })));
	});
};

const mockProfileSearchAndStatuses = async (page: Page) => {
	const accounts = [profileAccount, pleromaFixtures.account, datagramAccount];
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		const q = new URL(route.request().url()).searchParams.get('q') ?? '';
		const normalized = q.replace(/^@/, '').toLowerCase();
		await fulfillJson(route, accounts.filter((account) => account.acct.toLowerCase() === normalized || account.username.toLowerCase() === normalized || account.id === q));
	});
	for (const account of accounts) {
		await page.route(`https://pleroma.example/api/v1/accounts/${account.id}/statuses**`, async (route: Route) => {
			const url = new URL(route.request().url());
			await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account })));
		});
	}
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		const ids = new URL(route.request().url()).searchParams.getAll('id[]');
		await fulfillJson(route, ids.map((id) => relationshipFor(id)));
	});
};

test('profile route loads the canonical account timeline surface', async ({ page }) => {
	await authenticate(page);
	await mockProfileApis(page);
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		const url = new URL(route.request().url());
		expect(url.searchParams.getAll('id[]')).toEqual([profileAccount.id]);
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, [relationshipFor(profileAccount.id, { following: true, followed_by: true })]);
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/soft.hertz@kolektiva.social');

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'soft.hertz ✦' })).toBeVisible();
	await expect(profile).toContainText('@soft.hertz@kolektiva.social');
	await expect(profile).toContainText('field recordings + slow web · cassette decks · taipei.');
	await expect(profile).toContainText('Mutuals');
	await expect(profile).toContainText('bot');
	await expect(profile).toContainText('remote');
	await expect(profile).not.toContainText('alert("bio")');
	await expect(profile.locator('script')).toHaveCount(0);

	await expect(profile).toContainText('pinned');
	await expect(profile).toContainText("the algorithm doesn't care about you");
	await profile.getByRole('button', { name: 'Show all (2)' }).click();
	await expect(profile).toContainText('mute liberally');
	await expect(profile.getByTestId('profile-posts')).toContainText("rain recording from this morning's walk");

	await profile.getByRole('tab', { name: /Posts & Replies/ }).click();
	await expect(profile.getByTestId('profile-posts')).toContainText('reply from the margins');

	await profile.getByRole('tab', { name: /Media/ }).click();
	await expect(profile.getByTestId('profile-media-grid')).toContainText('AUDIO');
	await expect(profile.getByAltText('door with cat at dusk')).toBeVisible();
	await expect(profile.getByAltText('hidden sensitive frame')).toHaveCount(0);

	const rail = page.getByTestId('right-rail');
	await expect(rail).toContainText('Numbers');
	await expect(rail).toContainText('2,148');
	await expect(rail).toContainText('Details');
	await expect(rail).toContainText('softhertz.land');
	await expect(rail).toContainText('Also pinned');
	await expectNoHorizontalOverflow(page);

	await setViewport(page, 'mobile');
	await expect(profile.getByRole('heading', { name: 'soft.hertz ✦' })).toBeVisible();
	await expect(profile).toContainText('Numbers');
	await expectNoHorizontalOverflow(page);
});

test('profile route uses a placeholder when the profile avatar image fails', async ({ page }) => {
	const deadAvatarAccount = {
		...profileAccount,
		avatar: 'https://cdn.example/dead-profile-avatar.png',
		avatar_static: 'https://cdn.example/dead-profile-avatar.png'
	};
	await authenticate(page);
	await mockProfileApis(page, deadAvatarAccount);
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		await fulfillJson(route, [relationshipFor(profileAccount.id, { following: true, followed_by: true })]);
	});
	await page.route('https://cdn.example/dead-profile-avatar.png', async (route) => {
		await route.abort();
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/soft.hertz@kolektiva.social');

	const profileAvatar = page.getByTestId('profile-view').locator('.pp-v1-av.avatar-fallback');
	await expect(profileAvatar).toBeVisible();
	await expect(profileAvatar.locator('img[alt="soft.hertz ✦ avatar"]')).toHaveClass(/avatar-img-failed/);
});

test('profile navigation uses cached timeline account and refreshes existing post identity', async ({ page }) => {
	const cachedAccount: PleromaAccount = {
		...profileAccount,
		id: 'account-cached-soft',
		username: 'cached.soft',
		acct: 'cached.soft@kolektiva.social',
		display_name: 'cached.soft old',
		avatar: 'https://cdn.example/cached-soft-old.png',
		avatar_static: 'https://cdn.example/cached-soft-old.png',
		pleroma: { ...profileAccount.pleroma, relationship: undefined }
	};
	const freshAccount: PleromaAccount = {
		...cachedAccount,
		display_name: 'cached.soft updated',
		avatar: 'https://cdn.example/cached-soft-new.png',
		avatar_static: 'https://cdn.example/cached-soft-new.png'
	};
	const homeStatus = { ...statusForProfile('cached-home', 'cached account identity should refresh.'), account: cachedAccount };
	const newerStatus = { ...statusForProfile('cached-newer', 'newer account payload updates the cache.'), account: freshAccount };
	let searchRequestCount = 0;
	let releaseNewerTimeline: () => void = () => undefined;
	const newerTimelineReady = new Promise<void>((resolve) => {
		releaseNewerTimeline = resolve;
	});

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get('since_id')) await newerTimelineReady;
		await fulfillJson(route, url.searchParams.get('since_id') ? [newerStatus] : [homeStatus]);
	});
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		searchRequestCount += 1;
		await fulfillJson(route, [freshAccount]);
	});
	await page.route(`https://pleroma.example/api/v1/accounts/${freshAccount.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: freshAccount })));
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor(freshAccount.id, { following: true })]));
	await setViewport(page, 'desktop');

	await page.goto('/app/home');
	const post = page.getByTestId('home-timeline-list').locator('.post').first();
	await expect(post).toContainText('cached.soft old');
	releaseNewerTimeline();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('deltanet:check-home-timeline')));
	await expect(post).toContainText('cached.soft updated');
	await expect(page.getByTestId('timeline-header-actions').getByRole('button', { name: '1 new posts' })).toBeVisible();
	await post.getByRole('link', { name: '@cached.soft@kolektiva.social' }).click();

	await expect(page).toHaveURL(/\/app\/profiles\/cached\.soft%40kolektiva\.social$/);
	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'cached.soft updated' })).toBeVisible();
	expect(searchRequestCount).toBe(0);
});

test('profile route renders cached account header before relationship and statuses finish', async ({ page }) => {
	const cachedAccount: PleromaAccount = {
		...profileAccount,
		id: 'account-fast-soft',
		username: 'fast.soft',
		acct: 'fast.soft@kolektiva.social',
		display_name: 'fast.soft cached',
		pleroma: { ...profileAccount.pleroma, relationship: undefined }
	};
	const homeStatus = { ...statusForProfile('fast-home', 'cached profile should render immediately.'), account: cachedAccount };
	let searchRequestCount = 0;
	let releaseRelationship: () => void = () => undefined;
	let releaseStatuses: () => void = () => undefined;
	const relationshipReady = new Promise<void>((resolve) => {
		releaseRelationship = resolve;
	});
	const statusesReady = new Promise<void>((resolve) => {
		releaseStatuses = resolve;
	});

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => fulfillJson(route, [homeStatus]));
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		searchRequestCount += 1;
		await fulfillJson(route, [cachedAccount]);
	});
	await page.route(`https://pleroma.example/api/v1/accounts/${cachedAccount.id}/statuses**`, async (route: Route) => {
		await statusesReady;
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: cachedAccount })));
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		await relationshipReady;
		await fulfillJson(route, [relationshipFor(cachedAccount.id, { following: true })]);
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/home');
	await page.getByTestId('home-timeline-list').locator('.post').first().getByRole('link', { name: '@fast.soft@kolektiva.social' }).click();

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'fast.soft cached' })).toBeVisible();
	await expect(profile).toContainText('Loading profile posts');
	await expect(page.getByTestId('right-rail')).toContainText('Numbers');
	await expect(page.getByTestId('right-rail')).not.toContainText('Profile preview');
	await expect(page.getByTestId('right-rail')).not.toContainText('Profile tips');
	expect(searchRequestCount).toBe(0);

	releaseRelationship();
	releaseStatuses();
	await expect(profile.getByRole('button', { name: 'Following' })).toBeVisible();
	await expect(profile.getByTestId('profile-posts')).toContainText("rain recording from this morning's walk");
});

test('profile route reconciles relationship before slow statuses finish', async ({ page }) => {
	const cachedAccount: PleromaAccount = {
		...profileAccount,
		id: 'account-fast-relation',
		username: 'fast.relation',
		acct: 'fast.relation@kolektiva.social',
		display_name: 'fast.relation cached',
		pleroma: { ...profileAccount.pleroma, relationship: undefined }
	};
	const homeStatus = { ...statusForProfile('fast-relation-home', 'relationship should update before statuses.'), account: cachedAccount };
	let releaseStatuses: () => void = () => undefined;
	const statusesReady = new Promise<void>((resolve) => {
		releaseStatuses = resolve;
	});

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => fulfillJson(route, [homeStatus]));
	await page.route(`https://pleroma.example/api/v1/accounts/${cachedAccount.id}/statuses**`, async (route: Route) => {
		await statusesReady;
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: cachedAccount })));
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor(cachedAccount.id, { following: true })]));
	await setViewport(page, 'desktop');

	await page.goto('/app/home');
	await page.getByTestId('home-timeline-list').locator('.post').first().getByRole('link', { name: '@fast.relation@kolektiva.social' }).click();

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'fast.relation cached' })).toBeVisible();
	await expect(profile).toContainText('Loading profile posts');
	await expect(profile.getByRole('button', { name: 'Following' })).toBeVisible();

	releaseStatuses();
	await expect(profile.getByTestId('profile-posts')).toContainText("rain recording from this morning's walk");
});

test('profile loading state does not show settings profile preview rail', async ({ page }) => {
	let releaseSearch: () => void = () => undefined;
	const searchReady = new Promise<void>((resolve) => {
		releaseSearch = resolve;
	});

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		await searchReady;
		await fulfillJson(route, [profileAccount]);
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor(profileAccount.id, { following: true, followed_by: true })]));
	await page.route(`https://pleroma.example/api/v1/accounts/${profileAccount.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: profileAccount })));
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/soft.hertz@kolektiva.social');

	await expect(page.getByTestId('profile-route')).toContainText('Loading profile');
	await expect(page.getByTestId('right-rail')).toContainText('Loading profile');
	await expect(page.getByTestId('right-rail')).not.toContainText('Profile preview');
	await expect(page.getByTestId('right-rail')).not.toContainText('Profile tips');

	releaseSearch();
	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'soft.hertz ✦' })).toBeVisible();
});

test('direct profile route falls back to account search when no cached account matches', async ({ page }) => {
	const fallbackAccount: PleromaAccount = {
		...profileAccount,
		id: 'account-direct-soft',
		username: 'direct.soft',
		acct: 'direct.soft@kolektiva.social',
		display_name: 'direct.soft',
		pleroma: { ...profileAccount.pleroma, relationship: undefined }
	};
	let searchRequestCount = 0;

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		searchRequestCount += 1;
		const url = new URL(route.request().url());
		expect(url.searchParams.get('q')).toBe(fallbackAccount.acct);
		expect(url.searchParams.get('resolve')).toBe('true');
		await fulfillJson(route, [fallbackAccount]);
	});
	await page.route(`https://pleroma.example/api/v1/accounts/${fallbackAccount.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: fallbackAccount })));
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor(fallbackAccount.id, { following: true })]));
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/direct.soft@kolektiva.social');

	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'direct.soft' })).toBeVisible();
	expect(searchRequestCount).toBe(1);
});

test('deep-linked numeric profile id resolves via accounts/:id without account search', async ({ page }) => {
	const numericAccount: PleromaAccount = {
		...datagramAccount,
		id: '12',
		username: 'contact12',
		acct: 'contact12@retro.social',
		display_name: 'Contact Twelve'
	};
	let searchRequestCount = 0;

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		searchRequestCount += 1;
		await fulfillJson(route, []);
	});
	await page.route('https://pleroma.example/api/v1/accounts/12', async (route: Route) => {
		expect(new URL(route.request().url()).pathname).toBe('/api/v1/accounts/12');
		await fulfillJson(route, numericAccount);
	});
	await page.route('https://pleroma.example/api/v1/accounts/12/statuses**', async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: numericAccount })));
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor('12', { following: true })]));
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/12');

	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'Contact Twelve' })).toBeVisible();
	expect(searchRequestCount).toBe(0);
});

test('deep-linked raw @handle@domain resolves via accounts/lookup without account search', async ({ page }) => {
	let searchRequestCount = 0;
	let lookupAcct: string | null = null;

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		searchRequestCount += 1;
		await fulfillJson(route, []);
	});
	await page.route('https://pleroma.example/api/v1/accounts/lookup**', async (route: Route) => {
		lookupAcct = new URL(route.request().url()).searchParams.get('acct');
		await fulfillJson(route, datagramAccount);
	});
	await page.route(`https://pleroma.example/api/v1/accounts/${datagramAccount.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: datagramAccount })));
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor(datagramAccount.id, { following: true })]));
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/@datagram@retro.social');

	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'datagram' })).toBeVisible();
	expect(lookupAcct).toBe('@datagram@retro.social');
	expect(searchRequestCount).toBe(0);
});

test('deep-linked percent-encoded handle resolves via accounts/lookup without account search', async ({ page }) => {
	let searchRequestCount = 0;
	let lookupAcct: string | null = null;

	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => {
		searchRequestCount += 1;
		await fulfillJson(route, []);
	});
	await page.route('https://pleroma.example/api/v1/accounts/lookup**', async (route: Route) => {
		lookupAcct = new URL(route.request().url()).searchParams.get('acct');
		await fulfillJson(route, datagramAccount);
	});
	await page.route(`https://pleroma.example/api/v1/accounts/${datagramAccount.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: datagramAccount })));
	});
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor(datagramAccount.id, { following: true })]));
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/datagram%40retro.social');

	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'datagram' })).toBeVisible();
	expect(lookupAcct).toBe('datagram@retro.social');
	expect(searchRequestCount).toBe(0);
});

test('profile route fetches missing relationship state before rendering follow labels', async ({ page }) => {
	const relationshipAccount: PleromaAccount = {
		...profileAccount,
		id: 'account-following',
		username: 'line.noise',
		acct: 'line.noise@kolektiva.social',
		display_name: 'line.noise',
		pleroma: { ...profileAccount.pleroma, relationship: undefined }
	};
	let relationshipRequestCount = 0;

	await authenticate(page);
	await mockProfileApis(page, relationshipAccount);
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		relationshipRequestCount += 1;
		const url = new URL(route.request().url());
		expect(url.searchParams.getAll('id[]')).toEqual([relationshipAccount.id]);
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, [relationshipFor(relationshipAccount.id, { following: true })]);
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/line.noise@kolektiva.social');

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'line.noise' })).toBeVisible();
	await expect(profile.getByRole('button', { name: 'Following' })).toBeVisible();
	await expect(profile).not.toContainText('Mutuals');
	expect(relationshipRequestCount).toBe(1);
});

test('profile route refreshes stale embedded relationship state before rendering follow labels', async ({ page }) => {
	const relationshipAccount: PleromaAccount = {
		...profileAccount,
		id: 'account-stale-following',
		username: 'stale.signal',
		acct: 'stale.signal@kolektiva.social',
		display_name: 'stale.signal',
		pleroma: { ...profileAccount.pleroma, relationship: relationshipFor('account-stale-following') }
	};
	let relationshipRequestCount = 0;

	await authenticate(page);
	await mockProfileApis(page, relationshipAccount);
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		relationshipRequestCount += 1;
		const url = new URL(route.request().url());
		expect(url.searchParams.getAll('id[]')).toEqual([relationshipAccount.id]);
		expect(route.request().headers().authorization).toBe('Bearer access-token');
		await fulfillJson(route, [relationshipFor(relationshipAccount.id, { following: true })]);
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/stale.signal@kolektiva.social');

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'stale.signal' })).toBeVisible();
	await expect(profile.getByRole('button', { name: 'Following' })).toBeVisible();
	await expect(profile).not.toContainText('Mutuals');
	expect(relationshipRequestCount).toBe(1);
});

test('post avatars, handles, body mentions, and reply pings navigate to profiles', async ({ page }) => {
	const linkedStatus = statusForProfile('link-home', '@quietadmin@pleroma.example checking profile links with @datagram@retro.social.', { in_reply_to_id: 'parent-1', in_reply_to_account_id: 'account-1' });
	await authenticate(page);
	await mockProfileSearchAndStatuses(page);
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route) => fulfillJson(route, [linkedStatus]));
	await setViewport(page, 'desktop');

	await page.goto('/app/home');
	const post = page.getByTestId('home-timeline-list').locator('.post').first();

	const avatarLink = post.getByRole('link', { name: 'Open profile for soft.hertz ✦' });
	await expect(avatarLink).toHaveAttribute('href', '/app/profiles/soft.hertz%40kolektiva.social');
	await avatarLink.click();
	await expect(page).toHaveURL(/\/app\/profiles\/soft\.hertz%40kolektiva\.social$/);
	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'soft.hertz ✦' })).toBeVisible();

	await page.goto('/app/home');
	const handleLink = post.getByRole('link', { name: '@soft.hertz@kolektiva.social' });
	await expect(handleLink).toHaveAttribute('href', '/app/profiles/soft.hertz%40kolektiva.social');
	await handleLink.click();
	await expect(page).toHaveURL(/\/app\/profiles\/soft\.hertz%40kolektiva\.social$/);
	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'soft.hertz ✦' })).toBeVisible();

	await page.goto('/app/home');
	const mentionLink = post.getByRole('link', { name: '@datagram@retro.social' });
	await expect(mentionLink).toHaveAttribute('href', '/app/profiles/datagram%40retro.social');
	await mentionLink.click();
	await expect(page).toHaveURL(/\/app\/profiles\/datagram%40retro\.social$/);
	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'datagram' })).toBeVisible();

	await page.goto('/app/home');
	const pingLink = post.getByRole('link', { name: 'Open profile for @quietadmin@pleroma.example' });
	await expect(pingLink).toHaveAttribute('href', '/app/profiles/quietadmin%40pleroma.example');
	await pingLink.click();
	await expect(page).toHaveURL(/\/app\/profiles\/quietadmin%40pleroma\.example$/);
	await expect(page.getByTestId('profile-view').getByRole('heading', { name: 'quiet admin' })).toBeVisible();
});

test('profile route fetches public posts for locked accounts', async ({ page }) => {
	const lockedAccount = { ...profileAccount, id: 'account-locked', acct: 'locked.user@kolektiva.social', display_name: 'locked user', locked: true, pleroma: { ...profileAccount.pleroma, relationship: undefined } };
	let statusRequestCount = 0;
	await authenticate(page);
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route: Route) => fulfillJson(route, [lockedAccount]));
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => fulfillJson(route, [relationshipFor(lockedAccount.id)]));
	await page.route(`https://pleroma.example/api/v1/accounts/${lockedAccount.id}/statuses**`, async (route: Route) => {
		statusRequestCount += 1;
		await fulfillJson(route, postStatuses.map((status) => ({ ...status, account: lockedAccount })));
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/locked.user@kolektiva.social');

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'locked user' })).toBeVisible();
	await expect(profile).toContainText('locked');
	await expect(profile).not.toContainText('This account is locked');
	await expect(profile.getByTestId('profile-posts')).toContainText("rain recording from this morning's walk");
	expect(statusRequestCount).toBeGreaterThan(0);
	await expectNoHorizontalOverflow(page);
});

test('profile route refreshes token-only own locked profiles after account hydration', async ({ page }) => {
	const lockedOwnAccount: PleromaAccount = {
		...pleromaFixtures.account,
		locked: true,
		pleroma: { ...pleromaFixtures.account.pleroma, relationship: undefined }
	};
	let statusRequestCount = 0;
	await mockRightRailApis(page);
	await page.route('https://pleroma.example/api/v1/notifications**', async (route) => fulfillJson(route, []));
	await page.route('https://pleroma.example/api/v1/accounts/verify_credentials', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 150));
		await fulfillJson(route, lockedOwnAccount);
	});
	await page.route('https://pleroma.example/api/v1/accounts/search**', async (route) => fulfillJson(route, [lockedOwnAccount]));
	await page.route('https://pleroma.example/api/v1/accounts/account-1/statuses**', async (route) => {
		statusRequestCount += 1;
		await fulfillJson(route, pleromaFixtures.timelines.home);
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
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/quietadmin@pleroma.example');

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'quiet admin' })).toBeVisible();
	await expect(profile).toContainText('Edit profile');
	await expect(profile).not.toContainText('This account is locked');
	await expect(profile.getByTestId('profile-posts')).toContainText('quiet CSS can still carry the voice.');
	expect(statusRequestCount).toBeGreaterThan(0);
});

const mockRelationships = async (page: Page, accountId: string, overrides: Partial<PleromaRelationship> = {}) => {
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		await fulfillJson(route, [relationshipFor(accountId, overrides)]);
	});
};

test('profile follow button follows a stranger optimistically and reconciles with the server', async ({ page }) => {
	await authenticate(page);
	await mockProfileApis(page, datagramAccount);
	await mockRelationships(page, datagramAccount.id);

	let releaseFollow = () => {};
	const followGate = new Promise<void>((resolve) => (releaseFollow = resolve));
	let followRequests = 0;
	await page.route(`https://pleroma.example/api/v1/accounts/${datagramAccount.id}/follow`, async (route: Route) => {
		followRequests += 1;
		expect(route.request().method()).toBe('POST');
		await followGate;
		await fulfillJson(route, relationshipFor(datagramAccount.id, { following: true }));
	});

	await page.goto('/app/profiles/datagram@retro.social');
	const view = page.getByTestId('profile-view');
	const followButton = view.getByRole('button', { name: 'Follow', exact: true });
	await expect(followButton).toBeEnabled();
	await followButton.click();

	await expect(view.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
	releaseFollow();
	await expect(view.getByRole('button', { name: 'Following', exact: true })).toBeEnabled();
	expect(followRequests).toBe(1);
});

test('profile follow button unfollows a followed account', async ({ page }) => {
	const followedAccount = {
		...datagramAccount,
		pleroma: {
			...datagramAccount.pleroma,
			relationship: relationshipFor(datagramAccount.id, { following: true })
		}
	};
	await authenticate(page);
	await mockProfileApis(page, followedAccount);
	await mockRelationships(page, followedAccount.id, { following: true });
	await page.route(`https://pleroma.example/api/v1/accounts/${followedAccount.id}/unfollow`, async (route: Route) => {
		await fulfillJson(route, relationshipFor(followedAccount.id, { following: false }));
	});

	await page.goto('/app/profiles/datagram@retro.social');
	const view = page.getByTestId('profile-view');
	await view.getByRole('button', { name: 'Following', exact: true }).click();
	await expect(view.getByRole('button', { name: 'Follow', exact: true })).toBeEnabled();
});

test('profile follow of a locked account lands in the requested state', async ({ page }) => {
	const lockedAccount = { ...datagramAccount, locked: true };
	await authenticate(page);
	await mockProfileApis(page, lockedAccount);
	await mockRelationships(page, lockedAccount.id);
	await page.route(`https://pleroma.example/api/v1/accounts/${lockedAccount.id}/follow`, async (route: Route) => {
		await fulfillJson(route, relationshipFor(lockedAccount.id, { requested: true }));
	});

	await page.goto('/app/profiles/datagram@retro.social');
	const view = page.getByTestId('profile-view');
	await view.getByRole('button', { name: 'Follow', exact: true }).click();
	await expect(view.getByRole('button', { name: 'Requested', exact: true })).toBeVisible();
});

test('profile follow failure rolls back and surfaces an error', async ({ page }) => {
	await authenticate(page);
	await mockProfileApis(page, datagramAccount);
	await mockRelationships(page, datagramAccount.id);
	await page.route(`https://pleroma.example/api/v1/accounts/${datagramAccount.id}/follow`, async (route: Route) => {
		await fulfillJson(route, { error: 'Internal server error' }, 500);
	});

	await page.goto('/app/profiles/datagram@retro.social');
	const view = page.getByTestId('profile-view');
	await view.getByRole('button', { name: 'Follow', exact: true }).click();

	await expect(page.getByTestId('profile-follow-error')).toBeVisible();
	await expect(view.getByRole('button', { name: 'Follow', exact: true })).toBeEnabled();
});

test('profile follow signs out and redirects when unauthorized', async ({ page }) => {
	await authenticate(page);
	await mockProfileApis(page, datagramAccount);
	await mockRelationships(page, datagramAccount.id);
	await page.route(`https://pleroma.example/api/v1/accounts/${datagramAccount.id}/follow`, async (route: Route) => {
		await fulfillJson(route, { error: 'The access token is invalid' }, 401);
	});

	await page.goto('/app/profiles/datagram@retro.social');
	await page.getByTestId('profile-view').getByRole('button', { name: 'Follow', exact: true }).click();

	await page.waitForURL('/');
	const storedSession = await page.evaluate(() => window.localStorage.getItem('deltanet.session'));
	expect(storedSession).toBeNull();
});

test('signed-out visitors can view a public profile with sign-in prompts', async ({ page }) => {
	let relationshipRequests = 0;
	await page.route('https://pleroma.social/api/v1/accounts/relationships**', async (route: Route) => {
		relationshipRequests += 1;
		await fulfillJson(route, []);
	});
	await page.route('https://pleroma.social/api/v1/accounts/search**', async (route: Route) => {
		expect(route.request().headers().authorization).toBeUndefined();
		await fulfillJson(route, [datagramAccount]);
	});
	await page.route(`https://pleroma.social/api/v1/accounts/${datagramAccount.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: datagramAccount })));
	});

	await page.goto('/app/profiles/datagram@retro.social');
	const view = page.getByTestId('profile-view');
	await expect(view).toBeVisible();
	await expect(view.getByRole('heading', { name: 'datagram' })).toBeVisible();
	await expect(view.getByText("thinking about how the slow web isn't really slow — it's just the pace at which a person can actually pay attention.")).toBeVisible();
	await expect(view.getByRole('button', { name: 'Sign in to follow' })).toBeVisible();
	await expect(view.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
	await expect(page.getByTestId('app-header')).toHaveCount(0);
	await expect(page.getByTestId('public-profile-shell')).toBeVisible();
	expect(relationshipRequests).toBe(0);

	await view.getByRole('button', { name: 'Sign in to follow' }).click();
	await page.waitForURL('/');
});

test('signed-out visitors resolve remote profiles through account lookup', async ({ page }) => {
	await page.route('https://pleroma.social/api/v1/accounts/search**', async (route: Route) => {
		await fulfillJson(route, [pleromaFixtures.account]);
	});
	await page.route('https://pleroma.social/api/v1/accounts/lookup**', async (route: Route) => {
		const url = new URL(route.request().url());
		expect(url.searchParams.get('acct')).toBe('datagram@retro.social');
		expect(route.request().headers().authorization).toBeUndefined();
		await fulfillJson(route, datagramAccount);
	});
	await page.route(`https://pleroma.social/api/v1/accounts/${datagramAccount.id}/statuses**`, async (route: Route) => {
		const url = new URL(route.request().url());
		await fulfillJson(route, url.searchParams.get('pinned') === 'true' ? [] : postStatuses.map((status) => ({ ...status, account: datagramAccount })));
	});

	await page.goto('/app/profiles/datagram@retro.social');
	const view = page.getByTestId('profile-view');
	await expect(view.getByRole('heading', { name: 'datagram' })).toBeVisible();
	await expect(view.getByRole('button', { name: 'Sign in to follow' })).toBeVisible();
});

test('petnames: set from the profile, rendered as a chip after their chosen name', async ({ page }) => {
	// A deltanet contact account (numeric-ish contact id, deltanet extension).
	const carolAccount: PleromaAccount = {
		...profileAccount,
		id: '12',
		username: 'zbie604yz',
		acct: 'zbie604yz@nine.testrun.org',
		display_name: 'Carol Sparkle',
		bot: false,
		fields: [],
		pleroma: {
			...profileAccount.pleroma,
			relationship: undefined,
			deltanet: { auth_name: 'Carol Sparkle' }
		}
	};
	await authenticate(page);
	await mockProfileApis(page, carolAccount);
	await page.route('https://pleroma.example/api/v1/accounts/relationships**', async (route: Route) => {
		await fulfillJson(route, [relationshipFor(carolAccount.id, { following: true })]);
	});
	let petnameBody: unknown;
	await page.route('https://pleroma.example/api/deltanet/contacts/12/petname', async (route: Route) => {
		petnameBody = route.request().postDataJSON();
		await fulfillJson(route, {
			...carolAccount,
			display_name: 'carol',
			pleroma: { ...carolAccount.pleroma, deltanet: { auth_name: 'Carol Sparkle', petname: 'carol' } }
		});
	});
	await setViewport(page, 'desktop');

	await page.goto('/app/profiles/zbie604yz@nine.testrun.org');

	const profile = page.getByTestId('profile-view');
	await expect(profile.getByRole('heading', { name: 'Carol Sparkle' })).toBeVisible();
	await expect(profile.getByTestId('petname-chip')).toHaveCount(0);

	await profile.getByTestId('petname-edit').click();
	await profile.getByRole('textbox', { name: 'Petname' }).fill('carol');
	await profile.getByRole('button', { name: 'Save' }).click();

	// Their chosen name stays the heading; my petname renders as the chip.
	// (UI assertions first: they auto-wait for the intercepted POST to round-trip,
	// so the recorded body check below is deterministic on slow runners.)
	await expect(profile.getByRole('heading', { name: 'Carol Sparkle' })).toBeVisible();
	await expect(profile.getByTestId('petname-chip')).toContainText('carol');
	expect(petnameBody).toEqual({ petname: 'carol' });
	// The follow state was NOT clobbered by the petname response (no
	// relationship in that payload).
	await expect(profile).toContainText('Following');
});

import { expect, test } from '@playwright/test';
import { DEFAULT_STATUS_CHARACTER_LIMIT, adaptPleromaAccount, adaptPleromaNotifications, adaptPleromaProfile, adaptPleromaStatus, adaptPleromaStatuses, formatRelativeStatusTime, htmlToPlainText, mediaPlaceholderText, normalizePleromaRequestError, profileSettingsFromAccount, profileUpdateFromSettings, statusCharacterLimit } from './ui';
import { pleromaFixtures } from './fixtures';
import type { PleromaStatus } from './types';

const withStatus = (overrides: Partial<PleromaStatus>): PleromaStatus => ({
	...pleromaFixtures.status,
	...overrides,
	account: overrides.account ?? pleromaFixtures.status.account,
	pleroma: { ...pleromaFixtures.status.pleroma, ...overrides.pleroma }
});

test('Pleroma status adapters preserve plain text content and UI action state', () => {
	const post = adaptPleromaStatus(pleromaFixtures.status, { timelines: ['home', 'local'], now: Date.parse('2026-05-01T12:05:00.000Z') });

	expect(post).toMatchObject({
		id: 'status-1',
		originalStatusId: 'status-1',
		name: 'quiet admin',
		handle: '@quietadmin@pleroma.example',
		body: 'quiet CSS can still carry the voice.',
		avatarUrl: 'https://pleroma.example/avatar.png',
		timelines: ['home', 'local'],
		replies: 2,
		boosts: 4,
		favorites: 9,
		actions: { reply: false, boost: false, favorite: false },
		account: {
			id: 'account-1',
			displayName: 'quiet admin',
			handle: '@quietadmin@pleroma.example',
			avatarUrl: 'https://pleroma.example/avatar.png'
		},
		pleroma: {
			conversationId: 42,
			local: true,
			plainText: 'quiet CSS can still carry the voice.'
		}
	});
	expect(post.time).toBe('5 minutes ago');
	expect(post.contentHtml).toBe('<p>quiet CSS can still carry the voice.</p>');
	expect(post.mediaHidden).toBe(false);
});

test('Pleroma status timestamp formatter returns relative labels', () => {
	const now = Date.parse('2026-05-22T12:00:00.000Z');

	expect(formatRelativeStatusTime('2026-05-22T11:59:30.000Z', now)).toBe('just now');
	expect(formatRelativeStatusTime('2026-05-22T11:55:00.000Z', now)).toBe('5 minutes ago');
	expect(formatRelativeStatusTime('2026-05-22T10:00:00.000Z', now)).toBe('2 hours ago');
	expect(formatRelativeStatusTime('2026-05-20T12:00:00.000Z', now)).toBe('2 days ago');
	expect(formatRelativeStatusTime('2025-05-22T12:00:00.000Z', now)).toBe('1 year ago');
	expect(formatRelativeStatusTime('not-a-date', now)).toBe('');
});

test('Pleroma status adapters expose custom emoji for display names and body text', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'custom-emoji-status',
		account: {
			...pleromaFixtures.account,
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
			content: { 'text/plain': 'brainfrot :blobcat:' }
		}
	}));

	expect(post.name).toBe('zonk :fatteratte:');
	expect(post.nameEmojis).toEqual([
		{
			shortcode: 'fatteratte',
			url: 'https://cdn.example/emoji/fatteratte.png',
			staticUrl: 'https://cdn.example/emoji/fatteratte-static.png'
		}
	]);
	expect(post.body).toBe('brainfrot :blobcat:');
	expect(post.bodyEmojis).toEqual([
		{
			shortcode: 'blobcat',
			url: 'https://cdn.example/emoji/blobcat.png',
			staticUrl: 'https://cdn.example/emoji/blobcat-static.png'
		}
	]);
});

test('Pleroma status adapters preserve paragraph breaks when text/plain collapses HTML breaks', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'collapsed-plain-text-paragraphs',
		content: 'Good analysis.<br/><br/>Risk of getting caught is low because there&#39;s no motive.<br/><br/>Not getting caught comes down to:<br/>1. Don&#39;t bring your phone.<br/>2. Don&#39;t drive a car with a GSM in it.',
		pleroma: {
			content: {
				'text/plain': "Good analysis.Risk of getting caught is low because there's no motive.Not getting caught comes down to:1. Don't bring your phone.2. Don't drive a car with a GSM in it."
			}
		}
	}));

	expect(post.body).toBe("Good analysis.\n\nRisk of getting caught is low because there's no motive.\n\nNot getting caught comes down to:\n1. Don't bring your phone.\n2. Don't drive a car with a GSM in it.");
	expect(post.contentText).toBe(post.body);
});

test('Pleroma status adapters move leading reply recipients into addressees', () => {
	const reply = withStatus({
		id: 'reply-with-leading-recipients',
		in_reply_to_id: 'parent-status',
		in_reply_to_account_id: 'account-2',
		content: '<p>@dtluna @feld qwen 0.5b can handle it. has @lain tried it?</p>',
		pleroma: {
			content: { 'text/plain': '@dtluna @feld qwen 0.5b can handle it. has @lain tried it?' }
		}
	});

	const post = adaptPleromaStatus(reply);

	expect(post.body).toBe('qwen 0.5b can handle it. has @lain tried it?');
	expect(post.addressees).toEqual(['@dtluna', '@feld']);

	const topLevelPost = adaptPleromaStatus(withStatus({
		id: 'top-level-leading-mentions',
		content: '<p>@dtluna @feld qwen 0.5b can handle it.</p>',
		pleroma: {
			content: { 'text/plain': '@dtluna @feld qwen 0.5b can handle it.' }
		}
	}));

	expect(topLevelPost.body).toBe('@dtluna @feld qwen 0.5b can handle it.');
	expect(topLevelPost.addressees).toBeUndefined();
});

test('Pleroma status adapters use mention metadata for leading recipient mentions without visible parents', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'remote-leading-mention-with-hidden-parent',
		content: '<span class="h-card"><a class="u-url mention" href="https://lizards.live/@vriska" rel="ugc">@<span>vriska</span></a></span> Joseph was always on the side of the good guys.',
		pleroma: {
			content: { 'text/plain': '@vriska Joseph was always on the side of the good guys.' },
			parent_visible: false
		},
		mentions: [
			{
				id: '9quS1LZ6YIFB6VC6WO',
				url: 'https://lizards.live/@vriska',
				username: 'vriska',
				acct: 'vriska@lizards.live'
			}
		]
	}));

	expect(post.body).toBe('Joseph was always on the side of the good guys.');
	expect(post.addressees).toEqual(['@vriska@lizards.live']);
});

test('Pleroma status adapters synthesize reply addressees from metadata without visible mentions', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'metadata-only-reply',
		in_reply_to_id: 'parent-status',
		in_reply_to_account_id: 'parent-account',
		content: 'amazing look',
		pleroma: {
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
	}));

	expect(post.body).toBe('amazing look');
	expect(post.addressees).toEqual(['@mischievoustomato@tsundere.love']);
});

test('Pleroma status adapters map addressee handles to display names from mentions', () => {
	// Headwater ships a non-standard `display_name` on mentions (chatmail local
	// parts are random registration strings); the "Replying to" pill renders it.
	const post = adaptPleromaStatus(withStatus({
		id: 'named-reply',
		in_reply_to_id: 'parent-status',
		in_reply_to_account_id: 'parent-account',
		content: 'hello carol',
		pleroma: {
			content: { 'text/plain': 'hello carol' },
			in_reply_to_account_acct: 'zbie604yz@nine.testrun.org'
		},
		mentions: [
			{
				id: 'parent-account',
				url: 'http://localhost:4030/headwater/contact/12',
				username: 'zbie604yz',
				acct: 'zbie604yz@nine.testrun.org',
				display_name: 'Carol Sparkle'
			}
		]
	}));

	expect(post.addressees).toEqual(['@zbie604yz@nine.testrun.org']);
	// Both handle forms are keyed, mirroring mentionAcctMap.
	expect(post.addresseeNames).toEqual({
		'@zbie604yz@nine.testrun.org': 'Carol Sparkle',
		'@zbie604yz': 'Carol Sparkle'
	});
});

test('addresseeNames is empty when mentions carry no display names (fediverse statuses)', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'unnamed-reply',
		in_reply_to_id: 'parent-status',
		in_reply_to_account_id: 'parent-account',
		content: 'amazing look',
		pleroma: {
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
	}));

	expect(post.addresseeNames).toEqual({});
});

test('Pleroma status adapters handle reblogs, remote handles, warnings, and fallback assets', () => {
	const remoteAccount = {
		...pleromaFixtures.account,
		id: 'remote-account',
		username: 'datagram',
		acct: 'datagram@a-very-long-retro-instance-name.social',
		display_name: '',
		avatar: '',
		avatar_static: ''
	};
	const reblogged = withStatus({
		id: 'remote-status',
		account: remoteAccount,
		content: '<p>HTML fallback with<br>line breaks &amp; entities.</p>',
		spoiler_text: 'remote cw',
		favourited: true,
		favourites_count: 10,
		reblogged: true,
		reblogs_count: 6,
		media_attachments: [
			{
				id: 'media-1',
				type: 'image',
				url: 'https://cdn.example/media.png',
				preview_url: 'https://cdn.example/preview.png',
				description: 'screenshot'
			}
		],
		pleroma: {
			content: {},
			local: false,
			spoiler_text: { 'text/plain': 'plain cw' }
		}
	});
	const wrapper = withStatus({
		id: 'boost-wrapper',
		account: { ...pleromaFixtures.account, acct: 'booster@pleroma.example', display_name: 'booster' },
		reblog: reblogged,
		reblogged: true
	});

	const post = adaptPleromaStatus(wrapper);

	expect(post.id).toBe('boost-wrapper');
	expect(post.timelineItemId).toBe('boost-wrapper');
	expect(post.actionStatusId).toBe('remote-status');
	expect(post.threadStatusId).toBe('remote-status');
	expect(post.originalStatusId).toBe('remote-status');
	expect(post.name).toBe('datagram');
	expect(post.handle).toBe('@datagram@a-very-long-retro-instance-name.social');
	expect(post.account.avatarUrl).toBeNull();
	expect(post.avatar).toBe('grad-2');
	expect(post.cw).toBe('plain cw');
	expect(post.body).toBe('HTML fallback with\nline breaks & entities.');
	expect(post.contentText).toBe('HTML fallback with\nline breaks & entities.');
	expect(post.media).toBeUndefined();
	expect(post.attachments).toEqual([
		{ kind: 'photo', src: 'https://cdn.example/media.png', alt: 'screenshot', filename: 'media.png' }
	]);
	expect(post.mediaHidden).toBe(true);
	expect(post.boosts).toBe(5);
	expect(post.favorites).toBe(9);
	expect(post.actions).toMatchObject({ boost: true, favorite: true });
	expect(post.hasContentWarning).toBe(true);
	expect(post.spoilerText).toBe('plain cw');
	expect(post.mediaAttachments).toEqual([
		{
			id: 'media-1',
			type: 'image',
			url: 'https://cdn.example/media.png',
			previewUrl: 'https://cdn.example/preview.png',
			description: 'screenshot',
			filename: 'media.png',
			duration: null
		}
	]);
	expect(post.boostedBy).toMatchObject({ name: 'booster', handle: '@booster@pleroma.example' });
	expect(post.rebloggedBy).toMatchObject({ displayName: 'booster', handle: '@booster@pleroma.example' });
	expect(post.timelines).toEqual(['federated']);
});

test('Pleroma status adapters expose media attachments for shared post rendering', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'status-with-media',
		media_attachments: [
			{
				id: 'image-1',
				type: 'image',
				url: 'https://cdn.example/media/photo.jpg',
				preview_url: 'https://cdn.example/media/photo-preview.jpg',
				description: 'two cats in a window'
			},
			{
				id: 'video-1',
				type: 'video',
				url: 'https://cdn.example/media/clip.mp4',
				preview_url: 'https://cdn.example/media/clip.jpg',
				description: 'short clip',
				meta: { original: { duration: 83.2 } }
			},
			{
				id: 'audio-1',
				type: 'audio',
				url: 'https://cdn.example/media/field.mp3',
				description: 'field recording',
				meta: { original: { duration: 124 } }
			}
		]
	}));

	expect(post.media).toBeUndefined();
	expect(post.attachments).toEqual([
		{ kind: 'photo', src: 'https://cdn.example/media/photo.jpg', alt: 'two cats in a window', filename: 'photo.jpg' },
		{ kind: 'video', src: 'https://cdn.example/media/clip.mp4', posterUrl: 'https://cdn.example/media/clip.jpg', title: 'short clip', caption: 'short clip', duration: '1:23', filename: 'clip.mp4' },
		{ kind: 'audio', src: 'https://cdn.example/media/field.mp3', title: 'field recording', byline: 'audio', duration: '2:04', filename: 'field.mp3' }
	]);
});

test('Pleroma status adapters expose poll attachments for shared post rendering', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'status-with-poll',
		poll: {
			id: 'poll-1',
			options: [
				{ title: 'warm cassette', votes_count: 142 },
				{ title: 'cold terminal', votes_count: 38 },
				{ title: 'spinning vinyl', votes_count: 214 }
			],
			votes_count: 394,
			multiple: false,
			expired: false,
			ends_in: '6h 12m',
			own_votes: [2]
		}
	}));

	expect(post.attachments).toEqual([
		{
			kind: 'poll',
			id: 'poll-1',
			choices: [
				{ id: '0', label: 'warm cassette', votes: 142 },
				{ id: '1', label: 'cold terminal', votes: 38 },
				{ id: '2', label: 'spinning vinyl', votes: 214 }
			],
			totalVotes: 394,
			multi: false,
			endsIn: '6h 12m',
			endedAgo: undefined,
			myVote: '2',
			voted: true,
			expired: false
		}
	]);
});

test('Pleroma status adapters use real poll expiry and voted metadata', () => {
	const expiresAt = new Date(Date.now() + (6 * 60 + 12) * 60000).toISOString();
	const post = adaptPleromaStatus(withStatus({
		id: 'status-with-expiring-poll',
		poll: {
			id: 'poll-expiring',
			options: [
				{ title: 'one', votes_count: 1 },
				{ title: 'two', votes_count: 2 }
			],
			votes_count: 3,
			multiple: true,
			expires_at: expiresAt,
			voted: true
		}
	}));
	const poll = post.attachments?.[0];

	expect(poll).toEqual(expect.objectContaining({
		kind: 'poll',
		id: 'poll-expiring',
		multi: true,
		myVote: null,
		voted: true,
		expired: false,
		endedAgo: undefined
	}));
	expect(poll?.kind === 'poll' ? poll.endsIn : undefined).toMatch(/^6h 1[12]m$/);
});

test('Pleroma status adapters expose visible quote posts and strip inline quote links', () => {
	const quotedStatus = withStatus({
		id: 'quoted-status',
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
		content: '<p>quoted status body</p>',
		created_at: '2026-05-20T11:26:57.000Z',
		replies_count: 1,
		reblogs_count: 2,
		reblogged: true,
		favourites_count: 3,
		favourited: true,
		media_attachments: [
			{
				id: 'quoted-photo',
				type: 'image',
				url: 'https://remote.example/quoted-photo.jpg',
				description: 'quoted photo'
			}
		],
		poll: {
			id: 'quoted-poll',
			options: [{ title: 'polls do not render in quote previews', votes_count: 1 }],
			votes_count: 1
		},
		pleroma: {
			content: { 'text/plain': 'quoted status body' },
			quote: null,
			quote_visible: false
		}
	});
	const post = adaptPleromaStatus(withStatus({
		id: 'quote-wrapper',
		content: 'Me and who?<span class="quote-inline"><br/><br/><bdi>RT:</bdi> <a href="https://remote.example/objects/quoted-status">https://remote.example/objects/quoted-status</a></span>',
		pleroma: {
			content: { 'text/plain': 'Me and who?RT: https://remote.example/objects/quoted-status' },
			quote: quotedStatus,
			quote_id: 'quoted-status',
			quote_url: 'https://remote.example/objects/quoted-status',
			quote_visible: true
		}
	}), { now: Date.parse('2026-05-20T12:26:57.000Z') });

	expect(post.body).toBe('Me and who?');
	expect(post.contentText).toBe('Me and who?');
	expect(post.quotedPost).toMatchObject({
		href: '/app/thread/quoted-status',
		name: 'quoted source',
		handle: '@quoted@remote.example',
		time: '1 hour ago',
		body: 'quoted status body',
		avatarUrl: 'https://remote.example/avatar.jpg',
		replies: 1,
		boosts: 2,
		favs: 3,
		attachments: [{ kind: 'photo', src: 'https://remote.example/quoted-photo.jpg', alt: 'quoted photo' }]
	});

	const hiddenQuote = adaptPleromaStatus(withStatus({
		id: 'hidden-quote-wrapper',
		content: 'Reference kept.<span class="quote-inline"><br/><br/><bdi>RT:</bdi> <a href="https://remote.example/objects/quoted-status">https://remote.example/objects/quoted-status</a></span>',
		pleroma: {
			content: { 'text/plain': 'Reference kept.RT: https://remote.example/objects/quoted-status' },
			quote: quotedStatus,
			quote_url: 'https://remote.example/objects/quoted-status',
			quote_visible: false
		}
	}));
	expect(hiddenQuote.quotedPost).toBeUndefined();
	expect(hiddenQuote.body).toBe('Reference kept.\n\nRT: https://remote.example/objects/quoted-status');

	const replyStyleQuote = adaptPleromaStatus(withStatus({
		id: 'reply-style-quote-wrapper',
		content: '<p>mood<span class="quote-inline"><br/><br/>RE: <a href="https://remote.example/objects/quoted-status">https://remote.example/objects/quoted-status</a></span></p>',
		pleroma: {
			content: { 'text/plain': 'moodRE: https://remote.example/objects/quoted-status' },
			quote: quotedStatus,
			quote_url: 'https://remote.example/objects/quoted-status',
			quote_visible: true
		}
	}));
	expect(replyStyleQuote.body).toBe('mood');
	expect(replyStyleQuote.contentText).toBe('mood');
});

test('Pleroma notification adapters map known and unknown types with local last-seen read state', () => {
	const notifications = adaptPleromaNotifications(pleromaFixtures.notifications, {
		lastSeenAt: '2026-05-18T12:01:00.000Z'
	});

	expect(notifications.map((notification) => [notification.id, notification.kind, notification.read])).toEqual([
		['notif-mention', 'mention', false],
		['notif-follow', 'follow', true],
		['notif-fav', 'fav', true],
		['notif-boost', 'boost', true],
		['notif-reaction', 'reaction', true],
		['notif-unknown', 'unknown', true]
	]);
	expect(notifications[0]).toMatchObject({
		who: [{ name: 'orbit', handle: '@orbit@spacebear.net' }],
		post: { excerpt: 'hey @quietadmin, this carries through notifications.' },
		target: { route: 'thread', statusId: 'status-mention' }
	});
	expect(notifications[1].target).toEqual({ route: 'profile', accountHandle: 'staticgif@modem.zone', accountId: 'account-follow' });
	expect(notifications[4]).toMatchObject({
		kind: 'reaction',
		reactionEmoji: { name: '🔥' },
		target: { route: 'thread', statusId: 'status-reaction' }
	});
	expect(notifications[5].target).toEqual({ route: 'none' });

	const [cwNotification] = adaptPleromaNotifications([{
		...pleromaFixtures.notifications[0],
		id: 'notif-cw',
		status: withStatus({
			id: 'status-cw-notification',
			content: '<p>hidden notification body</p>',
			spoiler_text: 'quiet spoiler',
			pleroma: {
				...pleromaFixtures.status.pleroma,
				content: { 'text/plain': 'hidden notification body' },
				spoiler_text: { 'text/plain': 'quiet spoiler' }
			}
		})
	}]);
	expect(cwNotification.post?.excerpt).toBe('Content warning: quiet spoiler');
});

test('Pleroma status list adapter keeps fixture order and covers missing plain-text fallbacks', () => {
	const noPlainText = withStatus({
		id: 'html-only',
		content: '<p>fallback <strong>html</strong> body</p>',
		pleroma: { content: {}, local: true }
	});
	const posts = adaptPleromaStatuses([pleromaFixtures.status, noPlainText], { timelines: ['home'] });

	expect(posts.map((post) => post.id)).toEqual(['status-1', 'html-only']);
	expect(posts.map((post) => post.timelines)).toEqual([['home'], ['home']]);
	expect(posts[1].body).toBe('fallback html body');
	expect(adaptPleromaStatus(withStatus({ id: 'unknown-locality', pleroma: { local: undefined } })).timelines).toEqual([]);
});

test('HTML fallback text keeps malformed entities from breaking list adaptation', () => {
	expect(htmlToPlainText('<p>remote entity &#999999999999; survives</p>')).toBe('remote entity &#999999999999; survives');
});

test('Pleroma instance adapters expose the configured status character limit', () => {
	expect(statusCharacterLimit({
		...pleromaFixtures.instance,
		configuration: { statuses: { max_characters: 4096 } }
	})).toBe(4096);
	expect(statusCharacterLimit({
		...pleromaFixtures.instance,
		pleroma: {
			metadata: {
				features: [],
				max_toot_chars: 1234
			}
		}
	})).toBe(1234);
	expect(statusCharacterLimit({
		...pleromaFixtures.instance,
		configuration: { statuses: { max_characters: 0 } },
		pleroma: { metadata: { features: [], max_toot_chars: 'nope' } }
	})).toBe(DEFAULT_STATUS_CHARACTER_LIMIT);
});

test('Pleroma request error display distinguishes auth, rate limits, server, and network failures', () => {
	expect(normalizePleromaRequestError({ kind: 'unauthenticated', message: 'token required' })).toMatchObject({
		kind: 'auth-required',
		title: 'Re-authentication required',
		reauthRequired: true,
		retryable: false
	});
	expect(
		normalizePleromaRequestError({
			kind: 'http',
			status: 429,
			path: '/api/v1/timelines/home',
			message: 'slow down',
			response: null
		})
	).toMatchObject({ kind: 'rate-limited', title: 'Rate limit reached', retryable: true });
	expect(
		normalizePleromaRequestError({
			kind: 'http',
			status: 503,
			path: '/api/v1/timelines/home',
			message: 'maintenance',
			response: null
		})
	).toMatchObject({ kind: 'server', title: 'Pleroma server error', retryable: true });
	expect(normalizePleromaRequestError({ kind: 'network', path: '/api/v1/instance', message: 'offline', cause: new Error('offline') })).toMatchObject({
		kind: 'network',
		title: 'Network connection failed',
		retryable: true
	});
});

test('profile settings adapters map accounts to editable settings and update payloads', () => {
	const settings = profileSettingsFromAccount(pleromaFixtures.account);
	expect(settings).toEqual({
		displayName: 'quiet admin',
		username: 'quietadmin',
		bio: 'keeping the lights low',
		website: '',
		location: '',
		discoverable: true,
		showFollowers: true
	});

	const withoutSource = profileSettingsFromAccount({
		...pleromaFixtures.account,
		source: undefined,
		fields: [
			{ name: 'Website', value: '<a href="https://quiet.example">quiet.example</a>', verified_at: null },
			{ name: 'home', value: 'small web', verified_at: null }
		],
		pleroma: { ...pleromaFixtures.account.pleroma, hide_followers_count: true }
	});
	expect(withoutSource.bio).toBe('keeping the lights low');
	expect(withoutSource.website).toBe('quiet.example');
	expect(withoutSource.showFollowers).toBe(false);

	const update = profileUpdateFromSettings(
		{ ...settings, displayName: 'quiet mod', bio: 'new note', website: 'https://quiet.example', location: 'low orbit', showFollowers: false },
		pleromaFixtures.account
	);
	expect(update).toEqual({
		displayName: 'quiet mod',
		note: 'new note',
		discoverable: true,
		hideFollowersCount: true,
		fields: [
			{ name: 'home', value: 'small web' },
			{ name: 'Website', value: 'https://quiet.example' },
			{ name: 'Location', value: 'low orbit' }
		]
	});

	const cleared = profileUpdateFromSettings({ ...settings, website: '  ', location: '' }, {
		...pleromaFixtures.account,
		source: {
			note: 'keeping the lights low',
			fields: [
				{ name: 'Website', value: 'https://quiet.example' },
				{ name: 'home', value: 'small web' }
			]
		}
	});
	expect(cleared.fields).toEqual([{ name: 'home', value: 'small web' }]);
});

test('status reaction adapters normalize unicode and custom emoji reactions', () => {
	const post = adaptPleromaStatus(withStatus({
		pleroma: {
			emoji_reactions: [
				{ name: '❤️', count: 3, me: true },
				{ name: 'blobcat', count: 2, me: false, url: 'https://cdn.example/emoji/blobcat.png', static_url: 'https://cdn.example/emoji/blobcat-static.png' },
				{ name: 'ghost', count: 0, me: false },
				{ name: '', count: 4, me: false }
			]
		}
	}));

	expect(post.reactions).toEqual([
		{ name: '❤️', glyph: '❤️', url: null, staticUrl: null, count: 3, me: true },
		{ name: 'blobcat', glyph: null, url: 'https://cdn.example/emoji/blobcat.png', staticUrl: 'https://cdn.example/emoji/blobcat-static.png', count: 2, me: false }
	]);
	expect(adaptPleromaStatus(pleromaFixtures.status).reactions).toEqual([]);
});

test('media placeholder text summarizes media-only statuses', () => {
	expect(mediaPlaceholderText(['image'])).toBe('[image]');
	expect(mediaPlaceholderText(['image', 'image'])).toBe('[2 images]');
	expect(mediaPlaceholderText(['gifv'])).toBe('[image]');
	expect(mediaPlaceholderText(['video'])).toBe('[video]');
	expect(mediaPlaceholderText(['audio'])).toBe('[audio clip]');
	expect(mediaPlaceholderText(['audio', 'audio'])).toBe('[2 audio clips]');
	expect(mediaPlaceholderText(['image', 'video'])).toBe('[2 attachments]');
	expect(mediaPlaceholderText([], true)).toBe('[poll]');
	expect(mediaPlaceholderText([])).toBe('');

	const [imageOnly] = adaptPleromaNotifications([{
		id: 'notif-media',
		type: 'favourite',
		created_at: '2026-05-18T12:00:00.000Z',
		account: pleromaFixtures.account,
		status: {
			...pleromaFixtures.status,
			content: '',
			media_attachments: [{ id: 'm1', type: 'image', url: 'https://cdn.example/a.png' }],
			pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': '' } }
		},
		pleroma: {}
	}]);
	expect(imageOnly.post?.excerpt).toBe('[image]');
	expect(imageOnly.who[0].emojis).toEqual([]);

	const [empty] = adaptPleromaNotifications([{
		id: 'notif-empty',
		type: 'favourite',
		created_at: '2026-05-18T12:00:00.000Z',
		account: pleromaFixtures.account,
		status: {
			...pleromaFixtures.status,
			content: '',
			media_attachments: [],
			pleroma: { ...pleromaFixtures.status.pleroma, content: { 'text/plain': '' } }
		},
		pleroma: {}
	}]);
	expect(empty.post).toBeUndefined();
});

test('reply addressees and body mentions canonicalize to full federated handles', () => {
	const post = adaptPleromaStatus(withStatus({
		content: '<p>@merc @lain finally upgraded.</p>',
		in_reply_to_id: 'parent-1',
		in_reply_to_account_id: 'account-merc',
		mentions: [
			{ id: 'account-merc', username: 'merc', acct: 'merc@stereophonic.space', url: 'https://stereophonic.space/users/merc' },
			{ id: 'account-lain', username: 'lain', acct: 'lain@lain.com', url: 'https://lain.com/users/lain' }
		],
		pleroma: { content: { 'text/plain': '@merc @lain finally upgraded.' } }
	}));

	expect(post.addressees).toEqual(['@merc@stereophonic.space', '@lain@lain.com']);
	expect(post.mentionAccts).toMatchObject({
		'@merc': '@merc@stereophonic.space',
		'@lain': '@lain@lain.com'
	});

	const local = adaptPleromaStatus(withStatus({
		content: '<p>@quietadmin hello.</p>',
		in_reply_to_id: 'parent-2',
		in_reply_to_account_id: 'account-1',
		mentions: [{ id: 'account-1', username: 'quietadmin', acct: 'quietadmin', url: 'https://pleroma.example/users/quietadmin' }],
		pleroma: { content: { 'text/plain': '@quietadmin hello.' } }
	}));
	expect(local.addressees).toEqual(['@quietadmin']);
});

test('account/profile adapters prefer pleroma.headwater and fall back to legacy deltanet', () => {
	const carol = {
		...pleromaFixtures.account,
		id: 'carol-account',
		acct: 'zbie604yz@nine.testrun.org',
		display_name: 'carol',
		pleroma: {
			...pleromaFixtures.account.pleroma,
			headwater: { auth_name: 'Carol Headwater', petname: 'caz' },
			deltanet: { auth_name: 'Legacy Carol', petname: 'legacy' }
		}
	};
	const view = adaptPleromaAccount(carol);
	expect(view.authName).toBe('Carol Headwater');
	expect(view.petname).toBe('caz');

	const profile = adaptPleromaProfile(carol);
	expect(profile.authName).toBe('Carol Headwater');
	expect(profile.petname).toBe('caz');

	const legacy = adaptPleromaAccount({
		...carol,
		pleroma: { ...pleromaFixtures.account.pleroma, deltanet: { auth_name: 'Legacy Carol', petname: 'legacy' } }
	});
	expect(legacy.authName).toBe('Legacy Carol');
	expect(legacy.petname).toBe('legacy');

	// No Headwater or legacy bag (fediverse account) -> nulls.
	const plain = adaptPleromaAccount(pleromaFixtures.account);
	expect(plain.authName).toBeNull();
	expect(plain.petname).toBeNull();
});

test('status adapter carries the author petname + auth name onto the post view', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'petname-post',
		account: {
			...pleromaFixtures.account,
			id: 'carol-account',
			acct: 'zbie604yz@nine.testrun.org',
			display_name: 'carol',
			pleroma: { ...pleromaFixtures.account.pleroma, headwater: { auth_name: 'Carol Sparkle', petname: 'carol' } }
		}
	}));
	// name stays displayName (petname-first, like core); the pill render uses
	// authName + petname to show "Carol Sparkle [carol]".
	expect(post.name).toBe('carol');
	expect(post.authName).toBe('Carol Sparkle');
	expect(post.petname).toBe('carol');
});

test('addressee maps prefer the auth name and expose petnames separately', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'petname-reply',
		in_reply_to_id: 'parent-status',
		in_reply_to_account_id: 'carol-account',
		content: 'hey!',
		pleroma: {
			content: { 'text/plain': 'hey!' },
			in_reply_to_account_acct: 'zbie604yz@nine.testrun.org'
		},
		mentions: [
			{
				id: 'carol-account',
				url: 'http://localhost:4030/headwater/contact/12',
				username: 'zbie604yz',
				acct: 'zbie604yz@nine.testrun.org',
				display_name: 'carol',
				auth_name: 'Carol Sparkle',
				petname: 'carol'
			}
		]
	}));
	expect(post.addresseeNames?.['@zbie604yz@nine.testrun.org']).toBe('Carol Sparkle');
	expect(post.addresseePetnames?.['@zbie604yz@nine.testrun.org']).toBe('carol');
});

test('mentionNames maps body mention handles to petname-first labels', () => {
	const post = adaptPleromaStatus(withStatus({
		id: 'body-mention-post',
		content: 'hey @zbie604yz@nine.testrun.org!',
		pleroma: { content: { 'text/plain': 'hey @zbie604yz@nine.testrun.org!' } },
		mentions: [
			{
				id: 'carol-account',
				url: 'http://localhost:4030/headwater/contact/12',
				username: 'zbie604yz',
				acct: 'zbie604yz@nine.testrun.org',
				display_name: 'carol',
				auth_name: 'Carol Sparkle',
				petname: 'carol'
			},
			{
				id: 'bob-account',
				url: 'http://localhost:4030/headwater/contact/11',
				username: 'aab3ff9',
				acct: 'aab3ff9@nine.testrun.org',
				display_name: 'bob',
				auth_name: 'bob'
			}
		]
	}));
	// Petname wins; auth name is the fallback.
	expect(post.mentionNames?.['@zbie604yz@nine.testrun.org']).toBe('carol');
	expect(post.mentionNames?.['@aab3ff9@nine.testrun.org']).toBe('bob');
});

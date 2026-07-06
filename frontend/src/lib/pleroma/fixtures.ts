import type {
	PleromaAccount,
	PleromaInstance,
	PleromaMediaAttachment,
	PleromaNotification,
	PleromaRelationship,
	PleromaSearchResult,
	PleromaStatus,
	PleromaStatusContext,
	PleromaTag
} from './types';

const account: PleromaAccount = {
	id: 'account-1',
	username: 'quietadmin',
	acct: 'quietadmin@pleroma.example',
	display_name: 'quiet admin',
	note: '<p>keeping the lights low</p>',
	url: 'https://pleroma.example/users/quietadmin',
	avatar: 'https://pleroma.example/avatar.png',
	avatar_static: 'https://pleroma.example/avatar.png',
	header: 'https://pleroma.example/header.png',
	header_static: 'https://pleroma.example/header.png',
	locked: false,
	bot: false,
	discoverable: true,
	created_at: '2026-01-01T00:00:00.000Z',
	followers_count: 128,
	following_count: 64,
	statuses_count: 512,
	fields: [{ name: 'home', value: 'small web', verified_at: null }],
	emojis: [],
	source: {
		note: 'keeping the lights low',
		fields: [{ name: 'home', value: 'small web' }]
	},
	pleroma: {
		ap_id: 'https://pleroma.example/users/quietadmin',
		favicon: 'https://pleroma.example/favicon.png',
		is_admin: false,
		is_moderator: true,
		tags: ['operator']
	}
};

const status: PleromaStatus = {
	id: 'status-1',
	uri: 'https://pleroma.example/objects/status-1',
	url: 'https://pleroma.example/notice/status-1',
	account,
	content: '<p>quiet CSS can still carry the voice.</p>',
	created_at: '2026-05-01T12:00:00.000Z',
	emojis: [],
	favourited: false,
	favourites_count: 9,
	in_reply_to_account_id: null,
	in_reply_to_id: null,
	language: 'en',
	media_attachments: [],
	mentions: [],
	muted: false,
	pinned: false,
	pleroma: {
		content: { 'text/plain': 'quiet CSS can still carry the voice.' },
		conversation_id: 42,
		local: true,
		spoiler_text: { 'text/plain': '' }
	},
	reblog: null,
	reblogged: false,
	reblogs_count: 4,
	replies_count: 2,
	sensitive: false,
	spoiler_text: '',
	tags: [{ name: 'smallweb', url: 'https://pleroma.example/tag/smallweb' }],
	visibility: 'public'
};

const federatedStatus: PleromaStatus = {
	...status,
	id: 'status-2',
	uri: 'https://retro.social/objects/status-2',
	url: 'https://retro.social/notice/status-2',
	account: { ...account, id: 'account-2', acct: 'datagram@retro.social' },
	pleroma: { ...status.pleroma, local: false }
};

const context: PleromaStatusContext = {
	ancestors: [{ ...status, id: 'ancestor-1', content: '<p>the earlier context</p>' }],
	descendants: [{ ...status, id: 'reply-1', content: '<p>the gentle reply</p>' }]
};

const relationship: PleromaRelationship = {
	id: 'account-1',
	following: true,
	followed_by: false,
	blocking: false,
	muting: false,
	muting_notifications: false,
	requested: false,
	domain_blocking: false,
	showing_reblogs: true,
	endorsed: false,
	notifying: false,
	subscribing: false,
	blocked_by: false
};

const trends: PleromaTag[] = [
	{ name: 'smallweb', url: 'https://pleroma.example/tag/smallweb', history: [{ day: '1', uses: '24', accounts: '9' }] },
	{ name: 'fedidevs', url: 'https://pleroma.example/tag/fedidevs' }
];

const search: PleromaSearchResult = {
	accounts: [account],
	statuses: [status],
	hashtags: trends
};

const customEmojis = [
	{
		shortcode: 'blobcat',
		url: 'https://cdn.example/emoji/blobcat.png',
		static_url: 'https://cdn.example/emoji/blobcat-static.png',
		visible_in_picker: true
	}
];

const mediaAttachment: PleromaMediaAttachment = {
	id: 'media-1',
	type: 'image',
	url: 'https://cdn.example/uploads/cat.png',
	preview_url: 'https://cdn.example/uploads/cat-thumb.png',
	description: null
};

const notificationAccount = (id: string, displayName: string, acct: string): PleromaAccount => ({
	...account,
	id,
	username: acct.split('@')[0],
	acct,
	display_name: displayName,
	url: `https://pleroma.example/users/${id}`,
	avatar: `https://pleroma.example/${id}.png`,
	avatar_static: `https://pleroma.example/${id}.png`
});

const mentionAccount = notificationAccount('account-mention', 'orbit', 'orbit@spacebear.net');
const followAccount = notificationAccount('account-follow', 'static.gif', 'staticgif@modem.zone');
const favoriteAccount = notificationAccount('account-fav', 'kestrel', 'kestrel@audio.garden');
const boostAccount = notificationAccount('account-boost', 'lumen', 'lumen@candle.house');
const reactionAccount = notificationAccount('account-reaction', 'ember', 'ember@drift.fm');
const unknownAccount = notificationAccount('account-unknown', 'relay bot', 'relay@pleroma.example');
const notificationStatus = (id: string, text: string, statusAccount: PleromaAccount = account): PleromaStatus => ({
	...status,
	id,
	uri: `https://pleroma.example/objects/${id}`,
	url: `https://pleroma.example/notice/${id}`,
	account: statusAccount,
	content: `<p>${text}</p>`,
	created_at: '2026-05-18T12:00:00.000Z',
	pleroma: {
		...status.pleroma,
		content: { 'text/plain': text },
		spoiler_text: { 'text/plain': '' }
	}
});

const notifications: PleromaNotification[] = [
	{
		id: 'notif-mention',
		type: 'mention',
		created_at: '2026-05-18T12:02:00.000Z',
		account: mentionAccount,
		status: notificationStatus('status-mention', 'hey @quietadmin, this carries through notifications.', mentionAccount),
		pleroma: {}
	},
	{ id: 'notif-follow', type: 'follow', created_at: '2026-05-18T12:01:00.000Z', account: followAccount, status: null, pleroma: {} },
	{
		id: 'notif-fav',
		type: 'favourite',
		created_at: '2026-05-18T12:00:00.000Z',
		account: favoriteAccount,
		status: notificationStatus('status-fav', 'a placeholder is more honest than a guess.'),
		pleroma: {}
	},
	{
		id: 'notif-boost',
		type: 'reblog',
		created_at: '2026-05-18T11:59:00.000Z',
		account: boostAccount,
		status: notificationStatus('status-boost', 'living in a soft world. quietly federating.'),
		pleroma: {}
	},
	{
		id: 'notif-reaction',
		type: 'pleroma:emoji_reaction',
		emoji: '🔥',
		created_at: '2026-05-18T11:58:30.000Z',
		account: reactionAccount,
		status: notificationStatus('status-reaction', 'reactions carry through notifications.'),
		pleroma: {}
	},
	{
		id: 'notif-unknown',
		type: 'pleroma:chat_mention',
		created_at: '2026-05-18T11:58:00.000Z',
		account: unknownAccount,
		status: notificationStatus('status-unknown', 'an unknown notification still renders.'),
		pleroma: {}
	}
];

const instance: PleromaInstance = {
	domain: 'pleroma.example',
	title: 'Pleroma Example',
	version: '2.10.0 (compatible; Pleroma 2.10.0)',
	description: 'A quiet Pleroma instance for deterministic tests.',
	source_url: 'https://git.pleroma.social/pleroma/pleroma',
	usage: { users: { active_month: 128 } },
	pleroma: {
		metadata: {
			features: ['pleroma_api', 'oauth_registration', 'quote_posting']
		}
	}
};

export const pleromaFixtures = {
	account,
	status,
	context,
	relationship,
	trends,
	notifications,
	search,
	customEmojis,
	mediaAttachment,
	instance,
	timelines: {
		home: [status, federatedStatus],
		public: [federatedStatus]
	},
	oauthApp: {
		id: 'app-1',
		name: 'DeltaNet',
		website: 'https://deltanet.example',
		redirect_uri: 'http://localhost:4173/auth/callback',
		client_id: 'client-id',
		client_secret: 'client-secret',
		vapid_key: 'vapid-key'
	},
	token: {
		access_token: 'access-token',
		token_type: 'Bearer',
		scope: 'read write follow',
		created_at: 1700000001
	}
};

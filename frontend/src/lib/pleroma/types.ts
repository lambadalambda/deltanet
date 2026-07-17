export type PleromaScope = 'read' | 'write' | 'follow' | 'push' | `read:${string}` | `write:${string}`;

export type PleromaField = {
	name: string;
	value: string;
	verified_at?: string | null;
};

export type PleromaCustomEmoji = {
	shortcode: string;
	url: string;
	static_url?: string;
	visible_in_picker?: boolean;
	tags?: string[];
	category?: string | null;
	[key: string]: unknown;
};

type HeadwaterAccountMetadata = {
	auth_name?: string;
	petname?: string;
	[key: string]: unknown;
};

type HeadwaterStatusMetadata = {
	placeholder?: 'boost' | 'boost-unverified';
	ref?: { key: string; addr: string };
	/** True iff this status is a thread root the user is subscribed to. */
	thread_subscribed?: boolean;
	/** Key confirmation: signature verified but NO pinned key for the author yet. */
	author_unconfirmed?: boolean;
};

type HeadwaterCapabilities = {
	bookmarks?: boolean;
	status_deletion?: boolean;
	account_moderation?: boolean;
	media_description?: boolean;
	chats?: boolean;
	polls?: boolean;
	unlisted_visibility?: boolean;
	content_warnings?: boolean;
	extended_profile?: boolean;
};

export type PleromaMediaAttachment = {
	id: string;
	type: string;
	url?: string | null;
	preview_url?: string | null;
	description?: string | null;
	[key: string]: unknown;
};

export type PleromaRelationship = {
	id: string;
	following: boolean;
	followed_by: boolean;
	blocking: boolean;
	muting: boolean;
	muting_notifications: boolean;
	requested: boolean;
	domain_blocking: boolean;
	showing_reblogs: boolean;
	endorsed: boolean;
	notifying?: boolean;
	subscribing?: boolean;
	blocked_by?: boolean;
};

export type PleromaAccount = {
	id: string;
	username: string;
	acct: string;
	display_name: string;
	note: string;
	url: string;
	avatar: string;
	avatar_static: string;
	header: string;
	header_static: string;
	locked: boolean;
	bot: boolean;
	discoverable?: boolean;
	created_at: string;
	followers_count: number;
	following_count: number;
	statuses_count: number;
	fields: PleromaField[];
	emojis?: PleromaCustomEmoji[];
	source?: {
		note?: string;
		fields?: PleromaField[];
		[key: string]: unknown;
	};
	pleroma: {
		ap_id?: string;
		favicon?: string;
		is_admin?: boolean;
		is_moderator?: boolean;
		relationship?: PleromaRelationship;
		tags?: string[];
		/** Headwater petnames: their chosen name + my local override. */
		headwater?: HeadwaterAccountMetadata;
		/** Legacy wire-format fallback for paired DeltaNet daemons. */
		deltanet?: HeadwaterAccountMetadata;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

export type PleromaEmojiReaction = {
	name: string;
	count: number;
	me: boolean;
	url?: string | null;
	static_url?: string | null;
	[key: string]: unknown;
};

export type PleromaStatus = {
	id: string;
	uri: string;
	url: string;
	application?: { name?: string; website?: string | null } | null;
	account: PleromaAccount;
	content: string;
	created_at: string;
	emojis: PleromaCustomEmoji[];
	favourited: boolean;
	favourites_count: number;
	bookmarked?: boolean;
	in_reply_to_account_id: string | null;
	in_reply_to_id: string | null;
	language: string | null;
	media_attachments: unknown[];
	mentions: unknown[];
	muted: boolean;
	pinned: boolean;
	pleroma: {
		content?: Record<string, string>;
		conversation_id?: number;
		emoji_reactions?: PleromaEmojiReaction[];
		local?: boolean;
		quote?: PleromaStatus | null;
		quote_id?: string | null;
		quote_url?: string | null;
		quote_visible?: boolean;
		quotes_count?: number;
		spoiler_text?: Record<string, string>;
		/** Headwater-specific markers (boost placeholder, thread subscription). */
		headwater?: HeadwaterStatusMetadata;
		/** Legacy wire-format fallback for paired DeltaNet daemons. */
		deltanet?: HeadwaterStatusMetadata;
		[key: string]: unknown;
	};
	reblog: PleromaStatus | null;
	reblogged: boolean;
	reblogs_count: number;
	replies_count: number;
	sensitive: boolean;
	spoiler_text: string;
	tags: PleromaTag[];
	visibility: 'public' | 'unlisted' | 'private' | 'direct' | string;
	[key: string]: unknown;
};

export type PleromaStatusContext = {
	ancestors: PleromaStatus[];
	descendants: PleromaStatus[];
};

export type PleromaNotification = {
	id: string;
	type: string;
	created_at: string;
	account: PleromaAccount;
	status?: PleromaStatus | null;
	emoji?: string;
	emoji_url?: string | null;
	pleroma?: {
		is_seen?: boolean;
		[key: string]: unknown;
	};
	read?: boolean;
	[key: string]: unknown;
};

export type PleromaTag = {
	name: string;
	url: string;
	history?: Array<{ day: string; uses: string; accounts: string }>;
};

export type PleromaSearchResult = {
	accounts: PleromaAccount[];
	statuses: PleromaStatus[];
	hashtags: PleromaTag[];
};

export type PleromaInstance = {
	domain: string;
	title: string;
	version: string;
	source_url?: string;
	description: string;
	max_toot_chars?: number | string;
	usage?: { users?: { active_month?: number } };
	configuration?: {
		statuses?: {
			max_characters?: number | string;
			[key: string]: unknown;
		};
		media_attachments?: {
			supported_mime_types?: string[];
			[key: string]: unknown;
		};
		headwater?: {
			capabilities?: HeadwaterCapabilities;
			[key: string]: unknown;
		};
		/** Legacy configuration fallback for paired DeltaNet daemons. */
		deltanet?: {
			capabilities?: HeadwaterCapabilities;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	pleroma: {
		metadata: {
			features: string[];
			max_toot_chars?: number | string;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

export type TimelineQuery = {
	limit?: number;
	maxId?: string;
	minId?: string;
	sinceId?: string;
	onlyMedia?: boolean;
};

export type AccountStatusesQuery = TimelineQuery & {
	excludeReplies?: boolean;
	pinned?: boolean;
};

export type NotificationQuery = Pick<TimelineQuery, 'limit' | 'maxId' | 'minId' | 'sinceId'>;

export type TimelineCursor = Pick<TimelineQuery, 'maxId' | 'minId' | 'sinceId'>;

export type TimelinePagination = {
	next: TimelineCursor | null;
	previous: TimelineCursor | null;
};

export type TimelinePage<Item> = {
	items: Item[];
	cursors: TimelinePagination;
};

export type StatusCreateRequest = {
	status: string;
	visibility?: 'public' | 'unlisted' | 'private' | 'direct' | string;
	spoilerText?: string;
	inReplyToId?: string;
	mediaIds?: string[];
	poll?: {
		options: string[];
		expiresIn: number;
		multiple?: boolean;
		hideTotals?: boolean;
	};
};

export type MediaUploadRequest = {
	description?: string;
};

export type SearchQuery = {
	q: string;
	type?: 'accounts' | 'hashtags' | 'statuses';
	resolve?: boolean;
	limit?: number;
	offset?: number;
	following?: boolean;
};

export type AccountSearchQuery = {
	q: string;
	limit?: number;
	resolve?: boolean;
	following?: boolean;
};

export type ProfileUpdate = {
	displayName?: string;
	note?: string;
	locked?: boolean;
	bot?: boolean;
	discoverable?: boolean;
	hideFollowersCount?: boolean;
	fields?: PleromaField[];
};

export type ProfileImageUpdate = {
	avatar?: File | null;
	header?: File | null;
};

export type PleromaChatMessage = {
	id: string;
	content?: string | null;
	chat_id: string;
	account_id: string;
	created_at?: string;
	attachment?: PleromaMediaAttachment | null;
	emojis?: PleromaCustomEmoji[];
	unread?: boolean;
	[key: string]: unknown;
};

export type PleromaChat = {
	id: string;
	account: PleromaAccount;
	last_message?: PleromaChatMessage | null;
	unread: number;
	updated_at?: string;
	[key: string]: unknown;
};

export type ChatMessageCreateRequest = {
	content?: string;
	mediaId?: string;
};

export type PleromaSuggestion = {
	source?: string;
	account: PleromaAccount;
	[key: string]: unknown;
};

export type PleromaOAuthApp = {
	id?: string;
	name: string;
	website?: string | null;
	redirectUri: string;
	clientId: string;
	clientSecret: string;
	vapidKey?: string;
};

export type PleromaToken = {
	accessToken: string;
	tokenType: string;
	scope: string;
	createdAt?: number;
};

export type PendingPleromaOAuth = {
	instanceUrl: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: readonly PleromaScope[];
	state: string;
	createdAt: number;
};

export type PleromaOAuthClientRegistration = {
	instanceUrl: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: readonly PleromaScope[];
	createdAt: number;
};

export type PleromaSession = {
	instanceUrl: string;
	accessToken: string;
	tokenType: string;
	scope: string;
	createdAt: number;
	account?: PleromaAccount;
};

export type PleromaAuthState =
	| { status: 'unauthenticated' }
	| { status: 'authenticating'; pending: PendingPleromaOAuth }
	| { status: 'authenticated'; session: PleromaSession };

export type PleromaOAuthCallback =
	| { status: 'success'; code: string; state?: string }
	| { status: 'error'; error: string; description?: string; state?: string }
	| { status: 'missing_code'; state?: string };

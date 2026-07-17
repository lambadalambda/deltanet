import { createPleromaHttp, encodePathSegment, type FetchLike } from './http';
import { registerOAuthApp as registerApp } from './oauth';
import type {
	PleromaAccount,
	PleromaInstance,
	PleromaNotification,
	PleromaCustomEmoji,
	PleromaMediaAttachment,
	PleromaRelationship,
	PleromaSearchResult,
	PleromaStatus,
	PleromaStatusContext,
	PleromaTag,
	AccountStatusesQuery,
	AccountSearchQuery,
	ChatMessageCreateRequest,
	MediaUploadRequest,
	PleromaChat,
	PleromaChatMessage,
	NotificationQuery,
	PleromaSuggestion,
	ProfileImageUpdate,
	ProfileUpdate,
	SearchQuery,
	StatusCreateRequest,
	TimelineCursor,
	TimelinePage,
	TimelinePagination,
	TimelineQuery
} from './types';

type ClientConfig = {
	instanceUrl: string;
	accessToken?: string;
	fetch?: FetchLike;
};
type RequestControl = {
	signal?: AbortSignal;
};

const timelineQuery = (query: TimelineQuery = {}) => ({
	limit: query.limit,
	max_id: query.maxId,
	min_id: query.minId,
	since_id: query.sinceId,
	only_media: query.onlyMedia
});

const accountStatusesQuery = (query: AccountStatusesQuery = {}) => ({
	...timelineQuery(query),
	exclude_replies: query.excludeReplies,
	pinned: query.pinned
});

const accountRelationshipsQuery = (ids: string[]) => ({
	'id[]': ids
});

const notificationQuery = (query: NotificationQuery = {}) => ({
	limit: query.limit,
	max_id: query.maxId,
	min_id: query.minId,
	since_id: query.sinceId
});

const emptyTimelinePagination = (): TimelinePagination => ({ next: null, previous: null });

const cursorFromUrl = (href: string): TimelineCursor | null => {
	try {
		const url = new URL(href, 'https://headwater.invalid');
		const cursor = {
			maxId: url.searchParams.get('max_id') ?? undefined,
			minId: url.searchParams.get('min_id') ?? undefined,
			sinceId: url.searchParams.get('since_id') ?? undefined
		};

		return cursor.maxId || cursor.minId || cursor.sinceId ? cursor : null;
	} catch {
		return null;
	}
};

export const parseTimelinePaginationLinkHeader = (linkHeader: string | null): TimelinePagination => {
	const cursors = emptyTimelinePagination();
	if (!linkHeader) return cursors;

	for (const match of linkHeader.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)) {
		const cursor = cursorFromUrl(match[1]);
		if (!cursor) continue;

		const rels = match[2].split(/\s+/).map((rel) => rel.toLowerCase());
		if (rels.includes('next')) cursors.next = cursor;
		if (rels.includes('prev') || rels.includes('previous')) cursors.previous = cursor;
	}

	return cursors;
};

const searchQuery = (query: SearchQuery) => ({
	q: query.q,
	type: query.type,
	resolve: query.resolve,
	limit: query.limit,
	offset: query.offset,
	following: query.following
});

const accountSearchQuery = (query: AccountSearchQuery) => ({
	q: query.q,
	limit: query.limit,
	resolve: query.resolve,
	following: query.following
});

const profileUpdateBody = (profile: ProfileUpdate) => ({
	display_name: profile.displayName,
	note: profile.note,
	locked: profile.locked,
	bot: profile.bot,
	discoverable: profile.discoverable,
	hide_followers_count: profile.hideFollowersCount,
	fields_attributes: profile.fields
});

const appendMultipartScalar = (form: FormData, key: string, value: unknown) => {
	if (value === undefined || value === null) return;
	form.set(key, typeof value === 'boolean' ? String(value) : String(value));
};

// Multipart variant of the profile update, used when avatar/header File
// uploads are pending. Mirrors profileUpdateBody's keys as form fields so the
// daemon's single update_credentials handler receives the text fields and the
// files in one request.
const profileUpdateMultipart = (profile: ProfileUpdate, images: ProfileImageUpdate) => {
	const form = new FormData();
	appendMultipartScalar(form, 'display_name', profile.displayName);
	appendMultipartScalar(form, 'note', profile.note);
	appendMultipartScalar(form, 'locked', profile.locked);
	appendMultipartScalar(form, 'bot', profile.bot);
	appendMultipartScalar(form, 'discoverable', profile.discoverable);
	appendMultipartScalar(form, 'hide_followers_count', profile.hideFollowersCount);
	(profile.fields ?? []).forEach((field, index) => {
		form.set(`fields_attributes[${index}][name]`, field.name);
		form.set(`fields_attributes[${index}][value]`, field.value);
	});
	if (images.avatar) form.set('avatar', images.avatar, images.avatar.name);
	if (images.header) form.set('header', images.header, images.header.name);
	return form;
};

const hasProfileImages = (images?: ProfileImageUpdate): images is ProfileImageUpdate =>
	Boolean(images && (images.avatar || images.header));

const statusCreateForm = (input: StatusCreateRequest) => {
	const form = new URLSearchParams({ status: input.status });
	if (input.visibility) form.set('visibility', input.visibility);
	if (input.spoilerText) form.set('spoiler_text', input.spoilerText);
	if (input.inReplyToId) form.set('in_reply_to_id', input.inReplyToId);
	for (const mediaId of input.mediaIds ?? []) form.append('media_ids[]', mediaId);
	if (input.poll) {
		for (const option of input.poll.options) form.append('poll[options][]', option);
		form.set('poll[expires_in]', String(input.poll.expiresIn));
		form.set('poll[multiple]', String(Boolean(input.poll.multiple)));
		form.set('poll[hide_totals]', String(Boolean(input.poll.hideTotals)));
	}

	return form;
};

const mediaUploadForm = (file: File | Blob, input: MediaUploadRequest = {}) => {
	const form = new FormData();
	form.set('file', file);
	if (input.description) form.set('description', input.description);
	return form;
};

const timelinePage = <Item>(items: Item[], headers: Headers): TimelinePage<Item> => ({
	items,
	cursors: parseTimelinePaginationLinkHeader(headers.get('link'))
});

export const createPleromaClient = (config: ClientConfig) => {
	const http = createPleromaHttp(config);

	return {
		getHomeTimeline: (query?: TimelineQuery) =>
			http.request<PleromaStatus[]>({
				path: '/api/v1/timelines/home',
				query: timelineQuery(query),
				auth: 'required'
			}),

		getHomeTimelinePage: async (query?: TimelineQuery) => {
			const response = await http.requestWithHeaders<PleromaStatus[]>({
				path: '/api/v1/timelines/home',
				query: timelineQuery(query),
				auth: 'required'
			});
			return timelinePage(response.body, response.headers);
		},

		getLocalTimeline: (query?: TimelineQuery) =>
			http.request<PleromaStatus[]>({
				path: '/api/v1/timelines/public',
				query: { ...timelineQuery(query), local: true },
				auth: 'optional'
			}),

		getLocalTimelinePage: async (query?: TimelineQuery) => {
			const response = await http.requestWithHeaders<PleromaStatus[]>({
				path: '/api/v1/timelines/public',
				query: { ...timelineQuery(query), local: true },
				auth: 'optional'
			});
			return timelinePage(response.body, response.headers);
		},

		getFederatedTimeline: (query?: TimelineQuery) =>
			http.request<PleromaStatus[]>({
				path: '/api/v1/timelines/public',
				query: timelineQuery(query),
				auth: 'optional'
			}),

		getFederatedTimelinePage: async (query?: TimelineQuery) => {
			const response = await http.requestWithHeaders<PleromaStatus[]>({
				path: '/api/v1/timelines/public',
				query: timelineQuery(query),
				auth: 'optional'
			});
			return timelinePage(response.body, response.headers);
		},

		getStatus: (id: string) =>
			http.request<PleromaStatus>({
				path: `/api/v1/statuses/${encodePathSegment(id)}`,
				auth: 'optional'
			}),

		getStatusContext: (id: string) =>
			http.request<PleromaStatusContext>({
				path: `/api/v1/statuses/${encodePathSegment(id)}/context`,
				auth: 'optional'
			}),

		createStatus: (input: StatusCreateRequest) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: '/api/v1/statuses',
				form: statusCreateForm(input),
				auth: 'required'
			}),

		uploadMedia: (file: File | Blob, input?: MediaUploadRequest) =>
			http.request<PleromaMediaAttachment>({
				method: 'POST',
				path: '/api/v1/media',
				multipart: mediaUploadForm(file, input),
				auth: 'required'
			}),

		deleteMedia: (id: string) =>
			http.request<void>({
				method: 'DELETE',
				path: `/api/v1/media/${encodePathSegment(id)}`,
				auth: 'required'
			}),

		getAccount: (id: string) =>
			http.request<PleromaAccount>({
				path: `/api/v1/accounts/${encodePathSegment(id)}`,
				auth: 'optional'
			}),

		getAccountStatuses: (id: string, query?: AccountStatusesQuery) =>
			http.request<PleromaStatus[]>({
				path: `/api/v1/accounts/${encodePathSegment(id)}/statuses`,
				query: accountStatusesQuery(query),
				auth: 'optional'
			}),

		getAccountStatusesPage: async (id: string, query?: AccountStatusesQuery) => {
			const response = await http.requestWithHeaders<PleromaStatus[]>({
				path: `/api/v1/accounts/${encodePathSegment(id)}/statuses`,
				query: accountStatusesQuery(query),
				auth: 'optional'
			});
			return timelinePage(response.body, response.headers);
		},

		getAccountRelationships: (ids: string[]) =>
			http.request<PleromaRelationship[]>({
				path: '/api/v1/accounts/relationships',
				query: accountRelationshipsQuery(ids),
				auth: 'required'
			}),

		searchAccounts: (query: AccountSearchQuery) =>
			http.request<PleromaAccount[]>({
				path: '/api/v1/accounts/search',
				query: accountSearchQuery(query),
				auth: 'optional'
			}),

		getSuggestions: (limit = 5) =>
			http.request<PleromaSuggestion[]>({
				path: '/api/v2/suggestions',
				query: { limit },
				auth: 'required'
			}),

		lookupAccount: (acct: string) =>
			http.request<PleromaAccount>({
				path: '/api/v1/accounts/lookup',
				query: { acct },
				auth: 'optional'
			}),

		getCustomEmojis: () =>
			http.request<PleromaCustomEmoji[]>({
				path: '/api/v1/custom_emojis',
				auth: 'optional'
			}),

		getOwnAccount: () =>
			http.request<PleromaAccount>({
				path: '/api/v1/accounts/verify_credentials',
				auth: 'required'
			}),

		updateAccountProfile: (profile: ProfileUpdate, images?: ProfileImageUpdate) =>
			hasProfileImages(images)
				? http.request<PleromaAccount>({
						method: 'PATCH',
						path: '/api/v1/accounts/update_credentials',
						multipart: profileUpdateMultipart(profile, images),
						auth: 'required'
					})
				: http.request<PleromaAccount>({
						method: 'PATCH',
						path: '/api/v1/accounts/update_credentials',
						body: profileUpdateBody(profile),
						auth: 'required'
					}),

		followAccount: (id: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/accounts/${encodePathSegment(id)}/follow`,
				auth: 'required'
			}),

		unfollowAccount: (id: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/accounts/${encodePathSegment(id)}/unfollow`,
				auth: 'required'
			}),

		reactToStatus: (id: string, emoji: string) =>
			http.request<PleromaStatus>({
				method: 'PUT',
				path: `/api/v1/pleroma/statuses/${encodePathSegment(id)}/reactions/${encodePathSegment(emoji)}`,
				auth: 'required'
			}),

		unreactToStatus: (id: string, emoji: string) =>
			http.request<PleromaStatus>({
				method: 'DELETE',
				path: `/api/v1/pleroma/statuses/${encodePathSegment(id)}/reactions/${encodePathSegment(emoji)}`,
				auth: 'required'
			}),

		favoriteStatus: (id: string) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: `/api/v1/statuses/${encodePathSegment(id)}/favourite`,
				auth: 'required'
			}),

		unfavoriteStatus: (id: string) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: `/api/v1/statuses/${encodePathSegment(id)}/unfavourite`,
				auth: 'required'
			}),

		boostStatus: (id: string) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: `/api/v1/statuses/${encodePathSegment(id)}/reblog`,
				auth: 'required'
			}),

		unboostStatus: (id: string) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: `/api/v1/statuses/${encodePathSegment(id)}/unreblog`,
				auth: 'required'
			}),

		// Thread subscription (Headwater thread-subscribe): keep updated on a thread
		// regardless of who participates. `:id` is the thread ROOT status id.
		subscribeThread: (id: string) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: `/api/v1/pleroma/statuses/${encodePathSegment(id)}/subscribe`,
				auth: 'required'
			}),

		unsubscribeThread: (id: string) =>
			http.request<PleromaStatus>({
				method: 'DELETE',
				path: `/api/v1/pleroma/statuses/${encodePathSegment(id)}/subscribe`,
				auth: 'required'
			}),

		bookmarkStatus: (id: string) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: `/api/v1/statuses/${encodePathSegment(id)}/bookmark`,
				auth: 'required'
			}),

		unbookmarkStatus: (id: string) =>
			http.request<PleromaStatus>({
				method: 'POST',
				path: `/api/v1/statuses/${encodePathSegment(id)}/unbookmark`,
				auth: 'required'
			}),

		getBookmarksPage: async (query?: TimelineQuery) => {
			const response = await http.requestWithHeaders<PleromaStatus[]>({
				path: '/api/v1/bookmarks',
				query: timelineQuery(query),
				auth: 'required'
			});
			return timelinePage(response.body, response.headers);
		},

		deleteStatus: (id: string) =>
			http.request<PleromaStatus>({
				method: 'DELETE',
				path: `/api/v1/statuses/${encodePathSegment(id)}`,
				auth: 'required'
			}),

		getPoll: (id: string) =>
			http.request<Record<string, unknown>>({
				path: `/api/v1/polls/${encodePathSegment(id)}`,
				auth: 'optional'
			}),

		votePoll: (id: string, choices: Array<string | number>) => {
			const form = new URLSearchParams();
			for (const choice of choices) form.append('choices[]', String(choice));
			return http.request<Record<string, unknown>>({
				method: 'POST',
				path: `/api/v1/polls/${encodePathSegment(id)}/votes`,
				form,
				auth: 'required'
			});
		},

		updateMedia: (id: string, input: MediaUploadRequest) =>
			http.request<PleromaMediaAttachment>({
				method: 'PUT',
				path: `/api/v1/media/${encodePathSegment(id)}`,
				body: { description: input.description ?? '' },
				auth: 'required'
			}),

		getChats: (query?: TimelineQuery) =>
			http.request<PleromaChat[]>({
				path: '/api/v2/pleroma/chats',
				query: timelineQuery(query),
				auth: 'required'
			}),

		getOrCreateChat: (accountId: string) =>
			http.request<PleromaChat>({
				method: 'POST',
				path: `/api/v1/pleroma/chats/by-account-id/${encodePathSegment(accountId)}`,
				auth: 'required'
			}),

		getChatMessages: (chatId: string, query?: TimelineQuery) =>
			http.request<PleromaChatMessage[]>({
				path: `/api/v1/pleroma/chats/${encodePathSegment(chatId)}/messages`,
				query: timelineQuery(query),
				auth: 'required'
			}),

		sendChatMessage: (chatId: string, input: ChatMessageCreateRequest) =>
			http.request<PleromaChatMessage>({
				method: 'POST',
				path: `/api/v1/pleroma/chats/${encodePathSegment(chatId)}/messages`,
				body: { content: input.content, media_id: input.mediaId },
				auth: 'required'
			}),

		markChatRead: (chatId: string, lastReadId: string) =>
			http.request<PleromaChat>({
				method: 'POST',
				path: `/api/v1/pleroma/chats/${encodePathSegment(chatId)}/read`,
				body: { last_read_id: lastReadId },
				auth: 'required'
			}),

		deleteChatMessage: (chatId: string, messageId: string) =>
			http.request<PleromaChatMessage>({
				method: 'DELETE',
				path: `/api/v1/pleroma/chats/${encodePathSegment(chatId)}/messages/${encodePathSegment(messageId)}`,
				auth: 'required'
			}),

		getFollowRequests: () =>
			http.request<PleromaAccount[]>({
				path: '/api/v1/follow_requests',
				auth: 'required'
			}),

		authorizeFollowRequest: (accountId: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/follow_requests/${encodePathSegment(accountId)}/authorize`,
				auth: 'required'
			}),

		rejectFollowRequest: (accountId: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/follow_requests/${encodePathSegment(accountId)}/reject`,
				auth: 'required'
			}),

		muteAccount: (id: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/accounts/${encodePathSegment(id)}/mute`,
				auth: 'required'
			}),

		unmuteAccount: (id: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/accounts/${encodePathSegment(id)}/unmute`,
				auth: 'required'
			}),

		blockAccount: (id: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/accounts/${encodePathSegment(id)}/block`,
				auth: 'required'
			}),

		unblockAccount: (id: string) =>
			http.request<PleromaRelationship>({
				method: 'POST',
				path: `/api/v1/accounts/${encodePathSegment(id)}/unblock`,
				auth: 'required'
			}),

		getNotifications: (query?: NotificationQuery, control: RequestControl = {}) =>
			http.request<PleromaNotification[]>({
				path: '/api/v1/notifications',
				query: notificationQuery(query),
				signal: control.signal,
				auth: 'required'
			}),

		search: (query: SearchQuery) =>
			http.request<PleromaSearchResult>({
				path: '/api/v2/search',
				query: searchQuery(query),
				auth: 'optional'
			}),

		getTrendingTags: (query: Pick<TimelineQuery, 'limit'> = {}) =>
			http.request<PleromaTag[]>({
				path: '/api/v1/trends/tags',
				query: { limit: query.limit },
				auth: 'optional'
			}),

		getInstance: () =>
			http.request<PleromaInstance>({
				path: '/api/v2/instance',
				auth: 'optional'
			}),

		registerOAuthApp: (input: Parameters<typeof registerApp>[0]) => registerApp(input)
	};
};

export type PleromaClient = ReturnType<typeof createPleromaClient>;

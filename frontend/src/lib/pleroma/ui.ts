import type { AvatarVariant, CustomEmoji, PostAttachment, QuotedPostView, SocialNotificationData, SocialNotificationKind, TimelinePost, TimelineView } from '$lib/social/types';
import { isPleromaClientError } from './http';
import type { PleromaAccount, PleromaChat, PleromaChatMessage, PleromaCustomEmoji, PleromaField, PleromaInstance, PleromaNotification, PleromaStatus, ProfileUpdate } from './types';

export const DEFAULT_STATUS_CHARACTER_LIMIT = 500;

export type PleromaAccountView = {
	id: string;
	username: string;
	displayName: string;
	acct: string;
	handle: string;
	url: string;
	avatarUrl: string | null;
	emojis: CustomEmoji[];
	faviconUrl: string | null;
	isAdmin: boolean;
	isModerator: boolean;
	tags: string[];
};

export type PleromaProfileFollowState = 'stranger' | 'following' | 'mutual' | 'self' | 'requested' | 'blocked';

export type PleromaProfileFieldView = {
	key: string;
	value: string;
	verified: boolean;
};

export type PleromaProfileView = {
	id: string;
	username: string;
	displayName: string;
	displayNameEmojis: CustomEmoji[];
	acct: string;
	handle: string;
	url: string;
	bio: string;
	avatarUrl: string | null;
	headerUrl: string | null;
	fields: PleromaProfileFieldView[];
	stats: {
		posts: number;
		following: number;
		followers: number;
	};
	relations: {
		locked: boolean;
		bot: boolean;
		remote: boolean;
	};
	followState: PleromaProfileFollowState;
};

export type PleromaMediaAttachmentView = {
	id: string;
	type: string;
	url: string;
	previewUrl: string | null;
	description: string | null;
	filename: string | null;
	duration: string | null;
};

export type PleromaReactionView = {
	name: string;
	glyph: string | null;
	url: string | null;
	staticUrl: string | null;
	count: number;
	me: boolean;
};

export type PleromaStatusView = TimelinePost & {
	actionStatusId: string;
	threadStatusId: string;
	timelineItemId: string;
	originalStatusId: string;
	visibility: PleromaStatus['visibility'];
	inReplyToId: string | null;
	createdAt: string;
	applicationName: string | null;
	url: string;
	uri: string;
	account: PleromaAccountView;
	contentHtml: string;
	contentText: string;
	spoilerText: string;
	hasContentWarning: boolean;
	mediaHidden: boolean;
	mediaAttachments: PleromaMediaAttachmentView[];
	reactions: PleromaReactionView[];
	bookmarked: boolean;
	rebloggedBy?: PleromaAccountView;
	pleroma: {
		conversationId?: number;
		local?: boolean;
		plainText?: string;
	};
};

export type PleromaNotificationView = SocialNotificationData;

export type PleromaRequestErrorKind = 'auth-required' | 'rate-limited' | 'server' | 'network' | 'request';

export type PleromaRequestErrorView = {
	kind: PleromaRequestErrorKind;
	title: string;
	message: string;
	retryable: boolean;
	reauthRequired: boolean;
	status?: number;
	path?: string;
};

export type PleromaRequestState<Data> =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'empty' }
	| { status: 'error'; error: PleromaRequestErrorView }
	| { status: 'success'; data: Data };

export type AdaptPleromaStatusOptions = {
	timelines?: TimelineView[];
	now?: number;
};

const htmlEntities: Record<string, string> = {
	amp: '&',
	gt: '>',
	lt: '<',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

const displayName = (account: PleromaAccount) => account.display_name.trim() || account.username || account.acct;

const handle = (acct: string) => `@${acct.replace(/^@/, '')}`;

const decodeHtmlEntities = (value: string) =>
	value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
		const normalized = code.toLowerCase();
		if (normalized.startsWith('#x') || normalized.startsWith('#')) {
			const codePoint = Number.parseInt(normalized.startsWith('#x') ? normalized.slice(2) : normalized.slice(1), normalized.startsWith('#x') ? 16 : 10);
			return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}

		return htmlEntities[normalized] ?? entity;
	});

export const htmlToPlainText = (html: string) => {
	const safeHtml = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '');
	const withBreaks = safeHtml
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
		.replace(/<\/(div|li|blockquote|p)>/gi, '\n')
		.replace(/<li[^>]*>/gi, '- ');
	const stripped = withBreaks.replace(/<[^>]+>/g, '');

	return decodeHtmlEntities(stripped)
		.split('\n')
		.map((line) => line.replace(/[\t ]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
};

const lineBreakCount = (value: string) => value.match(/\n/g)?.length ?? 0;

const sameTextIgnoringWhitespace = (left: string, right: string) => left.replace(/\s+/g, '') === right.replace(/\s+/g, '');

const shouldPreferHtmlText = (plainText: string, htmlText: string) => lineBreakCount(htmlText) > lineBreakCount(plainText) && sameTextIgnoringWhitespace(plainText, htmlText);

const plainTextContent = (status: PleromaStatus) => {
	const plainText = status.pleroma.content?.['text/plain']?.trim();
	const htmlText = htmlToPlainText(status.content);
	if (plainText) return shouldPreferHtmlText(plainText, htmlText) ? htmlText : plainText;

	return htmlText;
};

const leadingReplyMentionPattern = /^(@[\w.]+(?:@[\w.-]+)?)(?=\s|$)/;

const leadingMentionHandles = (status: PleromaStatus) =>
	new Set(
		status.mentions.flatMap((mention) => {
			if (!mention || typeof mention !== 'object') return [];
			const values = mention as Record<string, unknown>;
			const username = typeof values.username === 'string' ? values.username.trim() : '';
			const acct = typeof values.acct === 'string' ? values.acct.trim() : '';

			return [username ? `@${username}` : '', acct ? `@${acct}` : '']
				.filter(Boolean)
				.map((handle) => handle.toLowerCase());
		})
	);

const handleFromAcct = (acct: unknown) => {
	if (typeof acct !== 'string' || !acct.trim()) return null;
	return `@${acct.trim().replace(/^@/, '')}`;
};

// Post text usually carries bare @usernames; the mentions metadata has the
// full user@domain acct needed to resolve remote profiles.
const mentionAcctMap = (status: PleromaStatus): Record<string, string> => {
	const map: Record<string, string> = {};
	for (const mention of status.mentions) {
		if (!mention || typeof mention !== 'object') continue;
		const values = mention as Record<string, unknown>;
		const full = handleFromAcct(values.acct);
		if (!full) continue;
		const username = typeof values.username === 'string' ? values.username.trim() : '';
		if (username) map[`@${username.toLowerCase()}`] = full;
		map[full.toLowerCase()] = full;
	}
	return map;
};

const directReplyAccountHandle = (status: PleromaStatus) => {
	if (!status.in_reply_to_id) return null;
	const pleromaAcct = handleFromAcct(status.pleroma.in_reply_to_account_acct);
	if (pleromaAcct) return pleromaAcct;

	const mention = status.mentions.find((entry) => {
		if (!entry || typeof entry !== 'object') return false;
		const values = entry as Record<string, unknown>;
		return typeof values.id === 'string' && values.id === status.in_reply_to_account_id;
	});
	if (!mention || typeof mention !== 'object') return null;
	const values = mention as Record<string, unknown>;

	return handleFromAcct(values.acct) ?? handleFromAcct(values.username);
};

const extractLeadingReplyAddressees = (text: string, status: PleromaStatus) => {
	const knownMentionHandles = leadingMentionHandles(status);
	if (!status.in_reply_to_id && knownMentionHandles.size === 0) return { body: text };

	const acctMap = mentionAcctMap(status);
	const addressees: string[] = [];
	let rest = text.trimStart();
	while (rest) {
		const match = leadingReplyMentionPattern.exec(rest);
		if (!match) break;
		if (!status.in_reply_to_id && !knownMentionHandles.has(match[1].toLowerCase())) break;

		addressees.push(acctMap[match[1].toLowerCase()] ?? match[1]);
		rest = rest.slice(match[1].length);
		const separator = /^\s+/.exec(rest);
		if (!separator) break;
		rest = rest.slice(separator[0].length);
	}

	if (addressees.length > 0) return { body: rest.trimStart(), addressees };
	const directReply = directReplyAccountHandle(status);
	return directReply ? { body: text, addressees: [directReply] } : { body: text };
};

const spoilerText = (status: PleromaStatus) => {
	const plainText = status.pleroma.spoiler_text?.['text/plain'];
	if (plainText?.trim()) return plainText.trim();

	return htmlToPlainText(status.spoiler_text ?? '');
};

const formatStatusDate = (createdAt: string) => {
	const date = new Date(createdAt);
	if (Number.isNaN(date.getTime())) return '';

	return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
};

const pluralUnit = (value: number, unit: string) => `${value} ${unit}${value === 1 ? '' : 's'} ago`;

export const formatRelativeStatusTime = (createdAt: string, now = Date.now()) => {
	const createdMs = Date.parse(createdAt);
	if (!Number.isFinite(createdMs) || !Number.isFinite(now)) return '';

	const elapsedSeconds = Math.max(0, Math.floor((now - createdMs) / 1000));
	if (elapsedSeconds < 60) return 'just now';

	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return pluralUnit(elapsedMinutes, 'minute');

	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return pluralUnit(elapsedHours, 'hour');

	const elapsedDays = Math.floor(elapsedHours / 24);
	if (elapsedDays < 30) return pluralUnit(elapsedDays, 'day');

	const elapsedMonths = Math.floor(elapsedDays / 30);
	if (elapsedDays < 365) return pluralUnit(elapsedMonths, 'month');

	return pluralUnit(Math.floor(elapsedDays / 365), 'year');
};

const avatarUrl = (account: PleromaAccount) => account.avatar || account.avatar_static || null;

const headerUrl = (account: PleromaAccount) => account.header || account.header_static || null;

const avatarVariant = (account: PleromaAccount): AvatarVariant => (avatarUrl(account) ? 'orb' : 'grad-2');

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const stringValue = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

const numberValue = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const booleanValue = (value: unknown) => (typeof value === 'boolean' ? value : null);

const compactExcerpt = (text: string) => text.length > 160 ? `${text.slice(0, 157).trimEnd()}...` : text;

const notificationKind = (type: string): SocialNotificationKind => {
	const normalized = type.toLowerCase();
	if (normalized === 'favourite' || normalized === 'favorite') return 'fav';
	if (normalized === 'reblog') return 'boost';
	if (normalized === 'follow_request') return 'follow_req';
	if (normalized === 'pleroma:emoji_reaction') return 'reaction';
	if (normalized === 'mention' || normalized === 'reply' || normalized === 'follow' || normalized === 'poll') return normalized;
	return 'unknown';
};

const notificationTarget = (kind: SocialNotificationKind, notification: PleromaNotification): SocialNotificationData['target'] => {
	const statusId = notification.status?.id;
	if ((kind === 'mention' || kind === 'reply' || kind === 'fav' || kind === 'boost' || kind === 'poll' || kind === 'reaction') && statusId) {
		return { route: 'thread', statusId };
	}
	if (kind === 'follow' || kind === 'follow_req') {
		return { route: 'profile', accountHandle: notification.account.acct, accountId: notification.account.id };
	}

	return { route: 'none' };
};

const notificationReadState = (notification: PleromaNotification, lastSeenAt: string | null | undefined) => {
	const createdMs = Date.parse(notification.created_at);
	const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
	const locallyRead = Number.isFinite(createdMs) && Number.isFinite(lastSeenMs) && createdMs <= lastSeenMs;
	const remoteRead = booleanValue(notification.pleroma?.is_seen) ?? booleanValue(notification.read) ?? false;

	return remoteRead || locallyRead;
};

export const mediaPlaceholderText = (types: Array<string | undefined>, hasPoll = false) => {
	const nouns: Record<string, [string, string]> = {
		image: ['image', 'images'],
		video: ['video', 'videos'],
		audio: ['audio clip', 'audio clips'],
		attachment: ['attachment', 'attachments']
	};
	const normalized = types.map((type) => {
		const kind = (type ?? '').toLowerCase();
		if (kind === 'image' || kind === 'photo' || kind === 'gifv') return 'image';
		if (kind === 'video') return 'video';
		if (kind === 'audio') return 'audio';
		return 'attachment';
	});
	if (normalized.length === 0) return hasPoll ? '[poll]' : '';
	const kind = new Set(normalized).size === 1 ? normalized[0] : 'attachment';
	const [singular, plural] = nouns[kind];
	return normalized.length === 1 ? `[${singular}]` : `[${normalized.length} ${plural}]`;
};

const statusMediaTypes = (status: PleromaStatus) =>
	(Array.isArray(status.media_attachments) ? status.media_attachments : [])
		.map((attachment) => (isRecord(attachment) && typeof attachment.type === 'string' ? attachment.type : ''));

const notificationPostRef = (status: PleromaStatus | null | undefined): SocialNotificationData['post'] => {
	if (!status) return undefined;
	const warning = spoilerText(status);
	const text = compactExcerpt(plainTextContent(status));
	const excerpt = warning
		? `Content warning: ${warning}`
		: text || mediaPlaceholderText(statusMediaTypes(status), Boolean(status.poll));
	if (!excerpt) return undefined;

	return { excerpt, tStamp: formatStatusDate(status.created_at) };
};

const positiveIntegerValue = (value: unknown) => {
	const number = typeof value === 'string' && value.trim() ? Number(value) : numberValue(value);
	return typeof number === 'number' && Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
};

export const statusCharacterLimit = (instance: PleromaInstance | null | undefined) => {
	const configuration = isRecord(instance?.configuration) ? instance.configuration : null;
	const statuses = isRecord(configuration?.statuses) ? configuration.statuses : null;
	const metadata = isRecord(instance?.pleroma.metadata) ? instance.pleroma.metadata : null;

	return positiveIntegerValue(statuses?.max_characters)
		?? positiveIntegerValue(instance?.max_toot_chars)
		?? positiveIntegerValue(metadata?.max_toot_chars)
		?? DEFAULT_STATUS_CHARACTER_LIMIT;
};

export const adaptCustomEmojis = (emojis: PleromaCustomEmoji[] | undefined): CustomEmoji[] => (emojis ?? [])
	.map((emoji) => ({
		shortcode: emoji.shortcode,
		url: emoji.url,
		staticUrl: emoji.static_url
	}))
	.filter((emoji) => emoji.shortcode && emoji.url);

const filenameFromUrl = (url: string) => {
	try {
		const filename = new URL(url).pathname.split('/').filter(Boolean).pop();
		return filename ? decodeURIComponent(filename) : null;
	} catch {
		const filename = url.split('?')[0]?.split('/').filter(Boolean).pop();
		return filename ? decodeURIComponent(filename) : null;
	}
};

const secondsToDuration = (seconds: number) => {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	return `${minutes}:${String(total % 60).padStart(2, '0')}`;
};

const mediaDuration = (attachment: Record<string, unknown>) => {
	const meta = isRecord(attachment.meta) ? attachment.meta : null;
	const original = meta && isRecord(meta.original) ? meta.original : null;
	const duration = numberValue(original?.duration) ?? numberValue(meta?.duration) ?? numberValue(attachment.duration);
	return duration == null ? null : secondsToDuration(duration);
};

const adaptMediaAttachment = (attachment: unknown, index: number): PleromaMediaAttachmentView | null => {
	if (!isRecord(attachment)) return null;

	const url = stringValue(attachment.url) ?? stringValue(attachment.remote_url);
	if (!url) return null;

	return {
		id: stringValue(attachment.id) ?? `media-${index + 1}`,
		type: stringValue(attachment.type) ?? 'unknown',
		url,
		previewUrl: stringValue(attachment.preview_url) ?? stringValue(attachment.previewUrl),
		description: stringValue(attachment.description),
		filename: filenameFromUrl(url),
		duration: mediaDuration(attachment)
	};
};

const adaptPostAttachment = (attachment: PleromaMediaAttachmentView): PostAttachment | null => {
	const type = attachment.type.toLowerCase();
	if (type === 'image' || type === 'photo') {
		return {
			kind: 'photo',
			src: attachment.url,
			alt: attachment.description ?? undefined,
			filename: attachment.filename ?? undefined
		};
	}

	if (type === 'video' || type === 'gifv') {
		return {
			kind: 'video',
			src: attachment.url,
			posterUrl: attachment.previewUrl ?? undefined,
			title: attachment.description ?? attachment.filename ?? 'video',
			caption: attachment.description ?? undefined,
			duration: attachment.duration ?? undefined,
			filename: attachment.filename ?? undefined
		};
	}

	if (type === 'audio') {
		return {
			kind: 'audio',
			src: attachment.url,
			title: attachment.description ?? attachment.filename ?? 'audio',
			byline: 'audio',
			duration: attachment.duration ?? undefined,
			filename: attachment.filename ?? undefined
		};
	}

	return null;
};

const pollChoices = (poll: Record<string, unknown>) => {
	const options = Array.isArray(poll.options) ? poll.options : Array.isArray(poll.choices) ? poll.choices : [];

	return options
		.map((option, index) => {
			if (!isRecord(option)) return null;
			const label = stringValue(option.title) ?? stringValue(option.label);
			if (!label) return null;

			return {
				id: stringValue(option.id) ?? String(index),
				label,
				votes: numberValue(option.votes_count) ?? numberValue(option.votes) ?? 0
			};
		})
		.filter((choice) => choice !== null);
};

const pollOwnVote = (poll: Record<string, unknown>, multi: boolean) => {
	const rawVote = poll.own_votes ?? poll.myVote;
	if (!Array.isArray(rawVote)) {
		return typeof rawVote === 'string' || typeof rawVote === 'number' ? String(rawVote) : null;
	}

	const votes = rawVote
		.map((vote) => typeof vote === 'string' || typeof vote === 'number' ? String(vote) : '')
		.filter(Boolean);
	if (votes.length === 0) return null;

	return multi ? votes : votes[0];
};

const compactRelativeTime = (targetMs: number) => {
	const minutes = Math.max(1, Math.ceil(Math.abs(targetMs - Date.now()) / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;

	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m`;
};

const pollExpiration = (poll: Record<string, unknown>) => {
	const explicitExpired = booleanValue(poll.expired) ?? false;
	const expiresAt = stringValue(poll.expires_at) ?? stringValue(poll.expiresAt);
	if (!expiresAt) return { expired: explicitExpired, relative: undefined };

	const expiresMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresMs)) return { expired: explicitExpired, relative: undefined };

	return {
		expired: explicitExpired || expiresMs <= Date.now(),
		relative: compactRelativeTime(expiresMs)
	};
};

export const adaptPleromaPoll = (poll: unknown): PostAttachment | null => adaptPollAttachment(poll);

const adaptPollAttachment = (poll: unknown): PostAttachment | null => {
	if (!isRecord(poll)) return null;
	const choices = pollChoices(poll);
	if (choices.length === 0) return null;

	const multi = booleanValue(poll.multiple) ?? booleanValue(poll.multi) ?? false;
	const ownVote = pollOwnVote(poll, multi);
	const expiration = pollExpiration(poll);
	const voted = (booleanValue(poll.voted) ?? false) || ownVote !== null;
	return {
		kind: 'poll',
		id: stringValue(poll.id) ?? undefined,
		choices,
		totalVotes: numberValue(poll.votes_count) ?? numberValue(poll.totalVotes) ?? choices.reduce((sum, choice) => sum + (choice.votes ?? 0), 0),
		multi,
		endsIn: stringValue(poll.ends_in) ?? stringValue(poll.endsIn) ?? (expiration.expired ? undefined : expiration.relative),
		endedAgo: stringValue(poll.ended_ago) ?? stringValue(poll.endedAgo) ?? (expiration.expired ? expiration.relative ? `${expiration.relative} ago` : undefined : undefined),
		myVote: ownVote,
		voted,
		expired: expiration.expired
	};
};

const adaptStatusAttachments = (status: PleromaStatus) => {
	const mediaAttachments = status.media_attachments.map(adaptMediaAttachment).filter((attachment) => attachment !== null);
	const pollAttachment = adaptPollAttachment(status.poll);
	const postAttachments = [
		...mediaAttachments.map(adaptPostAttachment).filter((attachment) => attachment !== null),
		...(pollAttachment ? [pollAttachment] : [])
	];

	return { mediaAttachments, postAttachments };
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const quoteReferenceUrl = (status: PleromaStatus) =>
	stringValue(status.pleroma.quote_url) ?? stringValue(status.pleroma.quote?.url) ?? stringValue(status.pleroma.quote?.uri);

const stripInlineQuoteReference = (text: string, status: PleromaStatus) => {
	const quoteUrl = quoteReferenceUrl(status);
	if (!quoteUrl) return text;

	return text.replace(new RegExp(`\\s*(?:RT|RE):\\s*${escapeRegExp(quoteUrl)}\\s*$`, 'i'), '').trim();
};

const visibleQuotedStatus = (status: PleromaStatus) => {
	if (status.pleroma.quote_visible === false) return null;
	return status.pleroma.quote ?? null;
};

const threadHref = (statusId: string) => `/app/thread/${encodeURIComponent(statusId)}`;

const adaptQuotedPost = (status: PleromaStatus, now?: number): QuotedPostView => {
	const account = adaptPleromaAccount(status.account);
	const { postAttachments } = adaptStatusAttachments(status);
	const quoteAttachments = postAttachments.filter((attachment) => attachment.kind !== 'poll');
	const warning = spoilerText(status);

	return {
		href: threadHref(status.id),
		name: account.displayName,
		nameEmojis: account.emojis,
		handle: account.handle,
		time: formatRelativeStatusTime(status.created_at, now),
		createdAt: status.created_at,
		body: warning ? `Content warning: ${warning}` : plainTextContent(status),
		bodyEmojis: adaptCustomEmojis(status.emojis),
		mentionAccts: mentionAcctMap(status),
		avClass: account.avatarUrl ? undefined : 'av-grad-2',
		avatarUrl: account.avatarUrl,
		replies: status.replies_count,
		boosts: status.reblogs_count,
		favs: status.favourites_count,
		attachments: status.sensitive || warning ? undefined : quoteAttachments
	};
};

const timelineMembership = (status: PleromaStatus, options: AdaptPleromaStatusOptions): TimelineView[] => {
	if (options.timelines) return options.timelines;
	if (typeof status.pleroma.local !== 'boolean') return [];

	return [status.pleroma.local ? 'local' : 'federated'];
};

const countBeforeViewerAction = (count: number, active: boolean) => Math.max(0, count - (active ? 1 : 0));

export const adaptPleromaAccount = (account: PleromaAccount): PleromaAccountView => ({
	id: account.id,
	username: account.username,
	displayName: displayName(account),
	acct: account.acct,
	handle: handle(account.acct),
	url: account.url,
	avatarUrl: avatarUrl(account),
	emojis: adaptCustomEmojis(account.emojis),
	faviconUrl: account.pleroma.favicon ?? null,
	isAdmin: account.pleroma.is_admin ?? false,
	isModerator: account.pleroma.is_moderator ?? false,
	tags: account.pleroma.tags ?? []
});

const hostname = (value: string | null | undefined) => {
	if (!value) return null;
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return null;
	}
};

const acctHost = (acct: string) => {
	const parts = acct.replace(/^@/, '').split('@').filter(Boolean);
	return parts.length > 1 ? parts.at(-1)?.toLowerCase() ?? null : null;
};

const profileRemote = (account: PleromaAccount, instanceUrl?: string) => {
	const accountHost = acctHost(account.acct) ?? hostname(account.url);
	const instanceHost = hostname(instanceUrl);
	return Boolean(accountHost && instanceHost && accountHost !== instanceHost);
};

const profileFollowState = (account: PleromaAccount, currentAccountId?: string): PleromaProfileFollowState => {
	if (currentAccountId && account.id === currentAccountId) return 'self';
	const relationship = account.pleroma.relationship;
	if (!relationship) return 'stranger';
	if (relationship.blocking) return 'blocked';
	if (relationship.requested) return 'requested';
	if (relationship.following && relationship.followed_by) return 'mutual';
	if (relationship.following) return 'following';
	return 'stranger';
};

export const adaptPleromaProfile = (account: PleromaAccount, options: { instanceUrl?: string; currentAccountId?: string } = {}): PleromaProfileView => ({
	id: account.id,
	username: account.username,
	displayName: displayName(account),
	displayNameEmojis: adaptCustomEmojis(account.emojis),
	acct: account.acct,
	handle: handle(account.acct),
	url: account.url,
	bio: htmlToPlainText(account.note ?? ''),
	avatarUrl: avatarUrl(account),
	headerUrl: headerUrl(account),
	fields: (account.fields ?? [])
		.map((field) => ({
			key: htmlToPlainText(field.name ?? ''),
			value: htmlToPlainText(field.value ?? ''),
			verified: Boolean(field.verified_at)
		}))
		.filter((field) => field.key || field.value),
	stats: {
		posts: account.statuses_count,
		following: account.following_count,
		followers: account.followers_count
	},
	relations: {
		locked: account.locked,
		bot: account.bot,
		remote: profileRemote(account, options.instanceUrl)
	},
	followState: profileFollowState(account, options.currentAccountId)
});

export type PleromaProfileSettingsView = {
	displayName: string;
	username: string;
	bio: string;
	website: string;
	location: string;
	discoverable: boolean;
	showFollowers: boolean;
};

const RESERVED_PROFILE_FIELD_NAMES = ['website', 'location'];

const isReservedProfileField = (name: string) => RESERVED_PROFILE_FIELD_NAMES.includes(name.trim().toLowerCase());

const plainAccountFields = (account: PleromaAccount | null | undefined): PleromaField[] => {
	if (!account) return [];
	if (account.source?.fields) return account.source.fields.map((field) => ({ name: field.name, value: field.value }));
	return (account.fields ?? []).map((field) => ({ name: field.name, value: htmlToPlainText(field.value ?? '') }));
};

const plainFieldValue = (fields: PleromaField[], name: string) =>
	fields.find((field) => field.name.trim().toLowerCase() === name)?.value ?? '';

export const profileSettingsFromAccount = (account: PleromaAccount): PleromaProfileSettingsView => {
	const fields = plainAccountFields(account);

	return {
		displayName: account.display_name ?? '',
		username: account.username ?? '',
		bio: account.source?.note ?? htmlToPlainText(account.note ?? ''),
		website: plainFieldValue(fields, 'website'),
		location: plainFieldValue(fields, 'location'),
		discoverable: account.discoverable ?? true,
		showFollowers: account.pleroma?.hide_followers_count !== true
	};
};

export const profileUpdateFromSettings = (settings: PleromaProfileSettingsView, account: PleromaAccount | null | undefined): ProfileUpdate => {
	const fields = plainAccountFields(account).filter((field) => !isReservedProfileField(field.name));
	if (settings.website.trim()) fields.push({ name: 'Website', value: settings.website.trim() });
	if (settings.location.trim()) fields.push({ name: 'Location', value: settings.location.trim() });

	return {
		displayName: settings.displayName,
		note: settings.bio,
		discoverable: settings.discoverable,
		hideFollowersCount: !settings.showFollowers,
		fields
	};
};

export const adaptStatusReactions = (status: PleromaStatus): PleromaReactionView[] => {
	const reactions = status.pleroma?.emoji_reactions;
	if (!Array.isArray(reactions)) return [];

	return reactions
		.filter((reaction) => reaction && typeof reaction.name === 'string' && reaction.name.length > 0 && typeof reaction.count === 'number' && reaction.count > 0)
		.map((reaction) => {
			const url = typeof reaction.url === 'string' && reaction.url ? reaction.url : null;
			return {
				name: reaction.name,
				glyph: url ? null : reaction.name,
				url,
				staticUrl: typeof reaction.static_url === 'string' && reaction.static_url ? reaction.static_url : url,
				count: reaction.count,
				me: reaction.me === true
			};
		});
};

export const adaptPleromaStatus = (status: PleromaStatus, options: AdaptPleromaStatusOptions = {}): PleromaStatusView => {
	const source = status.reblog ?? status;
	const account = adaptPleromaAccount(source.account);
	const { mediaAttachments, postAttachments } = adaptStatusAttachments(source);
	const warning = spoilerText(source);
	const quotedPost = visibleQuotedStatus(source);
	const plainText = quotedPost ? stripInlineQuoteReference(plainTextContent(source), source) : plainTextContent(source);
	const body = extractLeadingReplyAddressees(plainText, source);
	const mediaHidden = postAttachments.length > 0 && Boolean(warning || source.sensitive);
	const booster = status.reblog ? adaptPleromaAccount(status.account) : undefined;

	return {
		id: status.id,
		actionStatusId: source.id,
		threadStatusId: source.id,
		timelineItemId: status.id,
		originalStatusId: source.id,
		visibility: source.visibility,
		inReplyToId: source.in_reply_to_id,
		createdAt: source.created_at,
		applicationName: source.application?.name ?? null,
		timelines: timelineMembership(source, options),
		name: account.displayName,
		nameEmojis: account.emojis,
		handle: account.handle,
		time: formatRelativeStatusTime(source.created_at, options.now),
		cw: warning || undefined,
		body: body.body,
		bodyEmojis: adaptCustomEmojis(source.emojis),
		addressees: body.addressees,
		mentionAccts: mentionAcctMap(source),
		copyJson: status,
		quotedPost: quotedPost ? adaptQuotedPost(quotedPost, options.now) : undefined,
		avatar: avatarVariant(source.account),
		avatarUrl: account.avatarUrl,
		attachments: source.sensitive && !warning ? undefined : postAttachments,
		media: undefined,
		boostedBy: booster ? {
			name: booster.displayName,
			nameEmojis: booster.emojis,
			handle: booster.handle,
			time: formatRelativeStatusTime(status.created_at, options.now),
			createdAt: status.created_at,
			avatar: avatarVariant(status.account),
			avatarUrl: booster.avatarUrl
		} : undefined,
		replies: source.replies_count,
		boosts: countBeforeViewerAction(source.reblogs_count, source.reblogged),
		favorites: countBeforeViewerAction(source.favourites_count, source.favourited),
		actions: { reply: false, boost: source.reblogged, favorite: source.favourited },
		url: source.url,
		uri: source.uri,
		account,
		contentHtml: source.content,
		contentText: plainText,
		spoilerText: warning,
		hasContentWarning: Boolean(warning),
		mediaHidden,
		mediaAttachments,
		reactions: adaptStatusReactions(source),
		bookmarked: source.bookmarked === true,
		rebloggedBy: booster,
		pleroma: {
			conversationId: source.pleroma.conversation_id,
			local: source.pleroma.local,
			plainText: source.pleroma.content?.['text/plain']
		}
	};
};

export const adaptPleromaStatuses = (statuses: PleromaStatus[], options: AdaptPleromaStatusOptions = {}) =>
	statuses.map((status) => adaptPleromaStatus(status, options));

export const adaptPleromaNotification = (
	notification: PleromaNotification,
	options: { lastSeenAt?: string | null } = {}
): PleromaNotificationView => {
	const account = adaptPleromaAccount(notification.account);
	const kind = notificationKind(notification.type);
	const target = notificationTarget(kind, notification);
	const bio = htmlToPlainText(notification.account.note ?? '');

	return {
		id: notification.id,
		kind,
		read: notificationReadState(notification, options.lastSeenAt),
		time: formatStatusDate(notification.created_at),
		t: Date.parse(notification.created_at) || 0,
		who: [{
			name: account.displayName,
			handle: account.handle,
			av: 'sunset',
			avatarUrl: account.avatarUrl,
			emojis: account.emojis
		}],
		post: notificationPostRef(notification.status),
		reactionEmoji: kind === 'reaction' && typeof notification.emoji === 'string' && notification.emoji
			? { name: notification.emoji, url: typeof notification.emoji_url === 'string' && notification.emoji_url ? notification.emoji_url : null }
			: undefined,
		bio: (kind === 'follow' || kind === 'follow_req') && bio ? compactExcerpt(bio) : undefined,
		target,
		createdAt: notification.created_at,
		rawType: notification.type
	};
};

export const adaptPleromaNotifications = (
	notifications: PleromaNotification[],
	options: { lastSeenAt?: string | null } = {}
) => notifications.map((notification) => adaptPleromaNotification(notification, options));

export type PleromaChatMessageView = {
	id: string;
	chatId: string;
	accountId: string;
	own: boolean;
	body: string;
	bodyEmojis: CustomEmoji[];
	attachment: PleromaMediaAttachmentView | null;
	time: string;
	fullTime: string;
	createdAt: string;
};

export type ChatAdaptOptions = {
	currentAccountId?: string;
	now?: number;
};

export const adaptPleromaChatMessage = (message: PleromaChatMessage, options: ChatAdaptOptions = {}): PleromaChatMessageView => ({
	id: message.id,
	chatId: message.chat_id,
	accountId: message.account_id,
	own: Boolean(options.currentAccountId && message.account_id === options.currentAccountId),
	body: typeof message.content === 'string' ? htmlToPlainText(message.content) : '',
	bodyEmojis: adaptCustomEmojis(message.emojis),
	attachment: message.attachment ? adaptMediaAttachment(message.attachment, 0) : null,
	time: message.created_at ? formatRelativeStatusTime(message.created_at, options.now) : '',
	fullTime: message.created_at ? formatStatusDate(message.created_at) : '',
	createdAt: message.created_at ?? ''
});

export const adaptPleromaChatMessages = (messages: PleromaChatMessage[], options: ChatAdaptOptions = {}) =>
	messages.map((message) => adaptPleromaChatMessage(message, options));

export type PleromaChatView = {
	id: string;
	account: PleromaAccountView;
	lastMessage: string | null;
	lastMessageOwn: boolean;
	unread: number;
	time: string;
	updatedAt: string;
};

export const adaptPleromaChat = (chat: PleromaChat, options: ChatAdaptOptions = {}): PleromaChatView => {
	const last = chat.last_message ?? null;
	const lastText = last && typeof last.content === 'string' && last.content ? compactExcerpt(htmlToPlainText(last.content)) : null;
	const lastPlaceholder = last?.attachment ? mediaPlaceholderText([stringValue(last.attachment.type) ?? undefined]) : null;
	return {
		id: chat.id,
		account: adaptPleromaAccount(chat.account),
		lastMessage: lastText ?? lastPlaceholder,
		lastMessageOwn: Boolean(last && options.currentAccountId && last.account_id === options.currentAccountId),
		unread: chat.unread,
		time: chat.updated_at ? formatRelativeStatusTime(chat.updated_at, options.now) : '',
		updatedAt: chat.updated_at ?? ''
	};
};

export const adaptPleromaChats = (chats: PleromaChat[], options: ChatAdaptOptions = {}) =>
	chats.map((chat) => adaptPleromaChat(chat, options));

export const normalizePleromaRequestError = (error: unknown): PleromaRequestErrorView => {
	if (!isPleromaClientError(error)) {
		return {
			kind: 'request',
			title: 'Request failed',
			message: error instanceof Error ? error.message : 'DeltaNet could not complete this request.',
			retryable: true,
			reauthRequired: false
		};
	}

	if (error.kind === 'unauthenticated' || (error.kind === 'http' && (error.status === 401 || error.status === 403))) {
		return {
			kind: 'auth-required',
			title: 'Re-authentication required',
			message: error.message || 'Your Pleroma session needs to be authorized again.',
			retryable: false,
			reauthRequired: true,
			path: error.path,
			status: error.kind === 'http' ? error.status : undefined
		};
	}

	if (error.kind === 'network') {
		return {
			kind: 'network',
			title: 'Network connection failed',
			message: error.message,
			retryable: true,
			reauthRequired: false,
			path: error.path
		};
	}

	if (error.status === 429) {
		return {
			kind: 'rate-limited',
			title: 'Rate limit reached',
			message: error.message,
			retryable: true,
			reauthRequired: false,
			path: error.path,
			status: error.status
		};
	}

	if (error.status >= 500) {
		return {
			kind: 'server',
			title: 'Pleroma server error',
			message: error.message,
			retryable: true,
			reauthRequired: false,
			path: error.path,
			status: error.status
		};
	}

	return {
		kind: 'request',
		title: 'Pleroma request failed',
		message: error.message,
		retryable: false,
		reauthRequired: false,
		path: error.path,
		status: error.status
	};
};

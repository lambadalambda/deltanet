<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AncestorPost from '$lib/rebuild/AncestorPost.svelte';
	import AttachmentLightboxHost from '$lib/rebuild/AttachmentLightboxHost.svelte';
	import Avatar from '$lib/rebuild/Avatar.svelte';
	import Button from '$lib/rebuild/Button.svelte';
	import ComposerCWPanel from '$lib/rebuild/ComposerCWPanel.svelte';
	import ComposerMentionEditor from '$lib/rebuild/ComposerMentionEditor.svelte';
	import EmojiPicker from '$lib/rebuild/EmojiPicker.svelte';
	import ComposerPollPanel from '$lib/rebuild/ComposerPollPanel.svelte';
	import FocusedPost from '$lib/rebuild/FocusedPost.svelte';
	import Icon from '$lib/rebuild/Icon.svelte';
	import InlineReplyComposer, { type InlineReplyComposerProps } from '$lib/rebuild/InlineReplyComposer.svelte';
	import ChatRow from '$lib/rebuild/ChatRow.svelte';
	import ChatThread from '$lib/rebuild/ChatThread.svelte';
	import NotifRow from '$lib/rebuild/NotifRow.svelte';
	import NotifsPopover from '$lib/rebuild/NotifsPopover.svelte';
	import Post from '$lib/rebuild/Post.svelte';
	import ProfileMini from '$lib/rebuild/ProfileMini.svelte';
	import ProfileSideRail from '$lib/rebuild/ProfileSideRail.svelte';
	import ProfileView from '$lib/rebuild/ProfileView.svelte';
	import ReplyPost from '$lib/rebuild/ReplyPost.svelte';
	import RichText from '$lib/rebuild/RichText.svelte';
	import SurfaceCard from '$lib/rebuild/SurfaceCard.svelte';
	import TimelineLoadMore from '$lib/rebuild/TimelineLoadMore.svelte';
	import TimelineNewPostsIndicator from '$lib/rebuild/TimelineNewPostsIndicator.svelte';
	import { accountsFromPleromaNotifications, accountsFromPleromaStatus, accountsFromPleromaStatuses, createPleromaAccountCache, getCachedPleromaAccount, upsertPleromaAccounts } from '$lib/pleroma/account-cache';
	import { createPleromaClient } from '$lib/pleroma/client';
	import {
		backupNagState,
		exportDeltanetBackup,
		fetchDeltanetBackupInfo,
		fetchDeltanetInvite,
		followDeltanetInvite,
		isFeedInvite,
		requestDeltanetLockedAccess,
		setDeltanetPetname,
		type DeltanetBackupInfo
	} from '$lib/pleroma/deltanet';
	import { NOTIFICATION_POLL_EVENT, NOTIFICATION_POLL_INTERVAL_MS, readNotificationLastSeenAt, writeNotificationLastSeenAt } from '$lib/pleroma/notifications';
	import { revokeOAuthToken } from '$lib/pleroma/oauth';
	import { readPleromaSession, removePleromaOAuthClient, signOutPleroma, writePleromaSession } from '$lib/pleroma/session';
	import { openPleromaTimelineStream } from '$lib/pleroma/streaming';
	import {
		mergeTimelineItems,
		prependTimelineItems,
		queueNewerTimelineItems,
		type PaginatedTimelineBaseState,
		type PaginatedTimelineState,
		type PaginatedTimelineSuccess
	} from '$lib/pleroma/timeline-state';
	import { DEFAULT_STATUS_CHARACTER_LIMIT, adaptCustomEmojis, adaptPleromaAccount, adaptPleromaChatMessage, adaptPleromaChatMessages, adaptPleromaChats, adaptPleromaPoll, adaptPleromaNotifications, adaptPleromaProfile, adaptPleromaStatus, adaptPleromaStatuses, adaptStatusReactions, htmlToPlainText, mediaPlaceholderText, normalizePleromaRequestError, profileSettingsFromAccount, profileUpdateFromSettings, statusCharacterLimit, type PleromaAccountView, type PleromaChatMessageView, type PleromaChatView, type PleromaNotificationView, type PleromaProfileFollowState, type PleromaProfileSettingsView, type PleromaReactionView, type PleromaRequestErrorView, type PleromaRequestState, type PleromaStatusView } from '$lib/pleroma/ui';
	import type { BannerVariant, PostLike } from '$lib/rebuild/attachments';
	import { COMPOSER_MAX_UPLOAD_BYTES, COMPOSER_MAX_UPLOADS, composerPollPayload, customEmojiPack, composerUploadBadge, composerUploadError, composerUploadKind, createComposerPollDraft, getComposerUploadedMediaIds, hasComposerAddressMention, hasComposerUploadsPending, isComposerUploadType, type ComposerEmoji, type ComposerMentionAccount, type ComposerPollDraft, type ComposerUpload } from '$lib/rebuild/composer';
	import type { IconName } from '$lib/rebuild/icons';
	import type { ProfileData, ProfileMediaItem, ProfilePost } from '$lib/rebuild/profile';
	import type { PleromaAccount, PleromaInstance, PleromaNotification, PleromaRelationship, PleromaSession, PleromaStatus, PleromaTag } from '$lib/pleroma/types';
	import type { CustomEmoji, PostAttachment, SocialNotificationData, SocialPost } from '$lib/social/types';
	import { onMount, untrack } from 'svelte';
	import { env } from '$env/dynamic/public';

	type AppRoute = 'home' | 'public' | 'thread' | 'profile' | 'notifications' | 'explore' | 'search' | 'settings' | 'bookmarks' | 'messages';
	type NavItem = { route: AppRoute; label: string; icon: IconName; href: string; count?: number };
	type ThemeName = 'cream' | 'dusk' | 'drive' | 'simoun';
	type ExploreFeed = 'popular' | 'new' | 'active';
	type SearchTab = 'all' | 'people' | 'posts';
	type ProfileSettings = PleromaProfileSettingsView;
	type ReplySort = 'top' | 'newest';
	type StatusActionKey = 'boost' | 'fav';
	type StatusActionOrigin = 'home' | 'thread' | 'profile';
	type StatusActionScope = StatusActionOrigin | 'all';
	type StatusActionOriginSnapshot = { route: StatusActionOrigin; requestId: number };
	type StatusActionValue = { active: boolean; count: number };
	type StatusVisibility = PleromaStatus['visibility'];
	type InlineReplyTarget = {
		route: StatusActionOrigin;
		targetId: string;
		renderId: string;
		handle: string;
		visibility: StatusVisibility;
		name: string;
		authName?: string;
		petname?: string;
		avClass?: string;
		avBanner?: BannerVariant;
		avatarUrl?: string | null;
	};
	type InlineReplyComposerData = Omit<InlineReplyComposerProps, 'id'>;
	type AccountBackedPost = SocialPost & { visibility?: StatusVisibility; account?: PleromaAccountView; rebloggedBy?: PleromaAccountView; reactions?: PleromaReactionView[]; bookmarked?: boolean; url?: string };
	type RebuildPost = PostLike & {
		id: string | number;
		actionStatusId?: string;
		threadStatusId?: string;
		visibility?: StatusVisibility;
		name: string;
		authName?: string;
		petname?: string;
		authorUnconfirmed?: boolean;
		nameEmojis?: SocialPost['nameEmojis'];
		handle: string;
		time: string;
		createdAt?: string;
		avClass?: string;
		avBanner?: BannerVariant;
		avatarUrl?: string | null;
		body: string;
		bodyEmojis?: SocialPost['bodyEmojis'];
		replies: number;
		boosts: number;
		favs: number;
		addressees?: string[];
		mentionAccts?: Record<string, string>;
		boostedBy?: PostLike['boostedBy'];
		copyJson?: unknown;
		reactions?: PleromaReactionView[];
		bookmarked?: boolean;
		statusUrl?: string;
		authorId?: string;
		authorHandle?: string;
		own?: boolean;
		actions: { reply: boolean; boost: boolean; fav: boolean };
	};
	type ThreadViewPost = RebuildPost & {
		bookmarks?: number;
		fullTime?: string;
		source?: string;
		views?: string | null;
		nestedReplies?: ThreadViewPost[];
		/** deltanet thread-subscribe: true iff this (root) status is subscribed. */
		threadSubscribed?: boolean;
	};
	type HomeTimelineSuccess = PaginatedTimelineSuccess<PleromaStatusView, PleromaRequestErrorView> & {
		newerPosts: PleromaStatusView[];
		newPostsStatus: 'idle' | 'checking';
	};
	type HomeTimelineState = PaginatedTimelineBaseState<PleromaRequestErrorView> | HomeTimelineSuccess;
	type ThreadState =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'error'; error: PleromaRequestErrorView }
		| { status: 'success'; focused: ThreadViewPost; ancestors: ThreadViewPost[]; replies: ThreadViewPost[] };
	type ProfileState =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'error'; error: PleromaRequestErrorView }
		| { status: 'success'; data: ProfileData; timelineStatus: 'loading' | 'ready' };
	type NotificationState =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'empty' }
		| { status: 'error'; error: PleromaRequestErrorView }
		| { status: 'success'; data: PleromaNotificationView[] };
	type SearchAccountView = PleromaAccountView & { bio: string; followers: number; posts: number; followState: PleromaProfileFollowState };
	type SearchState =
		| { status: 'idle' }
		| { status: 'loading'; query: string }
		| { status: 'empty'; query: string }
		| { status: 'error'; query: string; error: PleromaRequestErrorView }
		| { status: 'success'; query: string; accounts: SearchAccountView[]; posts: PleromaStatusView[] };
	type HeaderSearchSelectableItem =
		| { kind: 'recent'; query: string }
		| { kind: 'account'; account: SearchAccountView }
		| { kind: 'post'; post: PleromaStatusView };
	type TrendView = { rank: number; tag: string; count: string | null };
	type SuggestionAccountView = { id: string; name: string; nameEmojis: CustomEmoji[]; handle: string; avatarUrl: string | null; followState: PleromaProfileFollowState };
	type StatusActionErrorState = { targetId: string; key: string; route: StatusActionOrigin; error: PleromaRequestErrorView };
	type NotificationPopoverStatus = 'ready' | 'loading' | 'empty' | 'error';
	const HOME_TIMELINE_CHECK_EVENT = 'deltanet:check-home-timeline';
	const HOME_TIMELINE_FALLBACK_INTERVAL_MS = 60_000;
	const HOME_TIMELINE_STREAM_RECONNECT_MS = HOME_TIMELINE_FALLBACK_INTERVAL_MS;
	const APP_PUBLIC_TIMELINE_STREAM_RECONNECT_MS = HOME_TIMELINE_FALLBACK_INTERVAL_MS;
	const NOTIFICATION_STREAM_RECONNECT_MS = NOTIFICATION_POLL_INTERVAL_MS;
	const SIGN_OUT_REVOKE_TIMEOUT_MS = 2_000;
	const HEADER_SEARCH_DEBOUNCE_MS = 160;
	const SEARCH_PAGE_DEBOUNCE_MS = 260;
	const SEARCH_RECENTS_STORAGE_KEY = 'pn-search-recents';
	const accountStatFormatter = new Intl.NumberFormat('en-US');
	const themeOptions: { id: ThemeName; label: string; grad: string }[] = [
		{ id: 'cream', label: 'Cream', grad: 'linear-gradient(135deg, #f5f1e8 50%, #a48bd9 50%)' },
		{ id: 'dusk', label: 'Dusk', grad: 'linear-gradient(135deg, #2a1f4a 50%, #e7a8c9 50%)' },
		{ id: 'drive', label: 'Drive', grad: 'linear-gradient(135deg, #0c0a28 50%, #7dc4be 50%)' },
		{ id: 'simoun', label: 'Simoun', grad: 'linear-gradient(135deg, #18203f 50%, #e8763a 50%)' }
	];
	const defaultProfile: ProfileSettings = {
		displayName: '',
		username: '',
		website: '',
		location: '',
		bio: '',
		discoverable: true,
		showFollowers: true
	};

	const publicInstanceUrl = env.PUBLIC_PLEROMA_INSTANCE_URL ?? 'https://pleroma.social';

	let sessionReady = $state(false);
	let mounted = $state(false);
	let currentSession = $state<PleromaSession | null>(null);
	let accountCache = $state(createPleromaAccountCache());
	let homeTimelineState = $state<HomeTimelineState>({ status: 'idle' });
	let threadState = $state<ThreadState>({ status: 'idle' });
	let profileRouteState = $state<ProfileState>({ status: 'idle' });
	let profileFollowPending = $state(false);
	let profilePetnamePending = $state(false);
	let profilePetnameError = $state<string | null>(null);
	let profileLockedRequestState = $state<'idle' | 'pending' | 'requested'>('idle');
	let profileFollowError = $state<PleromaRequestErrorView | null>(null);
	let notificationState = $state<NotificationState>({ status: 'idle' });
	let searchState = $state<SearchState>({ status: 'idle' });
	let headerSearchState = $state<SearchState>({ status: 'idle' });
	let trendsState = $state<PleromaRequestState<TrendView[]>>({ status: 'idle' });
	let suggestionsState = $state<PleromaRequestState<SuggestionAccountView[]>>({ status: 'idle' });
	let suggestionFollowPending = $state<Record<string, boolean>>({});
	let localHomePosts = $state<RebuildPost[]>([]);
	let composerText = $state('');
	let composerMentionAccounts = $state<ComposerMentionAccount[]>([]);
	let composerCustomEmojis = $state<ComposerEmoji[]>([]);
	let composerEmojiRecents = $state<Array<string | ComposerEmoji>>([]);
	let composerEmojiPickerOpen = $state(false);
	let composerEmojiPickerAnchor = $state<{ left?: number; top?: number; bottom?: number } | null>(null);
	let reactionPicker = $state<{ post: RebuildPost; route: StatusActionOrigin; anchor: { left: number; top: number; bottom: number } } | null>(null);
	let composerInsertRequest = $state<{ id: number; item: string | ComposerEmoji } | null>(null);
	let composerInsertRequestId = 0;
	let composerFileInput = $state<HTMLInputElement | null>(null);
	let composerUploads = $state<ComposerUpload[]>([]);
	let composerDragActive = $state(false);
	let composerDragDepth = $state(0);
	let composerSpoilerActive = $state(false);
	let composerSpoilerText = $state('');
	let composerPoll = $state<ComposerPollDraft | null>(null);
	let composerVisibility = $state<StatusVisibility>('public');
	let composerPrivacyOpen = $state(false);
	let composerPrivacyTrigger = $state<HTMLButtonElement | null>(null);
	let mobileDrawerOpen = $state(false);
	let mobileSheetOpen = $state(false);
	let userMenuOpen = $state(false);
	let userMenuTrigger = $state<HTMLButtonElement | null>(null);
	let activeTheme = $state<ThemeName>('cream');
	let notificationsMenuOpen = $state(false);
	let headerSearchDraft = $state('');
	let exploreSearchDraft = $state('');
	let searchPageDraft = $state('');
	let searchRecents = $state<string[]>([]);
	let headerSearchOpen = $state(false);
	let headerSearchSelectedIndex = $state(-1);
	let searchSidebarOpen = $state(false);
	let headerSearchInput = $state<HTMLInputElement | null>(null);
	let headerSearchForm = $state<HTMLFormElement | null>(null);
	let exploreFeed = $state<ExploreFeed>('popular');
	let joinedCommunities = $state<Record<string, boolean>>({});
	let settingsSaveState = $state('Saved');
	let settingsSaveError = $state<PleromaRequestErrorView | null>(null);
	let settingsSaveRequestId = 0;
	let profile = $state<ProfileSettings>({ ...defaultProfile });
	let savedProfile = $state<ProfileSettings>({ ...defaultProfile });
	let pendingAvatarFile = $state<File | null>(null);
	let pendingHeaderFile = $state<File | null>(null);
	let pendingAvatarPreview = $state<string | null>(null);
	let pendingHeaderPreview = $state<string | null>(null);
	let avatarFileInput = $state<HTMLInputElement | null>(null);
	let headerFileInput = $state<HTMLInputElement | null>(null);
	let homePostSubmitState = $state<'idle' | 'submitting'>('idle');
	let homePostSubmitError = $state<PleromaRequestErrorView | null>(null);
	let inlineReplyTarget = $state<InlineReplyTarget | null>(null);
	let inlineReplyDraft = $state('');
	let inlineReplyUploads = $state<ComposerUpload[]>([]);
	let inlineReplySpoilerActive = $state(false);
	let inlineReplySpoilerText = $state('');
	let inlineReplyPoll = $state<ComposerPollDraft | null>(null);
	let inlineReplySubmitState = $state<'idle' | 'submitting'>('idle');
	let inlineReplySubmitError = $state<PleromaRequestErrorView | null>(null);
	let statusActionErrors = $state<StatusActionErrorState[]>([]);
	let statusActionPending = $state<Record<string, number>>({});
	let postControlMessage = $state('');
	let postControlMessageId = 0;
	let bookmarksState = $state<PaginatedTimelineState<PleromaStatusView, PleromaRequestErrorView>>({ status: 'idle' });
	let bookmarksRequestId = 0;
	let chatsState = $state<PleromaRequestState<PleromaChatView[]>>({ status: 'idle' });
	let chatsRequestId = 0;
	let loadedChatsKey = '';
	let chatThreadState = $state<PleromaRequestState<PleromaChatMessageView[]>>({ status: 'idle' });
	let chatThreadRequestId = 0;
	let loadedChatThreadKey = '';
	let chatDraft = $state('');
	let chatSending = $state(false);
	let chatSendError = $state<PleromaRequestErrorView | null>(null);
	let loadedBookmarksKey = '';
	let profileAccountLoadError = $state<PleromaRequestErrorView | null>(null);
	let inviteState = $state<PleromaRequestState<string>>({ status: 'idle' });
	let inviteRequestId = 0;
	let loadedInviteKey = '';
	// Visibility channels: the LOCKED channel's invite, revealed on demand only
	// (it grants followers-only access; sharing it IS the approval).
	let lockedInviteState = $state<PleromaRequestState<string>>({ status: 'idle' });
	let backupInfo = $state<DeltanetBackupInfo | null>(null);
	let loadedBackupInfoKey = '';
	let backupPassphrase = $state('');
	let backupBusy = $state(false);
	let backupError = $state('');
	let backupSavedAs = $state('');
	let followInviteInput = $state('');
	let followInvitePending = $state(false);
	let replySort = $state<ReplySort>('top');
	let expandedThreadReplyIds = $state<Record<string, boolean>>({});
	let homeTimelineRequestId = 0;
	let homeTimelineNewPostsRequestId = 0;
	let threadRequestId = 0;
	let profileRouteRequestId = 0;
	let notificationRequestId = 0;
	let searchRequestId = 0;
	let headerSearchRequestId = 0;
	let trendsRequestId = 0;
	let statusActionRequestId = 0;
	let inlineReplyRequestId = 0;
	let homePostSubmitRequestId = 0;
	let profileAccountRequestId = 0;
	let instanceConfigRequestId = 0;
	let suggestionsRequestId = 0;
	let composerMentionSearchRequestId = 0;
	let composerCustomEmojiRequestId = 0;
	let loadedHomeTimelineKey = '';
	let loadedThreadKey = '';
	let loadedProfileRouteKey = '';
	let loadedNotificationsKey = '';
	let loadedForegroundNotificationsKey = '';
	let loadedSearchKey = '';
	let loadedProfileAccountKey = '';
	let loadedTrendsKey = '';
	let loadedInstanceConfigKey = '';
	let loadedSuggestionsKey = '';
	let loadedComposerCustomEmojiKey = '';
	let homeTimelineFallbackSinceId: string | null = null;
	let homeTimelineStreamKey = '';
	let homeTimelineStreamReadyKey = '';
	let closeHomeTimelineStream: (() => void) | null = null;
	let homeTimelineStreamReconnectTimer: number | null = null;
	let notificationStreamKey = '';
	let notificationStreamReadyKey = '';
	let closeNotificationStream: (() => void) | null = null;
	let notificationStreamReconnectTimer: number | null = null;
	let notificationLoadPromise: Promise<void> | null = null;
	let notificationLoadPromiseKey = '';
	let notificationLoadStartedAt = 0;
	let notificationAbortController: AbortController | null = null;
	let headerSearchDebounceTimer: number | null = null;
	let searchPageDebounceTimer: number | null = null;
	let headerSearchPointerActivated = false;
	let searchFollowPending = $state<Record<string, boolean>>({});
	let composerCharacterLimit = $state(DEFAULT_STATUS_CHARACTER_LIMIT);
	const sessionKey = (session: PleromaSession | null) => session ? `${session.instanceUrl}\n${session.accessToken}\n${session.createdAt}` : '';
	const resetAccountCache = () => {
		accountCache = createPleromaAccountCache();
	};
	const upsertAccountCache = (accounts: PleromaAccount[], options?: Parameters<typeof upsertPleromaAccounts>[2]) => {
		if (accounts.length === 0) return;
		const nextCache = upsertPleromaAccounts(accountCache, accounts, options);
		if (nextCache !== accountCache) accountCache = nextCache;
	};
	const instanceHost = (instanceUrl: string | undefined) => {
		if (!instanceUrl) return 'deltanet.example';
		try {
			return new URL(instanceUrl).hostname;
		} catch {
			return instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'deltanet.example';
		}
	};
	const accountStat = (value: number | null | undefined) => accountStatFormatter.format(Math.max(0, value ?? 0));
	const clearInlineReply = (route?: StatusActionOrigin) => {
		if (route && inlineReplyTarget?.route !== route) return;
		inlineReplyRequestId += 1;
		inlineReplyTarget = null;
		inlineReplyDraft = '';
		inlineReplyUploads = [];
		inlineReplySpoilerActive = false;
		inlineReplySpoilerText = '';
		inlineReplyPoll = null;
		inlineReplySubmitState = 'idle';
		inlineReplySubmitError = null;
	};
	const clearStatusActionErrors = (route?: StatusActionOrigin) => {
		if (!route) {
			if (statusActionErrors.length > 0) statusActionErrors = [];
			return;
		}

		if (!statusActionErrors.some((error) => error.route === route)) return;
		statusActionErrors = statusActionErrors.filter((error) => error.route !== route);
	};
	const removeStatusActionError = (targetId: string, key: string) => {
		statusActionErrors = statusActionErrors.filter((error) => error.targetId !== targetId || error.key !== key);
	};
	const addStatusActionError = (nextError: StatusActionErrorState) => {
		statusActionErrors = [
			...statusActionErrors.filter((error) => error.targetId !== nextError.targetId || error.key !== nextError.key || error.route !== nextError.route),
			nextError
		];
	};
	const invalidateStatusActionRequests = () => {
		statusActionRequestId += 1;
		statusActionPending = {};
		clearStatusActionErrors();
	};
	const invalidateHomeTimelineRequests = () => {
		homeTimelineRequestId += 1;
		homeTimelineNewPostsRequestId += 1;
		homePostSubmitRequestId += 1;
		homePostSubmitState = 'idle';
		homePostSubmitError = null;
		clearInlineReply('home');
		composerUploads = [];
		composerDragActive = false;
		composerDragDepth = 0;
		clearStatusActionErrors('home');
	};
	const invalidateThreadRequests = () => {
		threadRequestId += 1;
		loadedThreadKey = '';
		threadState = { status: 'idle' };
		expandedThreadReplyIds = {};
		clearInlineReply('thread');
		clearStatusActionErrors('thread');
	};
	const invalidateProfileRouteRequests = () => {
		profileRouteRequestId += 1;
		loadedProfileRouteKey = '';
		profileRouteState = { status: 'idle' };
		clearStatusActionErrors('profile');
	};
	const clearHomeRouteIfLoaded = () => {
		if (!loadedHomeTimelineKey && homeTimelineState.status === 'idle' && !closeHomeTimelineStream) return;
		invalidateHomeTimelineRequests();
		loadedHomeTimelineKey = '';
		closeHomeTimelineStreaming();
	};
	const clearThreadRouteIfLoaded = () => {
		if (!loadedThreadKey && threadState.status === 'idle') return;
		invalidateThreadRequests();
	};
	const clearProfileRouteIfLoaded = () => {
		if (!loadedProfileRouteKey && profileRouteState.status === 'idle') return;
		invalidateProfileRouteRequests();
	};
	const invalidateNotificationRequests = () => {
		notificationRequestId += 1;
		clearNotificationLoadPromise(true);
		closeNotificationStreaming();
		loadedNotificationsKey = '';
		loadedForegroundNotificationsKey = '';
		notificationState = { status: 'idle' };
	};
	const clearHeaderSearchDebounce = () => {
		if (!headerSearchDebounceTimer) return;
		window.clearTimeout(headerSearchDebounceTimer);
		headerSearchDebounceTimer = null;
	};
	const clearSearchPageDebounce = () => {
		if (!searchPageDebounceTimer) return;
		window.clearTimeout(searchPageDebounceTimer);
		searchPageDebounceTimer = null;
	};
	const closeHeaderSearch = () => {
		clearHeaderSearchDebounce();
		headerSearchOpen = false;
		headerSearchSelectedIndex = -1;
	};
	const invalidateSearchRequests = () => {
		clearSearchPageDebounce();
		searchRequestId += 1;
		headerSearchRequestId += 1;
		loadedSearchKey = '';
		searchState = { status: 'idle' };
		headerSearchState = { status: 'idle' };
		searchFollowPending = {};
		closeHeaderSearch();
	};
	const invalidateProfileAccountRequests = () => {
		profileAccountRequestId += 1;
		loadedProfileAccountKey = '';
		profileAccountLoadError = null;
	};
	const invalidateTrendsRequests = () => {
		trendsRequestId += 1;
		loadedTrendsKey = '';
		trendsState = { status: 'idle' };
	};
	const invalidateInstanceConfigRequests = () => {
		instanceConfigRequestId += 1;
		loadedInstanceConfigKey = '';
		composerCharacterLimit = DEFAULT_STATUS_CHARACTER_LIMIT;
	};
	const invalidateSuggestionsRequests = () => {
		suggestionsRequestId += 1;
		loadedSuggestionsKey = '';
		suggestionsState = { status: 'idle' };
		suggestionFollowPending = {};
	};
	const invalidateBookmarksRequests = () => {
		bookmarksRequestId += 1;
		loadedBookmarksKey = '';
		bookmarksState = { status: 'idle' };
	};
	const invalidateChatsRequests = () => {
		chatsRequestId += 1;
		chatThreadRequestId += 1;
		loadedChatsKey = '';
		loadedChatThreadKey = '';
		chatsState = { status: 'idle' };
		chatThreadState = { status: 'idle' };
		chatDraft = '';
		chatSending = false;
		chatSendError = null;
	};
	const invalidateInviteRequests = () => {
		inviteRequestId += 1;
		loadedInviteKey = '';
		inviteState = { status: 'idle' };
		followInviteInput = '';
		followInvitePending = false;
	};
	const invalidateComposerAutocompleteRequests = () => {
		composerMentionSearchRequestId += 1;
		composerCustomEmojiRequestId += 1;
		loadedComposerCustomEmojiKey = '';
		composerMentionAccounts = [];
		composerCustomEmojis = [];
	};
	const isCurrentSessionRequest = (requestSessionKey: string) => sessionKey(currentSession) === requestSessionKey;
	const clearHomeTimelineStreamReconnect = () => {
		if (homeTimelineStreamReconnectTimer === null) return;
		window.clearTimeout(homeTimelineStreamReconnectTimer);
		homeTimelineStreamReconnectTimer = null;
	};
	const closeHomeTimelineStreaming = () => {
		clearHomeTimelineStreamReconnect();
		closeHomeTimelineStream?.();
		closeHomeTimelineStream = null;
		homeTimelineStreamKey = '';
		homeTimelineStreamReadyKey = '';
	};
	const clearNotificationStreamReconnect = () => {
		if (notificationStreamReconnectTimer === null) return;
		window.clearTimeout(notificationStreamReconnectTimer);
		notificationStreamReconnectTimer = null;
	};
	const closeNotificationStreaming = () => {
		clearNotificationStreamReconnect();
		closeNotificationStream?.();
		closeNotificationStream = null;
		notificationStreamKey = '';
		notificationStreamReadyKey = '';
	};

	let notificationItems = $derived(notificationState.status === 'success' ? notificationState.data : []);
	let unreadNotificationCount = $derived(notificationItems.filter((notification) => !notification.read).length);
	let notificationPopoverStatus = $derived<NotificationPopoverStatus>(
		notificationState.status === 'success' ? 'ready' :
		notificationState.status === 'empty' ? 'empty' :
		notificationState.status === 'error' ? 'error' :
		'loading'
	);
	let notificationPopoverError = $derived(notificationState.status === 'error' ? notificationState.error : null);
	let headerNotificationLabel = $derived(unreadNotificationCount > 0 ? `Notifications, ${unreadNotificationCount} unread` : 'Notifications');
	let headerAccount = $derived(currentSession?.account ? adaptPleromaAccount(currentSession.account) : null);
	let headerAccountName = $derived(headerAccount?.displayName ?? 'Account');
	let headerAccountAvatarUrl = $derived(headerAccount?.avatarUrl ?? null);
	let headerAccountLabel = $derived(`${headerAccountName} account menu`);
	let headerAccountHandle = $derived(headerAccount?.handle ?? '@account');
	let headerAccountPosts = $derived(accountStat(currentSession?.account?.statuses_count));
	let headerAccountFollowing = $derived(accountStat(currentSession?.account?.following_count));
	let headerAccountFollowers = $derived(accountStat(currentSession?.account?.followers_count));
	let headerInstanceDomain = $derived(instanceHost(currentSession?.instanceUrl));
	let homeStatusActionErrors = $derived(statusActionErrors.filter((error) => error.route === 'home'));
	let threadStatusActionErrors = $derived(statusActionErrors.filter((error) => error.route === 'thread'));
	let profileStatusActionErrors = $derived(statusActionErrors.filter((error) => error.route === 'profile'));

	const chatUnreadCount = $derived(chatsState.status === 'success' ? chatsState.data.reduce((sum, chat) => sum + chat.unread, 0) : 0);
	let navItems = $derived<NavItem[]>([
		{ route: 'home', label: 'Home', icon: 'home', href: '/app/home' },
		{ route: 'explore', label: 'Explore', icon: 'search', href: '/app/explore' },
		{ route: 'notifications', label: 'Notifications', icon: 'bell', href: '/app/notifications', count: unreadNotificationCount || undefined },
		{ route: 'messages', label: 'Messages', icon: 'msg', href: '/app/messages', count: chatUnreadCount || undefined },
		{ route: 'bookmarks', label: 'Bookmarks', icon: 'bookmark', href: '/app/bookmarks' },
		{ route: 'settings', label: 'Settings', icon: 'gear', href: '/app/settings' },
	]);
	const timelineRoutes: AppRoute[] = ['home', 'public', 'thread'];
	const settingsSubnav = ['Profile', 'Appearance', 'Notifications', 'Filters', 'Federation', 'Account', 'Import / Export', 'Development'];

	const avatarClass = (avatar: SocialPost['avatar']) =>
		avatar === 'pc' ? 'av-pixel-pc' :
		avatar === 'orb' ? 'av-orb' :
		avatar === 'grad-1' ? 'av-grad-1' :
		avatar === 'grad-2' ? 'av-grad-2' :
		avatar === 'grad-3' ? 'av-grad-3' :
		'av-anime';
	const cachedAccountView = (account: PleromaAccountView | null | undefined): PleromaAccountView | null => {
		if (!account) return null;
		const cached = getCachedPleromaAccount(accountCache, account.id) ?? getCachedPleromaAccount(accountCache, account.acct);
		return cached ? adaptPleromaAccount(cached) : account;
	};

	const postForRebuild = (post: AccountBackedPost): RebuildPost => {
		const account = cachedAccountView(post.account);
		const booster = cachedAccountView(post.rebloggedBy);

		return {
			id: post.id,
			actionStatusId: post.actionStatusId,
			threadStatusId: post.threadStatusId,
			visibility: post.visibility,
			name: account?.displayName ?? post.name,
			nameEmojis: account?.emojis ?? post.nameEmojis,
			authName: account?.authName ?? post.authName,
			petname: account?.petname ?? post.petname,
			authorUnconfirmed: post.authorUnconfirmed,
			handle: account?.handle ?? post.handle,
			time: post.time,
			createdAt: post.createdAt,
			avClass: avatarClass(post.avatar),
			avatarUrl: account?.avatarUrl ?? post.avatarUrl,
			cw: post.cw,
			body: post.body,
			bodyEmojis: post.bodyEmojis,
			media: post.media,
			attachments: post.attachments,
			addressees: post.addressees,
			addresseeNames: post.addresseeNames,
			addresseePetnames: post.addresseePetnames,
			mentionNames: post.mentionNames,
			mentionAccts: post.mentionAccts,
			boostedBy: post.boostedBy ? {
				name: booster?.displayName ?? post.boostedBy.name,
				nameEmojis: booster?.emojis ?? post.boostedBy.nameEmojis,
				handle: booster?.handle ?? post.boostedBy.handle,
				time: post.boostedBy.time,
				createdAt: post.boostedBy.createdAt,
				avClass: post.boostedBy.avatar ? avatarClass(post.boostedBy.avatar) : undefined,
				avatarUrl: booster?.avatarUrl ?? post.boostedBy.avatarUrl
			} : undefined,
			copyJson: post.copyJson,
			quotedPost: post.quotedPost,
			reactions: post.reactions,
			bookmarked: post.bookmarked,
			statusUrl: post.url,
			authorId: account?.id ?? post.account?.id,
			authorHandle: account?.handle ?? post.account?.handle,
			own: Boolean(currentSession?.account?.id && (account?.id ?? post.account?.id) === currentSession.account.id),
			replies: post.replies,
			boosts: post.boosts,
			favs: post.favorites,
			actions: {
				reply: post.actions.reply,
				boost: post.actions.boost,
				fav: post.actions.favorite,
			},
		};
	};
	const threadFullTime = (createdAt: string) => {
		const date = new Date(createdAt);
		if (Number.isNaN(date.getTime())) return '';

		const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(date);
		const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
		return `${time} · ${day}`;
	};
	const threadPostForRebuild = (post: PleromaStatusView): ThreadViewPost => ({
		...postForRebuild(post),
		fullTime: threadFullTime(post.createdAt),
		source: post.applicationName ?? 'Pleroma',
		views: null,
		threadSubscribed: post.threadSubscribed
	});
	const profilePostForRebuild = (post: PleromaStatusView): ProfilePost => postForRebuild(post);
	const profileMediaItem = (attachment: PleromaStatusView['mediaAttachments'][number]): ProfileMediaItem | null => {
		const type = attachment.type.toLowerCase();
		if (type === 'image' || type === 'photo') return { kind: 'photo', src: attachment.previewUrl ?? attachment.url, alt: attachment.description ?? undefined };
		if (type === 'video' || type === 'gifv') return { kind: 'video', src: attachment.previewUrl ?? attachment.url, alt: attachment.description ?? undefined, title: attachment.description ?? attachment.filename ?? 'video' };
		if (type === 'audio') return { kind: 'audio', title: attachment.description ?? attachment.filename ?? 'audio' };
		return null;
	};
	const profileMediaItems = (posts: PleromaStatusView[]): ProfileMediaItem[] => posts
		.filter((post) => !post.mediaHidden && !post.hasContentWarning)
		.flatMap((post) => post.mediaAttachments.map(profileMediaItem))
		.filter((item): item is ProfileMediaItem => item !== null);
	const emptyProfileData = (profile: ProfileData['profile']): ProfileData => ({ profile, posts: [], replies: [], pinned: [], media: [] });
	const threadRepliesForRebuild = (focusedStatusId: string, descendants: PleromaStatusView[]) => {
		const posts: ThreadViewPost[] = descendants.map((post) => ({ ...threadPostForRebuild(post), nestedReplies: [] }));
		const byId = new Map(posts.map((post) => [String(post.id), post]));
		const roots: ThreadViewPost[] = [];

		descendants.forEach((status, index) => {
			const post = posts[index];
			const parent = status.inReplyToId ? byId.get(status.inReplyToId) : null;
			if (parent && status.inReplyToId !== focusedStatusId) {
				parent.nestedReplies = [...(parent.nestedReplies ?? []), post];
				return;
			}

			roots.push(post);
		});

		return roots;
	};
	const threadPostCount = (posts: ThreadViewPost[]): number => posts.reduce((total, post) => total + 1 + threadPostCount(post.nestedReplies ?? []), 0);
	const actionStateKey = (key: StatusActionKey) => key === 'fav' ? 'favorite' : 'boost';
	const statusActionPendingKey = (targetId: string, key: string) => `${targetId}:${key}`;
	const statusActionOriginRequestId = (originRoute: StatusActionOrigin) =>
		originRoute === 'home' ? homeTimelineRequestId :
		originRoute === 'thread' ? threadRequestId :
		profileRouteRequestId;
	const statusActionOriginActive = (origin: StatusActionOriginSnapshot) =>
		origin.route === 'home'
			? route === 'home' && homeTimelineRequestId === origin.requestId
			: origin.route === 'thread'
				? route === 'thread' && threadRequestId === origin.requestId
				: route === 'profile' && profileRouteRequestId === origin.requestId;
	const statusActionTargetId = (post: { id?: string | number; actionStatusId?: string }) => String(post.actionStatusId ?? post.id ?? '');
	const statusReplyTargetId = (post: { id?: string | number; actionStatusId?: string; threadStatusId?: string }) => String(post.threadStatusId ?? post.actionStatusId ?? post.id ?? '');
	const inlineReplyTargetHandle = (handle = '') => {
		const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
		const local = normalized.split('@').filter(Boolean)[0] ?? normalized;
		return `@${local || 'user'}`;
	};
	const matchesStatusActionTarget = (post: { id?: string | number; actionStatusId?: string }, targetId: string) => statusActionTargetId(post) === targetId;
	const matchesStatusReplyTarget = (post: { id?: string | number; actionStatusId?: string; threadStatusId?: string }, targetId: string) => statusReplyTargetId(post) === targetId;
	const statusViewActionValue = (post: PleromaStatusView, key: StatusActionKey): StatusActionValue =>
		key === 'fav'
			? { active: post.actions.favorite, count: post.favorites }
			: { active: post.actions.boost, count: post.boosts };
	const rebuildPostActionValue = (post: RebuildPost, key: StatusActionKey): StatusActionValue =>
		key === 'fav'
			? { active: post.actions.fav, count: post.favs }
			: { active: post.actions.boost, count: post.boosts };
	const setStatusViewAction = <PostType extends PleromaStatusView>(post: PostType, key: StatusActionKey, value: StatusActionValue): PostType => {
		const actionKey = actionStateKey(key);
		return {
			...post,
			boosts: key === 'boost' ? value.count : post.boosts,
			favorites: key === 'fav' ? value.count : post.favorites,
			actions: { ...post.actions, [actionKey]: value.active }
		};
	};
	const setRebuildPostAction = <PostType extends RebuildPost>(post: PostType, key: StatusActionKey, value: StatusActionValue): PostType => ({
		...post,
		boosts: key === 'boost' ? value.count : post.boosts,
		favs: key === 'fav' ? value.count : post.favs,
		actions: { ...post.actions, [key]: value.active }
	});
	const updateRebuildPostsByActionTarget = <PostType extends RebuildPost & { nestedReplies?: PostType[] }>(posts: PostType[], targetId: string, update: (post: PostType) => PostType): PostType[] =>
		posts.map((post) => {
			const updated = matchesStatusActionTarget(post, targetId) ? update(post) : post;

			return updated.nestedReplies ? { ...updated, nestedReplies: updateRebuildPostsByActionTarget(updated.nestedReplies, targetId, update) } : updated;
		});
	const updateStatusViewsByActionTarget = (posts: PleromaStatusView[], targetId: string, update: (post: PleromaStatusView) => PleromaStatusView) =>
		posts.map((post) => matchesStatusActionTarget(post, targetId) ? update(post) : post);
	const updateProfilePostsByActionTarget = (posts: ProfilePost[], targetId: string, update: (post: ProfilePost) => ProfilePost) =>
		posts.map((post) => matchesStatusActionTarget(post, targetId) ? update(post) : post);
	const updateRebuildPostsByReplyTarget = <PostType extends RebuildPost & { nestedReplies?: PostType[] }>(posts: PostType[], targetId: string, update: (post: PostType) => PostType): PostType[] =>
		posts.map((post) => {
			const updated = matchesStatusReplyTarget(post, targetId) ? update(post) : post;

			return updated.nestedReplies ? { ...updated, nestedReplies: updateRebuildPostsByReplyTarget(updated.nestedReplies, targetId, update) } : updated;
		});
	const updateStatusViewsByReplyTarget = (posts: PleromaStatusView[], targetId: string, update: (post: PleromaStatusView) => PleromaStatusView) =>
		posts.map((post) => matchesStatusReplyTarget(post, targetId) ? update(post) : post);
	const updateProfilePostsByReplyTarget = (posts: ProfilePost[], targetId: string, update: (post: ProfilePost) => ProfilePost) =>
		posts.map((post) => matchesStatusReplyTarget(post, targetId) ? update(post) : post);
	const profileHrefForAccount = (account: { acct: string }) => `/app/profiles/${encodeURIComponent(account.acct)}`;
	const searchUrl = (query: string, tab: SearchTab = 'all') => {
		const params = new URLSearchParams();
		const trimmed = query.trim();
		if (trimmed) params.set('q', trimmed);
		if (tab !== 'all') params.set('tab', tab);
		const queryString = params.toString();
		return queryString ? `/app/search?${queryString}` : '/app/search';
	};
	const submitSearch = (query: string, tab: SearchTab = 'all') => {
		const trimmed = query.trim();
		if (!trimmed) return;
		goto(searchUrl(trimmed, tab));
	};
	const incrementStatusViewReplies = <PostType extends PleromaStatusView>(post: PostType): PostType => ({ ...post, replies: post.replies + 1 });
	const incrementRebuildPostReplies = <PostType extends RebuildPost>(post: PostType): PostType => ({ ...post, replies: post.replies + 1 });
	const findPostInList = <PostType extends RebuildPost & { nestedReplies?: PostType[] }>(posts: PostType[], postId: string | number): PostType | null => {
		for (const post of posts) {
			if (String(post.id) === String(postId)) return post;
			const nested = post.nestedReplies ? findPostInList(post.nestedReplies, postId) : null;
			if (nested) return nested;
		}

		return null;
	};
	const findThreadPost = (postId: string | number) => {
		if (threadState.status !== 'success') return null;
		if (String(threadState.focused.id) === String(postId)) return threadState.focused;
		return findPostInList([...threadState.ancestors, ...threadState.replies], postId);
	};
	const showThreadReplyNested = (postId: string | number | undefined) => {
		if (postId == null) return;
		expandedThreadReplyIds = { ...expandedThreadReplyIds, [String(postId)]: true };
	};
	const expandThreadReplyPath = (postId: string) => {
		if (threadState.status !== 'success') return;

		const nextExpanded = { ...expandedThreadReplyIds };
		const expandIn = (posts: ThreadViewPost[]): boolean => {
			for (const post of posts) {
				if (String(post.id) === postId) {
					nextExpanded[String(post.id)] = true;
					return true;
				}

				if (post.nestedReplies && expandIn(post.nestedReplies)) {
					nextExpanded[String(post.id)] = true;
					return true;
				}
			}

			return false;
		};

		if (expandIn(threadState.ancestors) || expandIn(threadState.replies)) expandedThreadReplyIds = nextExpanded;
	};
	const applyStatusActionUpdate = (scope: StatusActionScope, targetId: string, statusUpdate: <PostType extends PleromaStatusView>(post: PostType) => PostType, rebuildUpdate: <PostType extends RebuildPost>(post: PostType) => PostType) => {
		if (scope === 'home' || scope === 'all') {
			localHomePosts = updateRebuildPostsByActionTarget(localHomePosts, targetId, rebuildUpdate);
		}
		if ((scope === 'home' || scope === 'all') && homeTimelineState.status === 'success') {
			homeTimelineState = {
				...homeTimelineState,
				data: updateStatusViewsByActionTarget(homeTimelineState.data, targetId, statusUpdate),
				newerPosts: updateStatusViewsByActionTarget(homeTimelineState.newerPosts, targetId, statusUpdate)
			};
		}
		if ((scope === 'home' || scope === 'all') && bookmarksState.status === 'success') {
			bookmarksState = {
				...bookmarksState,
				data: updateStatusViewsByActionTarget(bookmarksState.data, targetId, statusUpdate)
			};
		}
		if ((scope === 'thread' || scope === 'all') && threadState.status === 'success') {
			threadState = {
				...threadState,
				focused: matchesStatusActionTarget(threadState.focused, targetId) ? rebuildUpdate(threadState.focused) : threadState.focused,
				ancestors: updateRebuildPostsByActionTarget(threadState.ancestors, targetId, rebuildUpdate),
				replies: updateRebuildPostsByActionTarget(threadState.replies, targetId, rebuildUpdate)
			};
		}
		if ((scope === 'profile' || scope === 'all') && profileRouteState.status === 'success') {
			profileRouteState = {
				...profileRouteState,
				data: {
					...profileRouteState.data,
					posts: updateProfilePostsByActionTarget(profileRouteState.data.posts, targetId, rebuildUpdate),
					replies: updateProfilePostsByActionTarget(profileRouteState.data.replies, targetId, rebuildUpdate),
					pinned: updateProfilePostsByActionTarget(profileRouteState.data.pinned, targetId, rebuildUpdate)
				}
			};
		}
	};
	const applyReplyCountUpdate = (targetId: string) => {
		localHomePosts = updateRebuildPostsByReplyTarget(localHomePosts, targetId, incrementRebuildPostReplies);
		if (homeTimelineState.status === 'success') {
			homeTimelineState = {
				...homeTimelineState,
				data: updateStatusViewsByReplyTarget(homeTimelineState.data, targetId, incrementStatusViewReplies),
				newerPosts: updateStatusViewsByReplyTarget(homeTimelineState.newerPosts, targetId, incrementStatusViewReplies)
			};
		}
		if (threadState.status === 'success') {
			threadState = {
				...threadState,
				focused: matchesStatusReplyTarget(threadState.focused, targetId) ? incrementRebuildPostReplies(threadState.focused) : threadState.focused,
				ancestors: updateRebuildPostsByReplyTarget(threadState.ancestors, targetId, incrementRebuildPostReplies),
				replies: updateRebuildPostsByReplyTarget(threadState.replies, targetId, incrementRebuildPostReplies)
			};
		}
		if (profileRouteState.status === 'success') {
			profileRouteState = {
				...profileRouteState,
				data: {
					...profileRouteState.data,
					posts: updateProfilePostsByReplyTarget(profileRouteState.data.posts, targetId, incrementRebuildPostReplies),
					replies: updateProfilePostsByReplyTarget(profileRouteState.data.replies, targetId, incrementRebuildPostReplies),
					pinned: updateProfilePostsByReplyTarget(profileRouteState.data.pinned, targetId, incrementRebuildPostReplies)
				}
			};
		}
	};
	const insertNestedThreadReply = (posts: ThreadViewPost[], parentId: string, reply: ThreadViewPost[]): ThreadViewPost[] =>
		posts.map((post) => {
			if (String(post.id) === parentId) return { ...post, nestedReplies: [...(post.nestedReplies ?? []), ...reply] };

			return post.nestedReplies ? { ...post, nestedReplies: insertNestedThreadReply(post.nestedReplies, parentId, reply) } : post;
		});
	const insertThreadReply = (parentId: string, status: PleromaStatus) => {
		if (threadState.status !== 'success') return;

		upsertAccountCache(accountsFromPleromaStatus(status));
		const reply = [{ ...threadPostForRebuild(adaptPleromaStatus(status)), nestedReplies: [] }];
		threadState = String(threadState.focused.id) === parentId
			? { ...threadState, replies: [...threadState.replies, ...reply] }
			: {
				...threadState,
				ancestors: insertNestedThreadReply(threadState.ancestors, parentId, reply),
				replies: insertNestedThreadReply(threadState.replies, parentId, reply)
			};
		if (String(threadState.focused.id) !== parentId) expandThreadReplyPath(parentId);
	};
	const clearStatusActionPending = (pendingKey: string, requestId: number) => {
		if (statusActionPending[pendingKey] !== requestId) return;
		const { [pendingKey]: _cleared, ...rest } = statusActionPending;
		statusActionPending = rest;
	};
	const mutateStatusAction = (targetId: string, key: StatusActionKey, previous: StatusActionValue, originRoute: StatusActionOrigin) => {
		const session = currentSession;
		if (!session) return;
		const pendingKey = statusActionPendingKey(targetId, key);
		if (statusActionPending[pendingKey]) return;

		const requestSessionKey = sessionKey(session);
		const origin = { route: originRoute, requestId: statusActionOriginRequestId(originRoute) };
		const requestId = statusActionRequestId + 1;
		statusActionRequestId = requestId;
		statusActionPending = { ...statusActionPending, [pendingKey]: requestId };
		removeStatusActionError(targetId, key);
		const optimistic = { active: !previous.active, count: previous.count };
		applyStatusActionUpdate(originRoute, targetId, (post) => setStatusViewAction(post, key, optimistic), (post) => setRebuildPostAction(post, key, optimistic));

		void (async () => {
			try {
				const client = createPleromaClient({
					instanceUrl: session.instanceUrl,
					accessToken: session.accessToken,
					fetch: window.fetch.bind(window)
				});
				const status = key === 'fav'
					? previous.active ? await client.unfavoriteStatus(targetId) : await client.favoriteStatus(targetId)
					: previous.active ? await client.unboostStatus(targetId) : await client.boostStatus(targetId);
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				if (statusActionPending[pendingKey] !== requestId) return;

				upsertAccountCache(accountsFromPleromaStatus(status));
				const serverPost = adaptPleromaStatus(status);
				const reconciled = statusViewActionValue(serverPost, key);
				applyStatusActionUpdate('all', targetId, (post) => setStatusViewAction(post, key, reconciled), (post) => setRebuildPostAction(post, key, reconciled));
				clearStatusActionPending(pendingKey, requestId);
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				if (statusActionPending[pendingKey] !== requestId) return;

				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					clearStatusActionPending(pendingKey, requestId);
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}

				clearStatusActionPending(pendingKey, requestId);
				if (!statusActionOriginActive(origin)) return;

				applyStatusActionUpdate(origin.route, targetId, (post) => setStatusViewAction(post, key, previous), (post) => setRebuildPostAction(post, key, previous));
				addStatusActionError({ targetId, key, route: origin.route, error: normalized });
			}
		})();
	};
	const updatedPostReactions = (reactions: PleromaReactionView[] | undefined, name: string, active: boolean): PleromaReactionView[] => {
		const current = reactions ?? [];
		const existing = current.find((reaction) => reaction.name === name);
		if (!existing) {
			return active ? [...current, { name, glyph: name, url: null, staticUrl: null, count: 1, me: true }] : current;
		}

		return current
			.map((reaction) => {
				if (reaction.name !== name) return reaction;
				const delta = reaction.me === active ? 0 : active ? 1 : -1;
				return { ...reaction, me: active, count: Math.max(0, reaction.count + delta) };
			})
			.filter((reaction) => reaction.count > 0);
	};
	const mutateStatusReaction = (targetId: string, name: string, previouslyReacted: boolean, originRoute: StatusActionOrigin) => {
		const session = currentSession;
		if (!session) return;
		const actionKey = `reaction:${name}`;
		const pendingKey = statusActionPendingKey(targetId, actionKey);
		if (statusActionPending[pendingKey]) return;

		const requestSessionKey = sessionKey(session);
		const origin = { route: originRoute, requestId: statusActionOriginRequestId(originRoute) };
		const requestId = statusActionRequestId + 1;
		statusActionRequestId = requestId;
		statusActionPending = { ...statusActionPending, [pendingKey]: requestId };
		removeStatusActionError(targetId, actionKey);
		const applyReactionToggle = (scope: StatusActionScope, active: boolean) => applyStatusActionUpdate(
			scope,
			targetId,
			(post) => ({ ...post, reactions: updatedPostReactions(post.reactions, name, active) }),
			(post) => ({ ...post, reactions: updatedPostReactions(post.reactions, name, active) })
		);
		applyReactionToggle(originRoute, !previouslyReacted);

		void (async () => {
			try {
				const client = createPleromaClient({
					instanceUrl: session.instanceUrl,
					accessToken: session.accessToken,
					fetch: window.fetch.bind(window)
				});
				const status = previouslyReacted
					? await client.unreactToStatus(targetId, name)
					: await client.reactToStatus(targetId, name);
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				if (statusActionPending[pendingKey] !== requestId) return;

				upsertAccountCache(accountsFromPleromaStatus(status));
				const serverReactions = adaptPleromaStatus(status).reactions;
				applyStatusActionUpdate('all', targetId, (post) => ({ ...post, reactions: serverReactions }), (post) => ({ ...post, reactions: serverReactions }));
				clearStatusActionPending(pendingKey, requestId);
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				if (statusActionPending[pendingKey] !== requestId) return;

				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					clearStatusActionPending(pendingKey, requestId);
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}

				clearStatusActionPending(pendingKey, requestId);
				if (!statusActionOriginActive(origin)) return;

				applyReactionToggle(origin.route, previouslyReacted);
				addStatusActionError({ targetId, key: actionKey, route: origin.route, error: normalized });
			}
		})();
	};
	const postReactionByName = (post: { reactions?: PleromaReactionView[] }, name: string) => post.reactions?.find((reaction) => reaction.name === name);
	const openReactionPicker = (post: RebuildPost, originRoute: StatusActionOrigin, anchor: HTMLElement) => {
		const session = currentSession;
		if (!session) return;
		ensureComposerCustomEmojis(session);
		const rect = anchor.getBoundingClientRect();
		reactionPicker = { post, route: originRoute, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } };
	};
	const handleThreadReact = (postId: string | number | undefined, anchor: HTMLElement) => {
		if (postId == null) return;
		const post = findThreadPost(postId);
		if (post) openReactionPicker(post, 'thread', anchor);
	};
	const pickPostReaction = (item: string | ComposerEmoji) => {
		const target = reactionPicker;
		reactionPicker = null;
		if (!target) return;
		const name = typeof item === 'string' ? item : item.shortcode;
		const targetId = statusActionTargetId(target.post);
		if (!name || !targetId) return;
		composerEmojiRecents = [item, ...composerEmojiRecents.filter((recent) => emojiRecentKey(recent) !== emojiRecentKey(item))].slice(0, 12);
		mutateStatusReaction(targetId, name, postReactionByName(target.post, name)?.me === true, target.route);
	};
	const handleReactionAction = (post: RebuildPost, key: string, originRoute: StatusActionOrigin) => {
		const name = key.slice('reaction:'.length);
		const targetId = statusActionTargetId(post);
		if (!name || !targetId) return;
		mutateStatusReaction(targetId, name, postReactionByName(post, name)?.me === true, originRoute);
	};
	const replacePollInAttachments = (attachments: PostLike['attachments'], pollId: string, nextPoll: PostAttachment) =>
		(attachments ?? []).map((attachment) => attachment.kind === 'poll' && attachment.id === pollId ? nextPoll : attachment);
	const votePollForPost = (post: { id?: string | number; actionStatusId?: string }, pollId: string | undefined, choice: string | string[], originRoute: StatusActionOrigin) => {
		const session = currentSession;
		const targetId = statusActionTargetId(post);
		if (!session || !pollId || !targetId) return;
		const requestSessionKey = sessionKey(session);
		const choices = Array.isArray(choice) ? choice : [choice];

		void (async () => {
			try {
				const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
				const poll = await client.votePoll(pollId, choices);
				if (!isCurrentSessionRequest(requestSessionKey)) return;

				const nextPoll = adaptPleromaPoll(poll);
				if (!nextPoll) return;
				applyStatusActionUpdate(
					'all',
					targetId,
					(view) => ({ ...view, attachments: replacePollInAttachments(view.attachments, pollId, nextPoll) }),
					(rebuild) => ({ ...rebuild, attachments: replacePollInAttachments(rebuild.attachments, pollId, nextPoll) })
				);
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}
				flashPostControl(`Vote failed: ${normalized.title}`);
			}
		})();
	};
	const handleThreadVote = (postId: string | number | undefined, pollId: string | undefined, choice: string | string[]) => {
		if (postId == null) return;
		const post = findThreadPost(postId);
		if (post) votePollForPost(post, pollId, choice, 'thread');
	};
	const flashPostControl = (message: string) => {
		postControlMessage = message;
		const id = ++postControlMessageId;
		if (typeof window !== 'undefined') {
			window.setTimeout(() => {
				if (postControlMessageId === id) postControlMessage = '';
			}, 2600);
		}
	};
	const writeClipboardText = async (text: string) => {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return;
		}
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.setAttribute('readonly', '');
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		document.body.appendChild(textarea);
		textarea.select();
		const copied = document.execCommand('copy');
		textarea.remove();
		if (!copied) throw new Error('copy failed');
	};
	const copyPostLink = async (post: { statusUrl?: string; copyJson?: unknown }) => {
		const url = post.statusUrl || (isRecord(post.copyJson) && typeof post.copyJson.url === 'string' ? post.copyJson.url : '');
		if (!url) return;
		try {
			await writeClipboardText(url);
			flashPostControl('Link copied');
		} catch {
			flashPostControl('Copy failed');
		}
	};
	const setBookmarkStateEverywhere = (targetId: string, bookmarked: boolean) => {
		applyStatusActionUpdate('all', targetId, (post) => ({ ...post, bookmarked }), (post) => ({ ...post, bookmarked }));
		if (bookmarksState.status === 'success' && !bookmarked) {
			const data = bookmarksState.data.filter((post) => !matchesStatusActionTarget(post, targetId));
			bookmarksState = data.length > 0 ? { ...bookmarksState, data } : { status: 'empty' };
		}
	};
	const mutateBookmark = (targetId: string, previouslyBookmarked: boolean, originRoute: StatusActionOrigin) => {
		const session = currentSession;
		if (!session) return;
		const actionKey = 'bookmark';
		const pendingKey = statusActionPendingKey(targetId, actionKey);
		if (statusActionPending[pendingKey]) return;

		const requestSessionKey = sessionKey(session);
		const origin = { route: originRoute, requestId: statusActionOriginRequestId(originRoute) };
		const requestId = statusActionRequestId + 1;
		statusActionRequestId = requestId;
		statusActionPending = { ...statusActionPending, [pendingKey]: requestId };
		removeStatusActionError(targetId, actionKey);
		setBookmarkStateEverywhere(targetId, !previouslyBookmarked);

		void (async () => {
			try {
				const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
				const status = previouslyBookmarked ? await client.unbookmarkStatus(targetId) : await client.bookmarkStatus(targetId);
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				if (statusActionPending[pendingKey] !== requestId) return;

				setBookmarkStateEverywhere(targetId, adaptPleromaStatus(status).bookmarked);
				clearStatusActionPending(pendingKey, requestId);
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				if (statusActionPending[pendingKey] !== requestId) return;

				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					clearStatusActionPending(pendingKey, requestId);
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}

				clearStatusActionPending(pendingKey, requestId);
				setBookmarkStateEverywhere(targetId, previouslyBookmarked);
				if (statusActionOriginActive(origin)) addStatusActionError({ targetId, key: actionKey, route: origin.route, error: normalized });
			}
		})();
	};
	const keepThreadPosts = <PostType extends RebuildPost & { nestedReplies?: PostType[] }>(posts: PostType[], keep: (post: PostType) => boolean): PostType[] =>
		posts.filter(keep).map((post) => post.nestedReplies ? { ...post, nestedReplies: keepThreadPosts(post.nestedReplies, keep) } : post);
	const removeStatusesEverywhere = (keepView: (post: PleromaStatusView) => boolean, keepRebuild: (post: RebuildPost) => boolean) => {
		localHomePosts = keepThreadPosts(localHomePosts, keepRebuild);
		if (homeTimelineState.status === 'success') {
			homeTimelineState = { ...homeTimelineState, data: homeTimelineState.data.filter(keepView), newerPosts: homeTimelineState.newerPosts.filter(keepView) };
		}
		if (threadState.status === 'success') {
			threadState = { ...threadState, ancestors: keepThreadPosts(threadState.ancestors, keepRebuild), replies: keepThreadPosts(threadState.replies, keepRebuild) };
		}
		if (profileRouteState.status === 'success') {
			profileRouteState = {
				...profileRouteState,
				data: {
					...profileRouteState.data,
					posts: profileRouteState.data.posts.filter(keepRebuild),
					replies: profileRouteState.data.replies.filter(keepRebuild),
					pinned: profileRouteState.data.pinned.filter(keepRebuild)
				}
			};
		}
		if (bookmarksState.status === 'success') {
			const data = bookmarksState.data.filter(keepView);
			bookmarksState = data.length > 0 ? { ...bookmarksState, data } : { status: 'empty' };
		}
	};
	const deleteStatusEverywhere = (targetId: string, originRoute: StatusActionOrigin) => {
		const session = currentSession;
		if (!session) return;
		const requestSessionKey = sessionKey(session);
		const focusedDeleted = originRoute === 'thread' && threadState.status === 'success' && matchesStatusActionTarget(threadState.focused, targetId);

		void (async () => {
			try {
				const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
				await client.deleteStatus(targetId);
				if (!isCurrentSessionRequest(requestSessionKey)) return;

				if (focusedDeleted) {
					flashPostControl('Post deleted');
					goto('/app/home');
					return;
				}
				removeStatusesEverywhere((post) => !matchesStatusActionTarget(post, targetId), (post) => !matchesStatusActionTarget(post, targetId));
				flashPostControl('Post deleted');
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}
				flashPostControl(`Delete failed: ${normalized.title}`);
			}
		})();
	};
	const mutateAuthorRelationship = (accountId: string, handle: string, action: 'mute' | 'block') => {
		const session = currentSession;
		if (!session || !accountId) return;
		const requestSessionKey = sessionKey(session);

		void (async () => {
			try {
				const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
				const relationship = action === 'mute' ? await client.muteAccount(accountId) : await client.blockAccount(accountId);
				if (!isCurrentSessionRequest(requestSessionKey)) return;

				const cached = getCachedPleromaAccount(accountCache, accountId);
				if (cached) upsertAccountCache([{ ...cached, pleroma: { ...cached.pleroma, relationship } }], { relationship: 'replace' });
				removeStatusesEverywhere((post) => post.account.id !== accountId, (post) => post.authorId !== accountId);
				flashPostControl(action === 'mute' ? `Muted ${handle}` : `Blocked ${handle}`);
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}
				flashPostControl(`${action === 'mute' ? 'Mute' : 'Block'} failed: ${normalized.title}`);
			}
		})();
	};
	// deltanet thread-subscribe: subscribe/unsubscribe to the thread rooted at the
	// focused (root) status. Optimistically flips `threadSubscribed` on the focused
	// post; on the unreachable-author 422 it reverts + shows a clean toast.
	const mutateThreadSubscription = (targetId: string, subscribe: boolean) => {
		const session = currentSession;
		if (!session || !targetId) return;
		const requestSessionKey = sessionKey(session);
		const applySubscribed = (value: boolean) => {
			if (threadState.status !== 'success') return;
			if (!matchesStatusActionTarget(threadState.focused, targetId)) return;
			threadState = { ...threadState, focused: { ...threadState.focused, threadSubscribed: value } };
		};
		applySubscribed(subscribe); // optimistic
		void (async () => {
			try {
				const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
				const status = subscribe ? await client.subscribeThread(targetId) : await client.unsubscribeThread(targetId);
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				applySubscribed(adaptPleromaStatus(status).threadSubscribed);
				flashPostControl(subscribe ? 'Subscribed to thread' : 'Unsubscribed from thread');
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				applySubscribed(!subscribe); // revert
				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}
				// The daemon returns 422 (code:'unreachable_author') when there's no
				// key path to the thread author yet — surface it distinctly.
				flashPostControl(
					normalized.status === 422
						? "Can't reach the thread author yet"
						: `${subscribe ? 'Subscribe' : 'Unsubscribe'} failed: ${normalized.title}`
				);
			}
		})();
	};
	const handleManageAction = (post: RebuildPost, key: string, originRoute: StatusActionOrigin): boolean => {
		if (key === 'subscribe' || key === 'unsubscribe') {
			const targetId = statusActionTargetId(post);
			if (targetId) mutateThreadSubscription(targetId, key === 'subscribe');
			return true;
		}
		if (key === 'bookmark') {
			const targetId = statusActionTargetId(post);
			if (targetId) mutateBookmark(targetId, post.bookmarked === true, originRoute);
			return true;
		}
		if (key === 'copy-link') {
			void copyPostLink(post);
			return true;
		}
		if (key === 'delete') {
			const targetId = statusActionTargetId(post);
			if (targetId && post.own) deleteStatusEverywhere(targetId, originRoute);
			return true;
		}
		if (key === 'mute' || key === 'block') {
			if (post.authorId && post.authorHandle) mutateAuthorRelationship(post.authorId, post.authorHandle, key);
			return true;
		}
		return false;
	};
	const openThread = (post: { id: string | number; actionStatusId?: string; threadStatusId?: string }) => {
		const statusId = post.threadStatusId ?? post.actionStatusId ?? String(post.id);
		goto(`/app/thread/${encodeURIComponent(statusId)}`);
	};
	const route = $derived<AppRoute>(
		page.url.pathname.startsWith('/app/search') ? 'search' :
		page.url.pathname.startsWith('/app/explore') ? 'explore' :
		page.url.pathname.startsWith('/app/settings') ? 'settings' :
		page.url.pathname.startsWith('/app/public') ? 'public' :
		page.url.pathname.startsWith('/app/thread') ? 'thread' :
		page.url.pathname.startsWith('/app/profiles') ? 'profile' :
		page.url.pathname.startsWith('/app/notifications') ? 'notifications' :
		page.url.pathname.startsWith('/app/bookmarks') ? 'bookmarks' :
		page.url.pathname.startsWith('/app/messages') ? 'messages' :
		'home'
	);
	const searchShell = $derived(route === 'search');
	const messagesChatId = $derived(route === 'messages' ? page.url.pathname.split('/')[3] || null : null);
	const activeChat = $derived(messagesChatId && chatsState.status === 'success' ? chatsState.data.find((chat) => chat.id === messagesChatId) ?? null : null);
	const bookmarksPosts = $derived(bookmarksState.status === 'success' ? bookmarksState.data.map(postForRebuild) : []);
	const threadStatusId = $derived(route === 'thread' ? decodeURIComponent(page.url.pathname.split('/').filter(Boolean).slice(2).join('/') || '') : '');
	const profileRouteHandle = $derived(route === 'profile' ? decodeURIComponent(page.url.pathname.split('/').filter(Boolean).slice(2).join('/') || '') : '');
	const searchQuery = $derived(route === 'search' ? (page.url.searchParams.get('q') ?? '').trim() : '');
	const searchTab = $derived<SearchTab>(
		page.url.searchParams.get('tab') === 'people' ? 'people' :
		page.url.searchParams.get('tab') === 'posts' ? 'posts' :
		'all'
	);
	const COMPOSER_VISIBILITIES: Array<{ value: StatusVisibility; label: string; icon: IconName; description: string }> = [
		{ value: 'public', label: 'Public', icon: 'globe', description: 'Visible to everyone, shown on public timelines.' },
		{ value: 'unlisted', label: 'Unlisted', icon: 'planet', description: 'Visible to everyone, kept off public timelines.' },
		{ value: 'private', label: 'Followers', icon: 'users', description: 'Only your followers can see this post.' },
		{ value: 'direct', label: 'Direct', icon: 'msg', description: 'Only people mentioned in the post can see it.' }
	];
	const composerVisibilityOption = $derived(COMPOSER_VISIBILITIES.find((option) => option.value === composerVisibility) ?? COMPOSER_VISIBILITIES[0]);
	const selectComposerVisibility = (value: StatusVisibility) => {
		composerVisibility = value;
		composerPrivacyOpen = false;
		composerPrivacyTrigger?.focus();
	};
	const composerRemaining = $derived(composerCharacterLimit - composerText.length);
	const inlineReplyRemaining = $derived(composerCharacterLimit - inlineReplyDraft.length);
	const preparedComposerPoll = $derived(composerPoll ? composerPollPayload(composerPoll) : undefined);
	const preparedInlineReplyPoll = $derived(inlineReplyPoll ? composerPollPayload(inlineReplyPoll) : undefined);
	const composerUploadedMediaIds = $derived(getComposerUploadedMediaIds(composerUploads));
	const composerUploadsPending = $derived(hasComposerUploadsPending(composerUploads));
	const inlineReplyUploadedMediaIds = $derived(getComposerUploadedMediaIds(inlineReplyUploads));
	const inlineReplyUploadsPending = $derived(hasComposerUploadsPending(inlineReplyUploads));
	const composerHasPostContent = $derived(Boolean(composerText.trim()) || composerUploadedMediaIds.length > 0);
	const composerHasDirectRecipient = $derived(composerVisibility !== 'direct' || hasComposerAddressMention(composerText));
	const canSubmitHomePost = $derived(composerHasPostContent && composerHasDirectRecipient && composerRemaining >= 0 && (!composerPoll || Boolean(preparedComposerPoll)) && !composerUploadsPending && homePostSubmitState !== 'submitting');
	const timelinePosts = $derived([
		...localHomePosts,
		...(homeTimelineState.status === 'success' ? homeTimelineState.data.map(postForRebuild) : [])
	]);
	const profileBioCount = $derived(`${profile.bio.length} / 160`);
	const settingsAvatarUrl = $derived(currentSession?.account?.avatar ?? null);
	const settingsHeaderUrl = $derived(currentSession?.account?.header ?? null);
	const threadReplyPosts = $derived(threadState.status === 'success' ? threadState.replies : []);
	const threadReplyCount = $derived(threadState.status === 'success' ? threadPostCount(threadState.replies) : 0);
	const sortedThreadReplyPosts = $derived(replySort === 'newest' ? [...threadReplyPosts].reverse() : threadReplyPosts);
	const exploreFeedText = $derived(
		exploreFeed === 'popular' ? 'Popular across friendly instances' :
		exploreFeed === 'new' ? 'Fresh instance dispatches' :
		'Most replied threads'
	);
	const searchAccounts = $derived(searchState.status === 'success' ? searchState.accounts : []);
	const searchPosts = $derived(searchState.status === 'success' ? searchState.posts : []);
	const visibleSearchAccounts = $derived(searchTab === 'posts' ? [] : searchTab === 'all' ? searchAccounts.slice(0, 2) : searchAccounts);
	const visibleSearchPosts = $derived(searchTab === 'people' ? [] : searchPosts);
	const searchResultTotal = $derived(searchAccounts.length + searchPosts.length);
	const visibleSearchResultTotal = $derived(visibleSearchAccounts.length + visibleSearchPosts.length);
	const headerSearchAccounts = $derived(headerSearchState.status === 'success' ? headerSearchState.accounts.slice(0, 3) : []);
	const headerSearchPosts = $derived(headerSearchState.status === 'success' ? headerSearchState.posts.slice(0, 3) : []);
	const headerSearchResultTotal = $derived(headerSearchState.status === 'success' ? headerSearchState.accounts.length + headerSearchState.posts.length : 0);
	const headerSearchSelectableItems = $derived<HeaderSearchSelectableItem[]>(
		!headerSearchDraft.trim()
			? searchRecents.map((query) => ({ kind: 'recent', query }))
			: [
				...headerSearchAccounts.map((account) => ({ kind: 'account' as const, account })),
				...headerSearchPosts.map((post) => ({ kind: 'post' as const, post }))
			]
	);
	const headerSearchActiveDescendant = $derived(headerSearchSelectedIndex >= 0 && headerSearchSelectableItems[headerSearchSelectedIndex] ? `header-search-option-${headerSearchSelectedIndex}` : undefined);
	const placeholderHeading = $derived(
		route === 'public' ? 'Public timeline' :
		route === 'thread' ? 'Thread' :
		route === 'profile' ? 'quiet admin' :
		route === 'notifications' ? 'Notifications' :
		''
	);

	const isActive = (item: NavItem) => item.route === route;
	const isTimelineRoute = (value: AppRoute) => timelineRoutes.includes(value);
	const numberFormatter = new Intl.NumberFormat('en-US');
	const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
	const compactString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
	const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');
	const nonNegativeInteger = (value: unknown) => {
		const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
		return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
	};
	const positiveInteger = (value: unknown) => {
		const parsed = nonNegativeInteger(value);
		return parsed && parsed > 0 ? parsed : null;
	};
	const explicitStatusCharacterLimit = (instance: PleromaInstance) => {
		const configuration = isRecord(instance.configuration) ? instance.configuration : null;
		const statuses = isRecord(configuration?.statuses) ? configuration.statuses : null;
		const pleroma = isRecord(instance.pleroma) ? instance.pleroma : null;
		const metadata = isRecord(pleroma?.metadata) ? pleroma.metadata : null;

		return positiveInteger(statuses?.max_characters)
			?? positiveInteger(instance.max_toot_chars)
			?? positiveInteger(metadata?.max_toot_chars);
	};
	const trendUses = (tag: PleromaTag) => (tag.history ?? []).reduce((total, history) => total + (positiveInteger(history.uses) ?? 0), 0);
	const adaptTrendTags = (tags: PleromaTag[]): TrendView[] => tags
		.map((tag) => {
			const name = compactString(tag.name);
			return name ? { tag, name } : null;
		})
		.filter((tag): tag is { tag: PleromaTag; name: string } => Boolean(tag))
		.map(({ tag, name }, index) => {
			const uses = trendUses(tag);
			return {
				rank: index + 1,
				tag: `#${name.replace(/^#/, '')}`,
				count: uses > 0 ? `${numberFormatter.format(uses)} ${uses === 1 ? 'post' : 'posts'}` : null
			};
		});
	const instanceFeatures = (instance: PleromaInstance) => {
		const pleroma = isRecord(instance.pleroma) ? instance.pleroma : null;
		const metadata = isRecord(pleroma?.metadata) ? pleroma.metadata : null;
		const features = metadata?.features;

		return Array.isArray(features) ? features.filter((feature) => typeof feature === 'string' && feature.trim()).length : 0;
	};
	const updateProfile = <Key extends keyof ProfileSettings>(key: Key, value: ProfileSettings[Key]) => {
		profile = { ...profile, [key]: value };
		settingsSaveState = 'Unsaved changes';
	};
	const clearPendingProfileImage = (kind: 'avatar' | 'header') => {
		if (kind === 'avatar') {
			if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
			pendingAvatarFile = null;
			pendingAvatarPreview = null;
		} else {
			if (pendingHeaderPreview) URL.revokeObjectURL(pendingHeaderPreview);
			pendingHeaderFile = null;
			pendingHeaderPreview = null;
		}
	};
	const pickProfileImage = (kind: 'avatar' | 'header') =>
		(kind === 'avatar' ? avatarFileInput : headerFileInput)?.click();
	const handleProfileImageChange = (kind: 'avatar' | 'header', event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		input.value = '';
		if (!file || file.size === 0) return;
		if (file.size > COMPOSER_MAX_UPLOAD_BYTES) {
			flashPostControl(`Could not attach ${file.name} · 40 MB limit per file.`);
			return;
		}
		const preview = URL.createObjectURL(file);
		if (kind === 'avatar') {
			if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
			pendingAvatarFile = file;
			pendingAvatarPreview = preview;
		} else {
			if (pendingHeaderPreview) URL.revokeObjectURL(pendingHeaderPreview);
			pendingHeaderFile = file;
			pendingHeaderPreview = preview;
		}
		settingsSaveState = 'Unsaved changes';
	};
	// Avatar/header URLs are stable per contact id, so an in-place src swap to
	// the same URL wouldn't repaint after an upload. Append a cache-busting
	// query param so the freshly uploaded image actually shows.
	const cacheBustAccountImages = (account: PleromaAccount): PleromaAccount => {
		if (!pendingAvatarFile && !pendingHeaderFile) return account;
		const bust = (url: string) => {
			if (!url) return url;
			const separator = url.includes('?') ? '&' : '?';
			return `${url}${separator}_cb=${Date.now()}`;
		};
		const next: PleromaAccount = { ...account };
		if (pendingAvatarFile) {
			next.avatar = bust(account.avatar);
			next.avatar_static = bust(account.avatar_static);
		}
		if (pendingHeaderFile) {
			next.header = bust(account.header);
			next.header_static = bust(account.header_static);
		}
		return next;
	};
	const populateSettingsFromAccount = (account: PleromaAccount) => {
		const next = profileSettingsFromAccount(account);
		const pristine = untrack(() => settingsSaveState === 'Saved' || settingsSaveState === 'Saved just now');
		savedProfile = next;
		if (pristine) profile = { ...next };
	};
	const saveProfile = async () => {
		const session = currentSession;
		if (!session || settingsSaveState === 'Saving…') return;

		const requestSessionKey = sessionKey(session);
		const requestId = ++settingsSaveRequestId;
		settingsSaveState = 'Saving…';
		settingsSaveError = null;

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const rawAccount = await client.updateAccountProfile(
				profileUpdateFromSettings(profile, session.account),
				{ avatar: pendingAvatarFile, header: pendingHeaderFile }
			);
			if (requestId !== settingsSaveRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const account = cacheBustAccountImages(rawAccount);
			clearPendingProfileImage('avatar');
			clearPendingProfileImage('header');
			upsertAccountCache([account]);
			const nextSession = { ...session, account };
			currentSession = nextSession;
			writePleromaSession(localStorage, nextSession);
			savedProfile = profileSettingsFromAccount(account);
			profile = { ...savedProfile };
			settingsSaveState = 'Saved just now';
		} catch (error) {
			if (requestId !== settingsSaveRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			settingsSaveError = normalized;
			settingsSaveState = 'Unsaved changes';
		}
	};
	const resetProfile = () => {
		profile = { ...savedProfile };
		clearPendingProfileImage('avatar');
		clearPendingProfileImage('header');
		settingsSaveState = 'Saved';
		settingsSaveError = null;
	};
	$effect(() => {
		const account = currentSession?.account;
		if (account) populateSettingsFromAccount(account);
	});
	const queueUploadFiles = (files: FileList | File[], uploads: ComposerUpload[], updateUploads: (updater: (uploads: ComposerUpload[]) => ComposerUpload[]) => void, isStillCurrent: () => boolean = () => true) => {
		const session = currentSession;
		if (!session) return;
		const incoming = Array.from(files).filter((file) => file.size > 0);
		const usedSlots = uploads.filter((upload) => upload.status !== 'error').length;
		const slots = Math.max(0, COMPOSER_MAX_UPLOADS - usedSlots);
		const rejected: ComposerUpload[] = [];
		const accepted: File[] = [];
		for (const file of incoming) {
			if (!isComposerUploadType(file)) rejected.push(composerUploadError(file, `Could not attach ${file.name} · only photos, audio, and video.`));
			else if (file.size > COMPOSER_MAX_UPLOAD_BYTES) rejected.push(composerUploadError(file, `Could not attach ${file.name} · 40 MB limit per file.`));
			else if (accepted.length >= slots) rejected.push(composerUploadError(file, `Could not attach ${file.name} · 8 file limit.`));
			else accepted.push(file);
		}
		if (rejected.length > 0) updateUploads((current) => [...current, ...rejected]);
		if (accepted.length === 0) return;
		const requestSessionKey = sessionKey(session);
		const additions = accepted.map((file, index): ComposerUpload => ({
			localId: `${Date.now()}-${index}-${file.name}`,
			name: file.name,
			kind: composerUploadKind(file),
			progress: 5,
			status: 'uploading'
		}));
		updateUploads((current) => [...current, ...additions]);
		void accepted.forEach((file, index) => {
			const localId = additions[index].localId;
			void (async () => {
				try {
					const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
					const media = await client.uploadMedia(file);
					if (!isCurrentSessionRequest(requestSessionKey) || !isStillCurrent()) return;
					updateUploads((current) => current.map((upload) => upload.localId === localId ? { localId: upload.localId, name: upload.name, kind: upload.kind, progress: 100, status: 'uploaded', media } : upload));
				} catch (error) {
					if (!isCurrentSessionRequest(requestSessionKey) || !isStillCurrent()) return;
					const normalized = normalizePleromaRequestError(error);
					updateUploads((current) => current.map((upload) => upload.localId === localId ? { localId: upload.localId, name: upload.name, kind: upload.kind, progress: 0, status: 'error', error: normalized.message } : upload));
				}
			})();
		});
	};
	const updateComposerUploads = (updater: (uploads: ComposerUpload[]) => ComposerUpload[]) => {
		composerUploads = updater(composerUploads);
	};
	const updateInlineReplyUploads = (updater: (uploads: ComposerUpload[]) => ComposerUpload[]) => {
		inlineReplyUploads = updater(inlineReplyUploads);
	};
	const queueComposerFiles = (files: FileList | File[]) => queueUploadFiles(files, composerUploads, updateComposerUploads);
	const queueInlineReplyFiles = (files: FileList | File[]) => {
		const target = inlineReplyTarget;
		if (!target) return;
		const targetRequestId = inlineReplyRequestId;
		queueUploadFiles(files, inlineReplyUploads, updateInlineReplyUploads, () => inlineReplyRequestId === targetRequestId && inlineReplyTarget?.targetId === target.targetId && inlineReplyTarget?.route === target.route);
	};
	const removeComposerUpload = (localId: string) => {
		composerUploads = composerUploads.filter((upload) => upload.localId !== localId);
	};
	const removeInlineReplyUpload = (localId: string) => {
		inlineReplyUploads = inlineReplyUploads.filter((upload) => upload.localId !== localId);
	};
	const saveUploadAltText = (getUploads: () => ComposerUpload[], updateUploads: (updater: (uploads: ComposerUpload[]) => ComposerUpload[]) => void, localId: string, description: string) => {
		const session = currentSession;
		const upload = getUploads().find((candidate) => candidate.localId === localId);
		if (!session || !upload || upload.status !== 'uploaded' || !upload.media.id) return;
		if ((upload.media.description ?? '') === description) return;
		const requestSessionKey = sessionKey(session);
		void (async () => {
			try {
				const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
				const media = await client.updateMedia(String(upload.media.id), { description });
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				updateUploads((current) => current.map((candidate) => candidate.localId === localId && candidate.status === 'uploaded' ? { ...candidate, media } : candidate));
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}
				flashPostControl(`Alt text failed: ${normalized.title}`);
			}
		})();
	};
	const saveComposerUploadAlt = (localId: string, description: string) => saveUploadAltText(() => composerUploads, updateComposerUploads, localId, description);
	const saveInlineReplyUploadAlt = (localId: string, description: string) => saveUploadAltText(() => inlineReplyUploads, updateInlineReplyUploads, localId, description);
	const pickComposerFiles = () => composerFileInput?.click();
	const handleComposerFileChange = (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		if (input.files) queueComposerFiles(input.files);
		input.value = '';
	};
	const hasFileDrag = (event: DragEvent) => Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'));
	const resetComposerDrag = () => {
		composerDragActive = false;
		composerDragDepth = 0;
	};
	const handleComposerDragEnter = (event: DragEvent) => {
		if (!hasFileDrag(event)) return;
		event.preventDefault();
		composerDragDepth += 1;
		composerDragActive = true;
	};
	const handleComposerDragOver = (event: DragEvent) => {
		if (!hasFileDrag(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		composerDragActive = true;
	};
	const handleComposerDragLeave = () => {
		composerDragDepth = Math.max(0, composerDragDepth - 1);
		if (composerDragDepth > 0) return;
		resetComposerDrag();
	};
	const handleComposerDrop = (event: DragEvent) => {
		if (!event.dataTransfer?.files.length) return;
		event.preventDefault();
		resetComposerDrag();
		queueComposerFiles(event.dataTransfer.files);
	};
	const handleComposerPaste = (event: ClipboardEvent) => {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		queueComposerFiles(files);
	};
	const toggleCommunity = (community: string) => {
		joinedCommunities = { ...joinedCommunities, [community]: !joinedCommunities[community] };
	};
	const resetHomeComposer = () => {
		composerText = '';
		composerSpoilerActive = false;
		composerSpoilerText = '';
		composerPoll = null;
		composerUploads = [];
	};
	const submitHomePost = async () => {
		const body = composerText.trim();
		const spoilerText = composerSpoilerActive ? composerSpoilerText.trim() : '';
		const pollPayload = composerPoll ? preparedComposerPoll : undefined;
		const poll = pollPayload ?? undefined;
		const session = currentSession;
		if ((!body && composerUploadedMediaIds.length === 0) || (composerVisibility === 'direct' && !hasComposerAddressMention(body)) || composerText.length > composerCharacterLimit || (composerPoll && !pollPayload) || composerUploadsPending || homePostSubmitState === 'submitting' || !session) return;

		const requestSessionKey = sessionKey(session);
		const requestId = homePostSubmitRequestId + 1;
		homePostSubmitRequestId = requestId;
		homePostSubmitState = 'submitting';
		homePostSubmitError = null;

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const status = await client.createStatus({ status: body, visibility: composerVisibility, spoilerText: spoilerText || undefined, poll, mediaIds: composerUploadedMediaIds });
			if (requestId !== homePostSubmitRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			upsertAccountCache(accountsFromPleromaStatus(status));
			if (status.visibility === 'direct') {
				resetHomeComposer();
				homePostSubmitState = 'idle';
				await goto(`/app/thread/${encodeURIComponent(status.id)}`);
				return;
			}
			const createdPost = adaptPleromaStatus(status, { timelines: ['home'] });
			homeTimelineFallbackSinceId = String(createdPost.id);
			if (homeTimelineState.status === 'success') {
				homeTimelineState = {
					...homeTimelineState,
					data: prependTimelineItems(homeTimelineState.data, [createdPost]),
					newerPosts: homeTimelineState.newerPosts.filter((post) => post.id !== createdPost.id)
				};
			} else if (homeTimelineState.status === 'empty') {
				homeTimelineState = {
					status: 'success',
					data: [createdPost],
					nextCursor: null,
					loadMoreStatus: 'idle',
					newerPosts: [],
					newPostsStatus: 'idle'
				};
			} else {
				localHomePosts = prependTimelineItems(localHomePosts, [postForRebuild(createdPost)]);
			}
			resetHomeComposer();
			homePostSubmitState = 'idle';
		} catch (error) {
			if (requestId !== homePostSubmitRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			homePostSubmitError = normalized;
			homePostSubmitState = 'idle';
		}
	};
	const clearComposerSpoiler = () => {
		composerSpoilerActive = false;
		composerSpoilerText = '';
	};
	const toggleComposerSpoiler = () => {
		if (composerSpoilerActive) {
			clearComposerSpoiler();
			return;
		}

		composerSpoilerActive = true;
	};
	const toggleComposerPoll = () => {
		composerPoll = composerPoll ? null : createComposerPollDraft();
	};
	// Petnames (meta/issues/petnames.md): save my local name for the viewed
	// contact, then merge ONLY the name fields back into the profile state —
	// the endpoint's account payload carries no relationship, so re-adapting it
	// wholesale would wrongly reset followState.
	// Visibility channels 1B: ask the viewed contact for followers-only access.
	const requestProfileLockedAccess = async () => {
		const session = currentSession;
		if (!session || profileRouteState.status !== 'success' || profileLockedRequestState !== 'idle') return;
		const target = profileRouteState.data.profile;
		profileLockedRequestState = 'pending';
		try {
			await requestDeltanetLockedAccess({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				contactId: target.id,
				fetch: window.fetch.bind(window)
			});
			profileLockedRequestState = 'requested';
		} catch {
			profileLockedRequestState = 'idle';
		}
	};
	const saveProfilePetname = async (petname: string) => {
		const session = currentSession;
		if (!session || profileRouteState.status !== 'success' || profilePetnamePending) return;
		const target = profileRouteState.data.profile;
		profilePetnamePending = true;
		profilePetnameError = null;
		try {
			const account = (await setDeltanetPetname({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				contactId: target.id,
				petname,
				fetch: window.fetch.bind(window)
			})) as { display_name?: unknown; pleroma?: { deltanet?: { auth_name?: unknown; petname?: unknown } } } | null;
			if (profileRouteState.status !== 'success' || profileRouteState.data.profile.id !== target.id) return;
			const deltanet = account?.pleroma?.deltanet ?? {};
			profileRouteState = {
				...profileRouteState,
				data: {
					...profileRouteState.data,
					profile: {
						...target,
						displayName: typeof account?.display_name === 'string' && account.display_name.trim() ? account.display_name : target.displayName,
						authName: typeof deltanet.auth_name === 'string' ? deltanet.auth_name : target.authName,
						petname: typeof deltanet.petname === 'string' ? deltanet.petname : null
					}
				}
			};
		} catch (error) {
			profilePetnameError = error instanceof Error ? error.message : 'Could not save the petname.';
		} finally {
			profilePetnamePending = false;
		}
	};
	const openInlineReply = (post: RebuildPost, targetRoute: StatusActionOrigin) => {
		if (inlineReplySubmitState === 'submitting') return;

		const targetId = statusReplyTargetId(post);
		if (!targetId) return;

		const nextTarget = {
			route: targetRoute,
			targetId,
			renderId: String(post.id),
			handle: inlineReplyTargetHandle(post.handle),
			visibility: post.visibility ?? 'public',
			name: post.name,
			authName: post.authName,
			petname: post.petname,
			avClass: post.avClass,
			avBanner: post.avBanner,
			avatarUrl: post.avatarUrl
		};
		const sameTarget = inlineReplyTarget?.route === nextTarget.route && inlineReplyTarget.targetId === nextTarget.targetId && inlineReplyTarget.renderId === nextTarget.renderId;
		if (sameTarget) {
			clearInlineReply(targetRoute);
			return;
		}

		inlineReplyRequestId += 1;
		inlineReplyTarget = nextTarget;
		inlineReplySubmitState = 'idle';
		inlineReplySubmitError = null;
		inlineReplyDraft = '';
		inlineReplyUploads = [];
		inlineReplySpoilerActive = false;
		inlineReplySpoilerText = '';
		inlineReplyPoll = null;
	};
	const clearInlineReplySpoiler = () => {
		inlineReplySpoilerActive = false;
		inlineReplySpoilerText = '';
	};
	const toggleInlineReplySpoiler = () => {
		if (inlineReplySpoilerActive) {
			clearInlineReplySpoiler();
			return;
		}

		inlineReplySpoilerActive = true;
	};
	const toggleInlineReplyPoll = () => {
		inlineReplyPoll = inlineReplyPoll ? null : createComposerPollDraft();
	};
	const inlineReplyOpenFor = (targetRoute: StatusActionOrigin, post: { id?: string | number }) => inlineReplyTarget?.route === targetRoute && inlineReplyTarget.renderId === String(post.id);
	const inlineReplyComposerId = (targetRoute: StatusActionOrigin, post: { id?: string | number }) => {
		if (post.id == null) return undefined;
		return `${targetRoute}-inline-reply-${String(post.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
	};
	const submitInlineReply = async () => {
		const target = inlineReplyTarget;
		const body = inlineReplyDraft.trim();
		const spoilerText = inlineReplySpoilerActive ? inlineReplySpoilerText.trim() : '';
		const pollPayload = inlineReplyPoll ? preparedInlineReplyPoll : undefined;
		const poll = pollPayload ?? undefined;
		const session = currentSession;
		if (!target || (!body && inlineReplyUploadedMediaIds.length === 0) || inlineReplyRemaining < 0 || (inlineReplyPoll && !pollPayload) || inlineReplyUploadsPending || inlineReplySubmitState === 'submitting' || !session) return;

		const requestSessionKey = sessionKey(session);
		const requestId = inlineReplyRequestId + 1;
		inlineReplyRequestId = requestId;
		inlineReplySubmitState = 'submitting';
		inlineReplySubmitError = null;

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const status = await client.createStatus({ status: body, visibility: target.visibility, inReplyToId: target.targetId, spoilerText: spoilerText || undefined, poll, mediaIds: inlineReplyUploadedMediaIds });
			if (requestId !== inlineReplyRequestId || !isCurrentSessionRequest(requestSessionKey)) return;
			if (!inlineReplyTarget || inlineReplyTarget.route !== target.route || inlineReplyTarget.targetId !== target.targetId) return;

			upsertAccountCache(accountsFromPleromaStatus(status));
			applyReplyCountUpdate(target.targetId);
			if (target.route === 'thread') insertThreadReply(target.targetId, status);
			clearInlineReply();
		} catch (error) {
			if (requestId !== inlineReplyRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			inlineReplySubmitError = normalized;
			inlineReplySubmitState = 'idle';
		}
	};
	const handlePostAction = (clickedPost: RebuildPost, key: string) => {
		if (key.startsWith('reaction:')) {
			handleReactionAction(clickedPost, key, 'home');
			return;
		}
		if (handleManageAction(clickedPost, key, 'home')) return;
		if (key !== 'reply' && key !== 'boost' && key !== 'fav') return;
		if (key === 'reply') {
			openInlineReply(clickedPost, 'home');
			return;
		}

		const targetId = statusActionTargetId(clickedPost);
		if (targetId) mutateStatusAction(targetId, key, rebuildPostActionValue(clickedPost, key), 'home');
	};
	const handleThreadPostAction = (postId: string | number | undefined, key: string) => {
		if (postId == null) return;
		if (key.startsWith('reaction:')) {
			const post = findThreadPost(postId);
			if (post) handleReactionAction(post, key, 'thread');
			return;
		}
		if (key === 'bookmark' || key === 'copy-link' || key === 'delete' || key === 'mute' || key === 'block' || key === 'subscribe' || key === 'unsubscribe') {
			const post = findThreadPost(postId);
			if (post) handleManageAction(post, key, 'thread');
			return;
		}
		if (key !== 'reply' && key !== 'boost' && key !== 'fav') return;
		if (key === 'reply') {
			const post = findThreadPost(postId);
			if (post) openInlineReply(post, 'thread');
			return;
		}
		const post = findThreadPost(postId);
		const targetId = post ? statusActionTargetId(post) : '';
		if (post && targetId) mutateStatusAction(targetId, key, rebuildPostActionValue(post, key), 'thread');
	};
	const handleProfilePostAction = (post: ProfilePost, key: string) => {
		if (key.startsWith('reaction:')) {
			handleReactionAction(post, key, 'profile');
			return;
		}
		if (handleManageAction(post, key, 'profile')) return;
		if (key !== 'reply' && key !== 'boost' && key !== 'fav') return;
		if (key === 'reply') {
			openThread(post);
			return;
		}

		const targetId = statusActionTargetId(post);
		if (targetId) mutateStatusAction(targetId, key, rebuildPostActionValue(post, key), 'profile');
	};
	const closeMobilePanels = () => {
		mobileDrawerOpen = false;
		mobileSheetOpen = false;
	};
	const applyTheme = (theme: ThemeName) => {
		activeTheme = theme;
		document.documentElement.dataset.theme = theme;
		document.body.dataset.theme = theme;
		localStorage.setItem('pn-theme', theme);
	};
	const openUserProfile = () => {
		const account = currentSession?.account;
		userMenuOpen = false;
		if (account) goto(profileHrefForAccount(account));
	};
	const openUserSettings = () => {
		userMenuOpen = false;
		goto('/app/settings');
	};
	const signOutFromUserMenu = () => {
		userMenuOpen = false;
		const session = currentSession ?? readPleromaSession(localStorage);
		closeHomeTimelineStreaming();
		closeNotificationStreaming();
		signOutPleroma(localStorage);
		if (session) removePleromaOAuthClient(localStorage, session.instanceUrl);
		redirectToLanding();
		if (!session) return;

		const revokeController = new AbortController();
		const revokeTimeout = window.setTimeout(() => revokeController.abort(), SIGN_OUT_REVOKE_TIMEOUT_MS);
		void revokeOAuthToken({
			instanceUrl: session.instanceUrl,
			accessToken: session.accessToken,
			signal: revokeController.signal,
			fetch: window.fetch.bind(window)
		})
			.catch(() => undefined)
			.finally(() => window.clearTimeout(revokeTimeout));
	};
	const handleWindowKeydown = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			headerSearchInput?.focus();
			headerSearchInput?.select();
			return;
		}
		if (event.key !== 'Escape') return;
		const restoreUserMenuFocus = userMenuOpen;
		const restorePrivacyFocus = composerPrivacyOpen;
		userMenuOpen = false;
		notificationsMenuOpen = false;
		composerPrivacyOpen = false;
		closeHeaderSearch();
		mobileDrawerOpen = false;
		mobileSheetOpen = false;
		if (restoreUserMenuFocus) userMenuTrigger?.focus();
		if (restorePrivacyFocus) composerPrivacyTrigger?.focus();
	};
	const redirectToLanding = () => {
		invalidateHomeTimelineRequests();
		invalidateThreadRequests();
		invalidateProfileRouteRequests();
		invalidateStatusActionRequests();
		invalidateNotificationRequests();
		invalidateSearchRequests();
		invalidateProfileAccountRequests();
		invalidateTrendsRequests();
		invalidateInstanceConfigRequests();
		invalidateSuggestionsRequests();
		invalidateBookmarksRequests();
		invalidateChatsRequests();
		invalidateInviteRequests();
		invalidateComposerAutocompleteRequests();
		closeHomeTimelineStreaming();
		localHomePosts = [];
		resetAccountCache();
		loadedHomeTimelineKey = '';
		homeTimelineFallbackSinceId = null;
		currentSession = null;
		sessionReady = false;
		goto('/');
	};
	const readSessionOrRedirect = (options: { optional?: boolean } = {}) => {
		const session = readPleromaSession(localStorage);
		if (!session && !options.optional) {
			redirectToLanding();
			return null;
		}

		if (sessionKey(currentSession) !== sessionKey(session)) {
			invalidateHomeTimelineRequests();
			invalidateThreadRequests();
			invalidateProfileRouteRequests();
			invalidateStatusActionRequests();
			invalidateNotificationRequests();
			invalidateSearchRequests();
			invalidateProfileAccountRequests();
			invalidateTrendsRequests();
			invalidateInstanceConfigRequests();
		invalidateSuggestionsRequests();
		invalidateBookmarksRequests();
		invalidateChatsRequests();
		invalidateInviteRequests();
			invalidateComposerAutocompleteRequests();
			closeHomeTimelineStreaming();
			localHomePosts = [];
			resetAccountCache();
			if (session?.account) accountCache = upsertPleromaAccounts(createPleromaAccountCache(), [session.account]);
			loadedHomeTimelineKey = '';
			homeTimelineFallbackSinceId = null;
			currentSession = session;
		}
		sessionReady = true;
		return session;
	};
	const loadProfileAccount = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = profileAccountRequestId + 1;
		profileAccountRequestId = requestId;

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const account = await client.getOwnAccount();
			if (requestId !== profileAccountRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			upsertAccountCache([account]);
			const nextSession = { ...session, account };
			currentSession = nextSession;
			profileAccountLoadError = null;
			writePleromaSession(localStorage, nextSession);
		} catch (error) {
			profileAccountLoadError = normalizePleromaRequestError(error);
			// Profile data is best-effort; authenticated routes can still load with the token.
		}
	};
	const ensureProfileAccount = (session: PleromaSession) => {
		if (session.account) return;

		const requestSessionKey = sessionKey(session);
		if (loadedProfileAccountKey === requestSessionKey) return;

		loadedProfileAccountKey = requestSessionKey;
		void loadProfileAccount(session);
	};
	const loadTrends = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = trendsRequestId + 1;
		trendsRequestId = requestId;
		trendsState = { status: 'loading' };

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const trends = adaptTrendTags(await client.getTrendingTags({ limit: 5 }));
			if (requestId !== trendsRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			trendsState = trends.length > 0 ? { status: 'success', data: trends } : { status: 'empty' };
		} catch (error) {
			if (requestId !== trendsRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			trendsState = { status: 'error', error: normalizePleromaRequestError(error) };
		}
	};
	const ensureTrends = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedTrendsKey === requestSessionKey) return;

		loadedTrendsKey = requestSessionKey;
		void loadTrends(session);
	};
	const loadInstanceConfig = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = instanceConfigRequestId + 1;
		instanceConfigRequestId = requestId;

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const instance = await client.getInstance();
			if (requestId !== instanceConfigRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			composerCharacterLimit = statusCharacterLimit(instance);
		} catch {
			// Character limits are best-effort; keep the conservative default if instance metadata is unavailable.
		}
	};
	const ensureInstanceConfig = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedInstanceConfigKey === requestSessionKey) return;

		loadedInstanceConfigKey = requestSessionKey;
		void loadInstanceConfig(session);
	};
	const suggestionAccountView = (account: PleromaAccount, currentAccountId?: string): SuggestionAccountView => {
		const view = adaptPleromaAccount(account);
		return {
			id: view.id,
			name: view.displayName,
			nameEmojis: view.emojis,
			handle: view.handle,
			avatarUrl: view.avatarUrl,
			followState: followStateFromRelationship(account.pleroma?.relationship, account.id, currentAccountId)
		};
	};
	const loadSuggestions = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = suggestionsRequestId + 1;
		suggestionsRequestId = requestId;
		suggestionsState = { status: 'loading' };

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const entries = await client.getSuggestions();
			if (requestId !== suggestionsRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const currentAccountId = session.account?.id;
			const accounts = entries
				.map((entry) => entry?.account)
				.filter((account): account is PleromaAccount => Boolean(account?.id) && account?.id !== currentAccountId)
				.map((account) => suggestionAccountView(account, currentAccountId));
			upsertAccountCache(entries.map((entry) => entry?.account).filter((account): account is PleromaAccount => Boolean(account?.id)));
			suggestionsState = accounts.length > 0 ? { status: 'success', data: accounts } : { status: 'empty' };
		} catch (error) {
			if (requestId !== suggestionsRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			// Suggestions are optional; the card simply stays hidden when unavailable.
			suggestionsState = { status: 'error', error: normalizePleromaRequestError(error) };
		}
	};
	const ensureSuggestions = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedSuggestionsKey === requestSessionKey) return;

		loadedSuggestionsKey = requestSessionKey;
		void loadSuggestions(session);
	};
	const loadInvite = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = inviteRequestId + 1;
		inviteRequestId = requestId;
		inviteState = { status: 'loading' };

		try {
			const invite = await fetchDeltanetInvite({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			if (requestId !== inviteRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			inviteState = { status: 'success', data: invite };
		} catch (error) {
			if (requestId !== inviteRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			inviteState = { status: 'error', error: normalizePleromaRequestError(error) };
		}
	};
	const ensureInvite = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedInviteKey === requestSessionKey) return;

		loadedInviteKey = requestSessionKey;
		void loadInvite(session);
	};
	const ensureBackupInfo = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedBackupInfoKey === requestSessionKey) return;

		loadedBackupInfoKey = requestSessionKey;
		void (async () => {
			try {
				const info = await fetchDeltanetBackupInfo({
					instanceUrl: session.instanceUrl,
					accessToken: session.accessToken,
					fetch: window.fetch.bind(window)
				});
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				backupInfo = info;
			} catch {
				// The card still renders with an unknown last-backup state.
			}
		})();
	};
	const downloadBackup = async () => {
		const session = currentSession;
		if (!session || !backupPassphrase.trim() || backupBusy) return;

		backupBusy = true;
		backupError = '';
		backupSavedAs = '';
		try {
			const { blob, filename } = await exportDeltanetBackup({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				passphrase: backupPassphrase,
				fetch: window.fetch.bind(window)
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = filename;
			link.click();
			URL.revokeObjectURL(url);
			backupSavedAs = filename;
			backupInfo = { lastBackupAt: Date.now() };
			backupPassphrase = '';
		} catch (error) {
			backupError = error instanceof Error ? error.message : 'Could not export a backup.';
		} finally {
			backupBusy = false;
		}
	};
	const revealLockedInvite = async () => {
		const session = currentSession;
		if (!session || lockedInviteState.status === 'loading') return;
		lockedInviteState = { status: 'loading' };
		try {
			const invite = await fetchDeltanetInvite({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				channel: 'locked',
				fetch: window.fetch.bind(window)
			});
			lockedInviteState = { status: 'success', data: invite };
		} catch (error) {
			lockedInviteState = { status: 'error', error: normalizePleromaRequestError(error) };
		}
	};
	const copyInviteLink = async (invite: string) => {
		try {
			await writeClipboardText(invite);
			flashPostControl('Invite link copied');
		} catch {
			flashPostControl('Copy failed');
		}
	};
	const confirmFollowInvite = async (invite: string) => {
		const session = currentSession;
		if (!session || followInvitePending) return;

		followInvitePending = true;
		try {
			await followDeltanetInvite({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				invite,
				fetch: window.fetch.bind(window)
			});
			flashPostControl('Followed that feed');
			followInviteInput = '';
			headerSearchDraft = '';
			closeHeaderSearch();
		} catch (error) {
			const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : 'Could not follow that feed.';
			flashPostControl(`Could not follow: ${message}`);
		} finally {
			followInvitePending = false;
		}
	};
	const chatClient = (session: PleromaSession) =>
		createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
	const chatExcerpt = (text: string) => (text.length > 160 ? `${text.slice(0, 157).trimEnd()}...` : text);
	const loadChats = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = chatsRequestId + 1;
		chatsRequestId = requestId;
		chatsState = { status: 'loading' };

		try {
			const chats = await chatClient(session).getChats({ limit: 40 });
			if (requestId !== chatsRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const views = adaptPleromaChats(chats, { currentAccountId: session.account?.id });
			chatsState = views.length > 0 ? { status: 'success', data: views } : { status: 'empty' };
		} catch (error) {
			if (requestId !== chatsRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}
			chatsState = { status: 'error', error: normalized };
		}
	};
	const ensureChats = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedChatsKey === requestSessionKey) return;

		loadedChatsKey = requestSessionKey;
		void loadChats(session);
	};
	const markChatThreadRead = async (session: PleromaSession, chatId: string, lastReadId: string) => {
		const requestSessionKey = sessionKey(session);
		try {
			const chat = await chatClient(session).markChatRead(chatId, lastReadId);
			if (!isCurrentSessionRequest(requestSessionKey)) return;
			if (chatsState.status === 'success') {
				const unread = typeof chat.unread === 'number' ? chat.unread : 0;
				chatsState = { ...chatsState, data: chatsState.data.map((row) => (row.id === chatId ? { ...row, unread } : row)) };
			}
		} catch {
			// Read markers are non-critical; the unread badge self-corrects on the next chats load.
		}
	};
	const loadChatThread = async (session: PleromaSession, chatId: string) => {
		const requestSessionKey = sessionKey(session);
		const requestId = chatThreadRequestId + 1;
		chatThreadRequestId = requestId;
		chatThreadState = { status: 'loading' };
		chatSendError = null;

		try {
			const messages = await chatClient(session).getChatMessages(chatId, { limit: 40 });
			if (requestId !== chatThreadRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const views = adaptPleromaChatMessages(messages, { currentAccountId: session.account?.id }).reverse();
			chatThreadState = { status: 'success', data: views };
			const newest = views.at(-1);
			const row = chatsState.status === 'success' ? chatsState.data.find((chat) => chat.id === chatId) : null;
			if (newest && (!row || row.unread > 0)) void markChatThreadRead(session, chatId, newest.id);
		} catch (error) {
			if (requestId !== chatThreadRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}
			chatThreadState = { status: 'error', error: normalized };
		}
	};
	const ensureChatThread = (session: PleromaSession, chatId: string) => {
		const loadKey = `${sessionKey(session)}\n${chatId}`;
		if (loadedChatThreadKey === loadKey) return;

		loadedChatThreadKey = loadKey;
		chatDraft = '';
		chatSending = false;
		chatSendError = null;
		void loadChatThread(session, chatId);
	};
	const sendChatDraft = () => {
		const session = currentSession;
		const chatId = messagesChatId;
		const content = chatDraft.trim();
		if (!session || !chatId || !content || chatSending) return;
		const requestSessionKey = sessionKey(session);
		chatSending = true;
		chatSendError = null;

		void (async () => {
			try {
				const message = await chatClient(session).sendChatMessage(chatId, { content });
				if (!isCurrentSessionRequest(requestSessionKey)) return;

				const view = adaptPleromaChatMessage(message, { currentAccountId: session.account?.id });
				chatThreadState = chatThreadState.status === 'success'
					? { status: 'success', data: [...chatThreadState.data, view] }
					: { status: 'success', data: [view] };
				chatDraft = '';
				if (chatsState.status === 'success') {
					chatsState = {
						...chatsState,
						data: chatsState.data.map((row) => (row.id === chatId ? { ...row, lastMessage: chatExcerpt(view.body), lastMessageOwn: true, time: view.time, updatedAt: view.createdAt } : row))
					};
				}
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;

				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}
				chatSendError = normalized;
			} finally {
				if (isCurrentSessionRequest(requestSessionKey)) chatSending = false;
			}
		})();
	};
	const deleteChatThreadMessage = (messageId: string) => {
		const session = currentSession;
		const chatId = messagesChatId;
		if (!session || !chatId) return;
		const requestSessionKey = sessionKey(session);

		void (async () => {
			try {
				await chatClient(session).deleteChatMessage(chatId, messageId);
				if (!isCurrentSessionRequest(requestSessionKey)) return;
				if (chatThreadState.status === 'success') {
					chatThreadState = { status: 'success', data: chatThreadState.data.filter((message) => message.id !== messageId) };
				}
			} catch (error) {
				if (!isCurrentSessionRequest(requestSessionKey)) return;

				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}
				flashPostControl(`Delete failed: ${normalized.title}`);
			}
		})();
	};
	const loadBookmarks = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = bookmarksRequestId + 1;
		bookmarksRequestId = requestId;
		bookmarksState = { status: 'loading' };

		try {
			const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
			const timelinePage = await client.getBookmarksPage({ limit: 20 });
			if (requestId !== bookmarksRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			upsertAccountCache(accountsFromPleromaStatuses(timelinePage.items));
			const posts = adaptPleromaStatuses(timelinePage.items);
			bookmarksState = posts.length > 0
				? { status: 'success', data: posts, nextCursor: timelinePage.cursors.next, loadMoreStatus: 'idle' }
				: { status: 'empty' };
		} catch (error) {
			if (requestId !== bookmarksRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}
			bookmarksState = { status: 'error', error: normalized };
		}
	};
	const ensureBookmarks = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedBookmarksKey === requestSessionKey) return;

		loadedBookmarksKey = requestSessionKey;
		void loadBookmarks(session);
	};
	const loadMoreBookmarks = async () => {
		const session = currentSession;
		if (!session || bookmarksState.status !== 'success' || !bookmarksState.nextCursor || bookmarksState.loadMoreStatus === 'loading') return;

		const requestSessionKey = sessionKey(session);
		const nextCursor = bookmarksState.nextCursor;
		bookmarksState = { ...bookmarksState, loadMoreStatus: 'loading', loadMoreError: undefined };

		try {
			const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
			const timelinePage = await client.getBookmarksPage({ limit: 20, ...nextCursor });
			if (!isCurrentSessionRequest(requestSessionKey) || bookmarksState.status !== 'success') return;

			upsertAccountCache(accountsFromPleromaStatuses(timelinePage.items));
			bookmarksState = {
				...bookmarksState,
				data: mergeTimelineItems(bookmarksState.data, adaptPleromaStatuses(timelinePage.items)),
				nextCursor: timelinePage.cursors.next,
				loadMoreStatus: 'idle',
				loadMoreError: undefined
			};
		} catch (error) {
			if (!isCurrentSessionRequest(requestSessionKey) || bookmarksState.status !== 'success') return;
			bookmarksState = { ...bookmarksState, loadMoreStatus: 'error', loadMoreError: normalizePleromaRequestError(error) };
		}
	};
	const toggleSuggestionFollow = async (item: { id: string }) => {
		const session = currentSession;
		if (!session || suggestionsState.status !== 'success') return;
		const target = suggestionsState.data.find((entry) => entry.id === item.id);
		if (!target || target.followState === 'self' || target.followState === 'blocked' || suggestionFollowPending[target.id]) return;

		const requestSessionKey = sessionKey(session);
		suggestionFollowPending = { ...suggestionFollowPending, [target.id]: true };
		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const relationship = searchFollowIsFollowing(target.followState)
				? await client.unfollowAccount(target.id)
				: await client.followAccount(target.id);
			if (!isCurrentSessionRequest(requestSessionKey)) return;

			const followState = followStateFromRelationship(relationship, target.id, session.account?.id);
			if (suggestionsState.status === 'success') {
				suggestionsState = { ...suggestionsState, data: suggestionsState.data.map((entry) => entry.id === target.id ? { ...entry, followState } : entry) };
			}
		} catch (error) {
			if (!isCurrentSessionRequest(requestSessionKey)) return;
			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
			}
		} finally {
			if (isCurrentSessionRequest(requestSessionKey)) {
				const { [target.id]: _cleared, ...rest } = suggestionFollowPending;
				suggestionFollowPending = rest;
			}
		}
	};
	const railSuggestions = $derived(suggestionsState.status === 'success' ? suggestionsState.data.map((entry) => ({
		id: entry.id,
		name: entry.name,
		nameEmojis: entry.nameEmojis,
		handle: entry.handle,
		avatarUrl: entry.avatarUrl,
		followLabel: suggestionFollowPending[entry.id] ? 'Working...' : searchFollowLabel(entry.followState),
		followActive: searchFollowIsFollowing(entry.followState),
		followDisabled: entry.followState === 'self' || entry.followState === 'blocked' || Boolean(suggestionFollowPending[entry.id])
	})) : []);
	const composerMentionAccount = (account: PleromaStatus['account']): ComposerMentionAccount => {
		const view = adaptPleromaAccount(account);
		return {
			id: view.id,
			username: view.username,
			displayName: view.displayName,
			authName: view.authName,
			petname: view.petname,
			acct: view.acct,
			avatarUrl: view.avatarUrl,
			avClass: 'av-grad-3'
		};
	};
	const loadComposerCustomEmojis = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = composerCustomEmojiRequestId + 1;
		composerCustomEmojiRequestId = requestId;

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const emojis = (await client.getCustomEmojis())
				.filter((emoji) => emoji.shortcode && emoji.url && emoji.visible_in_picker !== false)
				.map((emoji) => ({
					shortcode: emoji.shortcode,
					url: emoji.url,
					staticUrl: emoji.static_url ?? undefined,
					pack: customEmojiPack(emoji)
				}));
			if (requestId !== composerCustomEmojiRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			composerCustomEmojis = emojis;
		} catch {
			if (requestId !== composerCustomEmojiRequestId || !isCurrentSessionRequest(requestSessionKey)) return;
			composerCustomEmojis = [];
		}
	};
	const ensureComposerCustomEmojis = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		if (loadedComposerCustomEmojiKey === requestSessionKey) return;

		loadedComposerCustomEmojiKey = requestSessionKey;
		void loadComposerCustomEmojis(session);
	};
	const followStateFromRelationship = (relationship: PleromaRelationship | undefined, accountId: string, currentAccountId?: string): PleromaProfileFollowState => {
		if (currentAccountId && accountId === currentAccountId) return 'self';
		if (!relationship) return 'stranger';
		if (relationship.blocking) return 'blocked';
		if (relationship.requested) return 'requested';
		if (relationship.following && relationship.followed_by) return 'mutual';
		if (relationship.following) return 'following';
		return 'stranger';
	};
	const searchPostSnippet = (post: PleromaStatusView) =>
		post.body || mediaPlaceholderText(post.mediaAttachments.map((attachment) => attachment.type), (post.attachments ?? []).some((attachment) => attachment.kind === 'poll'));
	const searchFollowLabel = (followState: PleromaProfileFollowState) => (
		followState === 'self' ? 'You' :
		followState === 'mutual' ? 'Mutuals' :
		followState === 'following' ? 'Following' :
		followState === 'requested' ? 'Requested' :
		followState === 'blocked' ? 'Blocked' :
		'Follow'
	);
	const searchFollowIsFollowing = (followState: PleromaProfileFollowState) => ['following', 'mutual', 'requested'].includes(followState);
	const searchFollowDisabled = (account: SearchAccountView) => account.followState === 'self' || account.followState === 'blocked' || Boolean(searchFollowPending[account.id]);
	const adaptSearchAccount = (account: PleromaAccount, currentAccountId?: string, relationship: PleromaRelationship | undefined = account.pleroma.relationship): SearchAccountView => ({
		...adaptPleromaAccount(account),
		bio: htmlToPlainText(account.note ?? ''),
		followers: account.followers_count,
		posts: account.statuses_count,
		followState: followStateFromRelationship(relationship, account.id, currentAccountId)
	});
	const readSearchRecents = () => {
		try {
			const value = JSON.parse(localStorage.getItem(SEARCH_RECENTS_STORAGE_KEY) ?? '[]') as unknown;
			return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 8) : [];
		} catch {
			return [];
		}
	};
	const writeSearchRecents = (recents: string[]) => {
		searchRecents = recents;
		try {
			localStorage.setItem(SEARCH_RECENTS_STORAGE_KEY, JSON.stringify(recents));
		} catch {
			// Recents are a local convenience; storage failures should not block search.
		}
	};
	const rememberSearch = (query: string) => {
		const q = query.trim();
		if (!q) return;
		writeSearchRecents([q, ...searchRecents.filter((recent) => recent !== q)].slice(0, 8));
	};
	const removeSearchRecent = (query: string) => {
		headerSearchSelectedIndex = -1;
		writeSearchRecents(searchRecents.filter((recent) => recent !== query));
	};
	const clearSearchRecents = () => {
		headerSearchSelectedIndex = -1;
		writeSearchRecents([]);
	};
	const searchResultState = async (session: PleromaSession, query: string) => {
		const client = createPleromaClient({
			instanceUrl: session.instanceUrl,
			accessToken: session.accessToken,
			fetch: window.fetch.bind(window)
		});
		const result = await client.search({ q: query, limit: 20, resolve: true });
		upsertAccountCache([...result.accounts, ...accountsFromPleromaStatuses(result.statuses)]);
		const accountIds = result.accounts.map((account) => account.id);
		const relationshipById = new Map(
			accountIds.length > 0
				? (await client.getAccountRelationships(accountIds)).map((relationship) => [relationship.id, relationship] as const)
				: []
		);
		const currentAccountId = currentSession?.account?.id ?? session.account?.id;
		const accounts = result.accounts.map((account) => adaptSearchAccount(account, currentAccountId, relationshipById.get(account.id)));
		const posts = adaptPleromaStatuses(result.statuses, { timelines: ['home'] });

		return accounts.length + posts.length > 0
			? { status: 'success' as const, query, accounts, posts }
			: { status: 'empty' as const, query };
	};
	const loadSearch = async (session: PleromaSession, query: string) => {
		const q = query.trim();
		if (!q) {
			searchRequestId += 1;
			loadedSearchKey = '';
			searchState = { status: 'idle' };
			return;
		}

		const requestSessionKey = sessionKey(session);
		const requestId = searchRequestId + 1;
		searchRequestId = requestId;
		searchState = { status: 'loading', query: q };

		try {
			const nextState = await searchResultState(session, q);
			if (requestId !== searchRequestId || !isCurrentSessionRequest(requestSessionKey)) return;
			searchState = nextState;
		} catch (error) {
			if (requestId !== searchRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			searchState = { status: 'error', query: q, error: normalized };
		}
	};
	const loadHeaderSearch = async (session: PleromaSession, query: string) => {
		const q = query.trim();
		if (!q) {
			headerSearchRequestId += 1;
			headerSearchState = { status: 'idle' };
			return;
		}

		const requestSessionKey = sessionKey(session);
		const requestId = headerSearchRequestId + 1;
		headerSearchRequestId = requestId;
		headerSearchState = { status: 'loading', query: q };

		try {
			const nextState = await searchResultState(session, q);
			if (requestId !== headerSearchRequestId || !isCurrentSessionRequest(requestSessionKey)) return;
			headerSearchState = nextState;
		} catch (error) {
			if (requestId !== headerSearchRequestId || !isCurrentSessionRequest(requestSessionKey)) return;
			headerSearchState = { status: 'error', query: q, error: normalizePleromaRequestError(error) };
		}
	};
	const ensureSearch = (session: PleromaSession, query: string) => {
		const q = query.trim();
		if (!q) {
			searchRequestId += 1;
			if (searchState.status !== 'idle') searchState = { status: 'idle' };
			loadedSearchKey = '';
			return;
		}

		const requestSessionKey = sessionKey(session);
		const viewerAccountId = currentSession?.account?.id ?? session.account?.id ?? '';
		const loadKey = `${requestSessionKey}\n${viewerAccountId}\n${q}`;
		if (loadedSearchKey === loadKey) return;

		loadedSearchKey = loadKey;
		void loadSearch(session, q);
	};
	const retrySearch = () => {
		if (currentSession && searchQuery) void loadSearch(currentSession, searchQuery);
	};
	const submitHeaderSearch = (event: SubmitEvent) => {
		event.preventDefault();
		if (isFeedInvite(headerSearchDraft)) return;
		rememberSearch(headerSearchDraft);
		closeHeaderSearch();
		submitSearch(headerSearchDraft);
	};
	const submitExploreSearch = (event: SubmitEvent) => {
		event.preventDefault();
		rememberSearch(exploreSearchDraft);
		submitSearch(exploreSearchDraft);
	};
	const submitSearchPage = (event: SubmitEvent) => {
		event.preventDefault();
		clearSearchPageDebounce();
		rememberSearch(searchPageDraft);
		submitSearch(searchPageDraft, searchTab);
	};
	const updateSearchPageDraft = (value: string) => {
		searchPageDraft = value;
		clearSearchPageDebounce();
		searchPageDebounceTimer = window.setTimeout(() => {
			searchPageDebounceTimer = null;
			const q = searchPageDraft.trim();
			goto(q ? searchUrl(q, searchTab) : '/app/search', { replaceState: true });
		}, SEARCH_PAGE_DEBOUNCE_MS);
	};
	const scheduleHeaderSearch = (session: PleromaSession, query: string) => {
		const q = query.trim();
		clearHeaderSearchDebounce();
		headerSearchRequestId += 1;
		headerSearchSelectedIndex = -1;
		if (!q) {
			headerSearchState = { status: 'idle' };
			return;
		}

		headerSearchState = { status: 'loading', query: q };
		headerSearchDebounceTimer = window.setTimeout(() => {
			headerSearchDebounceTimer = null;
			void loadHeaderSearch(session, q);
		}, HEADER_SEARCH_DEBOUNCE_MS);
	};
	const focusHeaderSearch = () => {
		headerSearchOpen = true;
		if (isFeedInvite(headerSearchDraft)) return;
		if (headerSearchDraft.trim() && currentSession) scheduleHeaderSearch(currentSession, headerSearchDraft);
	};
	const updateHeaderSearch = (value: string) => {
		headerSearchDraft = value;
		headerSearchOpen = true;
		headerSearchSelectedIndex = -1;
		const session = currentSession;
		if (isFeedInvite(value)) {
			clearHeaderSearchDebounce();
			headerSearchRequestId += 1;
			headerSearchState = { status: 'idle' };
			return;
		}

		if (!session || !value.trim()) {
			clearHeaderSearchDebounce();
			headerSearchRequestId += 1;
			headerSearchState = { status: 'idle' };
			return;
		}

		scheduleHeaderSearch(session, value);
	};
	const pickSearchRecent = (query: string) => {
		headerSearchDraft = query;
		rememberSearch(query);
		closeHeaderSearch();
		submitSearch(query);
	};
	const openSearchAccount = (account: { acct: string }) => {
		rememberSearch(headerSearchDraft || searchQuery);
		closeHeaderSearch();
		goto(profileHrefForAccount(account));
	};
	const openSearchPost = (post: { id: string | number; actionStatusId?: string; threadStatusId?: string }) => {
		rememberSearch(headerSearchDraft || searchQuery);
		closeHeaderSearch();
		openThread(post);
	};
	const updateSearchAccountFollowState = (accountId: string, followState: PleromaProfileFollowState) => {
		const updateAccount = (account: SearchAccountView) => account.id === accountId ? { ...account, followState } : account;
		if (searchState.status === 'success') {
			searchState = { ...searchState, accounts: searchState.accounts.map(updateAccount) };
		}
		if (headerSearchState.status === 'success') {
			headerSearchState = { ...headerSearchState, accounts: headerSearchState.accounts.map(updateAccount) };
		}
	};
	const setSearchFollowPending = (accountId: string, pending: boolean) => {
		if (pending) {
			searchFollowPending = { ...searchFollowPending, [accountId]: true };
			return;
		}

		const { [accountId]: _cleared, ...rest } = searchFollowPending;
		searchFollowPending = rest;
	};
	const toggleSearchFollow = async (event: MouseEvent, account: SearchAccountView) => {
		event.preventDefault();
		event.stopPropagation();
		const session = currentSession;
		if (!session || searchFollowDisabled(account)) return;

		const requestSessionKey = sessionKey(session);
		setSearchFollowPending(account.id, true);
		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const relationship = searchFollowIsFollowing(account.followState)
				? await client.unfollowAccount(account.id)
				: await client.followAccount(account.id);
			if (!isCurrentSessionRequest(requestSessionKey)) return;
			updateSearchAccountFollowState(account.id, followStateFromRelationship(relationship, account.id, session.account?.id));
		} catch (error) {
			if (!isCurrentSessionRequest(requestSessionKey)) return;
			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
			}
		} finally {
			if (isCurrentSessionRequest(requestSessionKey)) setSearchFollowPending(account.id, false);
		}
	};
	const activateHeaderSearchItem = (item: HeaderSearchSelectableItem) => {
		if (item.kind === 'recent') {
			pickSearchRecent(item.query);
			return;
		}

		if (item.kind === 'account') {
			openSearchAccount(item.account);
			return;
		}

		openSearchPost(item.post);
	};
	const activateHeaderSearchPointerItem = (event: PointerEvent, item: HeaderSearchSelectableItem) => {
		if (event.button !== 0) return;

		event.preventDefault();
		event.stopPropagation();
		headerSearchPointerActivated = true;
		activateHeaderSearchItem(item);
		window.setTimeout(() => (headerSearchPointerActivated = false), 400);
	};
	const activateHeaderSearchClickItem = (event: MouseEvent, item: HeaderSearchSelectableItem) => {
		event.preventDefault();
		event.stopPropagation();
		if (headerSearchPointerActivated) return;

		activateHeaderSearchItem(item);
	};
	const headerSearchRefineText = (item: HeaderSearchSelectableItem) => {
		if (item.kind === 'recent') return item.query;
		if (item.kind === 'account') return item.account.handle;
		return item.post.handle;
	};
	const refineHeaderSearchWithItem = (item: HeaderSearchSelectableItem) => {
		const refined = item.kind === 'recent' ? item.query : `${headerSearchRefineText(item)} `;
		headerSearchDraft = refined;
		headerSearchOpen = true;
		headerSearchSelectedIndex = -1;
		if (currentSession && refined.trim()) scheduleHeaderSearch(currentSession, refined);
		else headerSearchState = { status: 'idle' };
		window.setTimeout(() => {
			headerSearchInput?.focus();
			headerSearchInput?.setSelectionRange(refined.length, refined.length);
		});
	};
	const moveHeaderSearchSelection = (direction: 1 | -1) => {
		const itemCount = headerSearchSelectableItems.length;
		if (itemCount === 0) return;

		headerSearchOpen = true;
		headerSearchSelectedIndex = headerSearchSelectedIndex < 0
			? direction === 1 ? 0 : itemCount - 1
			: (headerSearchSelectedIndex + direction + itemCount) % itemCount;
	};
	const handleHeaderSearchKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeHeaderSearch();
			return;
		}

		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			moveHeaderSearchSelection(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}

		if (event.key !== 'Enter' && event.key !== 'Tab') return;
		if (headerSearchSelectedIndex < 0) return;
		const item = headerSearchSelectableItems[headerSearchSelectedIndex];
		if (!item) return;

		event.preventDefault();
		if (event.key === 'Tab') {
			refineHeaderSearchWithItem(item);
			return;
		}

		activateHeaderSearchItem(item);
	};
	const handleWindowPointerdown = (event: PointerEvent) => {
		const target = event.target;
		if (userMenuOpen && target instanceof Element && !target.closest('.user-chip') && !target.closest('.user-menu')) userMenuOpen = false;
		if (composerPrivacyOpen && target instanceof Element && !target.closest('.composer-privacy-wrap')) composerPrivacyOpen = false;
		if (headerSearchOpen && headerSearchForm && target instanceof Node && !headerSearchForm.contains(target)) closeHeaderSearch();
	};
	const setSearchTab = (tab: SearchTab) => {
		if (!searchQuery) return;
		goto(searchUrl(searchQuery, tab));
	};
	const searchComposerMentionAccounts = (query: string) => {
		const session = currentSession;
		const q = query.trim();
		if (!session || q.length === 0) {
			composerMentionAccounts = [];
			return;
		}
		const requestSessionKey = sessionKey(session);
		const requestId = composerMentionSearchRequestId + 1;
		composerMentionSearchRequestId = requestId;

		void (async () => {
			try {
				const client = createPleromaClient({
					instanceUrl: session.instanceUrl,
					accessToken: session.accessToken,
					fetch: window.fetch.bind(window)
				});
				const accounts = await client.searchAccounts({ q, limit: 5, resolve: true });
				if (requestId !== composerMentionSearchRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

				upsertAccountCache(accounts);
				composerMentionAccounts = accounts.map(composerMentionAccount);
			} catch {
				if (requestId !== composerMentionSearchRequestId || !isCurrentSessionRequest(requestSessionKey)) return;
				composerMentionAccounts = [];
			}
		})();
	};
	const toggleComposerEmojiPicker = (event: MouseEvent) => {
		const session = currentSession;
		if (session) ensureComposerCustomEmojis(session);
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		composerEmojiPickerAnchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
		composerEmojiPickerOpen = !composerEmojiPickerOpen;
	};
	const emojiRecentKey = (item: string | ComposerEmoji) => typeof item === 'string' ? item : item.shortcode;
	const insertComposerEmoji = (item: string | ComposerEmoji) => {
		composerEmojiRecents = [item, ...composerEmojiRecents.filter((recent) => emojiRecentKey(recent) !== emojiRecentKey(item))].slice(0, 12);
		composerInsertRequestId += 1;
		composerInsertRequest = { id: composerInsertRequestId, item };
	};
	const inlineReplyComposerProps = $derived<InlineReplyComposerData | null>(inlineReplyTarget ? {
		targetHandle: inlineReplyTarget.handle,
		targetName: inlineReplyTarget.name,
		targetAuthName: inlineReplyTarget.authName,
		targetPetname: inlineReplyTarget.petname,
		targetAvClass: inlineReplyTarget.avClass,
		targetAvBanner: inlineReplyTarget.avBanner,
		targetAvatarUrl: inlineReplyTarget.avatarUrl,
		draft: inlineReplyDraft,
		remaining: inlineReplyRemaining,
		submitting: inlineReplySubmitState === 'submitting',
		error: inlineReplySubmitError,
		spoilerActive: inlineReplySpoilerActive,
		spoilerText: inlineReplySpoilerText,
		poll: inlineReplyPoll,
		pollValid: Boolean(preparedInlineReplyPoll),
		accounts: composerMentionAccounts,
		emojis: composerCustomEmojis,
		uploads: inlineReplyUploads,
		onMentionQuery: searchComposerMentionAccounts,
		onFiles: queueInlineReplyFiles,
		onRemoveUpload: removeInlineReplyUpload,
		onAltText: saveInlineReplyUploadAlt,
		onSpoilerToggle: toggleInlineReplySpoiler,
		onSpoilerInput: (value: string) => (inlineReplySpoilerText = value),
		onSpoilerRemove: clearInlineReplySpoiler,
		onPollToggle: toggleInlineReplyPoll,
		onPollChange: (poll: ComposerPollDraft) => (inlineReplyPoll = poll),
		onPollRemove: () => (inlineReplyPoll = null),
		onDraftInput: (value: string) => (inlineReplyDraft = value),
		onCancel: () => clearInlineReply(),
		onSubmit: submitInlineReply
	} : null);
	const threadInlineReplyBinding = $derived(inlineReplyComposerProps ? {
		renderId: inlineReplyTarget?.route === 'thread' ? inlineReplyTarget.renderId : null,
		props: inlineReplyComposerProps
	} : null);
	const clearNotificationLoadPromise = (abort = false) => {
		if (abort) notificationAbortController?.abort();
		notificationLoadPromise = null;
		notificationLoadPromiseKey = '';
		notificationLoadStartedAt = 0;
		notificationAbortController = null;
	};
	const notificationTimestamp = (notification: PleromaNotificationView) => {
		const createdMs = notification.createdAt ? Date.parse(notification.createdAt) : Number.NaN;
		return Number.isFinite(createdMs) ? createdMs : notification.t;
	};
	const mergeNotificationViews = (current: PleromaNotificationView[], incoming: PleromaNotificationView[]) => {
		const byId = new Map<string, PleromaNotificationView>();
		for (const notification of current) byId.set(notification.id, notification);
		for (const notification of incoming) {
			const existing = byId.get(notification.id);
			byId.set(notification.id, existing ? { ...existing, ...notification, read: existing.read || notification.read } : notification);
		}

		return Array.from(byId.values()).sort((left, right) => notificationTimestamp(right) - notificationTimestamp(left));
	};
	const adaptNotificationsForSession = (session: PleromaSession, notifications: PleromaNotification[]) => {
		if (!session.account) return [];
		const notificationSession = { instanceUrl: session.instanceUrl, account: session.account };
		const lastSeenAt = readNotificationLastSeenAt(localStorage, notificationSession);
		return adaptPleromaNotifications(notifications, { lastSeenAt });
	};
	const loadNotifications = (session: PleromaSession, options: { background?: boolean } = {}) => {
		if (!session.account) return Promise.resolve();

		const requestSessionKey = sessionKey(session);
		const notificationLoadFresh = Date.now() - notificationLoadStartedAt < NOTIFICATION_POLL_INTERVAL_MS;
		if (notificationLoadPromise && notificationLoadPromiseKey === requestSessionKey && options.background && notificationLoadFresh) return notificationLoadPromise;
		if (notificationLoadPromise) {
			notificationRequestId += 1;
			clearNotificationLoadPromise(true);
		}
		const abortController = new AbortController();
		const requestId = notificationRequestId + 1;
		notificationRequestId = requestId;
		if (!options.background) notificationState = { status: 'loading' };

		const request = (async () => {
			try {
				const client = createPleromaClient({
					instanceUrl: session.instanceUrl,
					accessToken: session.accessToken,
					fetch: window.fetch.bind(window)
				});
				const notifications = await client.getNotifications({ limit: 40 }, { signal: abortController.signal });
				if (requestId !== notificationRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

				upsertAccountCache(accountsFromPleromaNotifications(notifications));
				const adapted = adaptNotificationsForSession(session, notifications);
				const merged = notificationState.status === 'success' ? mergeNotificationViews(notificationState.data, adapted) : adapted;
				notificationState = merged.length > 0 ? { status: 'success', data: merged } : { status: 'empty' };
			} catch (error) {
				if (requestId !== notificationRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

				const normalized = normalizePleromaRequestError(error);
				if (normalized.reauthRequired) {
					signOutPleroma(localStorage);
					redirectToLanding();
					return;
				}

				if (!options.background || notificationState.status !== 'success') notificationState = { status: 'error', error: normalized };
			}
		})().finally(() => {
			if (notificationLoadPromise === request) clearNotificationLoadPromise();
		});

		notificationLoadPromise = request;
		notificationLoadPromiseKey = requestSessionKey;
		notificationLoadStartedAt = Date.now();
		notificationAbortController = abortController;
		return request;
	};
	const ensureNotifications = (session: PleromaSession) => {
		if (!session.account) return;
		const requestSessionKey = sessionKey(session);
		if (loadedNotificationsKey === requestSessionKey) return;

		loadedNotificationsKey = requestSessionKey;
		void loadNotifications(session, { background: true });
	};
	const ensureForegroundNotifications = (session: PleromaSession) => {
		if (!session.account) return;
		const requestSessionKey = sessionKey(session);
		if (loadedForegroundNotificationsKey === requestSessionKey) return;

		loadedNotificationsKey = requestSessionKey;
		loadedForegroundNotificationsKey = requestSessionKey;
		void loadNotifications(session);
	};
	const hasActiveNotificationStream = (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		return notificationStreamReadyKey === requestSessionKey || homeTimelineStreamReadyKey === requestSessionKey;
	};
	const pollNotifications = () => {
		const session = readPleromaSession(localStorage);
		if (!session) {
			invalidateNotificationRequests();
			return;
		}
		if (!session.account) return;
		if (hasActiveNotificationStream(session)) return;

		void loadNotifications(session, { background: true });
	};
	const isStatusActionPending = (targetId: string, key: string) => Boolean(statusActionPending[statusActionPendingKey(targetId, key)]);
	const isReactionActionPending = (targetId: string) => Object.keys(statusActionPending).some((pendingKey) => pendingKey.startsWith(`${targetId}:reaction:`));
	const countBeforeStreamedViewerAction = (count: number, active: boolean) => Math.max(0, count - (active ? 1 : 0));
	const reconcileStreamedNotificationStatus = (status: PleromaStatus) => {
		const targetId = String(status.id);
		const freshFavorite = { active: status.favourited, count: countBeforeStreamedViewerAction(status.favourites_count, status.favourited) };
		const freshBoost = { active: status.reblogged, count: countBeforeStreamedViewerAction(status.reblogs_count, status.reblogged) };
		const freshReactions = adaptStatusReactions(status);
		const favPending = isStatusActionPending(targetId, 'fav');
		const boostPending = isStatusActionPending(targetId, 'boost');
		const reactionPending = isReactionActionPending(targetId);

		applyStatusActionUpdate(
			'all',
			targetId,
			(initial) => {
				const withFav = favPending ? initial : setStatusViewAction(initial, 'fav', freshFavorite);
				const withBoost = boostPending ? withFav : setStatusViewAction(withFav, 'boost', freshBoost);
				return { ...withBoost, replies: status.replies_count, reactions: reactionPending ? withBoost.reactions : freshReactions };
			},
			(initial) => {
				const withFav = favPending ? initial : setRebuildPostAction(initial, 'fav', freshFavorite);
				const withBoost = boostPending ? withFav : setRebuildPostAction(withFav, 'boost', freshBoost);
				return { ...withBoost, replies: status.replies_count, reactions: reactionPending ? withBoost.reactions : freshReactions };
			}
		);
	};
	const applyStreamedNotification = (requestSessionKey: string, notification: PleromaNotification) => {
		const session = currentSession;
		if (!session?.account || !isCurrentSessionRequest(requestSessionKey)) return;

		upsertAccountCache(accountsFromPleromaNotifications([notification]));
		if (notification.status) reconcileStreamedNotificationStatus(notification.status);
		const adapted = adaptNotificationsForSession(session, [notification]);
		const merged = mergeNotificationViews(notificationState.status === 'success' ? notificationState.data : [], adapted);
		notificationState = merged.length > 0 ? { status: 'success', data: merged } : { status: 'empty' };
	};
	const scheduleNotificationStreamReconnect = (session: PleromaSession, requestSessionKey: string) => {
		clearNotificationStreamReconnect();
		notificationStreamReconnectTimer = window.setTimeout(() => {
			notificationStreamReconnectTimer = null;
			if (route === 'home' || !isCurrentSessionRequest(requestSessionKey)) return;
			connectNotificationStreaming(session);
		}, NOTIFICATION_STREAM_RECONNECT_MS);
	};
	const handleNotificationStreamFailure = (session: PleromaSession, requestSessionKey: string) => {
		if (!isCurrentSessionRequest(requestSessionKey) || notificationStreamKey !== requestSessionKey) return;

		closeNotificationStream?.();
		closeNotificationStream = null;
		notificationStreamKey = '';
		notificationStreamReadyKey = '';
		void loadNotifications(session, { background: true });
		if (route !== 'home') scheduleNotificationStreamReconnect(session, requestSessionKey);
	};
	const connectNotificationStreaming = (session: PleromaSession) => {
		if (!session.account || route === 'home') {
			closeNotificationStreaming();
			return;
		}

		const requestSessionKey = sessionKey(session);
		if (notificationStreamKey === requestSessionKey && closeNotificationStream) return;

		closeNotificationStreaming();
		notificationStreamKey = requestSessionKey;
		const stream = openPleromaTimelineStream({
			instanceUrl: session.instanceUrl,
			accessToken: session.accessToken,
			fetch: window.fetch.bind(window),
			onNotification: (notification) => applyStreamedNotification(requestSessionKey, notification),
			onOpen: () => {
				if (notificationStreamKey === requestSessionKey && isCurrentSessionRequest(requestSessionKey)) notificationStreamReadyKey = requestSessionKey;
			},
			onError: () => handleNotificationStreamFailure(session, requestSessionKey),
			onClose: () => handleNotificationStreamFailure(session, requestSessionKey)
		});
		if (notificationStreamKey === requestSessionKey) closeNotificationStream = stream.close;
		else stream.close();
	};
	const latestNotificationCreatedAt = (notifications: SocialNotificationData[]) => notifications.reduce<string | null>((latest, notification) => {
		if (!notification.createdAt) return latest;
		if (!latest || Date.parse(notification.createdAt) > Date.parse(latest)) return notification.createdAt;
		return latest;
	}, null);
	const markNotificationsRead = () => {
		const session = currentSession;
		if (!session?.account || notificationState.status !== 'success') return;
		const notificationSession = { instanceUrl: session.instanceUrl, account: session.account };

		const latest = latestNotificationCreatedAt(notificationState.data);
		if (!latest) return;
		notificationRequestId += 1;
		clearNotificationLoadPromise(true);
		writeNotificationLastSeenAt(localStorage, notificationSession, latest);
		notificationState = {
			...notificationState,
			data: notificationState.data.map((notification) => ({ ...notification, read: true }))
		};
	};
	const openNotification = (notification: SocialNotificationData) => {
		notificationsMenuOpen = false;
		if (notification.target?.route === 'thread') {
			goto(`/app/thread/${encodeURIComponent(notification.target.statusId)}`);
			return;
		}
		if (notification.target?.route === 'profile') {
			goto(`/app/profiles/${encodeURIComponent(notification.target.accountHandle)}`);
		}
	};
	const resolveFollowRequestNotification = async (notification: SocialNotificationData, action: 'accept' | 'reject') => {
		const session = currentSession;
		const accountId = notification.target?.route === 'profile' ? notification.target.accountId : undefined;
		if (!session || !accountId) return;

		const requestSessionKey = sessionKey(session);
		try {
			const client = createPleromaClient({ instanceUrl: session.instanceUrl, accessToken: session.accessToken, fetch: window.fetch.bind(window) });
			const relationship = action === 'accept' ? await client.authorizeFollowRequest(accountId) : await client.rejectFollowRequest(accountId);
			if (!isCurrentSessionRequest(requestSessionKey)) return;

			const cached = getCachedPleromaAccount(accountCache, accountId);
			if (cached) upsertAccountCache([{ ...cached, pleroma: { ...cached.pleroma, relationship } }], { relationship: 'replace' });
			flashPostControl(action === 'accept' ? 'Follow request accepted' : 'Follow request declined');
		} catch (error) {
			if (!isCurrentSessionRequest(requestSessionKey)) return;
			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}
			flashPostControl(`${action === 'accept' ? 'Accept' : 'Decline'} failed: ${normalized.title}`);
			throw error;
		}
	};
	const acceptFollowRequestNotification = (notification: SocialNotificationData) => resolveFollowRequestNotification(notification, 'accept');
	const rejectFollowRequestNotification = (notification: SocialNotificationData) => resolveFollowRequestNotification(notification, 'reject');
	const queueStreamedHomeStatus = (requestSessionKey: string, status: PleromaStatus) => {
		if (!isCurrentSessionRequest(requestSessionKey)) return;

		upsertAccountCache(accountsFromPleromaStatus(status));
		const posts = adaptPleromaStatuses([status], { timelines: ['home'] });
		if (posts.length === 0) return;

		if (homeTimelineState.status === 'success') {
			homeTimelineState = {
				...homeTimelineState,
				newerPosts: queueNewerTimelineItems(homeTimelineState.newerPosts, homeTimelineState.data, posts),
				newPostsStatus: 'idle'
			};
			return;
		}

		if (homeTimelineState.status === 'empty') {
			homeTimelineState = {
				status: 'success',
				data: [],
				nextCursor: null,
				loadMoreStatus: 'idle',
				newerPosts: posts,
				newPostsStatus: 'idle'
			};
		}
	};
	const scheduleHomeTimelineStreamReconnect = (session: PleromaSession, requestSessionKey: string) => {
		clearHomeTimelineStreamReconnect();
		homeTimelineStreamReconnectTimer = window.setTimeout(() => {
			homeTimelineStreamReconnectTimer = null;
			if (route !== 'home' || !isCurrentSessionRequest(requestSessionKey)) return;
			connectHomeTimelineStreaming(session);
		}, HOME_TIMELINE_STREAM_RECONNECT_MS);
	};
	const handleHomeTimelineStreamFailure = (session: PleromaSession, requestSessionKey: string) => {
		if (!isCurrentSessionRequest(requestSessionKey) || homeTimelineStreamKey !== requestSessionKey) return;

		closeHomeTimelineStream?.();
		closeHomeTimelineStream = null;
		homeTimelineStreamKey = '';
		homeTimelineStreamReadyKey = '';
		if (route !== 'home') return;

		if (session.account) void loadNotifications(session, { background: true });
		void checkHomeTimelineForNewPosts();
		scheduleHomeTimelineStreamReconnect(session, requestSessionKey);
	};
	const connectHomeTimelineStreaming = (session: PleromaSession) => {
		if (route !== 'home') return;

		const requestSessionKey = sessionKey(session);
		if (homeTimelineStreamKey === requestSessionKey && closeHomeTimelineStream) return;

		closeHomeTimelineStreaming();
		homeTimelineStreamKey = requestSessionKey;
		const stream = openPleromaTimelineStream({
			instanceUrl: session.instanceUrl,
			accessToken: session.accessToken,
			fetch: window.fetch.bind(window),
			onUpdate: (status) => queueStreamedHomeStatus(requestSessionKey, status),
			onNotification: (notification) => applyStreamedNotification(requestSessionKey, notification),
			onOpen: () => {
				if (homeTimelineStreamKey === requestSessionKey && isCurrentSessionRequest(requestSessionKey)) homeTimelineStreamReadyKey = requestSessionKey;
			},
			onError: () => handleHomeTimelineStreamFailure(session, requestSessionKey),
			onClose: () => handleHomeTimelineStreamFailure(session, requestSessionKey)
		});
		if (homeTimelineStreamKey === requestSessionKey) closeHomeTimelineStream = stream.close;
		else stream.close();
	};
	const loadHomeTimeline = async (session: PleromaSession) => {
		const requestSessionKey = sessionKey(session);
		const requestId = homeTimelineRequestId + 1;
		homeTimelineRequestId = requestId;
		homeTimelineState = { status: 'loading' };

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const timelinePage = await client.getHomeTimelinePage();
			if (route !== 'home' || requestId !== homeTimelineRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			upsertAccountCache(accountsFromPleromaStatuses(timelinePage.items));
			const posts = adaptPleromaStatuses(timelinePage.items, { timelines: ['home'] });
			homeTimelineFallbackSinceId = posts[0]?.id ?? null;
			homeTimelineState = posts.length > 0
				? { status: 'success', data: posts, nextCursor: timelinePage.cursors.next, loadMoreStatus: 'idle', newerPosts: [], newPostsStatus: 'idle' }
				: { status: 'empty' };
			connectHomeTimelineStreaming(session);
		} catch (error) {
			if (requestId !== homeTimelineRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			homeTimelineState = { status: 'error', error: normalized };
		}
	};
	const loadThread = async (session: PleromaSession, statusId: string) => {
		const requestSessionKey = sessionKey(session);
		const requestId = threadRequestId + 1;
		threadRequestId = requestId;

		if (!statusId) {
			threadState = {
				status: 'error',
				error: {
					kind: 'request',
					title: 'Thread unavailable',
					message: 'DeltaNet needs a status id to load a thread.',
					retryable: false,
					reauthRequired: false
				}
			};
			return;
		}

		threadState = { status: 'loading' };

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const [status, context] = await Promise.all([
				client.getStatus(statusId),
				client.getStatusContext(statusId)
			]);
			if (route !== 'thread' || requestId !== threadRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			upsertAccountCache(accountsFromPleromaStatuses([status, ...context.ancestors, ...context.descendants]));
			threadState = {
				status: 'success',
				focused: threadPostForRebuild(adaptPleromaStatus(status)),
				ancestors: adaptPleromaStatuses(context.ancestors).map(threadPostForRebuild),
				replies: threadRepliesForRebuild(status.id, adaptPleromaStatuses(context.descendants))
			};
		} catch (error) {
			if (requestId !== threadRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			threadState = { status: 'error', error: normalized };
		}
	};
	const normalizedProfileHandle = (value: string) => value.replace(/^@/, '').trim().toLowerCase();
	const accountMatchesProfileHandle = (account: PleromaStatus['account'], handle: string) => {
		const normalized = normalizedProfileHandle(handle);
		const acct = normalizedProfileHandle(account.acct);
		const username = normalizedProfileHandle(account.username);
		return normalized === account.id.toLowerCase()
			|| normalized === acct
			|| (!acct.includes('@') && normalized === username);
	};
	const isNumericProfileHandle = (handle: string) => /^\d+$/.test(handle.trim());
	const isAddressProfileHandle = (handle: string) => normalizedProfileHandle(handle).includes('@');
	const resolveProfileAccount = async (client: ReturnType<typeof createPleromaClient>, session: PleromaSession | null, handle: string) => {
		if (session?.account && (!handle || accountMatchesProfileHandle(session.account, handle))) return session.account;
		const cached = getCachedPleromaAccount(accountCache, handle);
		if (cached && accountMatchesProfileHandle(cached, handle)) return cached;
		// The typed form dictates which daemon endpoint can answer: a numeric
		// contact id resolves through `GET /accounts/:id`; an address (raw or
		// `@`-prefixed, percent-decoded by the route) resolves through
		// `GET /accounts/lookup?acct=` (leading `@` tolerated). Address lookup
		// falls back to account search on a miss; only the ambiguous bare-name
		// case starts from search.
		if (isNumericProfileHandle(handle)) return client.getAccount(handle.trim());
		if (isAddressProfileHandle(handle)) {
			try {
				return await client.lookupAccount(handle);
			} catch {
				// Lookup misses fall through to account search below.
			}
		}
		const matches = await client.searchAccounts({ q: handle, limit: 5, resolve: true });
		const exactMatch = matches.find((account) => accountMatchesProfileHandle(account, handle));
		if (exactMatch) return exactMatch;
		try {
			const lookedUp = await client.lookupAccount(handle);
			if (accountMatchesProfileHandle(lookedUp, handle)) return lookedUp;
		} catch {
			// Lookup misses fall through to the direct account fetch.
		}
		const account = await client.getAccount(handle);
		return account;
	};
	const accountWithFetchedRelationship = async (client: ReturnType<typeof createPleromaClient>, account: PleromaAccount, currentAccountId?: string) => {
		if (currentAccountId && account.id === currentAccountId) return account;
		const [relationship] = await client.getAccountRelationships([account.id]);
		if (!relationship) return account;

		return {
			...account,
			pleroma: {
				...account.pleroma,
				relationship
			}
		};
	};
	const setProfileFollowState = (followState: PleromaProfileFollowState) => {
		if (profileRouteState.status !== 'success') return;
		profileRouteState = {
			...profileRouteState,
			data: { ...profileRouteState.data, profile: { ...profileRouteState.data.profile, followState } }
		};
	};
	const toggleProfileFollow = async () => {
		const session = currentSession;
		if (!session || profileRouteState.status !== 'success' || profileFollowPending) return;

		const targetProfile = profileRouteState.data.profile;
		const previous = targetProfile.followState;
		if (previous === 'self' || previous === 'blocked') return;

		const unfollowing = previous === 'following' || previous === 'mutual' || previous === 'requested';
		const optimistic: PleromaProfileFollowState = unfollowing ? 'stranger' : targetProfile.relations.locked ? 'requested' : 'following';
		const requestSessionKey = sessionKey(session);
		profileFollowPending = true;
		profileFollowError = null;
		setProfileFollowState(optimistic);

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const relationship = unfollowing
				? await client.unfollowAccount(targetProfile.id)
				: await client.followAccount(targetProfile.id);
			if (!isCurrentSessionRequest(requestSessionKey)) return;

			setProfileFollowState(followStateFromRelationship(relationship, targetProfile.id, session.account?.id));
			const cached = getCachedPleromaAccount(accountCache, targetProfile.id);
			if (cached) upsertAccountCache([{ ...cached, pleroma: { ...cached.pleroma, relationship } }], { relationship: 'replace' });
		} catch (error) {
			if (!isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			setProfileFollowState(previous);
			profileFollowError = normalized;
		} finally {
			if (isCurrentSessionRequest(requestSessionKey)) profileFollowPending = false;
		}
	};
	const loadProfileRoute = async (session: PleromaSession | null, handle: string) => {
		const requestSessionKey = sessionKey(session);
		const requestId = profileRouteRequestId + 1;
		profileRouteRequestId = requestId;
		profileFollowPending = false;
		profileFollowError = null;

		if (!handle && !session?.account) {
			profileRouteState = {
				status: 'error',
				error: {
					kind: 'request',
					title: 'Profile unavailable',
					message: 'DeltaNet needs an account handle to load a profile.',
					retryable: false,
					reauthRequired: false
				}
			};
			return;
		}

		profileRouteState = { status: 'loading' };
		profileLockedRequestState = 'idle';

		const profileInstanceUrl = session?.instanceUrl ?? publicInstanceUrl;
		try {
			const client = createPleromaClient({
				instanceUrl: profileInstanceUrl,
				accessToken: session?.accessToken,
				fetch: window.fetch.bind(window)
			});
			const resolvedAccount = await resolveProfileAccount(client, session, handle);
			const currentAccountId = currentSession?.account?.id ?? session?.account?.id;
			if (route !== 'profile' || requestId !== profileRouteRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			upsertAccountCache([resolvedAccount]);
			const provisionalProfile = adaptPleromaProfile(resolvedAccount, { instanceUrl: profileInstanceUrl, currentAccountId });
			profileRouteState = { status: 'success', data: emptyProfileData(provisionalProfile), timelineStatus: 'loading' };

			const statusPages = (accountId: string) => Promise.all([
				client.getAccountStatusesPage(accountId, { limit: 20, excludeReplies: true }),
				client.getAccountStatusesPage(accountId, { limit: 20 }),
				client.getAccountStatusesPage(accountId, { limit: 18, onlyMedia: true }),
				client.getAccountStatuses(accountId, { limit: 5, pinned: true })
			]);
			let account = resolvedAccount;
			let postsPage: Awaited<ReturnType<typeof client.getAccountStatusesPage>>;
			let repliesPage: Awaited<ReturnType<typeof client.getAccountStatusesPage>>;
			let mediaPage: Awaited<ReturnType<typeof client.getAccountStatusesPage>>;
			let pinnedStatuses: PleromaStatus[];

			if (resolvedAccount.locked) {
				account = session ? await accountWithFetchedRelationship(client, resolvedAccount, currentAccountId) : resolvedAccount;
				if (route !== 'profile' || requestId !== profileRouteRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

				upsertAccountCache([account], { relationship: 'replace' });
				const profile = adaptPleromaProfile(account, { instanceUrl: profileInstanceUrl, currentAccountId });
				profileRouteState = { status: 'success', data: emptyProfileData(profile), timelineStatus: 'loading' };
				[postsPage, repliesPage, mediaPage, pinnedStatuses] = await statusPages(account.id);
			} else {
				const relationshipPromise = session ? accountWithFetchedRelationship(client, resolvedAccount, currentAccountId) : Promise.resolve(resolvedAccount);
				const statusesPromise = statusPages(resolvedAccount.id);
				account = await relationshipPromise;
				if (route !== 'profile' || requestId !== profileRouteRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

				upsertAccountCache([account], { relationship: 'replace' });
				const profile = adaptPleromaProfile(account, { instanceUrl: profileInstanceUrl, currentAccountId });
				profileRouteState = {
					status: 'success',
					data: profileRouteState.status === 'success'
						? { ...profileRouteState.data, profile }
						: emptyProfileData(profile),
					timelineStatus: 'loading'
				};
				[postsPage, repliesPage, mediaPage, pinnedStatuses] = await statusesPromise;
			}
			if (route !== 'profile' || requestId !== profileRouteRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			upsertAccountCache([account], { relationship: 'replace' });
			const profile = adaptPleromaProfile(account, { instanceUrl: profileInstanceUrl, currentAccountId });
			upsertAccountCache(accountsFromPleromaStatuses([...postsPage.items, ...repliesPage.items, ...mediaPage.items, ...pinnedStatuses]));
			const posts = adaptPleromaStatuses(postsPage.items).map(profilePostForRebuild);
			const replies = adaptPleromaStatuses(repliesPage.items).map(profilePostForRebuild);
			const mediaStatuses = adaptPleromaStatuses(mediaPage.items);
			const pinned = adaptPleromaStatuses(pinnedStatuses).map(profilePostForRebuild);
			profileRouteState = {
				status: 'success',
				data: {
					profile,
					posts,
					replies,
					pinned,
					media: profileMediaItems(mediaStatuses)
				},
				timelineStatus: 'ready'
			};
		} catch (error) {
			if (requestId !== profileRouteRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired && session) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			profileRouteState = { status: 'error', error: normalized };
		}
	};
	const loadMoreHomeTimeline = async () => {
		const session = currentSession;
		if (!session || homeTimelineState.status !== 'success' || !homeTimelineState.nextCursor || homeTimelineState.loadMoreStatus === 'loading') return;

		const requestSessionKey = sessionKey(session);
		const requestId = homeTimelineRequestId + 1;
		homeTimelineRequestId = requestId;
		const nextCursor = homeTimelineState.nextCursor;
		homeTimelineState = { ...homeTimelineState, loadMoreStatus: 'loading', loadMoreError: undefined };

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const timelinePage = await client.getHomeTimelinePage(nextCursor);
			if (requestId !== homeTimelineRequestId || !isCurrentSessionRequest(requestSessionKey) || homeTimelineState.status !== 'success') return;

			upsertAccountCache(accountsFromPleromaStatuses(timelinePage.items));
			const posts = adaptPleromaStatuses(timelinePage.items, { timelines: ['home'] });
			homeTimelineState = {
				...homeTimelineState,
				data: mergeTimelineItems(homeTimelineState.data, posts),
				nextCursor: timelinePage.cursors.next,
				loadMoreStatus: 'idle',
				loadMoreError: undefined
			};
		} catch (error) {
			if (requestId !== homeTimelineRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			if (homeTimelineState.status !== 'success') return;
			homeTimelineState = { ...homeTimelineState, loadMoreStatus: 'error', loadMoreError: normalized };
		}
	};
	const checkHomeTimelineForNewPosts = async () => {
		const session = currentSession;
		if (!session || homeTimelineState.status !== 'success' || homeTimelineState.newPostsStatus === 'checking') return;

		const sinceId = homeTimelineFallbackSinceId;

		const requestSessionKey = sessionKey(session);
		const requestId = homeTimelineNewPostsRequestId + 1;
		homeTimelineNewPostsRequestId = requestId;
		homeTimelineState = { ...homeTimelineState, newPostsStatus: 'checking' };

		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const timelinePage = await client.getHomeTimelinePage(sinceId ? { sinceId } : undefined);
			if (requestId !== homeTimelineNewPostsRequestId || !isCurrentSessionRequest(requestSessionKey) || homeTimelineState.status !== 'success') return;

			upsertAccountCache(accountsFromPleromaStatuses(timelinePage.items));
			const posts = adaptPleromaStatuses(timelinePage.items, { timelines: ['home'] });
			homeTimelineFallbackSinceId = posts[0]?.id ?? homeTimelineFallbackSinceId;
			if (!sinceId && homeTimelineState.newerPosts.length === 0) {
				homeTimelineState = {
					...homeTimelineState,
					data: mergeTimelineItems(posts, homeTimelineState.data),
					nextCursor: timelinePage.cursors.next,
					newPostsStatus: 'idle'
				};
				return;
			}

			homeTimelineState = {
				...homeTimelineState,
				nextCursor: sinceId ? homeTimelineState.nextCursor : timelinePage.cursors.next,
				newerPosts: queueNewerTimelineItems(homeTimelineState.newerPosts, homeTimelineState.data, posts),
				newPostsStatus: 'idle'
			};
		} catch (error) {
			if (requestId !== homeTimelineNewPostsRequestId || !isCurrentSessionRequest(requestSessionKey)) return;

			const normalized = normalizePleromaRequestError(error);
			if (normalized.reauthRequired) {
				signOutPleroma(localStorage);
				redirectToLanding();
				return;
			}

			if (homeTimelineState.status !== 'success') return;
			homeTimelineState = { ...homeTimelineState, newPostsStatus: 'idle' };
		}
	};
	const showNewHomePosts = () => {
		if (homeTimelineState.status !== 'success' || homeTimelineState.newerPosts.length === 0) return;

		homeTimelineState = {
			...homeTimelineState,
			data: prependTimelineItems(homeTimelineState.data, homeTimelineState.newerPosts),
			newerPosts: []
		};
		window.scrollTo(window.scrollX, 0);
	};
	const retryHomeTimeline = () => {
		if (currentSession) void loadHomeTimeline(currentSession);
	};
	const retryThread = () => {
		if (currentSession) void loadThread(currentSession, threadStatusId);
	};
	const retryProfileRoute = () => {
		void loadProfileRoute(currentSession, profileRouteHandle);
	};
	const openNotificationsRoute = () => {
		notificationsMenuOpen = false;
		goto('/app/notifications');
	};
	const toggleNotificationsPopover = () => {
		userMenuOpen = false;
		notificationsMenuOpen = !notificationsMenuOpen;
		if (!notificationsMenuOpen) return;

		const session = currentSession;
		if (!session) return;
		if (session.account) {
			if (notificationState.status === 'idle' || notificationState.status === 'error') void loadNotifications(session);
			else ensureNotifications(session);
			return;
		}

		notificationState = { status: 'loading' };
		ensureProfileAccount(session);
	};
	const retryNotifications = () => {
		if (!currentSession) return;
		if (currentSession.account) {
			void loadNotifications(currentSession);
			return;
		}

		loadedProfileAccountKey = '';
		profileAccountLoadError = null;
		notificationState = { status: 'loading' };
		void loadProfileAccount(currentSession);
	};

	onMount(() => {
		const storedTheme = localStorage.getItem('pn-theme');
		if (storedTheme === 'cream' || storedTheme === 'dusk' || storedTheme === 'drive' || storedTheme === 'simoun') applyTheme(storedTheme);
		searchRecents = readSearchRecents();
		mounted = true;

		const triggerHomeTimelineCheck = () => {
			if (route === 'home') void checkHomeTimelineForNewPosts();
		};
		window.addEventListener(HOME_TIMELINE_CHECK_EVENT, triggerHomeTimelineCheck);
		window.addEventListener(NOTIFICATION_POLL_EVENT, pollNotifications);
		const checkInterval = window.setInterval(triggerHomeTimelineCheck, HOME_TIMELINE_FALLBACK_INTERVAL_MS);
		const notificationInterval = window.setInterval(pollNotifications, NOTIFICATION_POLL_INTERVAL_MS);

		return () => {
			invalidateHomeTimelineRequests();
			invalidateProfileRouteRequests();
			invalidateStatusActionRequests();
			invalidateNotificationRequests();
			invalidateSearchRequests();
			invalidateComposerAutocompleteRequests();
			closeHomeTimelineStreaming();
			window.removeEventListener(HOME_TIMELINE_CHECK_EVENT, triggerHomeTimelineCheck);
			window.removeEventListener(NOTIFICATION_POLL_EVENT, pollNotifications);
			window.clearInterval(checkInterval);
			window.clearInterval(notificationInterval);
		};
	});

	$effect(() => {
		const pathname = page.url.pathname;
		if (!mounted) return;
		if (route === 'search') {
			headerSearchDraft = searchQuery;
			searchPageDraft = searchQuery;
		} else {
			clearSearchPageDebounce();
		}

		const session = readSessionOrRedirect({ optional: route === 'profile' });
		if (!session && route !== 'profile') return;
		if (session) {
			ensureProfileAccount(session);
			if (session.account) {
				if (route === 'notifications') ensureForegroundNotifications(session);
				else ensureNotifications(session);
				connectNotificationStreaming(session);
				ensureChats(session);
				ensureInvite(session);
				if (route === 'messages') {
					const chatId = pathname.split('/')[3] || null;
					if (chatId) ensureChatThread(session, chatId);
				}
			}
			else if (route === 'notifications' && profileAccountLoadError) notificationState = { status: 'error', error: profileAccountLoadError };
			if (isTimelineRoute(route)) {
				ensureInstanceConfig(session);
				ensureTrends(session);
				ensureSuggestions(session);
				ensureComposerCustomEmojis(session);
			}
			if (route === 'search') ensureSearch(session, searchQuery);
			if (route === 'bookmarks') ensureBookmarks(session);
			if (route === 'settings') ensureBackupInfo(session);
			if (route === 'thread' || route === 'profile') ensureComposerCustomEmojis(session);
		}
		if (session && pathname.startsWith('/app/home')) {
			const loadKey = `${sessionKey(session)}\n${pathname}`;
			if (loadedHomeTimelineKey !== loadKey) {
				loadedHomeTimelineKey = loadKey;
				void loadHomeTimeline(session);
			}
		} else {
			clearHomeRouteIfLoaded();
		}
		if (session && pathname.startsWith('/app/thread')) {
			const loadKey = `${sessionKey(session)}\n${threadStatusId}`;
			if (loadedThreadKey !== loadKey) {
				clearInlineReply('thread');
				clearStatusActionErrors('thread');
				expandedThreadReplyIds = {};
				loadedThreadKey = loadKey;
				void loadThread(session, threadStatusId);
			}
		} else {
			clearThreadRouteIfLoaded();
		}
		if (pathname.startsWith('/app/profiles')) {
			const viewerAccountId = currentSession?.account?.id ?? session?.account?.id ?? '';
			const loadKey = `${sessionKey(session)}\n${viewerAccountId}\n${profileRouteHandle}`;
			if (loadedProfileRouteKey !== loadKey) {
				clearStatusActionErrors('profile');
				loadedProfileRouteKey = loadKey;
				void loadProfileRoute(session, profileRouteHandle);
			}
		} else {
			clearProfileRouteIfLoaded();
		}
	});
</script>

<svelte:head>
	<title>DeltaNet · App</title>
</svelte:head>

<svelte:window onkeydown={handleWindowKeydown} onpointerdown={handleWindowPointerdown} />

<AttachmentLightboxHost />

{#if reactionPicker}
	<EmojiPicker open emojis={composerCustomEmojis} recents={composerEmojiRecents} anchor={reactionPicker.anchor} onClose={() => (reactionPicker = null)} onPick={pickPostReaction} />
{/if}

{#if postControlMessage}
	<div class="post-control-toast" role="status" data-testid="post-control-toast">{postControlMessage}</div>
{/if}

{#snippet searchResultsBody()}
	{#if searchState.status === 'idle'}
		<div class="se-empty">
			<h2 class="se-empty-h">Start a search</h2>
			<p class="se-empty-s">Use the field above or the header search box to look up people and posts.</p>
		</div>
	{:else if searchState.status === 'loading'}
		<div class="se-skel" role="status" aria-label="Search status">
			<div class="se-empty-h">Searching “{searchState.query}”</div>
			{#each Array.from({ length: 3 }) as _}
				<div class="se-skel-row" aria-hidden="true">
					<span class="se-skel-av"></span>
					<span>
						<span class="se-skel-line long"></span>
						<span class="se-skel-line mid"></span>
						<span class="se-skel-line short"></span>
					</span>
				</div>
			{/each}
		</div>
	{:else if searchState.status === 'empty'}
		<div class="se-empty" data-testid="search-results">
			<h2 class="se-empty-h">No results for {searchState.query}</h2>
			<p class="se-empty-s">No people or posts matched. Try a shorter query, a handle, or a few words from a post.</p>
		</div>
	{:else if searchState.status === 'error'}
		<div class="se-empty se-error" role="alert">
			<h2 class="se-empty-h">{searchState.error.title}</h2>
			<p class="se-empty-s">{searchState.error.message}</p>
			{#if searchState.error.retryable}
				<Button variant="secondary" onclick={retrySearch}>Retry search</Button>
			{/if}
		</div>
	{:else if visibleSearchResultTotal === 0}
		<div class="se-empty" data-testid="search-results">
			<h2 class="se-empty-h">No {searchTab} results for {searchState.query}</h2>
			<p class="se-empty-s">Switch tabs or widen your query.</p>
		</div>
	{:else if searchState.status === 'success'}
		<div class="se-list" data-testid="search-results">
			{#each visibleSearchAccounts as account (account.id)}
				<div class="se-row se-account-row">
					<a class="se-row-open" href={profileHrefForAccount(account)}>
						<Avatar variant="plain" element="span" className="se-row-av" avatarUrl={account.avatarUrl} alt={`${account.displayName} avatar`} />
						<span class="se-row-main">
							<span class="se-row-head">
								<span class="se-row-name"><RichText text={account.displayName} emojis={account.emojis} linkMentions={false} /></span>
								<span class="se-row-acct">{account.handle}</span>
								{#if account.acct.includes('@')}<span class="se-row-tag user">Remote</span>{/if}
							</span>
							{#if account.bio}<span class="se-row-snippet">{account.bio}</span>{/if}
							<span class="se-row-meta"><span>{compactFormatter.format(account.followers)} followers</span><span>{compactFormatter.format(account.posts)} posts</span></span>
						</span>
					</a>
					<button type="button" class="se-follow-btn" class:is-following={searchFollowIsFollowing(account.followState)} disabled={searchFollowDisabled(account)} onclick={(event) => toggleSearchFollow(event, account)}>{searchFollowPending[account.id] ? 'Working...' : searchFollowLabel(account.followState)}</button>
				</div>
			{/each}
			{#each visibleSearchPosts as post (post.id)}
				<button type="button" class="se-row" onclick={() => openThread(post)}>
					<Avatar variant="plain" element="span" className="se-row-av" avatarUrl={post.avatarUrl} alt={`${post.name} avatar`} />
					<span class="se-row-main">
						<span class="se-row-head">
							<span class="se-row-name"><RichText text={post.name} emojis={post.nameEmojis} linkMentions={false} /></span>
							<span class="se-row-acct">{post.handle}</span>
							<span class="se-row-time">{post.time}</span>
						</span>
						<span class="se-row-snippet"><RichText text={searchPostSnippet(post)} emojis={post.bodyEmojis} mentionClass="post-mention-inline" linkMentions={false} /></span>
						<span class="se-row-meta"><span>↩ {post.replies}</span><span>↻ {post.boosts}</span><span>★ {post.favorites}</span></span>
					</span>
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

{#if sessionReady && !currentSession}
	{#if route === 'profile'}
		<main class="public-route-shell public-profile-shell" data-testid="public-profile-shell">
			<div class="public-profile-wrap">
				<div class="card public-signin-banner">
					<span>You're viewing a public profile.</span>
					<a href="/">Sign in to follow and interact →</a>
				</div>
				{#if profileRouteState.status === 'loading' || profileRouteState.status === 'idle'}
					<div class="card request-state" role="status" aria-label="Request status">Loading profile</div>
				{:else if profileRouteState.status === 'error'}
					<div class="card request-state request-error">
						<h2>{profileRouteState.error.title}</h2>
						<p>{profileRouteState.error.message}</p>
						{#if profileRouteState.error.retryable}
							<Button variant="secondary" onclick={retryProfileRoute}>Retry profile</Button>
						{/if}
					</div>
				{:else}
					<ProfileView
						profile={profileRouteState.data.profile}
						posts={profileRouteState.data.posts}
						replies={profileRouteState.data.replies}
						pinned={profileRouteState.data.pinned}
						media={profileRouteState.data.media}
						timelineLoading={profileRouteState.timelineStatus === 'loading'}
						signedOut
						onSignIn={() => goto('/')}
					/>
				{/if}
				<a class="public-home-link" href="/"><Icon name="arrowL" width={14} height={14} />Back to sign in</a>
			</div>
		</main>
	{/if}
{:else if sessionReady}
	<div class="app-route-shell">
		<header class="app-header" data-testid="app-header">
			<div class="app-header-shell">
				<div class="app-header-inner">
					<div class="app-brand">
						<button type="button" class="menu-btn app-mobile-menu" aria-label="Open navigation menu" onclick={() => (mobileDrawerOpen = true)}>
							<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
						</button>
						<a href="/app/home" class="brand-core" onclick={closeMobilePanels}>
							<span class="brand-mark"><Icon name="sparkBig" /></span>
							<span class="brand-name">DeltaNet<sup>™</sup></span>
						</a>
						<div class="brand-tag" data-testid="brand-tag">A federated<br />social web</div>
					</div>
					<div class="app-header-spacer"></div>
					<div class="app-header-right">
						<form bind:this={headerSearchForm} class="app-search" role="search" onsubmit={submitHeaderSearch} onfocusin={focusHeaderSearch}>
							<Icon name="search" width={14} height={14} />
							<input bind:this={headerSearchInput} value={headerSearchDraft} type="search" role="combobox" aria-label="Search DeltaNet" placeholder="Search..." aria-autocomplete="list" aria-expanded={headerSearchOpen} aria-controls={headerSearchOpen ? 'header-search-dropdown' : undefined} aria-activedescendant={headerSearchActiveDescendant} oninput={(event) => updateHeaderSearch(event.currentTarget.value)} onkeydown={handleHeaderSearchKeydown} />
							<span class="search-kbd">⌘K</span>
							{#if headerSearchOpen}
								<div id="header-search-dropdown" class="se-dropdown" role="listbox" data-testid="header-search-dropdown">
									{#if isFeedInvite(headerSearchDraft)}
										<div class="se-dd-empty">
											<div class="se-dd-empty-h">Feed invite detected</div>
											<div class="se-dd-empty-s">Follow this feed instead of searching for it.</div>
										</div>
										<button type="button" class="se-dd-l-see invite-follow-btn" disabled={followInvitePending} onclick={() => confirmFollowInvite(headerSearchDraft.trim())}>{followInvitePending ? 'Following…' : 'Follow this feed'}</button>
									{:else if !headerSearchDraft.trim()}
										{#if searchRecents.length === 0}
											<div class="se-dd-empty">
												<div class="se-dd-empty-h">Search across DeltaNet</div>
												<div class="se-dd-empty-s">Find people and posts on this instance and across the federation. Hashtags are ignored.</div>
											</div>
										{:else}
											<div class="se-dd-section">
												<div class="se-dd-l"><span>Recent</span><span class="se-dd-l-count">{searchRecents.length}</span><button type="button" class="se-dd-l-see" onclick={clearSearchRecents}>Clear all</button></div>
												{#each searchRecents as recent, i}
													<div id={`header-search-option-${i}`} class="se-recent-row" role="option" aria-selected={headerSearchSelectedIndex === i} class:sel={headerSearchSelectedIndex === i}>
														<button type="button" class="se-recent-pick" onclick={() => pickSearchRecent(recent)}><span class="se-recent-q">{recent}</span></button>
														<button type="button" class="se-recent-x" aria-label={`Remove ${recent} from recent searches`} onclick={() => removeSearchRecent(recent)}>×</button>
													</div>
												{/each}
											</div>
										{/if}
										<div class="se-dd-foot"><span class="se-kbd">↵</span> open · <span class="se-kbd">Esc</span> dismiss<span class="se-dd-foot-r">⌘K from anywhere</span></div>
									{:else if headerSearchState.status === 'loading'}
										<div class="se-dd-empty"><div class="se-dd-empty-h">Searching “{headerSearchState.query}”</div><div class="se-dd-empty-s">Looking through people and posts...</div></div>
									{:else if headerSearchState.status === 'error'}
										<div class="se-dd-empty"><div class="se-dd-empty-h">Search unavailable</div><div class="se-dd-empty-s">{headerSearchState.error.message}</div></div>
									{:else if headerSearchState.status === 'empty' || headerSearchResultTotal === 0}
										<div class="se-dd-empty"><div class="se-dd-empty-h">No matches for “{headerSearchDraft}”</div><div class="se-dd-empty-s">Press ↵ to open the full search and try a wider query.</div></div>
										<div class="se-dd-foot"><span class="se-kbd">↵</span> open · <span class="se-kbd">Esc</span> dismiss</div>
									{:else}
										{#if headerSearchAccounts.length > 0}
											<div class="se-dd-section">
												<div class="se-dd-l"><span>People</span><span class="se-dd-l-count">{headerSearchState.status === 'success' ? headerSearchState.accounts.length : 0}</span><button type="button" class="se-dd-l-see" onclick={() => { rememberSearch(headerSearchDraft); closeHeaderSearch(); submitSearch(headerSearchDraft, 'people'); }}>See all →</button></div>
												{#each headerSearchAccounts as account, i (account.id)}
													<button id={`header-search-option-${i}`} type="button" role="option" aria-selected={headerSearchSelectedIndex === i} class="se-dd-row" class:sel={headerSearchSelectedIndex === i} onpointerdown={(event) => activateHeaderSearchPointerItem(event, { kind: 'account', account })} onclick={(event) => activateHeaderSearchClickItem(event, { kind: 'account', account })}>
														<Avatar variant="plain" element="span" className="se-dd-av" avatarUrl={account.avatarUrl} alt={`${account.displayName} avatar`} />
														<span class="se-dd-user"><span class="se-dd-name"><RichText text={account.displayName} emojis={account.emojis} linkMentions={false} /></span><span class="se-dd-acct">{account.handle}</span></span>
														<span class="se-dd-followers">{compactFormatter.format(account.followers)} followers</span>
													</button>
												{/each}
											</div>
										{/if}
										{#if headerSearchPosts.length > 0}
											<div class="se-dd-section">
												<div class="se-dd-l"><span>Posts</span><span class="se-dd-l-count">{headerSearchState.status === 'success' ? headerSearchState.posts.length : 0}</span><button type="button" class="se-dd-l-see" onclick={() => { rememberSearch(headerSearchDraft); closeHeaderSearch(); submitSearch(headerSearchDraft, 'posts'); }}>See all →</button></div>
												{#each headerSearchPosts as post, i (post.id)}
													<button id={`header-search-option-${headerSearchAccounts.length + i}`} type="button" role="option" aria-selected={headerSearchSelectedIndex === headerSearchAccounts.length + i} class="se-dd-row" class:sel={headerSearchSelectedIndex === headerSearchAccounts.length + i} onpointerdown={(event) => activateHeaderSearchPointerItem(event, { kind: 'post', post })} onclick={(event) => activateHeaderSearchClickItem(event, { kind: 'post', post })}>
														<Avatar variant="plain" element="span" className="se-dd-av" avatarUrl={post.avatarUrl} alt={`${post.name} avatar`} />
														<span class="se-dd-snippet"><RichText text={searchPostSnippet(post)} emojis={post.bodyEmojis} mentionClass="post-mention-inline" linkMentions={false} /></span>
														<span class="se-dd-snippet-meta">{post.time}</span>
													</button>
												{/each}
											</div>
										{/if}
										<div class="se-dd-foot">Showing top results for <span class="se-dd-query">“{headerSearchDraft}”</span><span class="se-dd-foot-r"><span class="se-kbd">↵</span> view all · <span class="se-kbd">Esc</span> dismiss</span></div>
									{/if}
								</div>
							{/if}
						</form>
						<div class="header-notifs">
							<button type="button" class="icon-btn" aria-label={headerNotificationLabel} aria-expanded={notificationsMenuOpen} aria-controls={notificationsMenuOpen ? 'header-notifications-popover' : undefined} data-bell onclick={toggleNotificationsPopover}>
								<Icon name="bell" width={20} height={20} />
								{#if unreadNotificationCount > 0}<span class="badge">{unreadNotificationCount}</span>{/if}
							</button>
							{#if notificationsMenuOpen}
								<div id="header-notifications-popover" class="header-notifs-pop" data-testid="header-notifications-popover">
									<NotifsPopover
										notifications={notificationItems}
										status={notificationPopoverStatus}
										errorTitle={notificationPopoverError?.title}
										errorMessage={notificationPopoverError?.message}
										onClose={() => (notificationsMenuOpen = false)}
										onSeeAll={openNotificationsRoute}
										onMarkAll={markNotificationsRead}
										onOpen={openNotification}
										onAcceptFollowRequest={acceptFollowRequestNotification}
										onRejectFollowRequest={rejectFollowRequestNotification}
									/>
								</div>
							{/if}
						</div>
						<button bind:this={userMenuTrigger} type="button" class="user-chip" aria-label={headerAccountLabel} aria-expanded={userMenuOpen} aria-controls={userMenuOpen ? 'header-user-menu' : undefined} onclick={() => { notificationsMenuOpen = false; userMenuOpen = !userMenuOpen; }}>
							<Avatar variant="plain" element="span" className="user-chip-av" avatarUrl={headerAccountAvatarUrl} alt={`${headerAccountName} avatar`} />
							<span><RichText text={headerAccountName} emojis={headerAccount?.emojis ?? []} /></span>
							<Icon name="chevDown" width={14} height={14} className={userMenuOpen ? 'chev open' : 'chev'} />
						</button>
						{#if userMenuOpen}
							<div id="header-user-menu" class="user-menu" data-testid="user-menu">
								<div class="user-menu-head">
									<Avatar variant="plain" element="span" className="user-menu-av" avatarUrl={headerAccountAvatarUrl} alt={`${headerAccountName} avatar`} />
									<div class="user-menu-head-main">
										<div class="user-menu-name"><RichText text={headerAccountName} emojis={headerAccount?.emojis ?? []} /></div>
										<div class="user-menu-handle">{headerAccountHandle}</div>
									</div>
								</div>
								<div class="user-menu-stats">
									<div class="user-menu-stat"><div class="user-menu-stat-v">{headerAccountPosts}</div><div class="user-menu-stat-l">Posts</div></div>
									<div class="user-menu-stat"><div class="user-menu-stat-v">{headerAccountFollowing}</div><div class="user-menu-stat-l">Following</div></div>
									<div class="user-menu-stat"><div class="user-menu-stat-v">{headerAccountFollowers}</div><div class="user-menu-stat-l">Followers</div></div>
								</div>
								<div class="user-menu-sec">
									<button type="button" class="user-menu-item" disabled={!currentSession?.account} onclick={openUserProfile}><Icon name="users" width={16} height={16} /><span>View profile</span><Icon name="arrowR" width={13} height={13} className="user-menu-arrow" /></button>
									<button type="button" class="user-menu-item" disabled><Icon name="bookmark" width={16} height={16} /><span>Bookmarks</span></button>
									<button type="button" class="user-menu-item" disabled><Icon name="star" width={16} height={16} /><span>Favorites</span></button>
									<button type="button" class="user-menu-item" disabled><Icon name="list" width={16} height={16} /><span>Lists</span></button>
									<button type="button" class="user-menu-item" disabled><Icon name="lock" width={16} height={16} /><span>Drafts &amp; scheduled</span><span class="user-menu-badge">2</span></button>
								</div>
								<div class="user-menu-sec">
									<div class="user-menu-label">Appearance</div>
									<div class="user-menu-themes">
										{#each themeOptions as theme}
											<button type="button" aria-pressed={activeTheme === theme.id} class="user-menu-theme" class:active={activeTheme === theme.id} title={theme.label} onclick={() => applyTheme(theme.id)}>
												<span style={`background: ${theme.grad}`}></span>
												<span>{theme.label}</span>
											</button>
										{/each}
									</div>
								</div>
								<div class="user-menu-sec">
									<button type="button" class="user-menu-item" onclick={openUserSettings}><Icon name="gear" width={16} height={16} /><span>Settings</span><span class="kbd user-menu-kbd">S</span></button>
									<button type="button" class="user-menu-item" disabled><Icon name="info" width={16} height={16} /><span>Keyboard shortcuts</span><span class="kbd user-menu-kbd">?</span></button>
									<button type="button" class="user-menu-item" disabled><Icon name="ext" width={16} height={16} /><span>About this instance</span></button>
								</div>
								<div class="user-menu-sec">
									<button type="button" class="user-menu-item" disabled>
										<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true"><circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 7l3 3-3 3M19 10h-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
										<span>Switch account</span>
									</button>
									<div class="user-menu-label">Next sign-in needs a fresh terminal enrollment code.</div>
									<button type="button" class="user-menu-item user-menu-danger" onclick={signOutFromUserMenu}>
										<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true"><path d="M14 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 8l-4 4 4 4M6 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
										<span>Sign out &amp; forget this browser</span>
									</button>
								</div>
								<div class="user-menu-foot"><span>DeltaNet™</span><span class="user-menu-dot"></span><span>{headerInstanceDomain}</span></div>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</header>

		<div class="app-shell-grid" class:search-grid={searchShell}>
			<aside class="app-left-sidebar" data-testid="left-sidebar">
				<ProfileMini account={currentSession?.account} instanceUrl={currentSession?.instanceUrl} />
				<div class="card rail-card invite-card" data-testid="invite-card">
					<div class="card-head"><span class="card-title">Share your feed</span></div>
					<div class="card-body">
						{#if inviteState.status === 'loading' || inviteState.status === 'idle'}
							<span class="invite-status">Loading your invite link...</span>
						{:else if inviteState.status === 'error'}
							<span class="invite-status">Could not load your invite link.</span>
						{:else if inviteState.status === 'success'}
							<code class="invite-link">{inviteState.data}</code>
							<button type="button" class="btn-ghost invite-copy" onclick={() => copyInviteLink(inviteState.status === 'success' ? inviteState.data : '')}>Copy invite link</button>
						{/if}
						{#if lockedInviteState.status === 'idle'}
							<button type="button" class="btn-ghost invite-copy" data-testid="reveal-locked-invite" onclick={revealLockedInvite}>Show followers-only invite</button>
						{:else if lockedInviteState.status === 'loading'}
							<span class="invite-status">Loading the followers-only invite...</span>
						{:else if lockedInviteState.status === 'error'}
							<span class="invite-status">Could not load the followers-only invite.</span>
						{:else if lockedInviteState.status === 'success'}
							<div class="invite-status" data-testid="locked-invite-note">Followers-only invite — sharing it GRANTS access. Hand it out one-to-one, never publish it.</div>
							<code class="invite-link" data-testid="locked-invite-link">{lockedInviteState.data}</code>
							<button type="button" class="btn-ghost invite-copy" onclick={() => copyInviteLink(lockedInviteState.status === 'success' ? lockedInviteState.data : '')}>Copy followers-only invite</button>
						{/if}
					</div>
				</div>
				<div class="card app-side-card">
					<nav class="side-nav" aria-label="App sections">
						{#each navItems as item}
							<a href={item.href} class:active={isActive(item)} class="side-nav-item">
								<span class="ico"><Icon name={item.icon} width={18} height={18} /></span>
								<span>{item.label}</span>
								{#if item.count}<span class="count">{item.count}</span>{/if}
							</a>
						{/each}
					</nav>
					{#if route === 'settings'}
						<div class="side-sub" data-testid="settings-subnav">
							{#each settingsSubnav as item, i}
								<button type="button" class:active={i === 0} class="side-sub-item">{item}</button>
							{/each}
						</div>
					{:else}
						<div hidden data-testid="settings-subnav"></div>
					{/if}
				</div>
			</aside>

			<main class="app-content" data-testid="app-content">
				{#if route === 'home'}
					<section class="card app-feed-card">
						<div class="tabs timeline-tabs">
							<div class="timeline-tab-list" role="tablist" aria-label="Timeline sections">
								<a href="/app/home" role="tab" aria-selected="true" class="tab active">Home</a>
							</div>
							<span class="tab-spacer"></span>
							<div class="timeline-tab-actions" data-testid="timeline-header-actions">
								{#if homeTimelineState.status === 'success'}
									<TimelineNewPostsIndicator count={homeTimelineState.newerPosts.length} onActivate={showNewHomePosts} />
								{/if}
								<button type="button" class="tab-action" title="Filters"><Icon name="sliders" width={16} height={16} /></button>
							</div>
						</div>

						<form class="composer" class:is-drag-over={composerDragActive} aria-label="Composer" onsubmit={(e) => { e.preventDefault(); submitHomePost(); }} ondragenter={handleComposerDragEnter} ondragover={handleComposerDragOver} ondragleave={handleComposerDragLeave} ondrop={handleComposerDrop} onpaste={handleComposerPaste}>
							<Avatar variant="plain" element="span" className="composer-av" avatarUrl={headerAccountAvatarUrl} alt={`${headerAccountName} avatar`} />
							<div>
								<ComposerMentionEditor
									id="home-composer-editor"
									value={composerText}
									onInput={(value) => (composerText = value)}
									onMentionQuery={searchComposerMentionAccounts}
									accounts={composerMentionAccounts}
									emojis={composerCustomEmojis}
									insertRequest={composerInsertRequest}
									onSubmit={submitHomePost}
								/>
								<input bind:this={composerFileInput} class="sr-only" type="file" multiple tabindex="-1" aria-label="Attach media" accept="image/*,audio/*,video/*" onchange={handleComposerFileChange} />
								{#if composerUploads.length > 0}
									<div class="composer-uploads" aria-live="polite">
										{#each composerUploads as upload (upload.localId)}
											<div class="composer-upload-row" class:error={upload.status === 'error'} title={upload.error}>
												<div class={`composer-upload-thumb ${upload.kind}`}>{composerUploadBadge(upload.kind)}</div>
												<div class="composer-upload-meta">
													<div class="composer-upload-name">{upload.name}</div>
													<div class="composer-upload-prog-row">
														<div class="composer-upload-bar" role="progressbar" aria-label={`Upload progress for ${upload.name}`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={upload.progress}><span style={`width:${upload.progress}%`}></span></div>
														<span class="composer-upload-pct">{upload.status === 'error' ? 'Error' : `${upload.progress}%`}</span>
													</div>
													{#if upload.error}<div class="composer-upload-error">{upload.error}</div>{/if}
													{#if upload.status === 'uploaded'}
														<input class="composer-upload-alt" type="text" placeholder="Alt text (describe for screen readers)" aria-label={`Alt text for ${upload.name}`} value={upload.media.description ?? ''} onchange={(event) => saveComposerUploadAlt(upload.localId, event.currentTarget.value)} />
													{/if}
												</div>
												<button type="button" class="composer-upload-rm" aria-label={`Remove ${upload.name}`} onclick={() => removeComposerUpload(upload.localId)}>×</button>
											</div>
										{/each}
									</div>
								{/if}
								{#if composerSpoilerActive}
									<ComposerCWPanel value={composerSpoilerText} onInput={(value) => (composerSpoilerText = value)} onRemove={clearComposerSpoiler} focusOnMount />
								{/if}
								{#if composerPoll}
									<ComposerPollPanel poll={composerPoll} onPollChange={(poll) => (composerPoll = poll)} onRemove={() => (composerPoll = null)} focusOnMount idPrefix="home-composer-poll" />
								{/if}
								<div class="composer-row">
									<button type="button" class="composer-tool" title="Image" aria-label="Image" onclick={pickComposerFiles}><Icon name="image" width={18} height={18} /></button>
									{#if composerUploads.length > 0}<button type="button" class="composer-tool" title="Add another" aria-label="Add another attachment" onclick={pickComposerFiles}><Icon name="plus" width={14} height={14} /></button>{/if}
									<button type="button" class="composer-tool" class:active={Boolean(composerPoll)} title="Poll" aria-label="Poll" aria-pressed={Boolean(composerPoll)} onclick={toggleComposerPoll}><Icon name="poll" width={18} height={18} /></button>
									<button type="button" class="composer-tool" class:active={composerEmojiPickerOpen} title="Emoji" aria-label="Emoji" aria-pressed={composerEmojiPickerOpen} data-emoji-trigger onclick={toggleComposerEmojiPicker}><Icon name="smile" width={18} height={18} /></button>
									<button type="button" class="composer-tool cw" class:active={composerSpoilerActive} aria-label="Content warning" aria-pressed={composerSpoilerActive} onclick={toggleComposerSpoiler}>CW</button>
									<span class="composer-privacy-wrap">
										<button bind:this={composerPrivacyTrigger} type="button" class="composer-tool privacy" aria-label={`Privacy: ${composerVisibilityOption.label}`} aria-haspopup="menu" aria-expanded={composerPrivacyOpen} onclick={() => (composerPrivacyOpen = !composerPrivacyOpen)}>
											<Icon name={composerVisibilityOption.icon} width={13} height={13} /><span>{composerVisibilityOption.label}</span><Icon name="chevDown" width={12} height={12} className={composerPrivacyOpen ? 'chev open' : 'chev'} />
										</button>
										{#if composerPrivacyOpen}
											<div class="composer-privacy-menu" role="menu" aria-label="Post visibility" data-testid="composer-privacy-menu">
												{#each COMPOSER_VISIBILITIES as option (option.value)}
													<button type="button" role="menuitemradio" aria-checked={composerVisibility === option.value} class="composer-privacy-item" class:selected={composerVisibility === option.value} onclick={() => selectComposerVisibility(option.value)}>
														<Icon name={option.icon} width={14} height={14} />
														<span class="composer-privacy-item-main">
															<span class="composer-privacy-item-label">{option.label}</span>
															<span class="composer-privacy-item-desc">{option.description}</span>
														</span>
													</button>
												{/each}
											</div>
										{/if}
									</span>
									<span class="composer-spacer"></span>
									<span class="composer-count" class:over-limit={composerRemaining < 0}>{composerRemaining}</span>
									<Button variant="primary" disabled={!canSubmitHomePost} onclick={submitHomePost}>{homePostSubmitState === 'submitting' ? 'Posting...' : 'Post'}</Button>
								</div>
								{#if homePostSubmitError}
									<div class="request-state request-error" role="alert">
										<h2>{homePostSubmitError.title}</h2>
										<p>{homePostSubmitError.message}</p>
									</div>
								{/if}
							</div>
							{#if composerDragActive}
								<div class="composer-dropzone" data-testid="composer-dropzone" aria-hidden="true">
									<div class="composer-dropzone-card">
										<Icon name="upload" width={22} height={22} />
										<div class="composer-dropzone-h">Drop to attach</div>
										<div class="composer-dropzone-s">photos · audio · video</div>
										<div class="composer-dropzone-meta">Max 8 files · 40 MB each</div>
									</div>
								</div>
							{/if}
							<EmojiPicker open={composerEmojiPickerOpen} emojis={composerCustomEmojis} recents={composerEmojiRecents} anchor={composerEmojiPickerAnchor} onClose={() => (composerEmojiPickerOpen = false)} onPick={insertComposerEmoji} />
						</form>
						{#each homeStatusActionErrors as actionError (`${actionError.targetId}:${actionError.key}`)}
							<div class="status-action-error" role="alert">
								<strong>{actionError.error.title}</strong>
								<span>{actionError.error.message}</span>
							</div>
						{/each}

						{#if homeTimelineState.status === 'loading'}
							<div class="request-state" role="status" aria-label="Request status">Loading Pleroma data</div>
						{:else if homeTimelineState.status === 'empty'}
							<div class="request-state request-empty">
								<h2>No posts yet</h2>
								<p>Your home timeline is empty. Follow accounts to see posts here.</p>
							</div>
						{:else if homeTimelineState.status === 'error'}
							<div class="request-state request-error">
								<h2>{homeTimelineState.error.title}</h2>
								<p>{homeTimelineState.error.message}</p>
								{#if homeTimelineState.error.retryable && currentSession}
									<Button variant="secondary" onclick={retryHomeTimeline}>Retry request</Button>
								{/if}
							</div>
						{:else if homeTimelineState.status === 'success'}
							<div data-testid="home-timeline-list">
								{#each timelinePosts as post (post.id)}
									<Post {post} replyExpanded={inlineReplyOpenFor('home', post)} replyControlsId={inlineReplyOpenFor('home', post) ? inlineReplyComposerId('home', post) : undefined} onOpen={() => openThread(post)} onAction={(key) => handlePostAction(post, key)} onReact={(anchor) => openReactionPicker(post, 'home', anchor)} onVote={(pollId, choice) => votePollForPost(post, pollId, choice, 'home')} canManage={Boolean(currentSession)} />
									{#if inlineReplyOpenFor('home', post) && inlineReplyComposerProps}
										<InlineReplyComposer
											id={inlineReplyComposerId('home', post)}
											{...inlineReplyComposerProps}
										/>
									{/if}
								{/each}
							</div>
							<TimelineLoadMore
								nextCursor={homeTimelineState.nextCursor}
								loadMoreStatus={homeTimelineState.loadMoreStatus}
								loadMoreError={homeTimelineState.loadMoreError}
								onLoadMore={loadMoreHomeTimeline}
							/>
						{/if}
					</section>
				{:else if route === 'explore'}
					<section class="card app-panel app-explore-panel">
						<div class="app-page-kicker">Explore</div>
						<h1>Explore the network</h1>
						<p>Discover people, topics, and small communities across friendly Pleroma instances.</p>
						<form class="hero-search" role="search" onsubmit={submitExploreSearch}>
							<Icon name="search" width={16} height={16} />
							<input bind:value={exploreSearchDraft} type="search" aria-label="Search topics, people, and posts" placeholder="Search topics, people, and posts" />
							<Button variant="primary" type="submit">Search</Button>
						</form>
						<div class="hero-tags">
							<button type="button" class="tag">#fediverse</button>
							<button type="button" class="tag">#privacy</button>
							<button type="button" class="tag">#music</button>
						</div>
						<div class="explore-artwork" data-testid="explore-artwork"><Icon name="planet" width={58} height={58} /></div>
						<div class="explore-section-title">Suggested topics</div>
						<div class="explore-card-grid">
							{#each ['Small web', 'Pleroma admins', 'Cassette culture'] as topic}
								<article class="explore-card" data-testid="explore-topic-card">
									<strong>{topic}</strong>
									<span>Posts and people from friendly instances.</span>
								</article>
							{/each}
						</div>
						<div class="explore-section-title">Communities</div>
						<div class="explore-card-grid">
							{#each ['Federated CSS Garden', 'Retro Social Club', 'Instance Gardeners'] as community}
								<article class="explore-card explore-community" data-testid="explore-community-card">
									<div><strong>{community}</strong><span>Open community · weekly posts</span></div>
									<button type="button" aria-pressed={joinedCommunities[community] ? 'true' : 'false'} onclick={() => toggleCommunity(community)}>
										{joinedCommunities[community] ? `Joined ${community}` : `Join ${community}`}
									</button>
								</article>
							{/each}
						</div>
						<div class="explore-feed" data-testid="explore-feed">
							<div class="seg" role="tablist" aria-label="Discover feed">
								<button type="button" role="tab" aria-selected={exploreFeed === 'popular'} class:active={exploreFeed === 'popular'} onclick={() => (exploreFeed = 'popular')}>Popular</button>
								<button type="button" role="tab" aria-selected={exploreFeed === 'new'} class:active={exploreFeed === 'new'} onclick={() => (exploreFeed = 'new')}>New</button>
								<button type="button" role="tab" aria-selected={exploreFeed === 'active'} class:active={exploreFeed === 'active'} onclick={() => (exploreFeed = 'active')}>Active</button>
							</div>
							<p>{exploreFeedText}</p>
						</div>
					</section>
				{:else if route === 'search'}
					<section class="search-panel">
						<div class="se-pageframe card" data-testid="search-pageframe">
							<form class="se-bar" role="search" onsubmit={submitSearchPage}>
								<Icon name="search" width={18} height={18} />
								<input class="se-bar-input" value={searchPageDraft} type="search" aria-label="Search this instance and federation" placeholder="Search DeltaNet..." oninput={(event) => updateSearchPageDraft(event.currentTarget.value)} />
								<span class="se-bar-count">{searchResultTotal} {searchResultTotal === 1 ? 'result' : 'results'}</span>
							</form>
							<div class="se-tabs" role="tablist" aria-label="Search result types">
								<button type="button" role="tab" aria-selected={searchTab === 'all'} class="se-tab" class:active={searchTab === 'all'} onclick={() => setSearchTab('all')}>All <span class="se-tab-count">{searchResultTotal}</span></button>
								<button type="button" role="tab" aria-selected={searchTab === 'people'} class="se-tab" class:active={searchTab === 'people'} onclick={() => setSearchTab('people')}>People <span class="se-tab-count">{searchAccounts.length}</span></button>
								<button type="button" role="tab" aria-selected={searchTab === 'posts'} class="se-tab" class:active={searchTab === 'posts'} onclick={() => setSearchTab('posts')}>Posts <span class="se-tab-count">{searchPosts.length}</span></button>
								<span class="se-tabs-spacer"></span>
								<button type="button" class="se-tab-tool" class:on={searchSidebarOpen} aria-expanded={searchSidebarOpen} aria-controls="search-filter-sidebar" onclick={() => (searchSidebarOpen = !searchSidebarOpen)}>{searchSidebarOpen ? 'Hide filters ◂' : 'More filters ▸'}</button>
							</div>
							{#if searchSidebarOpen}
								<div class="se-v2-cols">
									<aside id="search-filter-sidebar" class="se-v2-side" data-testid="search-filter-sidebar">
										<div class="se-v2-side-head"><span class="se-v2-side-h">Filters</span><button type="button" class="se-v2-side-close" title="Close filters" onclick={() => (searchSidebarOpen = false)}>◂</button></div>
										<div class="se-v2-note">Filter controls are preview-only for now. Tabs and the search term are active.</div>
										<div class="se-v2-group"><div class="se-v2-group-l">Source</div><div class="se-v2-opt on">Federated</div><div class="se-v2-opt">This instance</div><div class="se-v2-opt">People you follow</div></div>
										<div class="se-v2-group"><div class="se-v2-group-l">Date</div><div class="se-v2-opt">Past 24 hours</div><div class="se-v2-opt on">Past week</div><div class="se-v2-opt">Past month</div><div class="se-v2-opt">All time</div></div>
										<div class="se-v2-group"><label class="se-v2-group-l" for="search-filter-user">From user</label><input id="search-filter-user" class="se-v2-input" placeholder="@user@server" disabled /></div>
										<div class="se-v2-group"><div class="se-v2-group-l">Has media</div><div class="se-v2-opt">Photos</div><div class="se-v2-opt">Audio</div><div class="se-v2-opt">Video</div></div>
										<div class="se-v2-group"><div class="se-v2-group-l">Sort</div><div class="se-v2-opt on">Most relevant</div><div class="se-v2-opt">Newest first</div><div class="se-v2-opt">Most boosted</div></div>
										<button type="button" class="se-v2-clear" disabled>CLEAR ALL</button>
									</aside>
									<div>{@render searchResultsBody()}</div>
								</div>
							{:else}
								{@render searchResultsBody()}
							{/if}
						</div>
					</section>
				{:else if route === 'thread'}
					<section class="card thread-view" data-testid="thread-view">
						<div class="thread-head-title">
							<button type="button" class="thread-back" aria-label="Back to home timeline" onclick={() => goto('/app/home')}><Icon name="arrowL" width={15} height={15} /></button>
							<h1>Thread</h1>
						</div>
						{#each threadStatusActionErrors as actionError (`${actionError.targetId}:${actionError.key}`)}
							<div class="status-action-error" role="alert">
								<strong>{actionError.error.title}</strong>
								<span>{actionError.error.message}</span>
							</div>
						{/each}
						{#if threadState.status === 'loading'}
							<div class="request-state" role="status" aria-label="Request status">Loading thread</div>
						{:else if threadState.status === 'error'}
							<div class="request-state request-error">
								<h2>{threadState.error.title}</h2>
								<p>{threadState.error.message}</p>
								{#if threadState.error.retryable && currentSession}
									<Button variant="secondary" onclick={retryThread}>Retry thread</Button>
								{/if}
							</div>
						{:else if threadState.status === 'success'}
							{#if threadState.ancestors.length > 0}
								<div class="thread-ancestors">
									{#each threadState.ancestors as ancestor (ancestor.id)}
										<div data-testid="thread-ancestor">
											<AncestorPost post={ancestor} replyExpanded={inlineReplyOpenFor('thread', ancestor)} replyControlsId={inlineReplyOpenFor('thread', ancestor) ? inlineReplyComposerId('thread', ancestor) : undefined} onAction={handleThreadPostAction} onReact={handleThreadReact} onVote={handleThreadVote} canManage={Boolean(currentSession)} />
										</div>
										{#if inlineReplyOpenFor('thread', ancestor) && inlineReplyComposerProps}
											<InlineReplyComposer
												id={inlineReplyComposerId('thread', ancestor)}
												{...inlineReplyComposerProps}
											/>
										{/if}
									{/each}
								</div>
							{/if}
							<FocusedPost post={threadState.focused} continuesAbove={threadState.ancestors.length > 0} replyExpanded={inlineReplyOpenFor('thread', threadState.focused)} replyControlsId={inlineReplyOpenFor('thread', threadState.focused) ? inlineReplyComposerId('thread', threadState.focused) : undefined} onAction={handleThreadPostAction} onReact={handleThreadReact} onVote={handleThreadVote} canManage={Boolean(currentSession)} />
							{#if inlineReplyOpenFor('thread', threadState.focused) && inlineReplyComposerProps}
								<InlineReplyComposer
									id={inlineReplyComposerId('thread', threadState.focused)}
									{...inlineReplyComposerProps}
								/>
							{/if}
							{#if threadReplyCount > 0}
								<div class="thread-reply-head">
									<div class="thread-reply-count" data-testid="thread-reply-count">{threadReplyCount} {threadReplyCount === 1 ? 'reply' : 'replies'}</div>
									<div class="seg" role="group" aria-label="Reply sort">
										<button type="button" aria-pressed={replySort === 'top'} class:active={replySort === 'top'} onclick={() => (replySort = 'top')}>Top</button>
										<button type="button" aria-pressed={replySort === 'newest'} class:active={replySort === 'newest'} onclick={() => (replySort = 'newest')}>Newest</button>
									</div>
								</div>
							{/if}
							<div class="thread-replies">
								{#each sortedThreadReplyPosts as reply, i (reply.id)}
									<div data-testid="thread-reply">
										<ReplyPost
											post={reply}
											isLast={i === sortedThreadReplyPosts.length - 1}
											nestedReplies={reply.nestedReplies}
											onAction={handleThreadPostAction}
											onReact={handleThreadReact}
											onVote={handleThreadVote}
											canManage={Boolean(currentSession)}
											inlineReply={threadInlineReplyBinding}
											expandedReplyIds={expandedThreadReplyIds}
											onShowNested={showThreadReplyNested}
										/>
									</div>
								{/each}
							</div>
					{/if}
					</section>
				{:else if route === 'profile'}
					<section class="profile-route" data-testid="profile-route">
						{#each profileStatusActionErrors as actionError (`${actionError.targetId}:${actionError.key}`)}
							<div class="status-action-error" role="alert">
								<strong>{actionError.error.title}</strong>
								<span>{actionError.error.message}</span>
							</div>
						{/each}
						{#if profileRouteState.status === 'loading' || profileRouteState.status === 'idle'}
							<div class="card request-state" role="status" aria-label="Request status">Loading profile</div>
						{:else if profileRouteState.status === 'error'}
							<div class="card request-state request-error">
								<h2>{profileRouteState.error.title}</h2>
								<p>{profileRouteState.error.message}</p>
								{#if profileRouteState.error.retryable && currentSession}
									<Button variant="secondary" onclick={retryProfileRoute}>Retry profile</Button>
								{/if}
							</div>
						{:else}
							<ProfileView
								profile={profileRouteState.data.profile}
								posts={profileRouteState.data.posts}
								replies={profileRouteState.data.replies}
								pinned={profileRouteState.data.pinned}
								media={profileRouteState.data.media}
								timelineLoading={profileRouteState.timelineStatus === 'loading'}
								followPending={profileFollowPending}
								followError={profileFollowError ? `${profileFollowError.title}: ${profileFollowError.message}` : null}
								onPostOpen={(post) => openThread(post)}
								onPostAction={handleProfilePostAction}
								onPostReact={(post, anchor) => openReactionPicker(post, 'profile', anchor)}
								onPostVote={(post, pollId, choice) => votePollForPost(post, pollId, choice, 'profile')}
								canManage={Boolean(currentSession)}
								onEditProfile={() => goto('/app/settings')}
								onFollowToggle={toggleProfileFollow}
								onSetPetname={profileRouteState.data.profile.id !== '0' ? saveProfilePetname : undefined}
								petnamePending={profilePetnamePending}
								petnameError={profilePetnameError}
								onRequestLocked={profileRouteState.data.profile.id !== '0' ? requestProfileLockedAccess : undefined}
								lockedRequestState={profileLockedRequestState}
							/>
						{/if}
					</section>
				{:else if route === 'messages'}
					<section class="card app-panel" data-testid="messages-panel">
						{#if messagesChatId}
							{#if chatsState.status === 'loading' || chatsState.status === 'idle' || chatThreadState.status === 'loading' || chatThreadState.status === 'idle'}
								<div class="request-state" role="status" aria-label="Request status">Loading conversation</div>
							{:else if chatThreadState.status === 'error'}
								<div class="request-state request-error">
									<h2>{chatThreadState.error.title}</h2>
									<p>{chatThreadState.error.message}</p>
									{#if chatThreadState.error.retryable && currentSession}
										<Button variant="secondary" onclick={() => currentSession && messagesChatId && loadChatThread(currentSession, messagesChatId)}>Retry request</Button>
									{/if}
								</div>
							{:else if !activeChat}
								<div class="request-state request-error">
									<h2>Conversation not found</h2>
									<p>This conversation does not exist or is not available for this account.</p>
								</div>
							{:else}
								<ChatThread
									partner={{ name: activeChat.account.displayName, nameEmojis: activeChat.account.emojis, handle: activeChat.account.handle, avatarUrl: activeChat.account.avatarUrl }}
									messages={chatThreadState.status === 'success' ? chatThreadState.data : []}
									draft={chatDraft}
									sending={chatSending}
									error={chatSendError}
									onDraftInput={(value) => (chatDraft = value)}
									onSend={sendChatDraft}
									onDeleteMessage={deleteChatThreadMessage}
								/>
							{/if}
						{:else}
							<div class="app-page-kicker">Messages</div>
							<h1>Messages</h1>
							<p>Direct conversations, powered by Pleroma chats.</p>

							{#if chatsState.status === 'loading' || chatsState.status === 'idle'}
								<div class="request-state" role="status" aria-label="Request status">Loading conversations</div>
							{:else if chatsState.status === 'empty'}
								<div class="request-state request-empty">
									<h2>No conversations yet</h2>
									<p>Direct messages you send and receive will appear here.</p>
								</div>
							{:else if chatsState.status === 'error'}
								<div class="request-state request-error">
									<h2>{chatsState.error.title}</h2>
									<p>{chatsState.error.message}</p>
									{#if chatsState.error.retryable && currentSession}
										<Button variant="secondary" onclick={() => currentSession && loadChats(currentSession)}>Retry request</Button>
									{/if}
								</div>
							{:else if chatsState.status === 'success'}
								<div class="chat-list" data-testid="chat-list">
									{#each chatsState.data as chat (chat.id)}
										<ChatRow {chat} href={`/app/messages/${chat.id}`} />
									{/each}
								</div>
							{/if}
						{/if}
					</section>
				{:else if route === 'bookmarks'}
					<section class="card app-panel" data-testid="bookmarks-panel">
						<div class="app-page-kicker">Bookmarks</div>
						<h1>Bookmarks</h1>
						<p>Posts you have saved for later.</p>

						{#if bookmarksState.status === 'loading' || bookmarksState.status === 'idle'}
							<div class="request-state" role="status" aria-label="Request status">Loading bookmarks</div>
						{:else if bookmarksState.status === 'empty'}
							<div class="request-state request-empty">
								<h2>No bookmarks yet</h2>
								<p>Save a post from its actions menu and it will appear here.</p>
							</div>
						{:else if bookmarksState.status === 'error'}
							<div class="request-state request-error">
								<h2>{bookmarksState.error.title}</h2>
								<p>{bookmarksState.error.message}</p>
								{#if bookmarksState.error.retryable && currentSession}
									<Button variant="secondary" onclick={() => currentSession && loadBookmarks(currentSession)}>Retry request</Button>
								{/if}
							</div>
						{:else if bookmarksState.status === 'success'}
							<div data-testid="bookmarks-list">
								{#each bookmarksPosts as post (post.id)}
									<Post {post} onOpen={() => openThread(post)} onAction={(key) => handlePostAction(post, key)} onReact={(anchor) => openReactionPicker(post, 'home', anchor)} onVote={(pollId, choice) => votePollForPost(post, pollId, choice, 'home')} canManage={Boolean(currentSession)} />
								{/each}
							</div>
							<TimelineLoadMore
								nextCursor={bookmarksState.nextCursor}
								loadMoreStatus={bookmarksState.loadMoreStatus}
								loadMoreError={bookmarksState.loadMoreError}
								onLoadMore={loadMoreBookmarks}
							/>
						{/if}
					</section>
				{:else if route === 'notifications'}
					<section class="card app-panel notifications-panel">
						<div class="notifications-head">
							<div>
								<div class="app-page-kicker">Notifications</div>
								<h1>Notifications</h1>
								<p>Mentions, follows, favorites, boosts, and Pleroma-specific events from your instance.</p>
							</div>
							<button type="button" class="btn-secondary" disabled={unreadNotificationCount === 0} onclick={markNotificationsRead}>Mark all read</button>
						</div>

						{#if notificationState.status === 'loading' || notificationState.status === 'idle'}
							<div class="request-state" role="status" aria-label="Request status">Loading notifications</div>
						{:else if notificationState.status === 'empty'}
							<div class="request-state request-empty">
								<h2>No notifications</h2>
								<p>Your instance has no notifications for this account yet.</p>
							</div>
						{:else if notificationState.status === 'error'}
							<div class="request-state request-error">
								<h2>{notificationState.error.title}</h2>
								<p>{notificationState.error.message}</p>
								{#if notificationState.error.retryable && currentSession}
									<Button variant="secondary" onclick={retryNotifications}>Retry notifications</Button>
								{/if}
							</div>
						{:else if notificationState.status === 'success'}
							<div class="notifications-list" data-testid="notifications-list">
								{#each notificationState.data as notification (notification.id)}
									<NotifRow n={notification} onOpen={openNotification} onAccept={acceptFollowRequestNotification} onReject={rejectFollowRequestNotification} />
								{/each}
							</div>
						{/if}
					</section>
				{:else if route === 'settings'}
					<section class="card app-panel settings-panel">
						<div class="crumbs">Settings / Profile</div>
						<h1>Profile settings</h1>
						<p>Manage your profile information and how you appear to others.</p>
						<div class="settings-save-row"><span data-testid="settings-save-state">{settingsSaveState}</span></div>
						<div class="upload-row" data-testid="avatar-upload-row">
							<input bind:this={avatarFileInput} class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose avatar file" onchange={(event) => handleProfileImageChange('avatar', event)} />
							{#if pendingAvatarPreview}
								<img class="upload-preview" data-testid="avatar-preview" src={pendingAvatarPreview} alt="Selected avatar preview" />
							{:else if settingsAvatarUrl}
								<img class="upload-preview" data-testid="avatar-current" src={settingsAvatarUrl} alt="Current avatar" />
							{/if}
							<button type="button" class="btn-secondary" onclick={() => pickProfileImage('avatar')}>Choose avatar</button>
							{#if pendingAvatarPreview}
								<button type="button" class="btn-secondary" onclick={() => clearPendingProfileImage('avatar')}>Discard avatar</button>
							{/if}
							<span>96×96px recommended</span>
						</div>
						<div class="upload-row" data-testid="banner-upload-row">
							<input bind:this={headerFileInput} class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose banner file" onchange={(event) => handleProfileImageChange('header', event)} />
							{#if pendingHeaderPreview}
								<img class="upload-preview upload-preview-wide" data-testid="banner-preview" src={pendingHeaderPreview} alt="Selected banner preview" />
							{:else if settingsHeaderUrl}
								<img class="upload-preview upload-preview-wide" data-testid="banner-current" src={settingsHeaderUrl} alt="Current banner" />
							{/if}
							<button type="button" class="btn-secondary" onclick={() => pickProfileImage('header')}>Choose banner</button>
							{#if pendingHeaderPreview}
								<button type="button" class="btn-secondary" onclick={() => clearPendingProfileImage('header')}>Discard banner</button>
							{/if}
							<span>Wide image recommended</span>
						</div>
						<div class="field">
							<label class="field-label" for="display-name">Display name</label>
							<input id="display-name" class="input" value={profile.displayName} oninput={(event) => updateProfile('displayName', event.currentTarget.value)} />
						</div>
						<div class="field">
							<label class="field-label" for="username">Username</label>
							<input id="username" class="input" value={profile.username} disabled />
							<div class="field-help">Your unique handle on this server. Usernames can't be changed.</div>
						</div>
						<div class="field">
							<label class="field-label" for="bio">Bio</label>
							<textarea id="bio" class="input textarea" value={profile.bio} oninput={(event) => updateProfile('bio', event.currentTarget.value)}></textarea>
							<div class="input-counter">{profileBioCount}</div>
						</div>
						<div class="field">
							<label class="field-label" for="website">Website</label>
							<input id="website" class="input" value={profile.website} oninput={(event) => updateProfile('website', event.currentTarget.value)} />
						</div>
						<div class="field">
							<label class="field-label" for="location">Location</label>
							<input id="location" class="input" value={profile.location} oninput={(event) => updateProfile('location', event.currentTarget.value)} />
						</div>
						<div class="settings-toggles">
							<button type="button" role="switch" aria-label="Discoverable profile" aria-checked={profile.discoverable ? 'true' : 'false'} onclick={() => updateProfile('discoverable', !profile.discoverable)}>Discoverable profile</button>
							<button type="button" role="switch" aria-label="Show follower count" aria-checked={profile.showFollowers ? 'true' : 'false'} onclick={() => updateProfile('showFollowers', !profile.showFollowers)}>Show follower count</button>
						</div>
						<div class="settings-actions">
							<button type="button" class="btn-primary" onclick={saveProfile} disabled={settingsSaveState === 'Saving…'}>Save profile settings</button>
							<button type="button" class="btn-secondary" onclick={resetProfile}>Reset profile settings</button>
						</div>
						{#if settingsSaveError}
							<div class="settings-save-error" data-testid="settings-save-error" role="alert">{settingsSaveError.title}: {settingsSaveError.message}</div>
						{/if}
					</section>
					<section class="card app-panel settings-panel" data-testid="backup-card" aria-label="Backup">
							<div class="crumbs">Settings / Backup</div>
							<h1>Backup &amp; identity</h1>
							<p>
								Your identity lives only in this node's data directory — the relay stores nothing for you,
								and deletes idle addresses after about 90 days. Download an encrypted backup so a lost disk
								doesn't mean losing your address, follows, and history.
							</p>
							{#if backupInfo}
								{@const nag = backupNagState(backupInfo.lastBackupAt, Date.now())}
								<p class="backup-status" data-testid="backup-status" class:backup-nag={nag !== 'fresh'}>
									{#if nag === 'never'}
										No backup has ever been made on this node.
									{:else if nag === 'stale'}
										Last backup {new Date(backupInfo.lastBackupAt!).toLocaleDateString()} — over a month ago. Time for a fresh one.
									{:else}
										Last backup {new Date(backupInfo.lastBackupAt!).toLocaleDateString()}.
									{/if}
								</p>
							{/if}
							<div class="field">
								<label class="field-label" for="backup-passphrase">Backup passphrase</label>
								<input
									id="backup-passphrase"
									class="input"
									type="password"
									autocomplete="new-password"
									value={backupPassphrase}
									oninput={(event) => (backupPassphrase = event.currentTarget.value)}
								/>
								<div class="field-help">Encrypts the download. You will need it to restore — there is no way to recover a forgotten passphrase.</div>
							</div>
							<div class="settings-actions">
								<button type="button" class="btn-primary" onclick={downloadBackup} disabled={!backupPassphrase.trim() || backupBusy}>
									{backupBusy ? 'Exporting…' : 'Download encrypted backup'}
								</button>
							</div>
							{#if backupSavedAs}
								<p class="backup-status" data-testid="backup-saved" role="status">Backup saved as {backupSavedAs}. Keep it somewhere that isn't this disk.</p>
							{/if}
							{#if backupError}
								<div class="settings-save-error" data-testid="backup-error" role="alert">{backupError}</div>
							{/if}
							<p class="field-help">
								Restoring: on a fresh node, choose “Restore from a backup” on the landing page instead of creating an account.
							</p>
					</section>
				{:else}
					<section class="card app-panel">
						<div class="app-page-kicker">App route</div>
						<h1>{placeholderHeading}</h1>
						<p>This route is now wired into the guarded app shell and ready for dedicated content.</p>
					</section>
				{/if}
			</main>

			<aside class="app-right-rail" data-testid="right-rail">
				{#if isTimelineRoute(route)}
					<div class="rail-title">Trends &amp; Activity</div>
					<SurfaceCard kind="trends" trendsState={trendsState} />
					{#if railSuggestions.length > 0}
						<SurfaceCard kind="who-to-follow" suggestions={railSuggestions} onSuggestionFollow={toggleSuggestionFollow} />
					{/if}
				{:else if route === 'explore'}
					<div class="rail-title">Discover</div>
					<div aria-label="Quick search Explore"><SurfaceCard kind="quick-search" /></div>
					<div class="card rail-card"><div class="card-head"><span class="card-title">Known instances</span></div><div class="card-body">pleroma.example · retro.social</div></div>
					<div class="card rail-card"><div class="card-head"><span class="card-title">Discovery mode</span></div><div class="card-body">Popular across friendly instances</div></div>
				{:else if route === 'profile'}
					{#if profileRouteState.status === 'success'}
						<ProfileSideRail profile={profileRouteState.data.profile} pinned={profileRouteState.data.pinned} />
					{:else}
						<div class="card request-state" role="status" aria-label="Profile rail status">Loading profile</div>
					{/if}
				{:else if route === 'settings'}
					<div class="card surface-card surface-profile-preview" data-testid="profile-preview-card">
						<div class="surface-profile-head"><div>Profile preview</div></div>
						<div class="surface-preview-body">
							<div class="surface-preview-name">{profile.displayName}</div>
							<div class="surface-preview-handle">@{profile.username}@{headerInstanceDomain}</div>
							<div class="surface-preview-bio">{profile.bio}</div>
							<div class="surface-preview-note">This is how your profile appears to other users.</div>
						</div>
					</div>
					<div class="card surface-card" data-testid="profile-tips-card">
						<div class="card-head surface-head-quiet"><span class="surface-tip-title"><Icon name="info" width={14} height={14} />Profile tips</span></div>
						<div class="surface-tip-list"><div class="surface-tip"><Icon name="image" width={14} height={14} /><span>Your avatar will be shown at 96×96px.</span></div></div>
					</div>
				{:else if route !== 'search'}
					<SurfaceCard kind="profile-preview" />
					<SurfaceCard kind="profile-tips" />
				{/if}
			</aside>
		</div>

		<nav class="mobile-bottom" data-testid="mobile-bottom-nav" aria-label="Mobile app navigation">
			<a href="/app/home" class:active={route === 'home'} class="mob-tab"><Icon name="home" /><span>Home</span></a>
			<a href="/app/explore" class:active={route === 'explore'} class="mob-tab"><Icon name="search" /><span>Explore</span></a>
			<a href="/app/settings" class:active={route === 'settings'} class="mob-tab"><Icon name="gear" /><span>Settings</span></a>
			<button type="button" class="mob-tab" onclick={() => (mobileSheetOpen = true)}><Icon name="list" /><span>More</span></button>
		</nav>

		{#if mobileDrawerOpen}
			<button type="button" class="mobile-drawer-bg open" aria-label="Close navigation menu" onclick={() => (mobileDrawerOpen = false)}></button>
			<aside class="mobile-drawer open" data-testid="mobile-drawer">
				<div class="drawer-head">
					<div class="drawer-brand"><span class="brand-mark"><Icon name="sparkBig" /></span><span class="brand-name">DeltaNet<sup>™</sup></span></div>
					<button type="button" class="drawer-close" aria-label="Close navigation menu" onclick={() => (mobileDrawerOpen = false)}>×</button>
				</div>
				<nav class="side-nav" aria-label="Mobile sections">
					{#each navItems as item}
						<a href={item.href} class:active={isActive(item)} class="side-nav-item" onclick={() => (mobileDrawerOpen = false)}>
							<span class="ico"><Icon name={item.icon} width={18} height={18} /></span>
							<span>{item.label}</span>
							{#if item.count}<span class="count">{item.count}</span>{/if}
						</a>
					{/each}
				</nav>
			</aside>
		{/if}

		{#if mobileSheetOpen}
			<button type="button" class="mobile-sheet-bg open" aria-label="Dismiss details sheet" onclick={() => (mobileSheetOpen = false)}></button>
			<aside class="mobile-sheet open" data-testid="mobile-sheet">
				<div class="sheet-grip"></div>
				<div class="sheet-head"><span class="sheet-title">Details</span><button type="button" class="drawer-close" aria-label="Close details sheet" onclick={() => (mobileSheetOpen = false)}>×</button></div>
				<SurfaceCard kind="trends" trendsState={trendsState} />
				{#if railSuggestions.length > 0}
					<SurfaceCard kind="who-to-follow" suggestions={railSuggestions} onSuggestionFollow={toggleSuggestionFollow} />
				{/if}
			</aside>
		{/if}
	</div>
{/if}

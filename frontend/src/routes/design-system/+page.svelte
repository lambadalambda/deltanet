<script lang="ts">
	import Avatar from '$lib/rebuild/Avatar.svelte';
	import AncestorPost from '$lib/rebuild/AncestorPost.svelte';
	import Button from '$lib/rebuild/Button.svelte';
	import ComposerCWPanel from '$lib/rebuild/ComposerCWPanel.svelte';
	import ComposerMentionEditor from '$lib/rebuild/ComposerMentionEditor.svelte';
	import EmojiPicker from '$lib/rebuild/EmojiPicker.svelte';
	import ComposerPollPanel from '$lib/rebuild/ComposerPollPanel.svelte';
	import FocusedPost from '$lib/rebuild/FocusedPost.svelte';
	import Icon from '$lib/rebuild/Icon.svelte';
	import InlineReplyComposer, { type InlineReplyComposerProps } from '$lib/rebuild/InlineReplyComposer.svelte';
	import Pill from '$lib/rebuild/Pill.svelte';
	import Post from '$lib/rebuild/Post.svelte';
	import ProfileSideRail from '$lib/rebuild/ProfileSideRail.svelte';
	import HalftoneImage from '$lib/rebuild/HalftoneImage.svelte';
	import ProfileView from '$lib/rebuild/ProfileView.svelte';
	import ReplyPost from '$lib/rebuild/ReplyPost.svelte';
	import CompactAudio from '$lib/rebuild/CompactAudio.svelte';
	import AttachmentLightboxHost from '$lib/rebuild/AttachmentLightboxHost.svelte';
	import { openLightbox } from '$lib/rebuild/attachments';
	import { createComposerPollDraft, type ComposerEmoji, type ComposerMentionAccount, type ComposerPollDraft } from '$lib/rebuild/composer';
	import MediaStripThumb from '$lib/rebuild/MediaStripThumb.svelte';
	import MediaStripKindBadge from '$lib/rebuild/MediaStripKindBadge.svelte';
	import MobilePreview from '$lib/rebuild/MobilePreview.svelte';
	import NowPlayingLine from '$lib/rebuild/NowPlayingLine.svelte';
	import NotifRow from '$lib/rebuild/NotifRow.svelte';
	import NotifsPopover from '$lib/rebuild/NotifsPopover.svelte';
	import OekakiModal from '$lib/rebuild/OekakiModal.svelte';
	import ProfileMini from '$lib/rebuild/ProfileMini.svelte';
	import Seg from '$lib/rebuild/Seg.svelte';
	import Tag from '$lib/rebuild/Tag.svelte';
	import Toggle from '$lib/rebuild/Toggle.svelte';
	import Radio from '$lib/rebuild/Radio.svelte';
	import SurfaceCard from '$lib/rebuild/SurfaceCard.svelte';
	import VaporBanner from '$lib/rebuild/VaporBanner.svelte';
	import { iconNames, type IconName } from '$lib/rebuild/icons';
	import { SAMPLE_NOTIFS, type NotificationData, type NotificationKind } from '$lib/rebuild/notifications';
	import type { Attachment, BannerVariant, PostLike } from '$lib/rebuild/attachments';
	import type { ProfileMediaItem, ProfilePost } from '$lib/rebuild/profile';
	import type { PleromaProfileView } from '$lib/pleroma/ui';
	import { onMount } from 'svelte';

	type AvatarVariant = 'post' | 'focused' | 'notif' | 'compose';

	const BANNER_VARIANTS: BannerVariant[] = ['sunset', 'pixel-window', 'city', 'space'];
	const AV_SIZE_CELLS: { variant: AvatarVariant; size: number; shape: string; cls: string; role: string }[] = [
		{ variant: 'notif', size: 28, shape: 'circle', cls: 'notif-av', role: 'Notification rows · stackable, ring-on-panel' },
		{ variant: 'compose', size: 40, shape: 'rect', cls: 'composer-av', role: 'Composer · 4px radius' },
		{ variant: 'post', size: 48, shape: 'rect', cls: 'post-av', role: 'Feed post · 4px radius' },
		{ variant: 'focused', size: 56, shape: 'rect', cls: 'focused-av', role: 'Focused thread post · 4px radius' },
	];

	type ThemeId = 'cream' | 'dusk' | 'drive' | 'simoun' | 'lablight' | 'labdark';
	type Theme = {
		id: ThemeId;
		label: string;
		bg: string;
		panel: string;
		ink: string;
		accent: string;
	};
	type Section = {
		id: string;
		label: string;
	};
	type ColorToken = {
		name: string;
		value: string;
		ink?: boolean;
	};
	type TypeRow = {
		family: string;
		sample: string;
		meta: string;
	};
	type QuotedDemoPost = {
		name?: string;
		handle?: string;
		time?: string;
		avClass?: string;
		avBanner?: BannerVariant;
		body?: string;
		attachments?: Attachment[];
		replies?: number;
		boosts?: number;
		favs?: number;
	};
	type DemoPostData = PostLike & {
		id: string | number;
		name: string;
		handle: string;
		time: string;
		avClass?: string;
		avBanner?: BannerVariant;
		avatarUrl?: string | null;
		body: string;
		addressees?: string[];
		quotedPost?: QuotedDemoPost;
		replies: number;
		boosts: number;
		favs: number;
		actions: { reply: boolean; boost: boolean; fav: boolean };
		fullTime?: string;
		source?: string;
		views?: string;
		bookmarks?: number;
		nestedReplies?: DemoPostData[];
	};
	type NotificationPreviewSpec = {
		label: string;
		note: string;
		notification: NotificationData;
	};
	type SurfaceSpec = {
		kind: string;
		label: string;
		note: string;
		span?: number;
	};
	type NavPreviewItem = {
		label: string;
		icon: IconName;
		active?: boolean;
		count?: number;
	};
	type MobilePreviewSpec = {
		variant: 'home' | 'drawer' | 'thread';
		label: string;
	};
	const THEMES: Theme[] = [
		{ id: 'cream', label: 'Cream', bg: '#f5f1e8', panel: '#fbfaf3', ink: '#1f2347', accent: '#a48bd9' },
		{ id: 'dusk', label: 'Dusk', bg: '#1a1538', panel: '#2a1f4a', ink: '#e8e2f5', accent: '#e7a8c9' },
		{ id: 'drive', label: 'Drive', bg: '#070719', panel: '#0c0c2a', ink: '#e0e6f0', accent: '#7dc4be' },
		{ id: 'simoun', label: 'Simoun', bg: '#141b36', panel: '#1c2547', ink: '#f4ebd8', accent: '#e8763a' },
		{ id: 'lablight', label: 'Lab Light', bg: '#ffffff', panel: '#ffffff', ink: '#0071a9', accent: '#0071a9' },
		{ id: 'labdark', label: 'Lab Dark', bg: '#0a0e12', panel: '#0a0e12', ink: '#4db8e8', accent: '#4db8e8' }
	];

	const SECTIONS: Section[] = [
		{ id: 'foundations', label: 'Foundations' },
		{ id: 'iconography', label: 'Iconography' },
		{ id: 'controls', label: 'Controls' },
		{ id: 'forms', label: 'Forms' },
		{ id: 'avatars', label: 'Avatars' },
		{ id: 'attachments', label: 'Attachments' },
		{ id: 'composer', label: 'Composer' },
		{ id: 'posts', label: 'Posts' },
		{ id: 'thread', label: 'Thread' },
		{ id: 'profile', label: 'Profile' },
		{ id: 'notifications', label: 'Notifications' },
		{ id: 'radio', label: 'Radio' },
		{ id: 'oekaki', label: 'Oekaki' },
		{ id: 'surfaces', label: 'Surfaces' },
		{ id: 'navigation', label: 'Navigation' },
		{ id: 'mobile', label: 'Mobile' }
	];
	const sharedPrimitiveModules = import.meta.glob('../../lib/rebuild/*.svelte');
	const sharedPrimitiveNames = Object.keys(sharedPrimitiveModules).map((path) => path.split('/').pop()?.replace('.svelte', '') ?? '');
	const SHARED_PRIMITIVE_COUNT = sharedPrimitiveNames.filter((name) =>
		name === 'Avatar' ||
		name === 'Button' ||
		name === 'Pill' ||
		name === 'Seg' ||
		name === 'SurfaceCard' ||
		name === 'Toggle' ||
		name.startsWith('Post') ||
		name.endsWith('Post') ||
		name.startsWith('Stat')
	).length;

	const colorTokens: ColorToken[] = [
		{ name: '--bg', value: 'page' },
		{ name: '--panel', value: 'cards' },
		{ name: '--panel-2', value: 'raised' },
		{ name: '--border', value: 'default' },
		{ name: '--border-strong', value: 'emphasis' },
		{ name: '--ink', value: 'primary text', ink: true },
		{ name: '--ink-2', value: 'secondary text', ink: true },
		{ name: '--muted', value: 'captions', ink: true },
		{ name: '--muted-2', value: 'weakest', ink: true },
		{ name: '--accent', value: 'brand' },
		{ name: '--accent-ink', value: 'brand-text', ink: true },
		{ name: '--accent-soft', value: 'hover/sel' },
		{ name: '--accent-soft-2', value: 'softest' }
	];

	const typeRows: TypeRow[] = [
		{ family: 'var(--serif)', sample: 'Soft hertz, slow web', meta: '--serif · Cormorant Garamond · headings, brand wordmark' },
		{ family: 'var(--sans)', sample: 'The quick brown fox jumps over the lazy dog.', meta: '--sans · Inter · body, UI' },
		{ family: 'var(--mono)', sample: 'DELTANET / v2.4.58 / @dreambyte@deltanet.example', meta: '--mono · JetBrains Mono · captions, eyebrows, technical' }
	];
	const SAMPLE_AUDIO_SRC = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

	const isThemeId = (value: string | null): value is ThemeId => THEMES.some((themeOption) => themeOption.id === value);

	const applyTheme = (nextTheme: ThemeId) => {
		document.body.dataset.theme = nextTheme;
		document.documentElement.dataset.theme = nextTheme;
	};

	let theme = $state<ThemeId>('cream');
	let section = $state('foundations');
	let mounted = $state(false);
	let toggleOn = $state(true);
	let segValue = $state('Popular');
	let toggleRowOn = $state(true);
	let composerText = $state('drafting in the design system');
	let composerCwSpecActive = $state(true);
	let composerCwText = $state('food, plated photos');
	let composerPollSpec = $state<ComposerPollDraft>({ ...createComposerPollDraft(), choices: ['warm cassette', 'cold terminal', 'spinning vinyl'] });
	let composerCombinedPollSpec = $state<ComposerPollDraft>({ ...createComposerPollDraft(), choices: ['long walk', 'call a friend', 'just sleep'], duration: '6h', hideUntil: false });
	let composerPrivacy = $state('Public');
	let composerAutocompleteText = $state('');
	let composerRemaining = $derived(500 - composerText.length);
	let composerAutocompleteRemaining = $derived(500 - composerAutocompleteText.length);
	let threadInlineReplyId = $state<string | number | null>(null);
	let threadInlineReplyDraft = $state('');
	let threadInlineReplyRemaining = $derived(500 - threadInlineReplyDraft.length);
	let oekakiOpen = $state(false);

	const demoPost = (attachments: Attachment[], body = '', quotedPost?: QuotedDemoPost): DemoPostData => ({
		id: 'ds-demo',
		name: 'orbit',
		handle: '@orbit@spacebear.net',
		time: '8m',
		avClass: 'av-orb',
		body,
		attachments,
		quotedPost,
		replies: 0,
		boosts: 0,
		favs: 0,
		actions: { reply: false, boost: false, fav: false },
	});

	const ATT_RULES = [
		{ input: '1 attachment of any kind', layout: 'single', highlight: false },
		{ input: '2–4 photos only', layout: 'photoGrid', highlight: false },
		{ input: '1 photo + 1 audio', layout: 'photoAudio', highlight: true },
		{ input: '2–4 photos + 1 audio', layout: 'photosAudio', highlight: false },
		{ input: 'anything else', layout: 'heroStrip', highlight: false },
	];
	const DS_MENTION_ACCOUNTS: ComposerMentionAccount[] = [
		{ id: 'soft-hertz', username: 'soft.hertz', displayName: 'soft.hertz ✦', acct: 'soft.hertz@kolektiva.social', avatarUrl: 'samples/cat-door.webp', avClass: 'av-grad-3' },
		{ id: 'softie', username: 'softie', displayName: 'softie ◌', acct: 'softie@graz.dev', avClass: 'av-orb' },
		{ id: 'softwave', username: 'softwave', displayName: 'softwave', acct: 'softwave@retro.social', avClass: 'av-grad-2' },
		{ id: 'softstack', username: 'softstack', displayName: 'softstack', acct: 'softstack@hub.dev', avClass: 'av-pixel-pc' }
	];
	const DS_CUSTOM_EMOJI: ComposerEmoji[] = [
		{ shortcode: 'blobcat', url: 'samples/cat-door.webp', pack: 'blobcats' },
		{ shortcode: 'blobfox', url: 'samples/cats-pair.webp', pack: 'blobcats' },
		{ shortcode: 'blobmoon', url: 'samples/cat-bank.webp', pack: 'blobcats' },
		{ shortcode: 'slowweb', url: 'samples/falco.png', pack: 'deltanet' }
	];
	const DS_SHORTCODE_QUERY = 'bl';
	const DS_SHORTCODE_EMOJI = DS_CUSTOM_EMOJI.filter((emoji) => emoji.shortcode.startsWith(DS_SHORTCODE_QUERY));
	const DS_UPLOADS = [
		{ id: 'u1', name: 'rain-on-glass-take2.wav', kind: 'audio', pct: 100 },
		{ id: 'u2', name: 'windowsill-dusk.jpg', kind: 'photo', pct: 62 },
		{ id: 'u3', name: 'kettle-take1.jpg', kind: 'photo', pct: 14 }
	];
	const DS_UPLOADS_SHORT = DS_UPLOADS.slice(0, 2);

	const SAMPLE_POST: DemoPostData = {
		id: '1', name: 'emi', handle: '@emichan@kolektiva.social', time: '16m',
		avClass: 'av-anime',
		body: "tiny update: fixed some bugs, added a toggle, and touched grass.\n\nthe internet can wait.",
		replies: 2, boosts: 7, favs: 42,
		actions: { reply: false, boost: false, fav: false },
	};
	const PHOTO_POST: DemoPostData = {
		...SAMPLE_POST, id: '2', body: "dusk in the city 🌆",
		attachments: [{ kind: 'photo', src: 'samples/falco.png', alt: 'still 1985' }],
	};
	const PHOTOS3_POST: DemoPostData = {
		...SAMPLE_POST, id: '3', name: 'sysadmin', handle: '@root@pleroma.social',
		avClass: 'av-pc-old',
		body: "Backup your data. Hug your cat. Update DeltaNet™.",
		attachments: [
			{ kind: 'photo', src: 'samples/cat-door.webp', alt: '' },
			{ kind: 'photo', src: 'samples/cat-bank.webp', alt: '' },
			{ kind: 'photo', src: 'samples/cats-pair.webp', alt: '' },
		],
	};
	const VIDEO_POST: DemoPostData = {
		...SAMPLE_POST, id: '4', name: 'pixelmoth', handle: '@pixelmoth@retro.social',
		avClass: 'av-pixel-pc',
		body: "cassette deck loop i recorded out the kitchen window.",
		attachments: [{ kind: 'video', poster: 'sunset', duration: '0:42', start: 0.15, cc: true, caption: 'A slow pan across a windowsill at dusk.' }],
	};
	const AUDIO_POST: DemoPostData = {
		...SAMPLE_POST, id: '5', name: 'kestrel.fm', handle: '@kestrel@audio.garden',
		avClass: 'av-grad-3',
		body: "demo from last night's basement set.",
		attachments: [{ kind: 'audio', title: 'after the storm (demo)', byline: 'kestrel · live take · 2026', duration: '4:18', start: 0.28, cover: 'samples/encardia-99.png' }],
	};
	const BANNER_POST: DemoPostData = {
		...SAMPLE_POST, id: '6', name: 'dreambyte', handle: '@dreambyte@deltanet.example',
		avClass: '', avBanner: 'sunset',
		body: "🤍",
	};
	const inlineReplyTargetHandle = (handle = '') => {
		const normalized = handle.startsWith('@') ? handle.slice(1) : handle;
		const local = normalized.split('@').filter(Boolean)[0] ?? normalized;
		return `@${local || 'user'}`;
	};
	const findDemoPost = (posts: DemoPostData[], id: string | number): DemoPostData | null => {
		for (const post of posts) {
			if (String(post.id) === String(id)) return post;
			const nested = post.nestedReplies ? findDemoPost(post.nestedReplies, id) : null;
			if (nested) return nested;
		}

		return null;
	};
	const clearThreadInlineReply = () => {
		threadInlineReplyId = null;
		threadInlineReplyDraft = '';
	};
	const handleThreadReplyAction = (id: string | number | undefined, key: string) => {
		if (key !== 'reply' || id == null) return;
		if (String(threadInlineReplyId) === String(id)) {
			clearThreadInlineReply();
			return;
		}

		threadInlineReplyId = id;
		threadInlineReplyDraft = '';
	};
	const threadInlineReplyOpenFor = (id: string | number | undefined) => id != null && String(threadInlineReplyId) === String(id);
	const threadInlineReplyComposerId = (id: string | number | undefined) => id == null ? undefined : `ds-thread-inline-reply-${String(id)}`;
	const POLL_CHOICES = [
		{ id: 'warm', label: 'warm cassette', votes: 142 },
		{ id: 'cold', label: 'cold terminal', votes: 38 },
		{ id: 'vinyl', label: 'spinning vinyl', votes: 214 }
	];
	const pollPost = (attachment: Attachment, body = 'which side wins?'): DemoPostData => demoPost([attachment], body);

	const THREAD_DEMO: { ancestors: DemoPostData[]; focused: DemoPostData; replies: DemoPostData[] } = {
		ancestors: [{
			id: 'a1', name: 'gridwave', handle: '@gridwave@retro.social', time: '5h',
			avClass: 'av-pixel-pc',
			body: 'anyone else feel like the web got a little too loud lately?',
			replies: 18, boosts: 42, favs: 210,
			actions: { reply: false, boost: false, fav: false },
		}],
		focused: {
			...SAMPLE_POST,
			id: 'focused',
			fullTime: '4:18 PM · May 11, 2026',
			source: 'DeltaNet™ Web',
			views: '12.4K',
			bookmarks: 24,
		},
		replies: [
			{
				id: 'r1', name: 'nyan.binary', handle: '@nyan@catgirl.cloud', time: '12m',
				avClass: 'av-anime', body: 'this is the energy i needed today 🌙',
				replies: 2, boosts: 3, favs: 18,
				actions: { reply: false, boost: false, fav: false },
				nestedReplies: [],
			},
			{
				id: 'r2', name: 'soft.hertz', handle: '@soft.hertz@kolektiva.social', time: '22m',
				avClass: 'av-grad-3', body: 'touched grass too. recommend the slow internet diet.',
				replies: 0, boosts: 7, favs: 31,
				actions: { reply: false, boost: false, fav: false },
				nestedReplies: [],
			},
		],
	};
	let threadInlineReplyTarget = $derived(threadInlineReplyId == null ? null : findDemoPost([...THREAD_DEMO.ancestors, THREAD_DEMO.focused, ...THREAD_DEMO.replies], threadInlineReplyId));
	const threadInlineReplyComposerProps = $derived<Omit<InlineReplyComposerProps, 'id'> | null>(threadInlineReplyTarget ? {
		targetHandle: inlineReplyTargetHandle(threadInlineReplyTarget.handle),
		targetName: threadInlineReplyTarget.name,
		targetAvClass: threadInlineReplyTarget.avClass,
		targetAvBanner: threadInlineReplyTarget.avBanner,
		targetAvatarUrl: threadInlineReplyTarget.avatarUrl,
		draft: threadInlineReplyDraft,
		remaining: threadInlineReplyRemaining,
		onDraftInput: (value: string) => (threadInlineReplyDraft = value),
		onCancel: clearThreadInlineReply,
		onSubmit: clearThreadInlineReply
	} : null);
	const threadInlineReplyBinding = $derived(threadInlineReplyComposerProps ? {
		renderId: threadInlineReplyId == null ? null : String(threadInlineReplyId),
		props: threadInlineReplyComposerProps
	} : null);
	const PROFILE_DEMO: PleromaProfileView = {
		id: 'profile-soft-hertz',
		username: 'soft.hertz',
		displayName: 'soft.hertz ✦',
		displayNameEmojis: [],
		acct: 'soft.hertz@kolektiva.social',
		handle: '@soft.hertz@kolektiva.social',
		url: 'https://kolektiva.social/users/soft.hertz',
		bio: "field recordings + slow web · cassette decks · taipei.\nthe algorithm doesn't care about you. the timeline does.",
		avatarUrl: null,
		headerUrl: null,
		fields: [
			{ key: 'Pronouns', value: 'they / them', verified: false },
			{ key: 'Location', value: 'Taipei, TW', verified: false },
			{ key: 'Web', value: 'softhertz.land', verified: true },
			{ key: 'Instance', value: 'kolektiva.social', verified: false }
		],
		stats: { posts: 2148, following: 312, followers: 1921 },
		relations: { locked: false, bot: false, remote: true },
		followState: 'mutual'
	};
	const PROFILE_POSTS: ProfilePost[] = [
		{
			id: 'profile-post-1', name: PROFILE_DEMO.displayName, handle: PROFILE_DEMO.handle, time: '2h',
			avClass: 'av-grad-3', body: "rain recording from this morning's walk — 11 minutes, two takes, the kettle made it onto the second one.",
			attachments: [{ kind: 'audio', title: 'rain on glass · take 2', byline: 'soft.hertz · field · 2026', duration: '11:42' }],
			replies: 8, boosts: 24, favs: 86,
			actions: { reply: false, boost: false, fav: false }
		},
		{
			id: 'profile-post-2', name: PROFILE_DEMO.displayName, handle: PROFILE_DEMO.handle, time: '6h',
			avClass: 'av-grad-3', body: "thinking about how the slow web isn't really slow — it's just the pace at which a person can actually pay attention.",
			replies: 12, boosts: 38, favs: 142,
			actions: { reply: false, boost: false, fav: false }
		}
	];
	const PROFILE_REPLIES: ProfilePost[] = [
		{
			id: 'profile-reply-1', name: PROFILE_DEMO.displayName, handle: PROFILE_DEMO.handle, time: '42m',
			avClass: 'av-grad-3', body: 'reply from the margins, still part of the shape.',
			replies: 1, boosts: 2, favs: 9,
			actions: { reply: false, boost: false, fav: false }
		},
		...PROFILE_POSTS
	];
	const PROFILE_PINNED: ProfilePost[] = [
		{
			id: 'profile-pin-1', name: PROFILE_DEMO.displayName, handle: PROFILE_DEMO.handle, time: '3w',
			avClass: 'av-grad-3', body: "the algorithm doesn't care about you. the timeline doesn't either. but the people in it do, and that's worth keeping.",
			replies: 142, boosts: 312, favs: 891,
			actions: { reply: false, boost: false, fav: true }
		},
		{
			id: 'profile-pin-2', name: PROFILE_DEMO.displayName, handle: PROFILE_DEMO.handle, time: '2mo',
			avClass: 'av-grad-3', body: 'follow whoever you want. mute liberally. block when you need to. the timeline is yours to tend.',
			replies: 38, boosts: 124, favs: 612,
			actions: { reply: false, boost: false, fav: false }
		}
	];
	const PROFILE_MEDIA: ProfileMediaItem[] = [
		{ kind: 'audio', title: 'rain on glass · take 2' },
		{ kind: 'photo', src: 'samples/cat-door.webp', alt: 'door with cat at dusk' }
	];

	const sampleNotification = (kind: NotificationKind): NotificationData =>
		SAMPLE_NOTIFS.find((notification) => notification.kind === kind) ?? SAMPLE_NOTIFS[0];

	const NOTIFICATION_PREVIEW_SPECS: NotificationPreviewSpec[] = [
		{ label: 'Mention · unread', note: 'NotifRow k-mention unread', notification: sampleNotification('mention') },
		{ label: 'Favorite · grouped', note: 'NotifRow k-fav · 4 actors', notification: sampleNotification('fav') },
		{ label: 'Boost', note: 'NotifRow k-boost', notification: sampleNotification('boost') },
		{ label: 'Reply', note: 'NotifRow k-reply', notification: sampleNotification('reply') },
		{ label: 'Follow', note: 'NotifRow k-follow · Follow back', notification: sampleNotification('follow') },
		{ label: 'Follow request', note: 'NotifRow k-follow_req · Accept / Decline', notification: sampleNotification('follow_req') },
	];

	const SURFACE_SPECS: SurfaceSpec[] = [
		{ kind: 'trends', label: 'TrendsCard', note: 'trend-list' },
		{ kind: 'who-to-follow', label: 'WhoToFollow', note: 'suggest' },
		{ kind: 'shortcuts', label: 'ShortcutsCard', note: 'short' },
		{ kind: 'instance-status', label: 'InstanceStatus', note: 'status-row' },
		{ kind: 'quick-search', label: 'QuickSearchCard', note: 'explore right rail' },
		{ kind: 'footer', label: 'FooterCard', note: 'footer-card' },
		{ kind: 'profile-preview', label: 'ProfilePreviewCard', note: 'settings right rail', span: 2 },
		{ kind: 'profile-tips', label: 'ProfileTipsCard', note: 'settings right rail' },
	];

	const NAV_PREVIEW_ITEMS: NavPreviewItem[] = [
		{ label: 'Home', icon: 'home', active: true },
		{ label: 'Local', icon: 'users' },
		{ label: 'Federated', icon: 'globe' },
		{ label: 'Notifications', icon: 'bell', count: 3 },
		{ label: 'Messages', icon: 'msg' },
		{ label: 'Bookmarks', icon: 'bookmark' },
		{ label: 'Lists', icon: 'list' },
		{ label: 'Settings', icon: 'gear' },
	];

	const MOBILE_PREVIEWS: MobilePreviewSpec[] = [
		{ variant: 'home', label: 'Home · feed + bottom tab bar' },
		{ variant: 'drawer', label: 'Drawer · left side menu' },
		{ variant: 'thread', label: 'Thread · ancestor + focused' },
	];

	onMount(() => {
		const storedTheme = localStorage.getItem('pn-theme');
		if (isThemeId(storedTheme)) theme = storedTheme;
		mounted = true;
		applyTheme(theme);
	});

	$effect(() => {
		if (!mounted) return;
		applyTheme(theme);
		localStorage.setItem('pn-theme', theme);
	});
</script>

<svelte:head>
	<title>DeltaNet · Design System</title>
</svelte:head>

<AttachmentLightboxHost />
<div class="ds-page">
	<header class="ds-header">
		<div class="ds-header-l">
			<div class="brand">
				<div class="brand-mark" aria-hidden="true">
					<svg viewBox="0 0 32 32" fill="none">
						<path d="M16 3v9M16 20v9M3 16h9M20 16h9M7 7l5 5M20 20l5 5M25 7l-5 5M12 20l-5 5" stroke="#dcd1f0" stroke-width="1.4" stroke-linecap="round" />
						<circle cx="16" cy="16" r="2" fill="#dcd1f0" />
					</svg>
				</div>
				<div>
					<div class="brand-name ds-brand-title">DeltaNet<sup>™</sup></div>
					<div class="ds-brand-subtitle">Design system · v2.4.58</div>
				</div>
			</div>
		</div>
		<div class="ds-header-r">
			<div class="ds-theme-picker" aria-label="Theme picker">
				{#each THEMES as themeOption}
					<button
						type="button"
						class:active={theme === themeOption.id}
						class="ds-theme-chip"
						onclick={() => (theme = themeOption.id)}
						aria-pressed={theme === themeOption.id}
					>
						<span class="ds-theme-swatch" style={`background: ${themeOption.bg}; border-color: ${themeOption.panel};`}>
							<span style={`background: ${themeOption.accent};`}></span>
							<span style={`background: ${themeOption.ink};`}></span>
						</span>
						<span>{themeOption.label}</span>
					</button>
				{/each}
			</div>
			<a class="ds-app-link" href="DeltaNet.html">Open app →</a>
		</div>
	</header>

	<div class="ds-body">
		<aside class="ds-nav">
			<div class="ds-nav-label">Contents</div>
			{#each SECTIONS as navSection}
				<a
					href={`#${navSection.id}`}
					class:active={section === navSection.id}
					class="ds-nav-item"
					onclick={() => (section = navSection.id)}
				>
					{navSection.label}
				</a>
			{/each}
			<div class="ds-nav-foot">
				<div>{SHARED_PRIMITIVE_COUNT} shared primitives</div>
				<div>4 themes</div>
			</div>
		</aside>

		<main class="ds-main">
			<section id="foundations" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">01</div>
					<h2 class="ds-h2">Foundations</h2>
					<p class="ds-sub">Tokens, palette and type. Everything else is composed from these.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-sub-h">Color tokens</div>
					<div class="ds-tok-grid">
						{#each colorTokens as token}
							<div class="ds-tok">
								<div class="ds-tok-swatch" style={`background: var(${token.name});${token.ink ? ` color: var(${token.name});` : ''}`}>
									{#if token.ink}<span>Aa</span>{/if}
								</div>
								<div class="ds-tok-meta">
									<div class="ds-tok-name">{token.name}</div>
									<div class="ds-tok-val">{token.value}</div>
								</div>
							</div>
						{/each}
					</div>

					<div class="ds-sub-h">Type</div>
					<div class="ds-type-stack">
						{#each typeRows as row}
							<div class="ds-type-row">
								<div class="ds-type-sample" style={`font-family: ${row.family};`}>{row.sample}</div>
								<div class="ds-type-meta">{row.meta}</div>
							</div>
						{/each}
					</div>

					<div class="ds-sub-h">Themes</div>
					<div class="ds-grid ds-grid-4">
						{#each THEMES as themeOption}
							<div class="ds-theme-card" style={`background: ${themeOption.bg}; color: ${themeOption.ink}; border-color: ${themeOption.panel};`}>
								<div class="ds-theme-card-head" style={`background: ${themeOption.panel}; border-bottom-color: ${themeOption.accent}33;`}>
									<div class="ds-theme-card-title">{themeOption.label}</div>
									<div class="ds-theme-card-sub" style={`color: ${themeOption.accent};`}>theme · {themeOption.id}</div>
								</div>
								<div class="ds-theme-card-swatches">
									<span style={`background: ${themeOption.bg}; border-color: ${themeOption.accent}33;`}></span>
									<span style={`background: ${themeOption.panel};`}></span>
									<span style={`background: ${themeOption.ink};`}></span>
									<span style={`background: ${themeOption.accent};`}></span>
								</div>
							</div>
						{/each}
					</div>

				</div>
			</section>

			<section id="iconography" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">02</div>
					<h2 class="ds-h2">Iconography</h2>
					<p class="ds-sub">One stroke weight (1.5–1.6), one corner style, currentColor on stroke. Imported from icons.jsx as the `I` namespace.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-icon-grid">
						{#each iconNames as iconName (iconName)}
							<div class="ds-icon-cell">
								<div class="ds-icon-box"><Icon name={iconName} className="ds-icon-svg" /></div>
								<div class="ds-icon-name">I.{iconName}</div>
							</div>
						{/each}
					</div>
				</div>
			</section>

			<section id="controls" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">03</div>
					<h2 class="ds-h2">Controls</h2>
					<p class="ds-sub">Buttons, pills, tabs and segmented switches.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-grid ds-grid-3">
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div class="ds-row">
									<Button variant="primary">Post</Button>
									<Button variant="primary" disabled>Disabled</Button>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Button · primary</span>
								<span class="ds-spec-note">btn-primary</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<Button variant="secondary">Reset</Button>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Button · secondary</span>
								<span class="ds-spec-note">btn-secondary</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div class="ds-row">
									<Button variant="follow">Follow</Button>
									<Button variant="follow" className="following">Following</Button>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Button · follow</span>
								<span class="ds-spec-note">btn-follow · btn-follow.following</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<Button variant="upload">
									<span>Change avatar</span>
									<Icon name="upload" className="ds-spec-icon-sm" />
								</Button>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Button · upload</span>
								<span class="ds-spec-note">btn-upload</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div class="ds-row">
									<Pill>All systems normal</Pill>
									<Pill>3 new</Pill>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Pill</span>
								<span class="ds-spec-note">pill</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div class="ds-row">
									<Tag>#fediverse</Tag>
									<Tag>#privacy</Tag>
									<Tag>#vaporwave</Tag>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Tag</span>
								<span class="ds-spec-note">tag</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div class="tabs" style="border-radius: 4px; overflow: hidden;">
									<button type="button" class="tab active">Home</button>
									<button type="button" class="tab">Local</button>
									<button type="button" class="tab">Federated</button>
									<div class="tab-spacer"></div>
									<button type="button" class="tab-action"><Icon name="sliders" className="ds-spec-icon-sm" /></button>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Tabs</span>
								<span class="ds-spec-note">.tabs > .tab · .tabs > .tab.active</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<Seg options={['Popular', 'New', 'Active']} value={segValue} onchange={(v) => (segValue = v)} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Segmented</span>
								<span class="ds-spec-note">.seg</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div class="ds-row" style="align-items: center;">
									<Toggle checked={toggleOn} onchange={(v) => (toggleOn = v)} />
									<span class="ds-toggle-label">{toggleOn ? 'ON' : 'OFF'}</span>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Toggle</span>
								<span class="ds-spec-note">.toggle · .toggle.on</span>
							</div>
						</div>
					</div>

				</div>
			</section>

			<section id="forms" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">04</div>
					<h2 class="ds-h2">Forms</h2>
					<p class="ds-sub">Inputs, textareas, selects, and the toggle row pattern.</p>
				</header>
					<div class="ds-slab-body">
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<input class="input" value="dreambyte" />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Input</span>
								<span class="ds-spec-note">.input</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<select class="select">
									<option>@deltanet.example</option>
									<option>@kolektiva.social</option>
								</select>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Select</span>
								<span class="ds-spec-note">.select</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage padded">
								<div class="split-row">
									<input class="input" value="dreambyte" />
									<select class="select"><option>@deltanet.example</option></select>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Split row</span>
								<span class="ds-spec-note">.split-row</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage padded">
								<textarea class="textarea">living in a soft world</textarea>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Textarea</span>
								<span class="ds-spec-note">.textarea</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage padded">
								<div class="toggle-row">
									<div>
										<div class="toggle-title">Discoverable</div>
										<div class="toggle-help">Allow others to find you in search and suggestions.</div>
									</div>
									<Toggle checked={toggleRowOn} onchange={(v) => (toggleRowOn = v)} />
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Toggle row</span>
								<span class="ds-spec-note">.toggle-row — used in settings</span>
							</div>
						</div>
					</div>

				</div>
			</section>

			<section id="avatars" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">05</div>
					<h2 class="ds-h2">Avatars</h2>
					<p class="ds-sub">&lt;Avatar/&gt; wraps four base CSS classes (.post-av / .focused-av / .notif-av / .composer-av) around either an .av-* CSS class or a VaporBanner. Pass a post-shaped object and the variant figures itself out.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-av-gallery">
						<div class="ds-av-section">
							<div class="ds-av-section-label">CSS variants</div>
							<div class="ds-av-row">
								{#each [
									{ lbl: 'av-anime', cls: 'av-anime' },
									{ lbl: 'av-pixel-pc', cls: 'av-pixel-pc' },
									{ lbl: 'av-orb', cls: 'av-orb' },
									{ lbl: 'av-pc-old', cls: 'av-pc-old' },
									{ lbl: 'av-grad-1', cls: 'av-grad-1' },
									{ lbl: 'av-grad-3', cls: 'av-grad-3' },
								] as v}
									<div class="ds-av-cell">
										<Avatar avClass={v.cls} />
										<div class="ds-av-name">.{v.lbl}</div>
									</div>
								{/each}
							</div>
						</div>
						<div class="ds-av-section">
							<div class="ds-av-section-label">VaporBanner variants <span style="opacity: 0.6">· shown at banner size, with avatar crop inset</span></div>
							<div class="ds-banner-row">
								{#each BANNER_VARIANTS as b}
									<div class="ds-banner-cell">
										<div class="ds-banner-tile">
											<VaporBanner variant={b} />
										</div>
										<div class="ds-banner-meta">
											<div class="ds-banner-crop">
												<VaporBanner variant={b} />
											</div>
											<div class="ds-banner-text">
												<div class="ds-av-name">{b}</div>
												<div class="ds-banner-note">as avatar →</div>
											</div>
										</div>
									</div>
								{/each}
							</div>
						</div>
						<div class="ds-av-section">
							<div class="ds-av-section-label">Sizes & shapes <span style="opacity: 0.6">· each variant has its own size and shape rules</span></div>
							<div class="ds-size-row">
								{#each AV_SIZE_CELLS as s}
									<div class="ds-size-cell">
										<div class="ds-size-stage">
											<Avatar variant={s.variant} avBanner="sunset" size={s.size} />
										</div>
										<div class="ds-size-meta">
											<div class="ds-size-name">
												<span class="ds-size-variant">.{s.cls}</span>
												<span class="ds-size-dim">{s.size}×{s.size}</span>
												<span class="ds-size-shape ds-size-shape-{s.shape}">{s.shape}</span>
											</div>
											<div class="ds-size-role">{s.role}</div>
										</div>
									</div>
								{/each}
							</div>
						</div>
					</div>
				</div>
			</section>

			<section id="attachments" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">06</div>
					<h2 class="ds-h2">Attachments</h2>
					<p class="ds-sub">Each post can carry any mix of media. A pure function — pickAttachmentLayout(attachments) — decides which layout pattern renders. The Post component never calls a media component directly.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-sub-h">Layout rules</div>
					<p class="ds-sub" style="margin-bottom:14px">Most-specific-first. The last branch is the fallthrough.</p>
					<div class="ds-att-rules">
						{#each ATT_RULES as r, i}
							<div class="ds-att-rule {r.highlight ? 'ds-att-rule-hi' : ''}">
								<div class="ds-att-rule-wire">
									<svg viewBox="0 0 80 50" style="width:80px;height:50px;display:block">
										{#if i === 0}
											<rect x="2" y="2" width="76" height="46" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.8"/>
										{:else if i === 1}
											<rect x="2" y="2" width="37" height="22" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.7"/>
											<rect x="41" y="2" width="37" height="22" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.7"/>
											<rect x="2" y="26" width="37" height="22" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.7"/>
											<rect x="41" y="26" width="37" height="22" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.7"/>
										{:else if i === 2}
											<rect x="2" y="2" width="76" height="32" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.8"/>
											<rect x="2" y="36" width="76" height="12" rx="1.5" fill="var(--panel)" stroke="var(--accent)" stroke-width="0.8"/>
											<circle cx="9" cy="42" r="3" fill="var(--accent)"/>
											<path d="M7.5 40.5 L10.5 42 L7.5 43.5 Z" fill="white"/>
										{:else if i === 3}
											<rect x="2" y="2" width="37" height="14" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.6"/>
											<rect x="41" y="2" width="37" height="14" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.6"/>
											<rect x="2" y="18" width="37" height="14" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.6"/>
											<rect x="41" y="18" width="37" height="14" rx="1" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.6"/>
											<rect x="2" y="34" width="76" height="14" rx="1.5" fill="var(--panel)" stroke="var(--accent)" stroke-width="0.7"/>
											<circle cx="9" cy="41" r="3" fill="var(--accent)"/>
											<path d="M7.5 39.5 L10.5 41 L7.5 42.5 Z" fill="white"/>
										{:else if i === 4}
											<rect x="2" y="2" width="76" height="30" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="0.8"/>
											<circle cx="40" cy="17" r="4" fill="var(--accent)"/>
											<path d="M38 14.5 L42 17 L38 19.5 Z" fill="white"/>
											{#each [2,12,22,32,42,52,62,72] as x, j}
												<rect x={x} y="36" width="6" height="10" rx="0.6" fill={j === 0 ? 'var(--accent)' : 'var(--border-strong)'} stroke="var(--muted-2)" stroke-width="0.4"/>
											{/each}
										{/if}
									</svg>
								</div>
								<div class="ds-att-rule-input">{r.input}</div>
								<div class="ds-att-rule-arrow">→</div>
								<div class="ds-att-rule-layout">{r.layout}</div>
							</div>
						{/each}
					</div>

					<div class="ds-sub-h">Single media (1 attachment of any kind)</div>
					<div class="ds-grid ds-grid-3">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'photo', src:'samples/falco.png', alt:'still 1985'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">1 photo</span>
								<span class="ds-spec-note">pickAttachmentLayout → 'single' → PhotoGrid n1</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'video', poster:'sunset', duration:'0:42', cc:true, caption:'A pan across a windowsill at dusk.'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">1 video</span>
								<span class="ds-spec-note">'single' → VideoAttachment</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'audio', src:SAMPLE_AUDIO_SRC, title:'after the storm (demo)', byline:'kestrel · 2026', duration:'4:18', start:0.28, cover:'samples/encardia-99.png'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">1 audio</span>
								<span class="ds-spec-note">'single' → AudioAttachment</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Photo grids (2–4 photos)</div>
					<div class="ds-grid ds-grid-3">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'photo', src:'samples/dragon.png'},{kind:'photo', src:'samples/flute-text.png'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">2 photos</span>
								<span class="ds-spec-note">photoGrid · n2</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'photo', src:'samples/cat-door.webp'},{kind:'photo', src:'samples/cat-bank.webp'},{kind:'photo', src:'samples/cats-pair.webp'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">3 photos</span>
								<span class="ds-spec-note">photoGrid · n3</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'photo', src:'samples/cat-door.webp'},{kind:'photo', src:'samples/cat-bank.webp'},{kind:'photo', src:'samples/cats-pair.webp'},{kind:'photo', src:'samples/falco.png'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">4 photos</span>
								<span class="ds-spec-note">photoGrid · n4</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Combos (photo(s) + 1 audio)</div>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'photo', src:'samples/cat-door.webp', alt:'window in the rain'},{kind:'audio', title:'rain on glass', byline:'lumen · field · 2026', duration:'5:12'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">★ 1 photo + 1 audio</span>
								<span class="ds-spec-note">photoAudio · photo + compact audio bar</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([{kind:'photo', src:'samples/falco.png'},{kind:'photo', src:'samples/dragon.png'},{kind:'photo', src:'samples/cat-door.webp'},{kind:'audio', title:'evening crickets', byline:'orbit · field', duration:'3:48'}])} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">3 photos + 1 audio</span>
								<span class="ds-spec-note">photosAudio · grid + compact audio bar</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">General (anything else) — hero + strip</div>
					<div class="ds-spec">
						<div class="ds-spec-stage">
							<Post post={demoPost([{kind:'photo', src:'samples/falco.png', alt:'station platform at dusk'},{kind:'photo', src:'samples/dragon.png', alt:'shrine path'},{kind:'photo', src:'samples/cat-door.webp', alt:'door with cat'},{kind:'video', poster:'sunset', duration:'0:42', cc:true, caption:'A pan across a windowsill at dusk.'},{kind:'audio', title:'kettle whistle', byline:'orbit · field · 2026', duration:'2:14'},{kind:'audio', title:'evening crickets', byline:'orbit · field · 2026', duration:'3:48'}])} />
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">3 photos + 1 video + 2 audio</span>
							<span class="ds-spec-note">heroStrip · click strip thumbs to promote</span>
						</div>
					</div>

					<div class="ds-sub-h">Primitives in isolation</div>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div style="padding:14px">
									<CompactAudio audio={{kind:'audio', title:'kettle whistle', byline:'orbit · field · 2026', duration:'2:14'}} />
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">CompactAudio</span>
								<span class="ds-spec-note">window.CompactAudio · used in combos + lightbox</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div style="display:flex;gap:8px">
									<div class="ds-media-thumb-cell" style="position:relative;width:56px;height:56px;border-radius:3px;overflow:hidden;border:1px solid var(--border)">
										<MediaStripThumb att={{kind:'photo', src:'samples/falco.png'}} />
										<MediaStripKindBadge kind="photo" />
									</div>
									<div class="ds-media-thumb-cell" style="position:relative;width:56px;height:56px;border-radius:3px;overflow:hidden;border:1px solid var(--border)">
										<MediaStripThumb att={{kind:'video'}} />
										<MediaStripKindBadge kind="video" />
									</div>
									<div class="ds-media-thumb-cell" style="position:relative;width:56px;height:56px;border-radius:3px;overflow:hidden;border:1px solid var(--border)">
										<MediaStripThumb att={{kind:'audio', cover:'samples/encardia-99.png'}} />
										<MediaStripKindBadge kind="audio" />
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">MediaStripThumb</span>
								<span class="ds-spec-note">thumbnails by kind</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Polls</div>
					<p class="ds-sub" style="margin-bottom:14px">Polls live alongside media as <code style="font-family:var(--mono);font-size:11px">kind: 'poll'</code> attachments, but render in a dedicated slot below the media block (never mixed in). The component is the same in every state — pre-vote it draws radio/check rows + a Vote button, post-vote (or post-expiry) it draws a horizontal bar chart with raw vote counts. Your vote gets a "You" chip and an accent-ink fill; the winning row gets the strongest accent fill.</p>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={pollPost({
									kind: 'poll',
									id: 'ds-p1',
									choices: POLL_CHOICES,
									totalVotes: 394,
									multi: false,
									endsIn: '6h 12m',
									myVote: null,
									expired: false
								})} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Voting · single choice</span>
								<span class="ds-spec-note">myVote = null · radio rows</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={pollPost({
									kind: 'poll',
									id: 'ds-p2',
									choices: [
										{ id: 'a', label: 'CW redesign', votes: 22 },
										{ id: 'b', label: 'Inline replies', votes: 15 },
										{ id: 'c', label: 'Polls', votes: 31 }
									],
									totalVotes: 68,
									multi: true,
									endsIn: '1d 4h',
									myVote: null,
									expired: false
								}, 'what should we ship first this week?')} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Voting · multiple choices</span>
								<span class="ds-spec-note">poll.multi = true · check rows</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={pollPost({
									kind: 'poll',
									id: 'ds-p3',
									choices: POLL_CHOICES,
									totalVotes: 394,
									multi: false,
									endsIn: '6h 12m',
									myVote: 'vinyl',
									expired: false
								})} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Results · with vote</span>
								<span class="ds-spec-note">myVote = 'vinyl' · bar chart</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={pollPost({
									kind: 'poll',
									id: 'ds-p4',
									choices: POLL_CHOICES,
									totalVotes: 394,
									multi: false,
									endedAgo: '2d ago',
									myVote: 'warm',
									expired: true
								}, 'which side won?')} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Ended</span>
								<span class="ds-spec-note">expired = true · Ended pill</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Lightbox</div>
					<p class="ds-sub" style="margin-bottom:14px">Triggered by clicking any photo or strip thumbnail. Mounted once at the app root as <code style="font-family:var(--mono);font-size:11px">&lt;AttachmentLightboxHost/&gt;</code>, dispatched globally via <code style="font-family:var(--mono);font-size:11px">openLightbox(attachments, idx, attribution)</code>.</p>
					<div class="ds-spec">
						<div class="ds-spec-stage">
							<div style="padding:18px;text-align:center">
								<Button variant="primary" onclick={() => openLightbox([
									{kind:'photo', src:'samples/falco.png', alt:'station platform at dusk'},
									{kind:'photo', src:'samples/dragon.png', alt:'shrine path'},
									{kind:'photo', src:'samples/cat-door.webp', alt:'door with cat'},
									{kind:'video', poster:'sunset', duration:'0:42', cc:true},
									{kind:'audio', title:'kettle whistle', byline:'orbit · field', duration:'2:14'},
								], 0, {name:'orbit', handle:'@orbit@spacebear.net', avClass:'av-orb'})}>Open lightbox →</Button>
							</div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">Try it</span>
							<span class="ds-spec-note">click any photo above, or this button to open with the full sample set</span>
						</div>
					</div>

					<div class="ds-sub-h">Media treatments</div>
					<p class="ds-sub" style="margin-bottom:14px">Feed photos default to the theme duotone with hover-to-reveal. The halftone treatment is the print-feel enhancement from the handoff — classic hex grid, 9px cells, contrast 6, light grain — rendered through a shared WebGL canvas with the plain image kept as the fallback when WebGL is unavailable.</p>
					<div class="ds-grid ds-grid-3" data-testid="media-treatments">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<img src="samples/cat-bank.webp" alt="cat on a river bank" width="280" height="200" style="display:block;width:100%;height:200px;object-fit:cover;border-radius:6px" />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Original</span>
								<span class="ds-spec-note">no treatment</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<img src="samples/cat-bank.webp" alt="cat on a river bank" width="280" height="200" style="display:block;width:100%;height:200px;object-fit:cover;border-radius:6px;filter:var(--photo-filter)" data-testid="treatment-duotone" />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Duotone · feed default</span>
								<span class="ds-spec-note">SVG feColorMatrix per theme</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<HalftoneImage src="samples/cat-bank.webp" alt="cat on a river bank" width={280} height={200} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Halftone · 9px hex classic</span>
								<span class="ds-spec-note">WebGL shader · falls back to the original image</span>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section id="composer" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">07</div>
					<h2 class="ds-h2">Composer</h2>
					<p class="ds-sub">The post composer. Lives at the top of the feed and inside threads (as a reply composer). Tool rail buttons toggle in-line panels for content warnings and polls; both panels persist as `composer.cw` and `composer.poll` state, attached on Post.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<ComposerMentionEditor value={composerText} onInput={(value) => (composerText = value)} accounts={DS_MENTION_ACCOUNTS} emojis={DS_CUSTOM_EMOJI} />
										<div class="composer-row">
											<button class="composer-tool" title="Image"><Icon name="image" width={18} height={18} /></button>
											<button class="composer-tool" title="Draw">
												<svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px"><path d="M3 21l4-1 11.5-11.5a2.121 2.121 0 00-3-3L4 17l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 6l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
											</button>
											<button class="composer-tool" title="Poll"><Icon name="poll" width={18} height={18} /></button>
											<button class="composer-tool" title="Emoji"><Icon name="smile" width={18} height={18} /></button>
											<button class="composer-tool cw">CW</button>
											<button class="composer-tool privacy"><Icon name="globe" width={13} height={13} /><span>{composerPrivacy}</span><Icon name="chevDown" width={12} height={12} /></button>
											<span class="composer-spacer"></span>
											<span class="composer-count" style={composerRemaining < 50 ? 'color:var(--bad)' : ''}>{composerRemaining}</span>
											<Button variant="primary" disabled={!composerText.trim()}>Post</Button>
										</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Composer · idle</span>
								<span class="ds-spec-note">.composer · no CW, no poll</span>
							</div>
						</div>

						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<ComposerMentionEditor value="every restaurant photo I take ends up looking like a NYT food review somehow" onInput={() => undefined} accounts={DS_MENTION_ACCOUNTS} emojis={DS_CUSTOM_EMOJI} />
										{#if composerCwSpecActive}
											<ComposerCWPanel value={composerCwText} onInput={(value) => (composerCwText = value)} onRemove={() => (composerCwSpecActive = false)} />
										{/if}
										<div class="composer-row">
											<button class="composer-tool" title="Image"><Icon name="image" width={18} height={18} /></button>
											<button class="composer-tool" title="Draw">
												<svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px"><path d="M3 21l4-1 11.5-11.5a2.121 2.121 0 00-3-3L4 17l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 6l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
											</button>
											<button class="composer-tool" title="Poll"><Icon name="poll" width={18} height={18} /></button>
											<button class="composer-tool" title="Emoji"><Icon name="smile" width={18} height={18} /></button>
											<button class="composer-tool cw" class:active={composerCwSpecActive} aria-pressed={composerCwSpecActive} onclick={() => (composerCwSpecActive = !composerCwSpecActive)}>CW</button>
											<button class="composer-tool privacy"><Icon name="globe" width={13} height={13} /><span>Public</span><Icon name="chevDown" width={12} height={12} /></button>
											<span class="composer-spacer"></span>
											<span class="composer-count">416</span>
											<Button variant="primary">Post</Button>
										</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Composer · with CW input</span>
								<span class="ds-spec-note">composer.cw is a string · warn-tinted row above tool rail</span>
							</div>
						</div>

						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<ComposerMentionEditor value="which side wins?" onInput={() => undefined} accounts={DS_MENTION_ACCOUNTS} emojis={DS_CUSTOM_EMOJI} />
										<ComposerPollPanel poll={composerPollSpec} onPollChange={(poll) => (composerPollSpec = poll)} onRemove={() => (composerPollSpec = createComposerPollDraft())} idPrefix="ds-poll-only" />
										<div class="composer-row">
											<button class="composer-tool" title="Image"><Icon name="image" width={18} height={18} /></button>
											<button class="composer-tool" title="Draw">
												<svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px"><path d="M3 21l4-1 11.5-11.5a2.121 2.121 0 00-3-3L4 17l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 6l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
											</button>
											<button class="composer-tool active" title="Poll" aria-label="Poll" aria-pressed="true"><Icon name="poll" width={18} height={18} /></button>
											<button class="composer-tool" title="Emoji"><Icon name="smile" width={18} height={18} /></button>
											<button class="composer-tool cw" aria-pressed="false">CW</button>
											<button class="composer-tool privacy"><Icon name="globe" width={13} height={13} /><span>Public</span><Icon name="chevDown" width={12} height={12} /></button>
											<span class="composer-spacer"></span>
											<span class="composer-count">484</span>
											<Button variant="primary">Post</Button>
										</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Composer · with poll editor</span>
								<span class="ds-spec-note">composer.poll · 2–6 choices · drag handles, duration, single/multi</span>
							</div>
						</div>

						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<ComposerMentionEditor value="rough day. need some external grounding — picking one of these tonight" onInput={() => undefined} accounts={DS_MENTION_ACCOUNTS} emojis={DS_CUSTOM_EMOJI} />
										<ComposerCWPanel value="mh, asking for input" onInput={() => undefined} onRemove={() => undefined} />
										<ComposerPollPanel poll={composerCombinedPollSpec} onPollChange={(poll) => (composerCombinedPollSpec = poll)} onRemove={() => (composerCombinedPollSpec = createComposerPollDraft())} idPrefix="ds-cw-poll" />
										<div class="composer-row">
											<button class="composer-tool" title="Image"><Icon name="image" width={18} height={18} /></button>
											<button class="composer-tool" title="Draw">
												<svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px"><path d="M3 21l4-1 11.5-11.5a2.121 2.121 0 00-3-3L4 17l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 6l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
											</button>
											<button class="composer-tool active" title="Poll" aria-label="Poll" aria-pressed="true"><Icon name="poll" width={18} height={18} /></button>
											<button class="composer-tool" title="Emoji"><Icon name="smile" width={18} height={18} /></button>
											<button class="composer-tool cw active" aria-pressed="true">CW</button>
											<button class="composer-tool privacy"><Icon name="globe" width={13} height={13} /><span>Public</span><Icon name="chevDown" width={12} height={12} /></button>
											<span class="composer-spacer"></span>
											<span class="composer-count">431</span>
											<Button variant="primary">Post</Button>
										</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Composer · CW + poll together</span>
								<span class="ds-spec-note">both panels stack</span>
							</div>
						</div>
					</div>

					<div class="ds-grid ds-grid-2" style="margin-top:14px">
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<div style="padding:14px;background:var(--panel-2);border-radius:4px">
									<div class="composer is-drag-over">
										<Avatar variant="compose" avBanner="sunset" />
										<div>
											<div class="composer-draft-preview">rain on glass · 11 minutes, two takes</div>
											<div class="composer-row" style="opacity:0.4">
												<span style="width:30px;height:30px"></span>
												<span class="composer-spacer"></span>
												<span class="composer-count">412</span>
												<Button variant="primary" disabled>Post</Button>
											</div>
										</div>
										<div class="composer-dropzone" aria-hidden="true">
											<div class="composer-dropzone-card">
												<Icon name="upload" width={22} height={22} />
												<div class="composer-dropzone-h">Drop to attach</div>
												<div class="composer-dropzone-s">photos · audio · video</div>
												<div class="composer-dropzone-meta">Max 8 files · 40 MB each</div>
											</div>
										</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Dropzone V1 · drag-over</span>
								<span class="ds-spec-note">overlay dropzone · accent border + tinted .composer-dropzone over the input</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<div class="composer-draft-preview">rain on glass · 11 minutes, two takes</div>
										<div class="composer-uploads">
											{#each DS_UPLOADS as upload}
												<div class="composer-upload-row">
													<div class={`composer-upload-thumb ${upload.kind}`}>{upload.kind === 'audio' ? 'WAV' : upload.kind === 'video' ? 'MP4' : 'JPG'}</div>
													<div class="composer-upload-meta">
														<div class="composer-upload-name">{upload.name}</div>
														<div class="composer-upload-prog-row">
															<div class="composer-upload-bar"><span style={`width:${upload.pct}%`}></span></div>
															<span class="composer-upload-pct">{upload.pct}%</span>
														</div>
													</div>
													<button type="button" class="composer-upload-rm" aria-label={`Remove ${upload.name}`}>×</button>
												</div>
											{/each}
										</div>
										<div class="composer-row">
											<button class="composer-tool" title="Image"><Icon name="image" width={18} height={18} /></button>
											<button class="composer-tool" title="Draw"><Icon name="pencil" width={18} height={18} /></button>
											<button class="composer-tool" title="Poll"><Icon name="poll" width={18} height={18} /></button>
											<button class="composer-tool" title="Emoji"><Icon name="smile" width={18} height={18} /></button>
											<button class="composer-tool cw" aria-pressed="false">CW</button>
											<button class="composer-tool privacy"><Icon name="globe" width={13} height={13} /><span>Public</span><Icon name="chevDown" width={12} height={12} /></button>
											<span class="composer-spacer"></span>
											<span class="composer-count">412</span>
											<Button variant="primary">Post</Button>
										</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Dropzone V1 · uploading</span>
								<span class="ds-spec-note">.composer-upload-row · 36px thumb · progress bar · per-row ✕</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h" style="margin-top:28px">Attachment dropzone variants · V2 recommended</div>
					<p class="ds-sub" style="margin-bottom:14px">V2 is the recommended handoff pattern: a persistent in-place slot below the editor that becomes upload rows once files are queued.</p>
					<div class="ds-grid ds-grid-2" style="margin-top:14px">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<div class="composer-draft-preview">rain on glass · 11 minutes, two takes</div>
										<button type="button" class="composer-drop-slot">
											<Icon name="upload" width={18} height={18} />
											<span><strong>Drag &amp; drop</strong> <span class="drop-copy-muted">files to attach</span> <em>· or browse</em></span>
											<kbd>⌘V to paste</kbd>
										</button>
										<div class="composer-row"><span class="composer-spacer"></span><span class="composer-count">412</span><Button variant="primary">Post</Button></div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Dropzone V2 · idle · recommended</span>
								<span class="ds-spec-note">always visible · click-to-browse · paste hint</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<div class="composer-draft-preview">rain on glass · 11 minutes, two takes</div>
										<button type="button" class="composer-drop-slot active">
											<Icon name="upload" width={18} height={18} />
											<span><strong>Drop to add 3 files</strong> <span class="drop-copy-muted">· photos · audio · video</span></span>
										</button>
										<div class="composer-row"><span class="composer-spacer"></span><span class="composer-count">412</span><Button variant="primary">Post</Button></div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Dropzone V2 · drag-over</span>
								<span class="ds-spec-note">slot turns accent · copy flips to drop action</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<div class="composer-draft-preview">rain on glass · 11 minutes, two takes</div>
										<div class="composer-uploads">
											{#each DS_UPLOADS_SHORT as upload}
												<div class="composer-upload-row">
													<div class={`composer-upload-thumb ${upload.kind}`}>{upload.kind === 'audio' ? 'WAV' : 'JPG'}</div>
													<div class="composer-upload-meta"><div class="composer-upload-name">{upload.name}</div><div class="composer-upload-prog-row"><div class="composer-upload-bar"><span style={`width:${upload.pct}%`}></span></div><span class="composer-upload-pct">{upload.pct}%</span></div></div>
													<button type="button" class="composer-upload-rm" aria-label={`Remove ${upload.name}`}>×</button>
												</div>
											{/each}
											<div class="composer-upload-row error" title="40 MB limit per file">
												<div class="composer-upload-thumb audio">FLAC</div>
												<div class="composer-upload-meta"><div class="composer-upload-name">raw-master-48bit.flac</div><div class="composer-upload-error">Couldn't attach · 40 MB limit per file.</div></div>
												<button type="button" class="composer-upload-rm" aria-label="Remove raw-master-48bit.flac">×</button>
											</div>
										</div>
										<div class="composer-row"><button class="composer-tool" title="Add another"><Icon name="plus" width={14} height={14} /></button><span class="composer-spacer"></span><span class="composer-count">412</span><Button variant="primary">Post</Button></div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Dropzone V2 · rejected file</span>
								<span class="ds-spec-note">upload rows replace slot · failed row keeps reason inline</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h" style="margin-top:28px">@mention &amp; :shortcode: autocomplete</div>
					<p class="ds-sub" style="margin-bottom:14px">The composer text surface is a contenteditable mention editor. Typing <code style="font-family:var(--mono);font-size:11px">@</code> opens account suggestions, while <code style="font-family:var(--mono);font-size:11px">:</code> plus 2+ shortcode characters opens custom emoji suggestions. Inserted atoms serialize back to federated <code style="font-family:var(--mono);font-size:11px">@user@server</code> and <code style="font-family:var(--mono);font-size:11px">:shortcode:</code> text for status creation.</p>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<div class="mention-demo-stage">
									<div class="me-editor composer-input" role="textbox" aria-label="Inserted mention demo" aria-readonly="true">
										thanks for the recs
										<span class="me-pill" contenteditable="false" data-acct="soft.hertz@kolektiva.social" title="@soft.hertz@kolektiva.social">
											<Avatar variant="plain" element="span" className="me-pill-av" avClass="av-grad-3" avatarUrl="samples/cat-door.webp" alt="soft.hertz ✦ avatar" />
											<span class="me-pill-at">@</span><span class="me-pill-handle">soft.hertz</span>
										</span>
										— going to try qwen 0.5b first.
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Editor · with inserted pill</span>
								<span class="ds-spec-note">contenteditable · pill is a contenteditable=false atom inside the body</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage padded">
								<div class="mention-demo-popover">
									<div class="mention-demo-line">thanks for the recs <span>@sof</span><span class="me-caret-static"></span></div>
									<div class="me-pop static">
										<div class="me-pop-l">Suggestions · 4 results</div>
										<div class="me-pop-list" role="listbox" aria-label="Static mention suggestions">
											{#each DS_MENTION_ACCOUNTS as account, index}
												<div class="me-row" class:sel={index === 0} role="option" aria-selected={index === 0}>
													<Avatar variant="plain" element="span" className="me-row-av" avClass={account.avClass} avatarUrl={account.avatarUrl} alt={`${account.displayName} avatar`} />
													<span class="me-row-name">{account.displayName}</span>
													<span class="me-row-acct">@{account.acct}</span>
													{#if index === 0}<span class="me-row-go"><span class="me-kbd">Tab</span></span>{/if}
												</div>
											{/each}
										</div>
										<div class="me-pop-foot"><span class="me-kbd">↑↓</span> navigate · <span class="me-kbd">Tab</span> insert · <span class="me-kbd">Esc</span> dismiss</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Dropdown · open mid-type</span>
								<span class="ds-spec-note">anchored to the @ position · slim rows + Tab hint on selected</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage padded">
								<div class="mention-demo-popover shortcode-context">
									<div class="mention-demo-line">that expression is pure <span>:{DS_SHORTCODE_QUERY}</span><span class="me-caret-static"></span></div>
									<div class="me-pop static shortcode-demo">
										<div class="me-pop-l">Emoji · {DS_SHORTCODE_EMOJI.length} matches</div>
										<div class="me-pop-list" role="listbox" aria-label="Static emoji suggestions">
											{#each DS_SHORTCODE_EMOJI as emoji, index}
												<div class="me-row" class:sel={index === 0} role="option" aria-selected={index === 0}>
													<span class="me-row-emoji"><img src={emoji.url} alt={`:${emoji.shortcode}:`} /></span>
													<span class="me-row-sc">:{emoji.shortcode}:</span>
													<span class="me-row-pack">{emoji.pack}</span>
													{#if index === 0}<span class="me-row-go"><span class="me-kbd">Tab</span></span>{/if}
												</div>
											{/each}
										</div>
										<div class="me-pop-foot"><span><span class="me-kbd">↑↓</span> navigate · <span class="me-kbd">Tab</span> insert · <span class="me-kbd">Esc</span> dismiss</span></div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">:shortcode: dropdown</span>
								<span class="ds-spec-note">same row chrome — emoji preview + :sc: + pack tag · works for any 2+ char prefix</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage padded">
								<EmojiPicker static open emojis={DS_CUSTOM_EMOJI} recents={[DS_CUSTOM_EMOJI[0], DS_CUSTOM_EMOJI[1], '🔥', '❤️', '✨']} onClose={() => undefined} onPick={() => undefined} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Full emoji picker</span>
								<span class="ds-spec-note">&lt;EmojiPicker/&gt; · opened by the composer's 😀 button · sidebar of packs + grid + search</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<div class="composer">
									<Avatar variant="compose" avBanner="sunset" />
									<div>
										<ComposerMentionEditor
											value={composerAutocompleteText}
											onInput={(value) => (composerAutocompleteText = value)}
											accounts={DS_MENTION_ACCOUNTS}
											emojis={DS_CUSTOM_EMOJI}
										/>
										<div class="composer-row">
											<button class="composer-tool" title="Image"><Icon name="image" width={18} height={18} /></button>
											<button class="composer-tool" title="Poll"><Icon name="poll" width={18} height={18} /></button>
											<button class="composer-tool active" title="Emoji"><Icon name="smile" width={18} height={18} /></button>
											<button class="composer-tool cw" aria-pressed="false">CW</button>
											<button class="composer-tool privacy"><Icon name="globe" width={13} height={13} /><span>Public</span><Icon name="chevDown" width={12} height={12} /></button>
											<span class="composer-spacer"></span>
											<span class="composer-count" class:over-limit={composerAutocompleteRemaining < 0}>{composerAutocompleteRemaining}</span>
											<Button variant="primary" disabled={!composerAutocompleteText.trim()}>Post</Button>
										</div>
										<div class="ds-code" data-serialized-text>{composerAutocompleteText || 'serialized status text appears here'}</div>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Interactive editor · autocomplete</span>
								<span class="ds-spec-note">Svelte implementation · @account + :emoji: atoms serialize to status text</span>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section id="posts" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">08</div>
					<h2 class="ds-h2">Posts</h2>
					<p class="ds-sub">The canonical post composes Avatar + PostHead + body + PostMedia + PostActions. Every post-shaped surface uses the same atoms.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-sub-h">Post anatomy</div>
					<div class="ds-anatomy">
						<div class="ds-anatomy-fig ds-post-anatomy" style="max-width:620px">
							<Post post={PHOTO_POST} onAction={() => {}} />
							<div class="ds-anatomy-marker ds-mk-1">1</div>
							<div class="ds-anatomy-marker ds-mk-2">2</div>
							<div class="ds-anatomy-marker ds-mk-3">3</div>
							<div class="ds-anatomy-marker ds-mk-4">4</div>
							<div class="ds-anatomy-marker ds-mk-5">5</div>
						</div>
						<ul class="ds-anatomy-list">
							<li><span class="m">1</span> <b>Avatar</b> · post variant, 40–48px</li>
							<li><span class="m">2</span> <b>PostHead</b> · name, handle, relative time</li>
							<li><span class="m">3</span> <b>PostBody</b> · body + inline @mentions + optional pinged footer</li>
							<li><span class="m">4</span> <b>PostMedia</b> · dispatches to PhotoGrid / Video / Audio</li>
							<li><span class="m">5</span> <b>PostActions</b> · reply / boost / fav + overflow</li>
						</ul>
					</div>

					<div class="ds-sub-h">Body, mentions &amp; reply addressees</div>
					<p class="ds-sub" style="margin-bottom:14px">The <code style="font-family:var(--mono);font-size:11px">&lt;PostBody/&gt;</code> primitive auto-parses <code style="font-family:var(--mono);font-size:11px">@handle</code> patterns in the body string and renders them as inline links. A separate <code style="font-family:var(--mono);font-size:11px">addressees</code> array (the leading recipient pile-up from a fediverse reply) renders as a "Replying to" footer below the body, so the first line of a reply stays content, not a recipient list. The <b>first</b> element of <code style="font-family:var(--mono);font-size:11px">addressees</code> is, by convention, the author of the post being directly replied to — it renders as a ghost chip prefixed with a ↪ glyph (the glyph is what marks the role; the chip fill matches the cc chips so it doesn't dominate the post body). The rest are inherited cc-addressees and render as the same ghost chip without the glyph, after an <code style="font-family:var(--mono);font-size:11px">· also</code> divider.</p>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([], "thanks for the recs @datagram — going to try qwen 0.5b first and then jan-nano if it doesn't cut it. @feld did you end up testing josie?")} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Body only</span>
								<span class="ds-spec-note">no addressees · just inline mention parsing</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={{...demoPost([]), body: 'agreed — this is exactly what I needed to hear today.', addressees: ['@gridwave']}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Reply · parent only</span>
								<span class="ds-spec-note">addressees=[parent] · ghost chip + ↪ glyph · no 'also'</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={{...demoPost([]), body: 'qwen 0.5b can handle some limited summary tasks. theres also the JOSIE models which are jailbroken qwens.', addressees: ['@dtluna@retro.social', '@feld@queer.party', '@lain']}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Reply + cc-list</span>
								<span class="ds-spec-note">addressees=[parent, …cc] · all ghost chips · parent prefixed with ↪</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={{...demoPost([]), body: 'agreed with @datagram — the slow web feels possible again. tagging @soft.hertz too, this was your point yesterday', addressees: ['@datagram', '@gridwave', '@nyan', '@soft.hertz', '@orbit', '@lumen', '@kestrel.fm']}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Long cc-chain</span>
								<span class="ds-spec-note">parent stays prominent · cc-list wraps to second row</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Quoted posts</div>
					<p class="ds-sub" style="margin-bottom:14px">The <code style="font-family:var(--mono);font-size:11px">&lt;QuotedPost/&gt;</code> primitive embeds a referenced post inside any other. With media, it renders a horizontal smart-card (hero on the left, body on the right). Without media, it falls back to a vertical embedded card with the engagement footer. Quoted media is always a preview — videos and audio never play inline, since the original is one click away.</p>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([], "this perfectly captures my feelings about saturday morning", { name: 'kestrel.fm', handle: '@kestrel@audio.garden', avClass: 'av-grad-3', time: '2h', body: "the moment between waking up and remembering you have responsibilities is the most peaceful state known to humanity", attachments: [{ kind: 'photo', src: 'samples/cat-door.webp' }], replies: 12, boosts: 87, favs: 312 })} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With 1 photo</span>
								<span class="ds-spec-note">smart-card · hero photo · body + attribution</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([], "agreed @soft.hertz — sharing in case anyone missed it the first time.", { name: 'soft.hertz', handle: '@soft.hertz@kolektiva.social', avClass: 'av-grad-3', time: '3h', body: "the algorithm doesn't care about you. the timeline doesn't either. but the people in it do, and that's worth keeping.", attachments: [], replies: 8, boosts: 34, favs: 142 })} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Text only (fallback)</span>
								<span class="ds-spec-note">no media → embedded card · header + body + footer</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([], "this whole walk was great. photos + the kettle audio.", { name: 'orbit', handle: '@orbit@spacebear.net', avClass: 'av-orb', time: '5h', body: "field walk yesterday — a couple of photos and the kettle clip i mentioned.", attachments: [{ kind: 'photo', src: 'samples/falco.png' }, { kind: 'photo', src: 'samples/dragon.png' }, { kind: 'video', poster: 'sunset', duration: '0:42' }, { kind: 'audio', title: 'kettle whistle', duration: '2:14' }], replies: 7, boosts: 24, favs: 116 })} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With multiple media</span>
								<span class="ds-spec-note">smart-card · hero photo + "+N" overflow badge</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={demoPost([], "the cinematography here, especially the kettle scene.", { name: 'pixelmoth', handle: '@pixelmoth@retro.social', avClass: 'av-pixel-pc', time: '6h', body: "cassette deck loop i recorded out the kitchen window.", attachments: [{ kind: 'video', poster: 'sunset', duration: '0:42', cc: true }], replies: 3, boosts: 12, favs: 58 })} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With video hero</span>
								<span class="ds-spec-note">smart-card · poster + play badge · no inline player</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={demoPost([], "have not stopped listening to this all week.", { name: 'kestrel.fm', handle: '@kestrel@audio.garden', avClass: 'av-grad-3', time: '3d', body: "demo from last night's basement set. 12 minutes of synths, one take, no edits.", attachments: [{ kind: 'audio', title: 'after the storm (demo)', byline: 'kestrel · 2026', duration: '4:18', cover: 'samples/encardia-99.png' }], replies: 6, boosts: 19, favs: 84 })} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With audio hero</span>
								<span class="ds-spec-note">smart-card · gradient cover with serif initial</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Variants</div>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={SAMPLE_POST} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Text only</span>
								<span class="ds-spec-note">no media</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={BANNER_POST} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With banner avatar</span>
								<span class="ds-spec-note">avBanner='sunset'</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={PHOTO_POST} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With one photo</span>
								<span class="ds-spec-note">post.photos.length === 1</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={PHOTOS3_POST} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With multiple photos</span>
								<span class="ds-spec-note">post-photos.n3</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={VIDEO_POST} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With video</span>
								<span class="ds-spec-note">post.video</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={AUDIO_POST} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">With audio</span>
								<span class="ds-spec-note">post.audio</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Content warnings</div>
					<p class="ds-sub" style="margin-bottom:14px">Setting <code style="font-family:var(--mono);font-size:11px">post.cw</code> to a summary string folds the body, quoted post, and ALL media into a warn-tinted card. The reader presses <i>Show post</i> to reveal; once revealed, a compact summary strip with a Hide link replaces the card so the content can be re-folded. The <code style="font-family:var(--mono);font-size:11px">&lt;PostCW/&gt;</code> primitive wraps the hidden region — used internally by <code style="font-family:var(--mono);font-size:11px">Post / AncestorPost / ReplyPost</code>.</p>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={{
									...SAMPLE_POST,
									id: 'ds-cw-1',
									name: 'mossy',
									handle: '@mossy@garden.cafe',
									time: '2h',
									avClass: 'av-grad-3',
									cw: 'food, plated photos',
									body: 'every restaurant photo I take ends up looking like a NYT food review somehow. is there a special app for that or is it just learned posture',
									attachments: [
										{ kind: 'photo', src: 'samples/cat-bank.webp', alt: '' },
										{ kind: 'photo', src: 'samples/cat-door.webp', alt: '' }
									],
									replies: 4,
									boosts: 3,
									favs: 22
								}} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Folded · with media</span>
								<span class="ds-spec-note">post.cw set · body + photos hidden</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={{
									...SAMPLE_POST,
									id: 'ds-cw-2',
									name: 'datagram',
									handle: '@datagram@retro.social',
									time: '5h',
									avClass: 'av-pixel-pc',
									cw: 'Severance · S2 finale spoilers',
									body: 'ok the elevator scene. the ELEVATOR scene. I have been thinking about it for 48 hours straight. spoilers for S2E10 in this thread, ye be warned.',
									replies: 1,
									boosts: 0,
									favs: 7
								}} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Folded · text only</span>
								<span class="ds-spec-note">no attachments · no chips row</span>
							</div>
						</div>
						<div class="ds-spec">
							<div class="ds-spec-stage">
								<Post post={{
									...SAMPLE_POST,
									id: 'ds-cw-3',
									name: 'kestrel',
									handle: '@kestrel@audio.garden',
									time: '1h',
									avClass: 'av-grad-3',
									cw: 'mh, asking for input',
									body: "rough day. need some external grounding — picking one of these tonight, vote what you'd do",
									attachments: [{
										kind: 'poll',
										id: 'ds-cw-poll',
										choices: [
											{ id: 'walk', label: 'long walk', votes: 12 },
											{ id: 'call', label: 'call a friend', votes: 8 },
											{ id: 'rest', label: 'just sleep', votes: 4 }
										],
										totalVotes: 24,
										multi: false,
										endsIn: '4h',
										myVote: null,
										expired: false
									}],
									replies: 2,
									boosts: 0,
									favs: 9
								}} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Folded · with poll</span>
								<span class="ds-spec-note">poll counted in meta chips</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Boosts</div>
					<p class="ds-sub" style="margin-bottom:14px">When a post is reshared (boosted), the original post is rendered inside a <code style="font-family:var(--mono);font-size:11px">&lt;PostBoost/&gt;</code> wrapper. A 4px accent-green left edge runs the full height of the boost; a horizontal attribution row at the top carries a small "boost" tag pill, the repeater's mini-avatar, name, handle, and short relative time. Long names get the full row width — the layout is identical at all viewport sizes.</p>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={{
									...SAMPLE_POST,
									id: 'ds-boost-1',
									name: 'soft.hertz',
									handle: '@soft.hertz@kolektiva.social',
									time: '3h',
									avClass: 'av-grad-3',
									boostedBy: { name: 'FiestaBun', handle: '@FiestaBun@decayable.ink', avClass: 'av-pixel-pc', time: '35m' },
									body: "the algorithm doesn't care about you. the timeline doesn't either. but the people in it do, and that's worth keeping.",
									replies: 8,
									boosts: 34,
									favs: 142
								}} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Boosted · text post</span>
								<span class="ds-spec-note">post.boostedBy = {'{ name, handle, avClass, time }'}</span>
							</div>
						</div>
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={{
									...SAMPLE_POST,
									id: 'ds-boost-2',
									name: 'orbit',
									handle: '@orbit@spacebear.net',
									time: '8h',
									avClass: 'av-orb',
									boostedBy: { name: 'datagram', handle: '@datagram@retro.social', avClass: 'av-pixel-pc', time: '12m' },
									body: 'dusk in the city 🌆',
									attachments: [{ kind: 'photo', src: 'samples/falco.png', alt: 'station platform at dusk' }],
									replies: 4,
									boosts: 15,
									favs: 120
								}} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Boosted · with photo</span>
								<span class="ds-spec-note">left edge runs full height regardless of content</span>
							</div>
						</div>
					</div>

					<div class="ds-sub-h">Emoji reactions · V3c letterpress</div>
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec ds-spec-span-2">
							<div class="ds-spec-stage">
								<Post post={{
									...SAMPLE_POST,
									id: 'ds-reactions-1',
									body: "the algorithm doesn't care about you. the timeline doesn't either. but the people in it do, and that's worth keeping.",
									reactions: [
										{ name: '❤️', glyph: '❤️', url: null, staticUrl: null, count: 24, me: true },
										{ name: 'pleromasummer', glyph: null, url: 'samples/dragon.png', staticUrl: 'samples/dragon.png', count: 18, me: false },
										{ name: '🔥', glyph: '🔥', url: null, staticUrl: null, count: 12, me: false },
										{ name: 'blobcat', glyph: null, url: 'samples/dragon.png', staticUrl: 'samples/dragon.png', count: 9, me: false },
										{ name: '😂', glyph: '😂', url: null, staticUrl: null, count: 6, me: false },
										{ name: '🌆', glyph: '🌆', url: null, staticUrl: null, count: 3, me: false }
									],
									replies: 8,
									boosts: 34,
									favs: 142
								}} onAction={() => {}} />
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">Reaction row · letterpress stamps</span>
								<span class="ds-spec-note">warm-cream perforated stamps · count caption below · accent paper for "you" · add affordance</span>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section id="thread" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">09</div>
					<h2 class="ds-h2">Thread</h2>
					<p class="ds-sub">The thread view stacks three post shapes — Ancestor (collapsed), Focused (expanded with meta), Reply (with branching line). Pressing Reply on any post unfolds an inline composer beneath it, pre-addressed to that author, with its own tool rail.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-spec">
						<div class="ds-spec-stage ds-thread-stage">
							<div class="card thread ds-thread-demo-card">
								<div class="thread-head">
									<button type="button" class="thread-back" aria-label="Back"><Icon name="arrowL" width={18} height={18} /></button>
									<div class="thread-head-title">Thread</div>
									<button type="button" class="tab-action" title="Refresh">
										<svg viewBox="0 0 24 24" fill="none" style="width:16px;height:16px"><path d="M4 12a8 8 0 0114-5.3L20 9M20 4v5h-5M20 12a8 8 0 01-14 5.3L4 15M4 20v-5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
									</button>
									<button type="button" class="tab-action" title="More"><Icon name="more" width={16} height={16} /></button>
								</div>

								{#if THREAD_DEMO.ancestors.length > 0}
									<div class="thread-ancestors">
										{#each THREAD_DEMO.ancestors as ancestor (ancestor.id)}
											<AncestorPost post={ancestor} replyExpanded={threadInlineReplyOpenFor(ancestor.id)} replyControlsId={threadInlineReplyOpenFor(ancestor.id) ? threadInlineReplyComposerId(ancestor.id) : undefined} onAction={handleThreadReplyAction} />
											{#if threadInlineReplyOpenFor(ancestor.id) && threadInlineReplyComposerProps}
												<InlineReplyComposer
													id={threadInlineReplyComposerId(ancestor.id)}
													{...threadInlineReplyComposerProps}
												/>
											{/if}
										{/each}
									</div>
								{/if}

								<FocusedPost post={THREAD_DEMO.focused} continuesAbove={THREAD_DEMO.ancestors.length > 0} replyExpanded={threadInlineReplyOpenFor(THREAD_DEMO.focused.id)} replyControlsId={threadInlineReplyOpenFor(THREAD_DEMO.focused.id) ? threadInlineReplyComposerId(THREAD_DEMO.focused.id) : undefined} onAction={handleThreadReplyAction} />
								{#if threadInlineReplyOpenFor(THREAD_DEMO.focused.id) && threadInlineReplyComposerProps}
									<InlineReplyComposer
										id={threadInlineReplyComposerId(THREAD_DEMO.focused.id)}
										{...threadInlineReplyComposerProps}
									/>
								{/if}

								<div class="thread-reply-head">
									<div class="thread-reply-count"><Icon name="reply" width={13} height={13} /><span>{THREAD_DEMO.replies.length} replies</span></div>
									<div class="seg" style="margin-left:auto">
										<button type="button" class="active">Top</button>
										<button type="button">Newest</button>
									</div>
								</div>

								<div class="thread-replies">
									{#each THREAD_DEMO.replies as reply, i (reply.id)}
										<ReplyPost
											post={reply}
											isLast={i === THREAD_DEMO.replies.length - 1}
											nestedReplies={reply.nestedReplies}
											onAction={handleThreadReplyAction}
											inlineReply={threadInlineReplyBinding}
											onShowNested={() => {}}
										/>
									{/each}
								</div>
							</div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">Full thread</span>
							<span class="ds-spec-note">AncestorPost → FocusedPost → ReplyPost</span>
						</div>
					</div>
				</div>
			</section>

			<section id="profile" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">10</div>
					<h2 class="ds-h2">Profile</h2>
					<p class="ds-sub">Canonical account profile route: header, relationship badges, pinned posts, timeline tabs, media grid, and side rail.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-spec">
						<div class="ds-spec-stage ds-profile-stage">
							<div class="ds-profile-shell">
								<ProfileView
									profile={PROFILE_DEMO}
									posts={PROFILE_POSTS}
									replies={PROFILE_REPLIES}
									pinned={PROFILE_PINNED}
									media={PROFILE_MEDIA}
								/>
								<div class="ds-profile-side"><ProfileSideRail profile={PROFILE_DEMO} pinned={PROFILE_PINNED} /></div>
							</div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">Full profile</span>
							<span class="ds-spec-note">ProfileView → ProfileSideRail</span>
						</div>
					</div>
				</div>
			</section>

			<section id="notifications" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">11</div>
					<h2 class="ds-h2">Notifications</h2>
					<p class="ds-sub">Six kinds — mention, fav, boost, reply, follow, follow_req, poll. Each kind has a tint and an icon.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-grid ds-grid-2">
						{#each NOTIFICATION_PREVIEW_SPECS as spec (spec.label)}
							<div class="ds-spec">
								<div class="ds-spec-stage">
									<NotifRow n={spec.notification} onAccept={() => undefined} onReject={() => undefined} />
								</div>
								<div class="ds-spec-foot">
									<span class="ds-spec-label">{spec.label}</span>
									<span class="ds-spec-note">{spec.note}</span>
								</div>
							</div>
						{/each}
					</div>

					<div class="ds-sub-h" style="margin-top:18px">Popover (header bell)</div>
					<div class="ds-spec">
						<div class="ds-spec-stage ds-notif-pop-stage">
							<div class="ds-notif-pop-wrap">
								<NotifsPopover onAcceptFollowRequest={() => undefined} onRejectFollowRequest={() => undefined} />
							</div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">NotifsPopover</span>
							<span class="ds-spec-note">header bell · 8 rows · See all →</span>
						</div>
					</div>
				</div>
			</section>

			<section id="radio" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">12</div>
					<h2 class="ds-h2">Radio · PN.fm</h2>
					<p class="ds-sub">A persistent server-radio dock. Floats bottom-left in the live app. Two states (compact bar, expanded panel), four sample albums.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-sub-h">Now playing line</div>
					<div class="ds-spec">
						<div class="ds-spec-stage padded">
							<div class="ds-nps-stack">
								<div class="ds-nps-wrap">
									<div class="ds-nps-label">playing</div>
									<NowPlayingLine playing track="pacific hour" artist="neon.cassette" tint="#a48bd9" />
								</div>
								<div class="ds-nps-wrap">
									<div class="ds-nps-label">paused</div>
									<NowPlayingLine playing={false} track="pacific hour" artist="neon.cassette" tint="#a48bd9" />
								</div>
							</div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">NowPlayingLine</span>
							<span class="ds-spec-note">shown in user menu &amp; profile mini</span>
						</div>
					</div>

					<div class="ds-sub-h">Compact bar (collapsed)</div>
					<div class="ds-spec">
						<div class="ds-spec-stage ds-radio-stage">
							<div class="ds-radio-host"><Radio inline /></div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">Radio · bar</span>
							<span class="ds-spec-note">.radio · default state</span>
						</div>
					</div>

					<div class="ds-sub-h">Expanded panel</div>
					<div class="ds-spec">
						<div class="ds-spec-stage ds-radio-stage tall">
							<div class="ds-radio-host"><Radio inline forceOpen forceView="now" /></div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">Radio · Now playing tab</span>
							<span class="ds-spec-note">.radio.open · panel + tracklist</span>
						</div>
					</div>
					<div class="ds-spec">
						<div class="ds-spec-stage ds-radio-stage tall">
							<div class="ds-radio-host"><Radio inline forceOpen forceView="albums" /></div>
						</div>
						<div class="ds-spec-foot">
							<span class="ds-spec-label">Radio · Albums tab</span>
							<span class="ds-spec-note">.radio.open · view=albums</span>
						</div>
					</div>
				</div>
			</section>

			<section id="oekaki" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">13</div>
					<h2 class="ds-h2">Oekaki</h2>
					<p class="ds-sub">In-composer drawing tool. Fullscreen modal triggered from the composer pencil button. Tool rail, canvas, side panel (color / brush / layers).</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-sub-h">Anatomy</div>
					<div class="ds-anatomy">
						<div class="ds-anatomy-fig ds-oekaki-anatomy">
							<div class="ds-oekaki-scale" inert aria-hidden="true">
								<OekakiModal open preview />
							</div>
							<div class="ds-anatomy-marker ds-omk-1">1</div>
							<div class="ds-anatomy-marker ds-omk-2">2</div>
							<div class="ds-anatomy-marker ds-omk-3">3</div>
							<div class="ds-anatomy-marker ds-omk-4">4</div>
							<button type="button" class="ds-oekaki-launch" onclick={() => (oekakiOpen = true)}>Launch fullscreen →</button>
							{#if oekakiOpen}
								<OekakiModal open onClose={() => (oekakiOpen = false)} onAttach={() => (oekakiOpen = false)} />
							{/if}
						</div>
						<ul class="ds-anatomy-list">
							<li><span class="m">1</span> <span><b>Tool rail</b> · 9 tools (brush, pen, eraser, fill, eyedrop, rect, circle, line, text)</span></li>
							<li><span class="m">2</span> <span><b>Canvas</b> · 800×600 native, zoom + cursor readout</span></li>
							<li><span class="m">3</span> <span><b>Side panel</b> · Color swatches + free picker, brush size/opacity/flow, layer stack</span></li>
							<li><span class="m">4</span> <span><b>Footer</b> · Clear / Save draft / Attach to post</span></li>
						</ul>
					</div>
				</div>
			</section>

			<section id="surfaces" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">14</div>
					<h2 class="ds-h2">Surfaces</h2>
					<p class="ds-sub">Cards and the right-rail card library. Each card is title + content + optional foot link.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-grid ds-grid-3">
						{#each SURFACE_SPECS as spec}
							<div class={`ds-spec${spec.span === 2 ? ' ds-spec-span-2' : ''}`}>
								<div class="ds-spec-stage ds-surface-stage">
									<SurfaceCard kind={spec.kind} />
								</div>
								<div class="ds-spec-foot">
									<span class="ds-spec-label">{spec.label}</span>
									<span class="ds-spec-note">{spec.note}</span>
								</div>
							</div>
						{/each}
					</div>
				</div>
			</section>

			<section id="navigation" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">15</div>
					<h2 class="ds-h2">Navigation</h2>
					<p class="ds-sub">Header, side nav, profile mini. The shell-level chrome.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-grid ds-grid-2">
						<div class="ds-spec">
							<div class="ds-spec-stage ds-navigation-stage">
								<div class="ds-navigation-card-wrap"><ProfileMini /></div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">ProfileMini</span>
								<span class="ds-spec-note">left column · top of stack</span>
							</div>
						</div>

						<div class="ds-spec">
							<div class="ds-spec-stage ds-navigation-stage">
								<div class="ds-navigation-card-wrap">
									<div class="card ds-side-nav-card">
										<nav class="side-nav" aria-label="Design-system side navigation specimen">
											{#each NAV_PREVIEW_ITEMS as item}
												<button type="button" class:active={item.active} class="side-nav-item">
													<span class="ico"><Icon name={item.icon} width={18} height={18} /></span>
													<span>{item.label}</span>
													{#if item.count}<span class="count">{item.count}</span>{/if}
												</button>
											{/each}
										</nav>
									</div>
								</div>
							</div>
							<div class="ds-spec-foot">
								<span class="ds-spec-label">SideNav (placeholder)</span>
								<span class="ds-spec-note">.side-nav inside a card</span>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section id="mobile" class="ds-slab">
				<header class="ds-slab-head">
					<div class="ds-kicker">16</div>
					<h2 class="ds-h2">Mobile</h2>
					<p class="ds-sub">The same components, scaled into a 375-wide viewport. Bottom tab bar, drawer (left), sheet (right) replace the rails.</p>
				</header>
				<div class="ds-slab-body">
					<div class="ds-phone-row">
						{#each MOBILE_PREVIEWS as preview}
							<MobilePreview variant={preview.variant} label={preview.label} />
						{/each}
					</div>
				</div>
			</section>

			<footer class="ds-foot">
				<div>End of system · everything else is composed from what's above.</div>
				<div>DeltaNet™ Design System · v2.4.58 · {new Date().getFullYear()}</div>
			</footer>
		</main>
	</div>
</div>

<style>
	.ds-page {
		min-height: 100vh;
		background: var(--bg);
		color: var(--ink);
		font-family: var(--sans);
	}

	/* ===== Header ===== */
	.ds-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 18px 32px;
		background: var(--panel);
		border-bottom: 1px solid var(--border);
		position: sticky;
		top: 0;
		z-index: 50;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.brand-mark {
		width: 48px;
		height: 48px;
		background: #1c2046;
		border-radius: 4px;
		display: grid;
		place-items: center;
		flex-shrink: 0;
	}

	.brand-mark svg {
		width: 30px;
		height: 30px;
	}

	.brand-name {
		font-family: var(--serif);
		font-size: 32px;
		font-weight: 500;
		letter-spacing: -0.01em;
		color: var(--ink);
		line-height: 1;
		position: relative;
		display: inline-block;
	}

	.brand-name sup {
		font-family: var(--sans);
		font-size: 10px;
		font-weight: 500;
		color: var(--muted);
		margin-left: 2px;
		vertical-align: super;
	}

	.ds-header .brand-mark {
		width: 44px;
		height: 44px;
	}

	.ds-header .brand-mark svg {
		width: 28px;
		height: 28px;
	}

	.ds-brand-title {
		font-size: 26px;
	}

	.ds-brand-subtitle {
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--muted);
		margin-top: 2px;
	}

	.ds-header-r {
		display: flex;
		align-items: center;
		gap: 18px;
	}

	.ds-app-link {
		font-family: var(--mono);
		font-size: 11px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 2px;
		background: var(--bg);
		transition: background 0.15s, color 0.15s;
	}

	.ds-app-link:hover {
		background: var(--accent-soft);
	}

	.ds-theme-picker {
		display: flex;
		gap: 6px;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: 2px;
		background: var(--bg);
	}

	.ds-theme-chip {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 4px 5px;
		font-family: var(--mono);
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
		border-radius: 2px;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.ds-theme-chip:hover {
		color: var(--ink);
	}

	.ds-theme-chip.active {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}

	.ds-theme-swatch {
		position: relative;
		width: 22px;
		height: 22px;
		border-radius: 2px;
		border: 1px solid var(--border-strong);
		display: block;
		overflow: hidden;
	}

	.ds-theme-swatch span:nth-child(1) {
		position: absolute;
		inset: auto 0 0 0;
		height: 50%;
		display: block;
	}

	.ds-theme-swatch span:nth-child(2) {
		position: absolute;
		inset: 0 50% 50% 0;
		display: block;
		opacity: 0.4;
	}

	/* ===== Layout ===== */
	.ds-body {
		display: grid;
		grid-template-columns: 220px 1fr;
		max-width: 1440px;
		margin: 0 auto;
	}

	.ds-nav {
		position: sticky;
		top: 80px;
		align-self: start;
		padding: 32px 0 32px 32px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		max-height: calc(100vh - 80px);
		overflow-y: auto;
	}

	.ds-nav-label {
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--muted-2);
		margin-bottom: 12px;
		padding: 0 12px;
	}

	.ds-nav-item {
		display: block;
		padding: 7px 12px;
		font-size: 13px;
		color: var(--ink-2);
		border-left: 1px solid var(--border);
		transition: background 0.12s, color 0.12s, border-color 0.12s;
	}

	.ds-nav-item:hover {
		background: var(--accent-soft-2);
		color: var(--ink);
	}

	.ds-nav-item.active {
		color: var(--accent-ink);
		border-left-color: var(--accent);
		background: var(--accent-soft-2);
	}

	.ds-nav-foot {
		margin-top: 24px;
		padding: 12px;
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.06em;
		color: var(--muted-2);
		border-top: 1px solid var(--border);
		display: grid;
		gap: 4px;
	}

	.ds-main {
		padding: 32px 48px 80px;
		min-width: 0;
	}

	/* ===== Slab ===== */
	.ds-slab {
		padding-top: 16px;
		padding-bottom: 56px;
		border-bottom: 1px solid var(--border);
		margin-bottom: 32px;
		scroll-margin-top: 90px;
	}

	.ds-slab:last-of-type {
		border-bottom: none;
	}

	.ds-slab-head {
		margin-bottom: 24px;
		max-width: 720px;
	}

	.ds-kicker {
		font-family: var(--mono);
		font-size: 11px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--accent-ink);
		margin-bottom: 8px;
	}

	.ds-h2 {
		font-family: var(--serif);
		font-weight: 500;
		font-size: 36px;
		line-height: 1.05;
		letter-spacing: -0.02em;
		margin: 0;
		color: var(--ink);
	}

	.ds-sub {
		font-size: 14px;
		line-height: 1.55;
		color: var(--ink-2);
		margin: 10px 0 0;
		max-width: 60ch;
		text-wrap: pretty;
	}

	.ds-sub-h {
		font-family: var(--mono);
		font-size: 11px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--muted);
		margin: 28px 0 14px;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}

	.ds-sub-h:first-child {
		margin-top: 0;
	}

	/* ===== Grid ===== */
	.ds-grid {
		display: grid;
		gap: 18px;
	}

	:global(.ds-grid-2) {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	:global(.ds-grid-3) {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.ds-grid-4 {
		grid-template-columns: repeat(4, minmax(0, 1fr));
	}

	/* ===== Color tokens ===== */
	.ds-tok-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
		gap: 8px;
	}

	.ds-tok {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px;
		border: 1px solid var(--border);
		background: var(--panel);
		border-radius: 2px;
	}

	.ds-tok-swatch {
		width: 44px;
		height: 44px;
		flex-shrink: 0;
		border-radius: 2px;
		border: 1px solid var(--border);
		display: grid;
		place-items: center;
		font-family: var(--serif);
		font-size: 22px;
		line-height: 1;
	}

	.ds-tok-meta {
		min-width: 0;
	}

	.ds-tok-name {
		font-family: var(--mono);
		font-size: 11px;
		letter-spacing: 0.04em;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ds-tok-val {
		font-size: 10.5px;
		color: var(--muted);
		margin-top: 2px;
	}

	/* ===== Type ===== */
	.ds-type-stack {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ds-type-row {
		padding: 18px 20px;
		border: 1px solid var(--border);
		background: var(--panel);
		border-radius: 2px;
	}

	.ds-type-sample {
		font-size: 32px;
		line-height: 1.15;
		color: var(--ink);
		margin-bottom: 8px;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	:global(.ds-media-thumb-cell img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.ds-type-meta {
		font-family: var(--mono);
		font-size: 10.5px;
		letter-spacing: 0.08em;
		color: var(--muted);
		text-transform: uppercase;
	}

	/* ===== Theme cards ===== */
	.ds-theme-card {
		border: 1px solid;
		border-radius: 2px;
		overflow: hidden;
		min-height: 110px;
	}

	.ds-theme-card-head {
		padding: 10px 12px;
		border-bottom: 1px solid;
	}

	.ds-theme-card-title {
		font-family: var(--serif);
		font-size: 20px;
		line-height: 1;
	}

	.ds-theme-card-sub {
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		margin-top: 4px;
	}

	.ds-theme-card-swatches {
		padding: 12px;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 4px;
	}

	.ds-theme-card-swatches span {
		height: 28px;
		border: 0;
	}

	.ds-theme-card-swatches span:first-child {
		border: 1px solid;
	}

	/* ===== Icon gallery ===== */
	.ds-icon-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: 8px;
	}

	.ds-icon-cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 14px 8px 10px;
		border: 1px solid var(--border);
		background: var(--panel);
		border-radius: 2px;
	}

	.ds-icon-box {
		width: 40px;
		height: 40px;
		border: 1px solid var(--border);
		background: var(--bg);
		display: grid;
		place-items: center;
		color: var(--ink);
		border-radius: 2px;
	}

	:global(.ds-icon-svg) {
		width: 20px;
		height: 20px;
	}

	:global(.ds-spec-icon-sm) {
		width: 14px;
		height: 14px;
	}

	.ds-spec {
		border: 1px solid var(--border);
		background: var(--panel);
		display: flex;
		flex-direction: column;
		border-radius: 2px;
		overflow: hidden;
	}

	:global(.ds-spec-span-2) {
		grid-column: span 2;
	}

	.ds-spec-stage {
		flex: 1;
		background:
			repeating-linear-gradient(45deg, transparent 0, transparent 12px, rgba(0,0,0,0.02) 12px, rgba(0,0,0,0.02) 13px);
		display: flex;
		align-items: stretch;
		justify-content: center;
		min-height: 100px;
	}

	.ds-spec-stage.padded {
		padding: 24px;
		align-items: center;
	}

	.ds-thread-stage {
		width: 100%;
		padding: 18px;
		background: var(--bg);
	}

	.ds-profile-stage {
		width: 100%;
		padding: 18px;
		background: var(--bg);
		align-items: flex-start;
	}

	.ds-profile-shell {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 280px;
		gap: 18px;
		width: min(100%, 980px);
		align-items: start;
	}

	.ds-profile-side {
		min-width: 0;
	}

	.ds-notif-pop-stage {
		padding: 16px;
		background: var(--bg);
		align-items: flex-start;
	}

	.ds-notif-pop-wrap {
		position: relative;
		display: inline-block;
		max-width: 100%;
	}

	.ds-radio-stage {
		padding: 20px;
		background: var(--bg);
		display: flex;
		justify-content: center;
		min-height: 80px;
	}

	.ds-radio-stage.tall {
		min-height: 400px;
		align-items: flex-start;
	}

	.ds-radio-host {
		position: relative;
		width: 360px;
		max-width: 100%;
	}

	.ds-radio-host :global(.radio),
	.ds-radio-host :global(.radio-revive) {
		position: static;
		width: 100%;
		max-width: none;
		box-shadow: 0 4px 20px -8px rgba(0,0,0,0.18);
	}

	.ds-surface-stage {
		align-items: flex-start;
		background: var(--bg);
		min-height: 0;
	}

	.ds-surface-stage :global(.surface-card) {
		width: 100%;
	}

	.ds-navigation-stage {
		align-items: flex-start;
		background: var(--bg);
		padding: 18px;
	}

	.ds-navigation-card-wrap {
		width: min(320px, 100%);
	}

	:global(.ds-side-nav-card) {
		padding: 6px 0;
		width: 100%;
	}

	/* ===== Phone frames ===== */
	:global(.ds-phone-row) {
		display: flex;
		gap: 28px;
		flex-wrap: wrap;
		justify-content: center;
		align-items: flex-start;
	}

	:global(.ds-phone-wrap) {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		width: min(375px, 100%);
	}

	:global(.ds-phone) {
		width: 100%;
		aspect-ratio: 375 / 720;
		box-sizing: border-box;
		background: #15131c;
		border-radius: 38px;
		padding: 10px;
		box-shadow: 0 30px 60px -20px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.1);
		position: relative;
		flex-shrink: 0;
	}

	:global(.ds-phone-notch) {
		position: absolute;
		top: 14px;
		left: 50%;
		transform: translateX(-50%);
		width: 110px;
		height: 26px;
		background: #15131c;
		border-radius: 0 0 16px 16px;
		z-index: 5;
	}

	:global(.ds-phone-screen) {
		width: 100%;
		height: 100%;
		border-radius: 30px;
		overflow: hidden;
		position: relative;
		background: var(--bg);
	}

	:global(.ds-phone-label) {
		font-family: var(--mono);
		font-size: 11px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--muted);
		text-align: center;
	}

	:global(.ds-mobile-app) {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		position: relative;
		background: var(--bg);
	}

	:global(.ds-mobile-statusbar) {
		height: 36px;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		padding: 4px 28px 6px;
		font-family: var(--sans);
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		flex-shrink: 0;
	}

	:global(.ds-mobile-battery) {
		width: 16px;
		height: 8px;
		border: 1px solid currentColor;
		border-radius: 2px;
		opacity: 0.8;
	}

	:global(.ds-mobile-header) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 14px;
		background: var(--panel);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	:global(.ds-mobile-header .menu-btn),
	:global(.ds-mobile-header .icon-btn) {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--panel);
		color: var(--ink);
		position: relative;
	}

	:global(.ds-mobile-header .badge) {
		position: absolute;
		top: 3px;
		right: 3px;
		min-width: 14px;
		height: 14px;
		border-radius: 7px;
		background: var(--accent);
		color: white;
		font-size: 9px;
		font-weight: 700;
		display: grid;
		place-items: center;
		padding: 0 4px;
		border: 2px solid var(--panel);
	}

	:global(.ds-mobile-app .mobile-brand-name) {
		font-family: var(--serif);
		font-size: 20px;
		font-weight: 500;
		line-height: 1;
		color: var(--ink);
	}

	:global(.ds-mobile-app .mobile-brand-name sup) {
		font-family: var(--sans);
		font-size: 8px;
		color: var(--muted);
		margin-left: 2px;
	}

	:global(.ds-mobile-app .brand-mark) {
		width: 36px;
		height: 36px;
		background: #1c2046;
		border-radius: 4px;
		display: grid;
		place-items: center;
		flex-shrink: 0;
	}

	:global(.ds-mobile-app .brand-mark svg) {
		width: 22px;
		height: 22px;
	}

	:global(.ds-mobile-feed) {
		flex: 1;
		overflow-y: auto;
		background: var(--bg);
	}

	:global(.ds-mobile-feed .post),
	:global(.ds-mobile-thread .post) {
		padding: 12px 14px;
		grid-template-columns: 40px minmax(0, 1fr);
		gap: 10px;
	}

	:global(.ds-mobile-feed .post-av),
	:global(.ds-mobile-thread .post-av) {
		width: 40px;
		height: 40px;
	}

	:global(.ds-mobile-feed .post-actions) {
		gap: 8px;
	}

	:global(.ds-mobile-feed .post-action) {
		padding-inline: 3px;
	}

	:global(.ds-mobile-bottom) {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		padding: 6px 4px 10px;
		background: var(--panel);
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}

	:global(.ds-mobile-bottom .mob-tab) {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 8px 4px;
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--muted);
		position: relative;
		border-radius: 4px;
	}

	:global(.ds-mobile-bottom .mob-tab svg) {
		width: 18px;
		height: 18px;
	}

	:global(.ds-mobile-bottom .mob-tab.active) {
		color: var(--accent-ink);
	}

	:global(.ds-mobile-bottom .tab-badge) {
		position: absolute;
		top: 4px;
		right: 50%;
		margin-right: -16px;
		background: var(--bad);
		color: white;
		font-size: 9px;
		padding: 1px 4px;
		border-radius: 6px;
		min-width: 14px;
		text-align: center;
	}

	:global(.ds-mobile-drawer-inner) {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 20px;
	}

	:global(.drawer-head) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 14px;
		border-bottom: 1px solid var(--border);
	}

	:global(.drawer-brand) {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	:global(.drawer-close) {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border-radius: 4px;
		color: var(--muted);
	}

	:global(.ds-mobile-drawer-stack) {
		padding: 0 10px 10px;
	}

	:global(.ds-mobile-profile-card) {
		padding: 10px 12px;
	}

	:global(.ds-mobile-profile-name) {
		font-family: var(--serif);
		font-size: 18px;
		line-height: 1;
	}

	:global(.ds-mobile-profile-handle) {
		font-size: 11px;
		color: var(--muted);
		margin-top: 3px;
	}

	:global(.ds-mobile-side-card) {
		margin-top: 10px;
		padding: 4px 0;
	}

	:global(.ds-mobile-thread) {
		flex: 1;
		overflow-y: auto;
		padding: 10px;
	}

	:global(.ds-mobile-thread .focused-av) {
		width: 44px;
		height: 44px;
	}

	:global(.ds-mobile-thread .focused-post) {
		padding: 16px 14px 12px;
	}

	:global(.ds-mobile-thread .focused-post-head) {
		gap: 9px;
	}

	:global(.ds-mobile-thread .focused-name) {
		font-size: 18px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.ds-mobile-thread .focused-handle) {
		font-size: 12.5px;
	}

	:global(.ds-mobile-thread .focused-post-head .btn-follow) {
		padding: 3px 10px;
		font-size: 11.5px;
		min-width: 0;
	}

	:global(.ds-mobile-thread .focused-post-head .post-more) {
		width: 26px;
		height: 26px;
	}

	:global(.ds-mobile-thread .focused-body) {
		font-size: 14.5px;
		line-height: 1.5;
	}

	:global(.ds-mobile-thread .focused-meta) {
		font-size: 11px;
		line-height: 1.45;
	}

	:global(.ds-mobile-thread .focused-action) {
		padding: 8px 4px;
	}

	:global(.ds-mobile-thread .focused-action span) {
		display: none;
	}

	:global(.ds-mobile-thread .focused-action svg) {
		width: 18px;
		height: 18px;
	}

	:global(.ds-mobile-thread .thread-head-title) {
		margin-right: 30px;
	}

	.ds-nps-stack {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 280px;
	}

	.ds-nps-wrap {
		display: grid;
		grid-template-columns: 70px 1fr;
		align-items: center;
		gap: 14px;
		padding: 6px 10px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.ds-nps-label {
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--muted-2);
	}

	:global(.ds-oekaki-anatomy) {
		position: relative;
		overflow: hidden;
		background: var(--ink);
		padding: 18px;
		min-height: 360px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(.ds-oekaki-anatomy .ds-oekaki-scale) {
		width: 920px;
		transform: scale(0.55);
		transform-origin: center center;
		pointer-events: none;
		user-select: none;
	}

	:global(.ds-oekaki-anatomy .ds-anatomy-marker) {
		z-index: 5;
	}

	:global(.ds-oekaki-anatomy .ds-omk-1) { top: 50%; left: calc(50% - 232px); transform: translateY(-50%); }
	:global(.ds-oekaki-anatomy .ds-omk-2) { top: 50%; left: calc(50% - 70px); transform: translateY(-50%); }
	:global(.ds-oekaki-anatomy .ds-omk-3) { top: 50%; left: calc(50% + 170px); transform: translateY(-50%); }
	:global(.ds-oekaki-anatomy .ds-omk-4) { bottom: 36px; left: calc(50% + 200px); }

	:global(.ds-oekaki-scale .oek-backdrop) {
		position: static;
		background: transparent;
		padding: 0;
		animation: none;
	}

	:global(.ds-oekaki-scale .oek-window) {
		max-width: none;
		max-height: none;
		height: 600px;
	}

	.ds-oekaki-launch {
		position: absolute;
		bottom: 14px;
		right: 14px;
		padding: 8px 14px;
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		background: var(--accent);
		color: white;
		border-radius: 2px;
		cursor: pointer;
		transition: filter 0.15s;
		z-index: 2;
	}

	.ds-oekaki-launch:hover {
		filter: brightness(1.08);
	}

	@media (max-width: 720px) {
		:global(.ds-oekaki-scale) { transform: scale(0.35); }
	}

	:global(.ds-thread-demo-card) {
		width: min(720px, 100%);
	}

	.ds-spec-foot {
		padding: 8px 12px;
		border-top: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		background: var(--panel-2);
	}

	.ds-spec-label {
		font-family: var(--mono);
		font-size: 11px;
		letter-spacing: 0.06em;
		color: var(--ink);
	}

	.ds-spec-note {
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--muted);
	}

	:global(.ds-row) {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		align-items: flex-start;
	}

	.ds-toggle-label {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
	}

	:global(.ds-av-gallery) { display: flex; flex-direction: column; gap: 24px; }
	:global(.ds-av-section) {
		border: 1px solid var(--border);
		background: var(--panel);
		padding: 16px 20px;
		border-radius: 2px;
	}
	:global(.ds-av-section-label) {
		font-family: var(--mono);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--muted);
		margin-bottom: 14px;
	}
	:global(.ds-av-row) {
		display: flex;
		gap: 24px;
		flex-wrap: wrap;
	}
	:global(.ds-av-cell) {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}
	:global(.ds-av-name) {
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--muted);
	}
	:global(.ds-banner-row) {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 14px;
	}
	:global(.ds-banner-cell) {
		border: 1px solid var(--border);
		background: var(--bg);
		border-radius: 2px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	:global(.ds-banner-tile) {
		width: 100%;
		aspect-ratio: 16 / 7;
		position: relative;
		overflow: hidden;
	}
	:global(.ds-banner-meta) {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-top: 1px solid var(--border);
		background: var(--panel);
	}
	:global(.ds-banner-crop) {
		width: 36px;
		height: 36px;
		border-radius: 4px;
		overflow: hidden;
		flex-shrink: 0;
		position: relative;
		border: 1px solid var(--border);
	}
	:global(.ds-banner-text) { min-width: 0; }
	:global(.ds-banner-note) {
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		color: var(--muted-2);
		margin-top: 2px;
	}
	:global(.ds-size-row) {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 12px;
	}
	:global(.ds-size-cell) {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		background: var(--bg);
		border-radius: 2px;
		overflow: hidden;
	}
	:global(.ds-size-stage) {
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding: 14px 8px 12px;
		background:
			repeating-linear-gradient(45deg, transparent 0, transparent 10px, rgba(0,0,0,0.025) 10px, rgba(0,0,0,0.025) 11px),
			var(--panel);
		min-height: 80px;
	}
	:global(.ds-size-meta) {
		padding: 8px 10px;
		border-top: 1px solid var(--border);
		background: var(--panel);
	}
	:global(.ds-size-name) {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}
	:global(.ds-size-variant) {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--ink);
		letter-spacing: 0.02em;
	}
	:global(.ds-size-dim) {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--accent-ink);
	}
	:global(.ds-size-shape) {
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 1px 5px;
		border-radius: 8px;
		border: 1px solid var(--border-strong);
		color: var(--muted);
	}
	:global(.ds-size-shape-circle) {
		border-radius: 8px;
	}
	:global(.ds-size-role) {
		font-size: 11px;
		color: var(--muted);
		margin-top: 4px;
	}

	.ds-icon-name {
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--muted);
	}

	.ds-foot {
		margin-top: 40px;
		padding-top: 32px;
		border-top: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--muted-2);
	}

	/* ===== Responsive nav collapse ===== */
	@media (max-width: 1100px) {
		.ds-grid-4 {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		:global(.ds-grid-3) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 900px) {
		.ds-body {
			grid-template-columns: 1fr;
		}

		.ds-nav {
			position: static;
			flex-direction: row;
			overflow-x: auto;
			max-height: none;
			padding: 12px 16px;
			gap: 4px;
			border-bottom: 1px solid var(--border);
		}

		.ds-nav-label,
		.ds-nav-foot {
			display: none;
		}

		.ds-nav-item {
			border-left: none;
			border-bottom: 2px solid transparent;
			white-space: nowrap;
			padding: 6px 10px;
		}

		.ds-nav-item.active {
			border-left: none;
			border-bottom-color: var(--accent);
		}

		.ds-main {
			padding: 24px 20px 60px;
		}

		.ds-header {
			padding: 14px 18px;
		}
	}

	@media (max-width: 720px) {
		.ds-header {
			align-items: flex-start;
			flex-direction: column;
			gap: 14px;
		}

		.ds-header-r {
			width: 100%;
			align-items: stretch;
			flex-direction: column;
			gap: 10px;
		}

		.ds-theme-picker {
			overflow-x: auto;
		}

		.ds-app-link {
			width: max-content;
		}

		.ds-grid-4,
		:global(.ds-grid-3),
		:global(.ds-grid-2) {
			grid-template-columns: 1fr;
		}

		:global(.ds-spec-span-2) {
			grid-column: auto;
		}

		.ds-thread-stage {
			padding: 10px;
		}

		.ds-profile-stage {
			padding: 10px;
		}

		.ds-profile-shell {
			grid-template-columns: minmax(0, 1fr);
		}

		.ds-profile-side {
			display: none;
		}

		:global(.ds-att-rule) {
			grid-template-columns: 70px 1fr;
			gap: 8px 12px;
		}

		:global(.ds-att-rule-arrow) {
			display: none;
		}

		:global(.ds-att-rule-layout) {
			grid-column: 2;
			justify-self: start;
		}

		.ds-spec-foot {
			align-items: flex-start;
			flex-direction: column;
		}

		.ds-spec-note {
			overflow-wrap: anywhere;
		}

		.ds-type-sample {
			font-size: 26px;
		}

		.ds-foot {
			flex-direction: column;
			gap: 8px;
		}
	}

	/* ===== Attachment rules ===== */
	:global(.ds-att-rules) {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 18px;
	}
	:global(.ds-att-rule) {
		display: grid;
		grid-template-columns: 80px 1fr auto 1fr;
		align-items: center;
		gap: 14px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 2px;
		background: var(--panel);
		font-size: 13px;
	}
	:global(.ds-att-rule-hi) {
		border-color: var(--accent);
		background: var(--accent-soft-2);
	}
	:global(.ds-att-rule-input) {
		color: var(--ink-2);
	}
	:global(.ds-att-rule-arrow) {
		color: var(--accent-ink);
		font-family: var(--mono);
		font-weight: 600;
	}
	:global(.ds-att-rule-layout) {
		font-family: var(--mono);
		font-size: 11px;
		letter-spacing: 0.06em;
		color: var(--accent-ink);
		background: var(--accent-soft);
		padding: 2px 8px;
		border-radius: 2px;
	}

	/* ===== Post anatomy markers ===== */
	:global(.ds-post-anatomy) {
		position: relative;
		overflow: visible;
	}
	:global(.ds-anatomy-marker) {
		position: absolute;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--accent);
		color: white;
		font-family: var(--mono);
		font-size: 12px;
		font-weight: 600;
		display: grid;
		place-items: center;
		box-shadow: 0 0 0 2px var(--panel), 0 4px 12px -2px rgba(0,0,0,0.3);
		pointer-events: none;
		z-index: 4;
	}
	:global(.ds-post-anatomy .ds-mk-1) { top: 12px; left: 12px; }
	:global(.ds-post-anatomy .ds-mk-2) { top: 12px; right: 12px; }
	:global(.ds-post-anatomy .ds-mk-3) { top: 64px; left: 12px; }
	:global(.ds-post-anatomy .ds-mk-4) { top: 130px; left: 12px; }
	:global(.ds-post-anatomy .ds-mk-5) { bottom: 12px; left: 12px; }

	/* ===== Anatomy section ===== */
	:global(.ds-anatomy) {
		display: grid;
		grid-template-columns: 1fr 280px;
		gap: 24px;
		align-items: start;
	}
	:global(.ds-anatomy-fig) {
		border: 1px solid var(--border);
		background: var(--panel);
		border-radius: 2px;
		overflow: hidden;
	}
	:global(.ds-anatomy-list) {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
		color: var(--ink-2);
	}
	:global(.ds-anatomy-list li) {
		display: grid;
		grid-template-columns: 24px 1fr;
		align-items: baseline;
		gap: 10px;
		padding: 10px 12px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 2px;
	}
	:global(.ds-anatomy-list li .m) {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--accent-ink);
		background: var(--accent-soft);
		text-align: center;
		border-radius: 2px;
		padding: 2px 0;
	}
	:global(.ds-anatomy-list b) { color: var(--ink); font-weight: 600; }
	@media (max-width: 900px) {
		:global(.ds-anatomy) { grid-template-columns: 1fr; }
	}
</style>

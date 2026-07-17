<script lang="ts">
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import PostCW from './PostCW.svelte';
	import PostMedia from './PostMedia.svelte';
	import PostPinged from './PostPinged.svelte';
	import PostReactions from './PostReactions.svelte';
	import QuotedPost from './QuotedPost.svelte';
	import PetnameChip from './PetnameChip.svelte';
	import UnconfirmedChip from './UnconfirmedChip.svelte';
	import RichText from './RichText.svelte';
	import { profileHref } from './profile-links';
	import VaporBanner from './VaporBanner.svelte';
	import type { CustomEmoji } from '$lib/social/types';
	import { normalizeRenderableAttachments, openLightbox } from './attachments';
	import type { BannerVariant, PostLike } from './attachments';
	import type { PleromaReactionView } from '$lib/pleroma/ui';
	import type { PostManagementCapabilities } from './post-capabilities';

	type FocusedThreadPost = PostLike & {
		id?: string | number;
		name?: string;
		nameEmojis?: CustomEmoji[];
		handle?: string;
		avClass?: string;
		avBanner?: BannerVariant;
		body?: string;
		bodyEmojis?: CustomEmoji[];
		addressees?: string[];
		addresseeNames?: Record<string, string>;
		addresseePetnames?: Record<string, string>;
		mentionNames?: Record<string, string>;
		authName?: string;
		petname?: string;
		authorUnconfirmed?: boolean;
		visibility?: string;
		quotedPost?: Record<string, unknown>;
		mentionAccts?: Record<string, string>;
		reactions?: PleromaReactionView[];
		bookmarked?: boolean;
		own?: boolean;
		authorHandle?: string;
		statusUrl?: string;
		/** Headwater thread-subscribe: true iff the viewer is subscribed to this thread root. */
		threadSubscribed?: boolean;
		replies: number;
		boosts: number;
		favs: number;
		bookmarks?: number;
		fullTime?: string;
		source?: string;
		views?: string | null;
		actions: { reply: boolean; boost: boolean; fav: boolean };
	};

	type Props = {
		post: FocusedThreadPost;
		continuesAbove?: boolean;
		replyExpanded?: boolean;
		replyControlsId?: string;
		onAction?: (id: string | number | undefined, key: string) => void;
		onReact?: (id: string | number | undefined, anchor: HTMLElement) => void;
		onVote?: (id: string | number | undefined, pollId: string | undefined, choice: string | string[]) => void;
		canManage?: boolean;
		managementCapabilities?: PostManagementCapabilities;
	};

	let { post, continuesAbove = false, replyExpanded, replyControlsId, onAction, onReact, onVote, canManage = false, managementCapabilities }: Props = $props();
	let canSubscribe = $derived(managementCapabilities?.threadSubscription ?? canManage);
	let canDelete = $derived(managementCapabilities?.deletion ?? canManage);
	let canModerate = $derived(managementCapabilities?.moderation ?? canManage);
	let canBookmark = $derived(managementCapabilities?.bookmarks ?? canManage);
	let href = $derived(profileHref(post.handle));
	let menuOpen = $state(false);
	let confirmDelete = $state(false);
	let moreButton = $state<HTMLButtonElement | null>(null);
	let menuStyle = $state('');
	const openMenu = () => {
		const rect = moreButton?.getBoundingClientRect();
		if (rect) {
			const viewHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
			const spaceBelow = viewHeight - rect.bottom;
			const openUp = spaceBelow < 240 && rect.top > spaceBelow;
			const left = Math.round(rect.right);
			menuStyle = openUp
				? `left:${left}px;top:${Math.round(rect.top - 6)}px;transform:translate(-100%, -100%)`
				: `left:${left}px;top:${Math.round(rect.bottom + 6)}px;transform:translateX(-100%)`;
		}
		menuOpen = true;
	};
	const closeMenu = () => { menuOpen = false; confirmDelete = false; };
	const runMenuAction = (key: string) => { closeMenu(); onAction?.(post.id, key); };
	$effect(() => {
		if (!menuOpen) return;
		const onPointer = (event: MouseEvent) => {
			if (!(event.target instanceof Element) || !event.target.closest('.post-more-wrap')) closeMenu();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') closeMenu();
		};
		document.addEventListener('mousedown', onPointer);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onPointer);
			document.removeEventListener('keydown', onKey);
		};
	});

	const handleLightbox = (idx: number) => {
		const attachments = normalizeRenderableAttachments(post);
		if (!attachments.length) return;
		openLightbox(attachments, idx, {
			name: post.name,
			nameEmojis: post.nameEmojis,
			handle: post.handle,
			avClass: post.avClass,
			avBanner: post.avBanner
		});
	};
</script>

<article class="focused-post" data-testid="focused-post">
	{#if continuesAbove}
		<div class="thread-line-top"></div>
	{/if}
	<div class="focused-post-head">
		<Avatar post={post} variant="focused" />
		<div style="min-width:0;flex:1">
			<div class="focused-name">
				<RichText text={post.petname ? (post.authName || post.name) : post.name} emojis={post.nameEmojis} linkMentions={false} />
				{#if post.petname}<PetnameChip petname={post.petname} />{/if}
				{#if post.authorUnconfirmed}<UnconfirmedChip />{/if}
			</div>
			{#if href}
				<a class="focused-handle" href={href}>{post.handle}</a>
			{:else}
				<div class="focused-handle">{post.handle}</div>
			{/if}
		</div>
		<div class="post-more-wrap" data-post-ignore>
			<button bind:this={moreButton} type="button" class="post-more" aria-label="More post actions" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen ? closeMenu() : openMenu())}><Icon name="more" width={16} height={16} /></button>
			{#if menuOpen}
				<div class="post-action-menu" role="menu" style={menuStyle}>
					{#if post.statusUrl}
						<button type="button" role="menuitem" onclick={() => runMenuAction('copy-link')}>Copy link to post</button>
					{/if}
					{#if canSubscribe}
						{#if post.threadSubscribed}
							<button type="button" role="menuitem" data-testid="thread-unsubscribe" onclick={() => runMenuAction('unsubscribe')}>Unsubscribe from thread</button>
						{:else}
							<button type="button" role="menuitem" data-testid="thread-subscribe" onclick={() => runMenuAction('subscribe')}>Subscribe to thread</button>
						{/if}
					{/if}
					{#if canDelete && post.own}
						{#if confirmDelete}
							<button type="button" role="menuitem" class="menu-danger" onclick={() => runMenuAction('delete')}>Confirm delete</button>
							<button type="button" role="menuitem" onclick={() => (confirmDelete = false)}>Cancel</button>
						{:else}
							<button type="button" role="menuitem" class="menu-danger" onclick={() => (confirmDelete = true)}>Delete post</button>
						{/if}
					{:else if canModerate && post.authorHandle}
						<button type="button" role="menuitem" onclick={() => runMenuAction('mute')}>Mute {post.authorHandle}</button>
						<button type="button" role="menuitem" class="menu-danger" onclick={() => runMenuAction('block')}>Block {post.authorHandle}</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<PostCW post={post}>
		<div class="focused-body"><RichText text={post.body} emojis={post.bodyEmojis} mentionAccts={post.mentionAccts} mentionNames={post.mentionNames} mentionClass="post-mention-inline" linkUrls /></div>
		<QuotedPost quoted={post.quotedPost} />
		<PostPinged addressees={post.addressees} addresseeNames={post.addresseeNames} addresseePetnames={post.addresseePetnames} focused />

		{#if post.media}
			<div class="focused-media">
				<VaporBanner variant={post.media} />
			</div>
		{/if}
		<PostMedia post={post} onOpen={handleLightbox} onVote={onVote ? (pollId, choice) => onVote(post.id, pollId, choice) : undefined} />
	</PostCW>

	<PostReactions reactions={post.reactions} onToggle={onAction ? (reaction) => onAction(post.id, `reaction:${reaction.name}`) : undefined} onAdd={onReact ? (anchor) => onReact(post.id, anchor) : undefined} />

	<div class="focused-meta">
		<span>{post.fullTime || '4:18 PM · May 11, 2026'}</span>
		<span class="dot">·</span>
		<span>{post.source || 'Pleroma'}</span>
		{#if post.views}
			<span class="dot">·</span>
			<span><strong>{post.views}</strong> views</span>
		{/if}
	</div>

	<div class="focused-actions" data-testid="focused-engagement">
		<button type="button" class="focused-action" aria-expanded={replyExpanded} aria-controls={replyControlsId} aria-label={`Reply ${post.replies}`} onclick={() => onAction?.(post.id, 'reply')}>
			<Icon name="reply" />
			<span>Reply</span>
			{#if post.replies > 0}<span class="focused-action-c">{post.replies}</span>{/if}
		</button>
		<button type="button" class="focused-action {post.actions.boost ? 'on' : ''}" aria-pressed={post.actions.boost ? 'true' : 'false'} aria-label={`Boost ${post.boosts + (post.actions.boost ? 1 : 0)}`} disabled={post.visibility === 'private' || post.visibility === 'direct'} title={post.visibility === 'private' ? 'Followers-only posts cannot be boosted' : post.visibility === 'direct' ? 'Direct posts cannot be boosted' : undefined} onclick={() => onAction?.(post.id, 'boost')}>
			<Icon name="boost" />
			<span>Boost</span>
			{#if post.boosts + (post.actions.boost ? 1 : 0) > 0}<span class="focused-action-c">{post.boosts + (post.actions.boost ? 1 : 0)}</span>{/if}
		</button>
		<button type="button" class="focused-action {post.actions.fav ? 'on' : ''}" aria-pressed={post.actions.fav ? 'true' : 'false'} aria-label={`Favorite ${post.favs + (post.actions.fav ? 1 : 0)}`} onclick={() => onAction?.(post.id, 'fav')}>
			<Icon name="star" fill={post.actions.fav ? 'currentColor' : 'none'} />
			<span>Favorite</span>
			{#if post.favs + (post.actions.fav ? 1 : 0) > 0}<span class="focused-action-c">{post.favs + (post.actions.fav ? 1 : 0)}</span>{/if}
		</button>
		{#if onReact}
			<button type="button" class="focused-action" aria-label="Add reaction" aria-haspopup="dialog" data-emoji-trigger onclick={(event) => onReact?.(post.id, event.currentTarget)}>
				<Icon name="smile" />
				<span>React</span>
			</button>
		{/if}
		<button type="button" class="focused-action {post.bookmarked ? 'on' : ''}" aria-pressed={post.bookmarked ? 'true' : 'false'} aria-label={post.bookmarked ? 'Remove bookmark' : 'Save'} disabled={!canBookmark} onclick={() => onAction?.(post.id, 'bookmark')}>
			<Icon name="bookmark" fill={post.bookmarked ? 'currentColor' : 'none'} />
			<span>{post.bookmarked ? 'Saved' : 'Save'}</span>
		</button>
		<button type="button" class="focused-action" aria-label="Copy link to post" disabled={!post.statusUrl} onclick={() => onAction?.(post.id, 'copy-link')}>
			<Icon name="ext" />
			<span>Share</span>
		</button>
	</div>
</article>

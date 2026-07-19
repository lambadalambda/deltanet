<script lang="ts">
	import { writeClipboardText } from '$lib/clipboard';
	import Icon from './Icon.svelte';
	import type { PostManagementCapabilities } from './post-capabilities';

	type Props = {
		post: {
			replies: number;
			boosts: number;
			favs: number;
			copyJson?: unknown;
			bookmarked?: boolean;
			own?: boolean;
			authorHandle?: string;
			statusUrl?: string;
			actions: { reply: boolean; boost: boolean; fav: boolean };
		};
		disabledActions?: { reply?: boolean; boost?: boolean; fav?: boolean };
		replyExpanded?: boolean;
		replyControlsId?: string;
		canManage?: boolean;
		managementCapabilities?: PostManagementCapabilities;
		onAction?: (key: string) => void;
		onReact?: (anchor: HTMLElement) => void;
	};

	let { post, disabledActions = {}, replyExpanded, replyControlsId, canManage = false, managementCapabilities, onAction, onReact }: Props = $props();
	let canBookmark = $derived(managementCapabilities?.bookmarks ?? canManage);
	let canDelete = $derived(managementCapabilities?.deletion ?? canManage);
	let canModerate = $derived(managementCapabilities?.moderation ?? canManage);
	let menuOpen = $state(false);
	let confirmDelete = $state(false);
	let copyStatus = $state('');
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
	const closeMenu = () => {
		menuOpen = false;
		confirmDelete = false;
	};
	const runAction = (key: string) => {
		closeMenu();
		onAction?.(key);
	};

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

	const copyPostJson = async () => {
		try {
			await writeClipboardText(JSON.stringify(post.copyJson ?? post, null, 2));
			copyStatus = 'Copied post JSON';
			closeMenu();
		} catch {
			copyStatus = 'Copy failed';
		}
	};
</script>

<div class="post-actions">
	<button
		class="post-action reply {post.actions.reply ? 'on' : ''}"
		aria-expanded={replyExpanded}
		aria-controls={replyControlsId}
		aria-label={`Reply ${post.replies}`}
		disabled={disabledActions.reply}
		onclick={() => onAction?.('reply')}
	>
		<Icon name="reply" /> {post.replies}
	</button>
	<button
		class="post-action boost {post.actions.boost ? 'on' : ''}"
		aria-pressed={post.actions.boost ? 'true' : 'false'}
		aria-label={`Boost ${post.boosts + (post.actions.boost ? 1 : 0)}`}
		disabled={disabledActions.boost}
		onclick={() => onAction?.('boost')}
	>
		<Icon name="boost" /> {post.boosts + (post.actions.boost ? 1 : 0)}
	</button>
	<button
		class="post-action fav {post.actions.fav ? 'on' : ''}"
		aria-pressed={post.actions.fav ? 'true' : 'false'}
		aria-label={`Favorite ${post.favs + (post.actions.fav ? 1 : 0)}`}
		disabled={disabledActions.fav}
		onclick={() => onAction?.('fav')}
	>
		<Icon name="star" fill={post.actions.fav ? 'currentColor' : 'none'} /> {post.favs + (post.actions.fav ? 1 : 0)}
	</button>
	{#if onReact}
		<button
			type="button"
			class="post-action react"
			aria-label="Add reaction"
			aria-haspopup="dialog"
			title="Add reaction"
			data-emoji-trigger
			onclick={(event) => onReact?.(event.currentTarget)}
		>
			<Icon name="smile" width={15} height={15} />
		</button>
	{/if}
	<div class="post-more-wrap" data-post-ignore>
		<button
			bind:this={moreButton}
			type="button"
			class="post-more"
			aria-label="More post actions"
			aria-haspopup="menu"
			aria-expanded={menuOpen}
			onclick={() => (menuOpen ? closeMenu() : openMenu())}
		>
			<Icon name="more" width={16} height={16} />
		</button>
		{#if menuOpen}
			<div class="post-action-menu" role="menu" style={menuStyle}>
				{#if canBookmark && post.bookmarked !== undefined}
					<button type="button" role="menuitem" onclick={() => runAction('bookmark')}>{post.bookmarked ? 'Remove bookmark' : 'Bookmark'}</button>
				{/if}
				{#if post.statusUrl}
					<button type="button" role="menuitem" onclick={() => runAction('copy-link')}>Copy link to post</button>
				{/if}
				<button type="button" role="menuitem" onclick={copyPostJson}>Copy post JSON</button>
				{#if canDelete && post.own}
					{#if confirmDelete}
						<button type="button" role="menuitem" class="menu-danger" onclick={() => runAction('delete')}>Confirm delete</button>
						<button type="button" role="menuitem" onclick={() => (confirmDelete = false)}>Cancel</button>
					{:else}
						<button type="button" role="menuitem" class="menu-danger" onclick={() => (confirmDelete = true)}>Delete post</button>
					{/if}
				{:else if canModerate && post.authorHandle}
					<button type="button" role="menuitem" onclick={() => runAction('mute')}>Mute {post.authorHandle}</button>
					<button type="button" role="menuitem" class="menu-danger" onclick={() => runAction('block')}>Block {post.authorHandle}</button>
				{/if}
			</div>
		{/if}
		{#if copyStatus}
			<span class="post-copy-status" role="status" aria-label="Post JSON copy status">{copyStatus}</span>
		{/if}
	</div>
</div>

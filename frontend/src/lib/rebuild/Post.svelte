<script lang="ts">
	import Avatar from './Avatar.svelte';
	import PostHead from './PostHead.svelte';
	import PostBody from './PostBody.svelte';
	import PostMedia from './PostMedia.svelte';
	import PostBoost from './PostBoost.svelte';
	import PostCW from './PostCW.svelte';
	import PostActions from './PostActions.svelte';
	import PostReactions from './PostReactions.svelte';
	import QuotedPost from './QuotedPost.svelte';
	import type { PostLike, BannerVariant } from './attachments';
	import { normalizeRenderableAttachments, openLightbox } from './attachments';
	import type { CustomEmoji } from '$lib/social/types';
	import type { PleromaReactionView } from '$lib/pleroma/ui';

	type Props = {
		post: PostLike & {
			id?: string | number;
			actionStatusId?: string;
			threadStatusId?: string;
			name?: string;
			nameEmojis?: CustomEmoji[];
			handle?: string;
			time?: string;
			createdAt?: string;
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
			visibility?: string;
			quotedPost?: Record<string, unknown>;
			mentionAccts?: Record<string, string>;
			reactions?: PleromaReactionView[];
			bookmarked?: boolean;
			own?: boolean;
			authorHandle?: string;
			statusUrl?: string;
			replies: number;
			boosts: number;
			favs: number;
			actions: { reply: boolean; boost: boolean; fav: boolean };
		};
		replyExpanded?: boolean;
		replyControlsId?: string;
		canManage?: boolean;
		onAction?: (key: string) => void;
		onReact?: (anchor: HTMLElement) => void;
		onVote?: (pollId: string | undefined, choice: string | string[]) => void;
		onOpen?: () => void;
	};

	let { post, replyExpanded, replyControlsId, canManage = false, onAction, onReact, onVote, onOpen }: Props = $props();

	const handleLightbox = (idx: number) => {
		const attachments = normalizeRenderableAttachments(post);
		if (!attachments.length) return;
		openLightbox(attachments, idx, {
			name: post.name,
			nameEmojis: post.nameEmojis,
			handle: post.handle,
			avClass: post.avClass,
			avBanner: post.avBanner,
		});
	};
</script>

{#snippet postContents()}
	<Avatar post={post} />
	<div style="min-width:0">
		<PostHead post={post} />
		<PostCW post={post}>
			<PostBody body={post.body} emojis={post.bodyEmojis} addressees={post.addressees} addresseeNames={post.addresseeNames} addresseePetnames={post.addresseePetnames} mentionNames={post.mentionNames} mentionAccts={post.mentionAccts} />
			<QuotedPost quoted={post.quotedPost} />
			<PostMedia post={post} onOpen={handleLightbox} onVote={onVote} />
		</PostCW>
		<PostReactions reactions={post.reactions} onToggle={onAction ? (reaction) => onAction(`reaction:${reaction.name}`) : undefined} onAdd={onReact} />
		<PostActions post={post} disabledActions={{ boost: post.visibility === 'private' }} replyExpanded={replyExpanded} replyControlsId={replyControlsId} canManage={canManage} onAction={onAction} onReact={onReact} />
	</div>
{/snippet}

<PostBoost boostedBy={post.boostedBy}>
	{#if onOpen}
		<div
			class="post"
			data-status-id={post.id}
			data-action-status-id={post.actionStatusId}
			data-thread-status-id={post.threadStatusId}
			role="button"
			tabindex="0"
			onclick={(e) => {
				if ((e.target as HTMLElement).closest('button, a, [data-post-ignore]')) return;
				onOpen?.();
			}}
			onkeydown={(e) => {
				if (e.key !== 'Enter' && e.key !== ' ') return;
				if ((e.target as HTMLElement).closest('button, a, [data-post-ignore]')) return;
				e.preventDefault();
				onOpen?.();
			}}
			style="cursor:pointer"
		>
			{@render postContents()}
		</div>
	{:else}
		<div class="post" data-status-id={post.id} data-action-status-id={post.actionStatusId} data-thread-status-id={post.threadStatusId}>
			{@render postContents()}
		</div>
	{/if}
</PostBoost>

<script lang="ts">
	import Avatar from './Avatar.svelte';
	import InlineReplyComposer, { type InlineReplyComposerProps } from './InlineReplyComposer.svelte';
	import PostActions from './PostActions.svelte';
	import PostBoost from './PostBoost.svelte';
	import PostBody from './PostBody.svelte';
	import PostCW from './PostCW.svelte';
	import PostHead from './PostHead.svelte';
	import PostMedia from './PostMedia.svelte';
	import PostReactions from './PostReactions.svelte';
	import QuotedPost from './QuotedPost.svelte';
	import ReplyPostBranch from './ReplyPost.svelte';
	import type { CustomEmoji } from '$lib/social/types';
	import type { PleromaReactionView } from '$lib/pleroma/ui';
	import { normalizeRenderableAttachments, openLightbox } from './attachments';
	import type { BannerVariant, PostLike } from './attachments';

	type ThreadReply = PostLike & {
		id?: string | number;
		name?: string;
		nameEmojis?: CustomEmoji[];
		handle?: string;
		time?: string;
		avClass?: string;
		avBanner?: BannerVariant;
		body?: string;
		bodyEmojis?: CustomEmoji[];
		mentionAccts?: Record<string, string>;
		bookmarked?: boolean;
		own?: boolean;
		authorHandle?: string;
		statusUrl?: string;
		addressees?: string[];
		addresseeNames?: Record<string, string>;
		addresseePetnames?: Record<string, string>;
		mentionNames?: Record<string, string>;
		authName?: string;
		petname?: string;
		visibility?: string;
		quotedPost?: Record<string, unknown>;
		reactions?: PleromaReactionView[];
		replies: number;
		boosts: number;
		favs: number;
		actions: { reply: boolean; boost: boolean; fav: boolean };
		nestedReplies?: ThreadReply[];
	};
	type InlineReplyBinding = {
		renderId: string | null;
		props: Omit<InlineReplyComposerProps, 'id'>;
	};

	type Props = {
		post: ThreadReply;
		isLast?: boolean;
		nestedReplies?: ThreadReply[];
		onAction?: (id: string | number | undefined, key: string) => void;
		onReact?: (id: string | number | undefined, anchor: HTMLElement) => void;
		onVote?: (id: string | number | undefined, pollId: string | undefined, choice: string | string[]) => void;
		canManage?: boolean;
		inlineReply?: InlineReplyBinding | null;
		expandedReplyIds?: Record<string, boolean>;
		onShowNested?: (id: string | number | undefined) => void;
	};

	let {
		post,
		isLast = false,
		nestedReplies = [],
		onAction,
		onReact,
		onVote,
		canManage = false,
		inlineReply = null,
		expandedReplyIds = {},
		onShowNested
	}: Props = $props();

	const handleLightbox = (target: ThreadReply, idx: number) => {
		const attachments = normalizeRenderableAttachments(target);
		if (!attachments.length) return;
		openLightbox(attachments, idx, {
			name: target.name,
			handle: target.handle,
			avClass: target.avClass,
			avBanner: target.avBanner
		});
	};
	const inlineReplyOpenFor = (target: ThreadReply) => inlineReply?.renderId === String(target.id);
	const inlineReplyComposerId = (target: ThreadReply) => target.id == null ? undefined : `thread-inline-reply-${String(target.id)}`;
	const nestedRepliesOpenFor = (target: ThreadReply) => target.id != null && Boolean(expandedReplyIds[String(target.id)]);
</script>

<PostBoost boostedBy={post.boostedBy}>
	<div class="post post-reply {isLast && nestedReplies.length === 0 ? 'post-reply-last' : ''}">
		<div class="thread-line-wrap">
			<Avatar post={post} />
			{#if nestedReplies.length > 0 && !isLast}
				<div class="thread-line"></div>
			{/if}
		</div>
		<div style="min-width:0">
			<PostHead post={post} />
			<PostCW post={post}>
				<PostBody body={post.body} emojis={post.bodyEmojis} addressees={post.addressees} addresseeNames={post.addresseeNames} addresseePetnames={post.addresseePetnames} mentionNames={post.mentionNames} mentionAccts={post.mentionAccts} />
				<QuotedPost quoted={post.quotedPost} />
				<PostMedia post={post} onOpen={(idx) => handleLightbox(post, idx)} onVote={onVote ? (pollId, choice) => onVote(post.id, pollId, choice) : undefined} />
			</PostCW>
			<PostReactions reactions={post.reactions} onToggle={onAction ? (reaction) => onAction(post.id, `reaction:${reaction.name}`) : undefined} onAdd={onReact ? (anchor) => onReact(post.id, anchor) : undefined} />
			<PostActions post={post} disabledActions={{ boost: post.visibility === 'private' }} replyExpanded={inlineReplyOpenFor(post)} replyControlsId={inlineReplyOpenFor(post) ? inlineReplyComposerId(post) : undefined} onAction={(key) => onAction?.(post.id, key)} onReact={onReact ? (anchor) => onReact(post.id, anchor) : undefined} canManage={canManage} />
			{#if nestedReplies.length > 0 && !nestedRepliesOpenFor(post)}
				<button type="button" class="show-replies" onclick={() => onShowNested?.(post.id)}>
					<span class="show-replies-line"></span>
					Show {nestedReplies.length} {nestedReplies.length === 1 ? 'reply' : 'replies'} →
				</button>
			{/if}
		</div>
	</div>
	{#if inlineReplyOpenFor(post) && inlineReply}
		<InlineReplyComposer
			id={inlineReplyComposerId(post)}
			{...inlineReply.props}
		/>
	{/if}
</PostBoost>

{#if nestedRepliesOpenFor(post) && nestedReplies.length > 0}
	<div class="nested-replies">
		{#each nestedReplies as reply, i}
			<ReplyPostBranch
				post={reply}
				isLast={i === nestedReplies.length - 1}
				nestedReplies={reply.nestedReplies}
				onAction={onAction}
				onReact={onReact}
				onVote={onVote}
				canManage={canManage}
				inlineReply={inlineReply}
				expandedReplyIds={expandedReplyIds}
				onShowNested={onShowNested}
			/>
		{/each}
	</div>
{/if}

<script lang="ts">
	import Avatar from './Avatar.svelte';
	import PostActions from './PostActions.svelte';
	import PostBoost from './PostBoost.svelte';
	import PostBody from './PostBody.svelte';
	import PostCW from './PostCW.svelte';
	import PostHead from './PostHead.svelte';
	import PostMedia from './PostMedia.svelte';
	import PostReactions from './PostReactions.svelte';
	import QuotedPost from './QuotedPost.svelte';
	import type { CustomEmoji } from '$lib/social/types';
	import type { PleromaReactionView } from '$lib/pleroma/ui';
	import { normalizeRenderableAttachments, openLightbox } from './attachments';
	import type { BannerVariant, PostLike } from './attachments';

	type ThreadPost = PostLike & {
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
		addressees?: string[];
		addresseeNames?: Record<string, string>;
		addresseePetnames?: Record<string, string>;
		mentionNames?: Record<string, string>;
		authName?: string;
		petname?: string;
		visibility?: string;
		quotedPost?: Record<string, unknown>;
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

	type Props = {
		post: ThreadPost;
		replyExpanded?: boolean;
		replyControlsId?: string;
		onAction?: (id: string | number | undefined, key: string) => void;
		onReact?: (id: string | number | undefined, anchor: HTMLElement) => void;
		onVote?: (id: string | number | undefined, pollId: string | undefined, choice: string | string[]) => void;
		canManage?: boolean;
	};

	let { post, replyExpanded, replyControlsId, onAction, onReact, onVote, canManage = false }: Props = $props();

	const handleLightbox = (idx: number) => {
		const attachments = normalizeRenderableAttachments(post);
		if (!attachments.length) return;
		openLightbox(attachments, idx, {
			name: post.name,
			handle: post.handle,
			avClass: post.avClass,
			avBanner: post.avBanner
		});
	};
</script>

<PostBoost boostedBy={post.boostedBy}>
	<div class="post post-ancestor">
		<div class="thread-line-wrap">
			<Avatar post={post} />
			<div class="thread-line" data-testid="thread-line"></div>
		</div>
		<div style="min-width:0">
			<PostHead post={post} />
			<PostCW post={post}>
				<PostBody body={post.body} emojis={post.bodyEmojis} addressees={post.addressees} addresseeNames={post.addresseeNames} addresseePetnames={post.addresseePetnames} mentionNames={post.mentionNames} mentionAccts={post.mentionAccts} />
				<QuotedPost quoted={post.quotedPost} />
				<PostMedia post={post} onOpen={handleLightbox} onVote={onVote ? (pollId, choice) => onVote(post.id, pollId, choice) : undefined} />
			</PostCW>
			<PostReactions reactions={post.reactions} onToggle={onAction ? (reaction) => onAction(post.id, `reaction:${reaction.name}`) : undefined} onAdd={onReact ? (anchor) => onReact(post.id, anchor) : undefined} />
			<PostActions post={post} disabledActions={{ boost: post.visibility === 'private' }} replyExpanded={replyExpanded} replyControlsId={replyControlsId} onAction={(key) => onAction?.(post.id, key)} onReact={onReact ? (anchor) => onReact(post.id, anchor) : undefined} canManage={canManage} />
		</div>
	</div>
</PostBoost>

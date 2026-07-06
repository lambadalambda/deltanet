<script lang="ts">
	import AttachmentLightboxHost from '$lib/rebuild/AttachmentLightboxHost.svelte';
	import Button from '$lib/rebuild/Button.svelte';
	import Icon from '$lib/rebuild/Icon.svelte';
	import Post from '$lib/rebuild/Post.svelte';
	import TimelineLoadMore from '$lib/rebuild/TimelineLoadMore.svelte';
	import { createPleromaClient } from '$lib/pleroma/client';
	import { mergeTimelineItems, type PaginatedTimelineState } from '$lib/pleroma/timeline-state';
	import { adaptPleromaStatuses, normalizePleromaRequestError, type PleromaRequestErrorView, type PleromaStatusView } from '$lib/pleroma/ui';
	import { env } from '$env/dynamic/public';
	import type { BannerVariant, PostLike } from '$lib/rebuild/attachments';
	import type { SocialPost } from '$lib/social/types';
	import { onMount } from 'svelte';

	type PublicView = 'local' | 'federated';
	type RebuildPost = PostLike & {
		id: string | number;
		actionStatusId?: string;
		threadStatusId?: string;
		name: string;
		handle: string;
		time: string;
		createdAt?: string;
		avClass?: string;
		avBanner?: BannerVariant;
		avatarUrl?: string | null;
		body: string;
		mentionAccts?: Record<string, string>;
		boostedBy?: PostLike['boostedBy'];
		replies: number;
		boosts: number;
		favs: number;
		actions: { reply: boolean; boost: boolean; fav: boolean };
	};
	type PublicTimelineState = PaginatedTimelineState<PleromaStatusView, PleromaRequestErrorView>;

	let view = $state<PublicView>('local');
	let timelineState = $state<PublicTimelineState>({ status: 'idle' });
	let requestId = 0;

	const instanceUrl = env.PUBLIC_PLEROMA_INSTANCE_URL ?? 'https://pleroma.social';
	const avatarClass = (avatar: SocialPost['avatar']) =>
		avatar === 'pc' ? 'av-pixel-pc' :
		avatar === 'orb' ? 'av-orb' :
		avatar === 'grad-1' ? 'av-grad-1' :
		avatar === 'grad-2' ? 'av-grad-2' :
		avatar === 'grad-3' ? 'av-grad-3' :
		'av-anime';
	const postForRebuild = (post: PleromaStatusView): RebuildPost => ({
		id: post.id,
		actionStatusId: post.actionStatusId,
		threadStatusId: post.threadStatusId,
		name: post.name,
		handle: post.handle,
		time: post.time,
		createdAt: post.createdAt,
		avClass: avatarClass(post.avatar),
		avatarUrl: post.avatarUrl,
		body: post.body,
		mentionAccts: post.mentionAccts,
		media: post.media,
		attachments: post.attachments,
		boostedBy: post.boostedBy ? {
			name: post.boostedBy.name,
			nameEmojis: post.boostedBy.nameEmojis,
			handle: post.boostedBy.handle,
			time: post.boostedBy.time,
			createdAt: post.boostedBy.createdAt,
			avClass: post.boostedBy.avatar ? avatarClass(post.boostedBy.avatar) : undefined,
			avatarUrl: post.boostedBy.avatarUrl
		} : undefined,
		quotedPost: post.quotedPost,
		reactions: post.reactions,
		replies: post.replies,
		boosts: post.boosts,
		favs: post.favorites,
		actions: {
			reply: post.actions.reply,
			boost: post.actions.boost,
			fav: post.actions.favorite
		}
	});
	const posts = $derived(timelineState.status === 'success' ? timelineState.data.map(postForRebuild) : []);

	const loadTimeline = async (nextView = view) => {
		const nextRequestId = requestId + 1;
		requestId = nextRequestId;
		timelineState = { status: 'loading' };

		try {
			const client = createPleromaClient({ instanceUrl, fetch: window.fetch.bind(window) });
			const timelinePage = nextView === 'local' ? await client.getLocalTimelinePage() : await client.getFederatedTimelinePage();
			if (nextRequestId !== requestId) return;

			const adapted = adaptPleromaStatuses(timelinePage.items, { timelines: [nextView] });
			timelineState = adapted.length > 0
				? { status: 'success', data: adapted, nextCursor: timelinePage.cursors.next, loadMoreStatus: 'idle' }
				: { status: 'empty' };
		} catch (error) {
			if (nextRequestId !== requestId) return;
			timelineState = { status: 'error', error: normalizePleromaRequestError(error) };
		}
	};
	const loadMoreTimeline = async () => {
		if (timelineState.status !== 'success' || !timelineState.nextCursor || timelineState.loadMoreStatus === 'loading') return;

		const nextRequestId = requestId + 1;
		requestId = nextRequestId;
		const requestView = view;
		const nextCursor = timelineState.nextCursor;
		timelineState = { ...timelineState, loadMoreStatus: 'loading', loadMoreError: undefined };

		try {
			const client = createPleromaClient({ instanceUrl, fetch: window.fetch.bind(window) });
			const timelinePage = requestView === 'local' ? await client.getLocalTimelinePage(nextCursor) : await client.getFederatedTimelinePage(nextCursor);
			if (nextRequestId !== requestId || timelineState.status !== 'success') return;

			const adapted = adaptPleromaStatuses(timelinePage.items, { timelines: [requestView] });
			timelineState = {
				...timelineState,
				data: mergeTimelineItems(timelineState.data, adapted),
				nextCursor: timelinePage.cursors.next,
				loadMoreStatus: 'idle',
				loadMoreError: undefined
			};
		} catch (error) {
			if (nextRequestId !== requestId || timelineState.status !== 'success') return;
			timelineState = { ...timelineState, loadMoreStatus: 'error', loadMoreError: normalizePleromaRequestError(error) };
		}
	};
	const selectView = (nextView: PublicView) => {
		view = nextView;
		void loadTimeline(nextView);
	};

	onMount(() => {
		void loadTimeline();
	});
</script>

<svelte:head>
	<title>DeltaNet · Public Timeline</title>
</svelte:head>

<AttachmentLightboxHost />

<main class="public-route-shell">
	<section class="card public-panel">
		<div class="app-page-kicker">DeltaNet public</div>
		<h1>Public timeline</h1>
		<p>Read local and federated public posts without signing in.</p>
		<div class="tabs" role="tablist" aria-label="Public timeline sections">
			<button type="button" role="tab" aria-selected={view === 'local'} class="tab" class:active={view === 'local'} onclick={() => selectView('local')}>Local</button>
			<button type="button" role="tab" aria-selected={view === 'federated'} class="tab" class:active={view === 'federated'} onclick={() => selectView('federated')}>Federated</button>
		</div>

		{#if timelineState.status === 'loading'}
			<div class="request-state" role="status" aria-label="Request status">Loading Pleroma data</div>
		{:else if timelineState.status === 'empty'}
			<div class="request-state request-empty">
				<h2>No public posts yet</h2>
				<p>This Pleroma timeline returned no statuses for this slice.</p>
			</div>
		{:else if timelineState.status === 'error'}
			<div class="request-state request-error">
				<h2>{timelineState.error.title}</h2>
				<p>{timelineState.error.message}</p>
				{#if timelineState.error.retryable}
					<Button variant="secondary" onclick={() => loadTimeline()}>Retry request</Button>
				{/if}
			</div>
		{:else if timelineState.status === 'success'}
			<div data-testid="public-timeline-list">
				{#each posts as post (post.id)}
					<Post {post} onAction={() => {}} />
				{/each}
			</div>
			<TimelineLoadMore
				nextCursor={timelineState.nextCursor}
				loadMoreStatus={timelineState.loadMoreStatus}
				loadMoreError={timelineState.loadMoreError}
				onLoadMore={loadMoreTimeline}
			/>
		{/if}
	</section>
	<a class="public-home-link" href="/"><Icon name="arrowL" width={14} height={14} />Back to sign in</a>
</main>

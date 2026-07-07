<script lang="ts">
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import PetnameChip from './PetnameChip.svelte';
	import Post from './Post.svelte';
	import ProfileSideRail from './ProfileSideRail.svelte';
	import RichText from './RichText.svelte';
	import { profileHref } from './profile-links';
	import type { PleromaProfileFollowState, PleromaProfileView } from '$lib/pleroma/ui';
	import type { ProfileMediaItem, ProfilePost } from './profile';

	type ProfileTab = 'posts' | 'replies' | 'media';
	type Props = {
		profile: PleromaProfileView;
		posts?: ProfilePost[];
		replies?: ProfilePost[];
		pinned?: ProfilePost[];
		media?: ProfileMediaItem[];
		timelineLoading?: boolean;
		followPending?: boolean;
		followError?: string | null;
		signedOut?: boolean;
		onPostOpen?: (post: ProfilePost) => void;
		onPostAction?: (post: ProfilePost, key: string) => void;
		onPostReact?: (post: ProfilePost, anchor: HTMLElement) => void;
		onPostVote?: (post: ProfilePost, pollId: string | undefined, choice: string | string[]) => void;
		canManage?: boolean;
		onEditProfile?: () => void;
		onFollowToggle?: () => void;
		onSignIn?: () => void;
		/** Petnames (meta/issues/petnames.md): save MY local name for this contact ('' clears). */
		onSetPetname?: (petname: string) => void | Promise<void>;
		petnamePending?: boolean;
		petnameError?: string | null;
		/** Visibility channels 1B: ask this contact for followers-only access. */
		onRequestLocked?: () => void | Promise<void>;
		lockedRequestState?: 'idle' | 'pending' | 'requested';
	};

	let { profile, posts = [], replies = [], pinned = [], media = [], timelineLoading = false, followPending = false, followError = null, signedOut = false, onPostOpen, onPostAction, onPostReact, onPostVote, canManage = false, onEditProfile, onFollowToggle, onSignIn, onSetPetname, petnamePending = false, petnameError = null, onRequestLocked, lockedRequestState = 'idle' }: Props = $props();
	let tab = $state<ProfileTab>('posts');
	let pinnedExpanded = $state(false);
	let petnameEditorOpen = $state(false);
	let petnameDraft = $state('');
	const openPetnameEditor = () => {
		petnameDraft = profile.petname ?? '';
		petnameEditorOpen = true;
	};
	const savePetname = async () => {
		if (!onSetPetname || petnamePending) return;
		await onSetPetname(petnameDraft.trim());
		petnameEditorOpen = false;
	};
	let locked = $derived(profile.relations.locked && !['mutual', 'following', 'self'].includes(profile.followState));
	let empty = $derived(posts.length === 0 && replies.length === 0 && pinned.length === 0 && media.length === 0 && !timelineLoading);
	let visiblePinned = $derived(pinnedExpanded ? pinned : pinned.slice(0, 1));
	let tabPosts = $derived(tab === 'replies' ? replies : posts);
	let href = $derived(profileHref(profile.handle));
	const followLabel = (state: PleromaProfileFollowState) =>
		state === 'self' ? 'Edit profile' :
		state === 'following' ? 'Following' :
		state === 'mutual' ? 'Mutuals' :
		state === 'requested' ? 'Requested' :
		state === 'blocked' ? 'Blocked' :
		'Follow';
	const followTitle = (state: PleromaProfileFollowState) =>
		state === 'self' ? 'Edit profile settings' :
		signedOut ? 'Sign in to follow' :
		!onFollowToggle ? 'Follow controls are not wired yet' :
		state === 'following' || state === 'mutual' ? `Unfollow ${profile.handle}` :
		state === 'requested' ? 'Cancel follow request' :
		state === 'blocked' ? 'You have blocked this account' :
		`Follow ${profile.handle}`;
	let followButtonLabel = $derived(signedOut && profile.followState !== 'self' ? 'Sign in to follow' : followLabel(profile.followState));
	let followButtonDisabled = $derived(
		profile.followState === 'self' ? false :
		signedOut ? false :
		profile.followState === 'blocked' || followPending || !onFollowToggle
	);
	const handleFollowClick = () => {
		if (profile.followState === 'self') {
			onEditProfile?.();
			return;
		}
		if (signedOut) {
			onSignIn?.();
			return;
		}
		onFollowToggle?.();
	};
</script>

<section class="pp-page" data-testid="profile-view" aria-labelledby="profile-heading">
	<header class="pp-feed pp-profile-head">
		<div class="pp-v1-banner">
			{#if profile.headerUrl}
				<img class="pp-v1-banner-img" src={profile.headerUrl} alt="" loading="lazy" decoding="async" />
			{/if}
		</div>
		<div class="pp-v1-id">
			<div class="pp-v1-id-top">
				<Avatar avatarUrl={profile.avatarUrl} alt={`${profile.displayName} avatar`} profileHref={href} size={104} className="pp-v1-av" />
				<div class="pp-v1-actions">
					<button type="button" class="pp-follow-btn" class:is-following={profile.followState === 'following' || profile.followState === 'mutual' || profile.followState === 'self'} class:is-blocked={profile.followState === 'blocked'} title={followTitle(profile.followState)} disabled={followButtonDisabled} onclick={handleFollowClick}>
						<span class="pp-btn-l">{followButtonLabel}</span>
					</button>
					{#if profile.followState !== 'self'}
						<button type="button" class="pp-icon-btn" title="Notifications not wired yet" aria-label="Profile notifications" disabled><Icon name="bell" width={14} height={14} /></button>
					{/if}
					{#if onRequestLocked && (profile.followState === 'following' || profile.followState === 'mutual')}
						<button
							type="button"
							class="pp-follow-btn pp-locked-request"
							data-testid="request-locked"
							disabled={lockedRequestState !== 'idle'}
							title="Ask for access to their followers-only posts"
							onclick={() => void onRequestLocked()}
						>
							<span class="pp-btn-l">{lockedRequestState === 'requested' ? 'Locked access requested' : lockedRequestState === 'pending' ? 'Requesting…' : 'Request locked access'}</span>
						</button>
					{/if}
					<button type="button" class="pp-icon-btn" title="More profile actions not wired yet" aria-label="More profile actions" disabled><Icon name="more" width={14} height={14} /></button>
				</div>
			</div>
			{#if followError}
				<div class="pp-follow-error" role="alert" data-testid="profile-follow-error">{followError}</div>
			{/if}
			<h1 id="profile-heading" class="pp-v1-name">
				<RichText text={profile.petname ? (profile.authName || profile.displayName) : profile.displayName} emojis={profile.displayNameEmojis} />
				{#if profile.petname}<PetnameChip petname={profile.petname} />{/if}
				{#if onSetPetname && profile.followState !== 'self'}
					<button type="button" class="pp-petname-edit" data-testid="petname-edit" title={profile.petname ? 'Edit petname' : 'Set a petname'} onclick={openPetnameEditor}>{profile.petname ? 'edit petname' : 'set petname'}</button>
				{/if}
				{#if profile.relations.locked}<span class="pp-relation-pill locked"><Icon name="lock" width={9} height={9} /> locked</span>{/if}
				{#if profile.relations.bot}<span class="pp-relation-pill bot">bot</span>{/if}
				{#if profile.relations.remote}<span class="pp-relation-pill remote">remote</span>{/if}
			</h1>
			{#if petnameEditorOpen}
				<form class="pp-petname-form" data-testid="petname-form" onsubmit={(event) => { event.preventDefault(); void savePetname(); }}>
					<input
						class="pp-petname-input"
						aria-label="Petname"
						placeholder="Your name for them (empty clears)"
						value={petnameDraft}
						oninput={(event) => (petnameDraft = event.currentTarget.value)}
					/>
					<button type="submit" class="pp-petname-save" disabled={petnamePending}>{petnamePending ? 'Saving…' : 'Save'}</button>
					<button type="button" class="pp-petname-cancel" onclick={() => (petnameEditorOpen = false)}>Cancel</button>
				</form>
				{#if petnameError}
					<div class="pp-follow-error" role="alert" data-testid="petname-error">{petnameError}</div>
				{/if}
			{/if}
			<div class="pp-v1-handle">{profile.handle}</div>
		</div>
		{#if profile.bio}
			<div class="pp-v1-bio">{profile.bio}</div>
		{/if}
	</header>

	<div class="pp-inline-rail">
		<ProfileSideRail {profile} {pinned} />
	</div>

	<div class="pp-feed pp-profile-body">
		{#if pinned.length > 0}
			<div class="pp-pinned-strip">
				<div class="pp-pinned-l">
					<span>pinned</span>
					<span class="pp-pinned-count">· {pinned.length}</span>
					{#if pinned.length > 1}
						<button type="button" class="pp-pinned-toggle" onclick={() => (pinnedExpanded = !pinnedExpanded)}>{pinnedExpanded ? 'Collapse' : `Show all (${pinned.length})`}</button>
					{/if}
				</div>
				<div>
					{#each visiblePinned as post (post.id)}
						<Post {post} onOpen={() => onPostOpen?.(post)} onAction={(key) => onPostAction?.(post, key)} onReact={onPostReact ? (anchor) => onPostReact(post, anchor) : undefined} onVote={onPostVote ? (pollId, choice) => onPostVote(post, pollId, choice) : undefined} canManage={canManage} />
					{/each}
				</div>
			</div>
		{/if}

		<div class="pp-tabs" role="tablist" aria-label="Profile timeline tabs">
			<button type="button" role="tab" class="pp-tab" class:active={tab === 'posts'} aria-selected={tab === 'posts'} onclick={() => (tab = 'posts')}>Posts<span class="pp-tab-count">{profile.stats.posts}</span></button>
			<button type="button" role="tab" class="pp-tab" class:active={tab === 'replies'} aria-selected={tab === 'replies'} onclick={() => (tab = 'replies')}>Posts &amp; Replies<span class="pp-tab-count">{replies.length}</span></button>
			<button type="button" role="tab" class="pp-tab" class:active={tab === 'media'} aria-selected={tab === 'media'} onclick={() => (tab = 'media')}>Media<span class="pp-tab-count">{media.length}</span></button>
			<span class="pp-tabs-spacer"></span>
		</div>

		{#if timelineLoading}
			<div class="pp-empty" role="status" aria-label="Profile timeline status">
				<div class="pp-empty-h">Loading profile posts</div>
				<div class="pp-empty-s">Fetching {profile.displayName}'s posts, replies, pinned posts, and media.</div>
			</div>
		{:else if empty && locked}
			<div class="pp-locked">
				<div class="pp-locked-icon"><Icon name="lock" width={16} height={16} /></div>
				<div class="pp-locked-h">This account is locked</div>
				<div class="pp-locked-s">{profile.displayName} approves followers manually. Send a follow request to see their posts.</div>
				{#if signedOut}
					<button type="button" class="pp-follow-btn" onclick={() => onSignIn?.()}>Sign in to follow</button>
				{:else}
					<button type="button" class="pp-follow-btn" disabled={!onFollowToggle || followPending || profile.followState === 'blocked'} onclick={() => onFollowToggle?.()}>{profile.followState === 'requested' ? 'Requested' : 'Send follow request'}</button>
				{/if}
			</div>
		{:else if empty}
			<div class="pp-empty">
				<div class="pp-empty-h">Nothing here yet</div>
				<div class="pp-empty-s">{profile.displayName} hasn't posted anything yet. Check back later or follow to get notified when they do.</div>
			</div>
		{:else if tab === 'media'}
			<div class="pp-media-grid" data-testid="profile-media-grid">
				{#each media as item, index (`${item.kind}:${index}`)}
					{#if item.kind === 'audio'}
						<div class="pp-media-cell audio">
							<span class="pp-media-title">{item.title}</span>
							<span class="pp-media-kind">AUDIO</span>
						</div>
					{:else if item.kind === 'video'}
						<div class="pp-media-cell">
							{#if item.src}<img src={item.src} alt={item.alt ?? item.title ?? ''} loading="lazy" decoding="async" />{/if}
							<span class="pp-media-kind">VIDEO</span>
						</div>
					{:else}
						<div class="pp-media-cell">
							<img src={item.src} alt={item.alt ?? ''} loading="lazy" decoding="async" />
						</div>
					{/if}
				{/each}
			</div>
		{:else}
			<div data-testid="profile-posts">
				{#each tabPosts as post (post.id)}
					<Post {post} onOpen={() => onPostOpen?.(post)} onAction={(key) => onPostAction?.(post, key)} onReact={onPostReact ? (anchor) => onPostReact(post, anchor) : undefined} onVote={onPostVote ? (pollId, choice) => onPostVote(post, pollId, choice) : undefined} canManage={canManage} />
				{/each}
			</div>
		{/if}
	</div>
</section>

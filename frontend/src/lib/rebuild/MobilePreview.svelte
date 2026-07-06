<script lang="ts">
	import AncestorPost from './AncestorPost.svelte';
	import FocusedPost from './FocusedPost.svelte';
	import Icon from './Icon.svelte';
	import Post from './Post.svelte';
	import type { BannerVariant, PostLike } from './attachments';
	import type { IconName } from './icons';

	type Variant = 'home' | 'drawer' | 'thread';
	type PreviewPost = PostLike & {
		id: string | number;
		name: string;
		handle: string;
		time?: string;
		avClass?: string;
		avBanner?: BannerVariant;
		body: string;
		replies: number;
		boosts: number;
		favs: number;
		fullTime?: string;
		source?: string;
		views?: string;
		bookmarks?: number;
		actions: { reply: boolean; boost: boolean; fav: boolean };
	};
	type BottomItem = { label: string; icon: IconName; active?: boolean; count?: number };
	type DrawerItem = { label: string; icon: IconName; active?: boolean; count?: number };
	type Props = {
		variant: Variant;
		label: string;
	};

	let { variant, label }: Props = $props();

	const samplePost: PreviewPost = {
		id: 'sample',
		name: 'emi',
		handle: '@emichan@kolektiva.social',
		time: '16m',
		avClass: 'av-anime',
		body: 'tiny update: fixed some bugs, added a toggle, and touched grass.\n\nthe internet can wait.',
		replies: 2,
		boosts: 7,
		favs: 42,
		actions: { reply: false, boost: false, fav: false },
	};
	const bannerPost: PreviewPost = {
		...samplePost,
		id: 'banner',
		name: 'dreambyte',
		handle: '@dreambyte@deltanet.example',
		avClass: '',
		avBanner: 'sunset',
		body: '🤍',
	};
	const ancestorPost: PreviewPost = {
		id: 'ancestor',
		name: 'gridwave',
		handle: '@gridwave@retro.social',
		time: '5h',
		avClass: 'av-pixel-pc',
		body: 'anyone else feel like the web got a little too loud lately?',
		replies: 18,
		boosts: 42,
		favs: 210,
		actions: { reply: false, boost: false, fav: false },
	};
	const focusedPost: PreviewPost = {
		...samplePost,
		id: 'focused',
		fullTime: '4:18 PM · May 11, 2026',
		source: 'DeltaNet™ Web',
		views: '12.4K',
		bookmarks: 24,
	};
	const bottomItems: BottomItem[] = [
		{ label: 'Home', icon: 'home', active: true },
		{ label: 'Explore', icon: 'search' },
		{ label: 'Alerts', icon: 'bell', count: 3 },
		{ label: 'Settings', icon: 'gear' },
		{ label: 'More', icon: 'list' },
	];
	const drawerItems: DrawerItem[] = [
		{ label: 'Home', icon: 'home', active: true },
		{ label: 'Local', icon: 'users' },
		{ label: 'Federated', icon: 'globe' },
		{ label: 'Notifications', icon: 'bell', count: 3 },
		{ label: 'Settings', icon: 'gear' },
	];
</script>

<div class="ds-phone-wrap">
	<div class="ds-phone">
		<div class="ds-phone-notch"></div>
		<div class="ds-phone-screen">
			{#if variant === 'home'}
				<div class="ds-mobile-app">
					<div class="ds-mobile-statusbar">
						<span>9:41</span>
						<span class="ds-mobile-battery"></span>
					</div>
					<div class="ds-mobile-header">
						<button type="button" class="menu-btn" aria-label="Menu">
							<svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
						</button>
						<div class="brand-name mobile-brand-name">DeltaNet<sup>™</sup></div>
						<button type="button" class="icon-btn" aria-label="Notifications">
							<Icon name="bell" width={18} height={18} />
							<span class="badge">3</span>
						</button>
					</div>
					<div class="ds-mobile-feed">
						<Post post={samplePost} onAction={() => {}} />
						<Post post={bannerPost} onAction={() => {}} />
					</div>
					<nav class="ds-mobile-bottom" aria-label="Mobile bottom navigation preview">
						{#each bottomItems as item}
							<button type="button" class:active={item.active} class="mob-tab">
								<Icon name={item.icon} />
								<span>{item.label}</span>
								{#if item.count}<span class="tab-badge">{item.count}</span>{/if}
							</button>
						{/each}
					</nav>
				</div>
			{:else if variant === 'drawer'}
				<div class="ds-mobile-app">
					<div class="ds-mobile-statusbar"><span>9:41</span></div>
					<div class="ds-mobile-drawer-inner">
						<div class="drawer-head">
							<div class="drawer-brand">
								<div class="brand-mark"><Icon name="sparkBig" /></div>
								<div class="brand-name mobile-brand-name">DeltaNet<sup>™</sup></div>
							</div>
							<button type="button" class="drawer-close" aria-label="Close drawer">
								<svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
							</button>
						</div>
						<div class="ds-mobile-drawer-stack">
							<div class="card">
								<div class="ds-mobile-profile-card">
									<div class="ds-mobile-profile-name">dreambyte</div>
									<div class="ds-mobile-profile-handle">@dreambyte@pleroma.social</div>
								</div>
							</div>
							<div class="card ds-mobile-side-card">
								{#each drawerItems as item}
									<button type="button" class:active={item.active} class="side-nav-item">
										<span class="ico"><Icon name={item.icon} width={16} height={16} /></span>
										<span>{item.label}</span>
										{#if item.count}<span class="count">{item.count}</span>{/if}
									</button>
								{/each}
							</div>
						</div>
					</div>
				</div>
			{:else}
				<div class="ds-mobile-app">
					<div class="ds-mobile-statusbar"><span>9:41</span></div>
					<div class="ds-mobile-thread">
						<div class="card thread">
							<div class="thread-head">
								<button type="button" class="thread-back" aria-label="Back"><Icon name="arrowL" width={16} height={16} /></button>
								<div class="thread-head-title">Thread</div>
								<button type="button" class="tab-action" aria-label="More"><Icon name="more" width={14} height={14} /></button>
							</div>
							<AncestorPost post={ancestorPost} onAction={() => {}} />
							<FocusedPost post={focusedPost} continuesAbove onAction={() => {}} />
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
	<div class="ds-phone-label">{label}</div>
</div>

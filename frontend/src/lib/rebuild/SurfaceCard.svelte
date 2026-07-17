<script lang="ts">
	import Avatar from './Avatar.svelte';
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';
	import Pill from './Pill.svelte';
	import RichText from './RichText.svelte';
	import VaporBanner from './VaporBanner.svelte';
	import { profileHref } from './profile-links';
	import type { CustomEmoji } from '$lib/social/types';
	import type { IconName } from './icons';

	type RequestError = { title: string; message: string; status?: number };
	type RequestState<Data> =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'empty' }
		| { status: 'error'; error: RequestError }
		| { status: 'success'; data: Data };
	type TrendStateItem = { rank: number; tag: string; count: string | null };
	type InstanceStatusItem = { label: string; value: string };
	type InstanceStatus = { title: string | null; domain: string | null; rows: InstanceStatusItem[] };
	type SuggestionView = {
		id: string;
		name: string;
		nameEmojis?: CustomEmoji[];
		handle: string;
		avatarUrl?: string | null;
		followLabel: string;
		followActive: boolean;
		followDisabled: boolean;
	};
	type Props = {
		kind: string;
		trendsState?: RequestState<TrendStateItem[]>;
		instanceState?: RequestState<InstanceStatus>;
		suggestions?: SuggestionView[];
		onSuggestionFollow?: (suggestion: SuggestionView) => void;
	};
	type Trend = { rank: number; tag: string; count: string };
	type Suggestion = { id: string; name: string; handle: string; av: string };
	type Shortcut = { icon: IconName; label: string; key: string };
	type QuickSearchItem = { icon: IconName; label: string };
	type Tip = { icon: IconName; text: string };
	type Stat = { label: string; value: string };

	let { kind, trendsState, instanceState, suggestions: liveSuggestions, onSuggestionFollow }: Props = $props();
	let following = $state<Record<string, boolean>>({});

	const trends: Trend[] = [
		{ rank: 1, tag: '#fediverse', count: '12.4K' },
		{ rank: 2, tag: '#IndieWeb', count: '6,213' },
		{ rank: 3, tag: '#pleroma', count: '5,105' },
		{ rank: 4, tag: '#vaporwave', count: '3,901' },
		{ rank: 5, tag: '#selfhosted', count: '2,844' },
	];
	const suggestions: Suggestion[] = [
		{ id: 'nyan', name: 'nyan.binary', handle: '@nyan@catgirl.cloud', av: 'av-anime' },
		{ id: 'datagram', name: 'datagram', handle: '@datagram@retro.social', av: 'av-pixel-pc' },
		{ id: 'soft', name: 'soft.hertz', handle: '@soft.hertz@kolektiva.social', av: 'av-grad-3' },
	];
	const shortcuts: Shortcut[] = [
		{ icon: 'pencil', label: 'Compose new post', key: 'N' },
		{ icon: 'msg', label: 'Direct messages', key: 'M' },
		{ icon: 'bookmark', label: 'Bookmarks', key: 'B' },
		{ icon: 'list', label: 'Lists', key: 'L' },
		{ icon: 'gear', label: 'User settings', key: 'S' },
	];
	const quickSearchItems: QuickSearchItem[] = [
		{ icon: 'search', label: 'Search users' },
		{ icon: 'users', label: 'Search communities' },
		{ icon: 'hash', label: 'Search hashtags' },
	];
	const profileStats: Stat[] = [
		{ label: 'Posts', value: '1,248' },
		{ label: 'Following', value: '312' },
		{ label: 'Followers', value: '1,921' },
	];
	const profileTips: Tip[] = [
		{ icon: 'image', text: 'Your avatar will be shown at 96×96px.' },
		{ icon: 'users', text: 'The banner helps personalize your profile.' },
		{ icon: 'ext', text: 'Link your website to drive traffic.' },
		{ icon: 'info', text: 'A good bio helps others find you.' },
	];

	const toggleFollow = (id: string) => {
		following = { ...following, [id]: !following[id] };
	};
	const unavailableError = (error: RequestError) => error.status === 404 || error.status === 410;
</script>

{#if kind === 'trends'}
	<div class="card surface-card" data-testid="trends-card">
		<div class="card-head">
			<span class="card-title">Trends</span>
			<Icon name="trend" width={16} height={16} className="surface-head-icon" />
		</div>
		{#if trendsState}
			{#if trendsState.status === 'idle' || trendsState.status === 'loading'}
				<div class="surface-state" role="status">Loading trends</div>
			{:else if trendsState.status === 'empty'}
				<div class="surface-state">No trends available</div>
			{:else if trendsState.status === 'error'}
				<div class="surface-state surface-state-error">
					<strong>{unavailableError(trendsState.error) ? 'Trends unavailable' : trendsState.error.title}</strong>
					{#if !unavailableError(trendsState.error)}<span>{trendsState.error.message}</span>{/if}
				</div>
			{:else}
				<div class="trend-list">
					{#each trendsState.data as trend}
						<button type="button" class="trend-item">
							<span class="trend-rank">{trend.rank}</span>
							<span>
								<span class="trend-tag">{trend.tag}</span>
								{#if trend.count}<span class="trend-meta">{trend.count}</span>{/if}
							</span>
						</button>
					{/each}
				</div>
				<button type="button" class="card-foot">View all trends →</button>
			{/if}
		{:else}
			<div class="trend-list">
				{#each trends as trend}
					<button type="button" class="trend-item">
						<span class="trend-rank">{trend.rank}</span>
						<span>
							<span class="trend-tag">{trend.tag}</span>
							<span class="trend-meta">{trend.count} posts</span>
						</span>
					</button>
				{/each}
			</div>
			<button type="button" class="card-foot">View all trends →</button>
		{/if}
	</div>
{:else if kind === 'who-to-follow'}
	<div class="card surface-card" data-testid="who-to-follow-card">
		<div class="card-head">
			<span class="card-title">Who to follow</span>
			<Icon name="users" width={16} height={16} className="surface-head-icon" />
		</div>
		{#if liveSuggestions}
			<div class="surface-card-list">
				{#each liveSuggestions as suggestion (suggestion.id)}
					<div class="suggest">
						<Avatar variant="plain" element="span" className="suggest-av" avatarUrl={suggestion.avatarUrl} alt={`${suggestion.name} avatar`} />
						<div>
							<a class="suggest-name" href={profileHref(suggestion.handle) ?? undefined}><RichText text={suggestion.name} emojis={suggestion.nameEmojis} linkMentions={false} /></a>
							<div class="suggest-handle">{suggestion.handle}</div>
						</div>
						<Button variant="follow" className={suggestion.followActive ? 'following' : ''} disabled={suggestion.followDisabled} onclick={() => onSuggestionFollow?.(suggestion)}>
							{suggestion.followLabel}
						</Button>
					</div>
				{/each}
			</div>
		{:else}
			<div class="surface-card-list">
				{#each suggestions as suggestion}
					<div class="suggest">
						<div class="suggest-av {suggestion.av}"></div>
						<div>
							<div class="suggest-name">{suggestion.name}</div>
							<div class="suggest-handle">{suggestion.handle}</div>
						</div>
						<Button variant="follow" className={following[suggestion.id] ? 'following' : ''} onclick={() => toggleFollow(suggestion.id)}>
							{following[suggestion.id] ? 'Following' : 'Follow'}
						</Button>
					</div>
				{/each}
			</div>
			<button type="button" class="card-foot">View more suggestions →</button>
		{/if}
	</div>
{:else if kind === 'shortcuts'}
	<div class="card surface-card">
		<div class="card-head">
			<span class="card-title">Shortcuts</span>
			<Icon name="bolt" width={16} height={16} className="surface-head-icon" />
		</div>
		<div class="surface-card-list">
			{#each shortcuts as shortcut}
				<button type="button" class="short">
					<span class="ico"><Icon name={shortcut.icon} width={14} height={14} /></span>
					<span>{shortcut.label}</span>
					<span class="key">{shortcut.key}</span>
				</button>
			{/each}
		</div>
	</div>
{:else if kind === 'instance-status'}
	<div class="card surface-card" data-testid="instance-status-card">
		<div class="card-head">
			<span class="card-title">Instance status</span>
			<Icon name="pulse" width={16} height={16} className="surface-head-icon" />
		</div>
		{#if instanceState}
			{#if instanceState.status === 'idle' || instanceState.status === 'loading'}
				<div class="surface-state" role="status">Loading instance metadata</div>
			{:else if instanceState.status === 'empty'}
				<div class="surface-state">No instance metadata</div>
			{:else if instanceState.status === 'error'}
				<div class="surface-state surface-state-error">
					<strong>{unavailableError(instanceState.error) ? 'Instance metadata unavailable' : instanceState.error.title}</strong>
					{#if !unavailableError(instanceState.error)}<span>{instanceState.error.message}</span>{/if}
				</div>
			{:else}
				<div>
					{#if instanceState.data.title || instanceState.data.domain}
						<div class="status-row no-dot"><span class="l">{instanceState.data.title ?? instanceState.data.domain}</span>{#if instanceState.data.title && instanceState.data.domain}<span class="r">{instanceState.data.domain}</span>{/if}</div>
					{/if}
					{#each instanceState.data.rows as row}
						<div class="status-row"><span class="l">{row.label}</span><span class="r">{row.value}</span></div>
					{/each}
				</div>
			{/if}
		{:else}
			<div>
				<div class="status-row"><span class="l">headwater.example</span><Pill>All systems normal</Pill></div>
				<div class="status-row"><span class="l">Uptime</span><span class="r">30d 12h 42m</span></div>
				<div class="status-row"><span class="l">Users</span><span class="r">2,487</span></div>
			</div>
		{/if}
	</div>
{:else if kind === 'quick-search'}
	<div class="card surface-card">
		<div class="card-head surface-head-quiet">
			<span class="card-title">Quick search</span>
		</div>
		<div class="surface-qs-list">
			{#each quickSearchItems as item}
				<button type="button" class="qs">
					<Icon name={item.icon} width={14} height={14} />
					<span>{item.label}</span>
					<Icon name="arrowR" width={14} height={14} className="arr" />
				</button>
			{/each}
		</div>
	</div>
{:else if kind === 'footer'}
	<div class="card surface-card footer-card">
		<div><span class="v">HEADWATER™ 2.4.58</span></div>
		<div class="footer-copy">© 2024 Headwater™ Contributors</div>
		<div class="footer-links">
			<a href="#surfaces">Docs</a>
			<span>·</span>
			<a href="#surfaces">GitHub</a>
			<span>·</span>
			<a href="#surfaces">About</a>
		</div>
	</div>
{:else if kind === 'profile-preview'}
	<div class="card surface-card surface-profile-preview">
		<div class="surface-profile-head">
			<div>Profile preview</div>
		</div>
		<div class="surface-profile-visual">
			<div class="preview-banner">
				<VaporBanner variant="sunset" />
				<button type="button" class="preview-edit">Edit preview <Icon name="ext" width={11} height={11} /></button>
			</div>
			<div class="preview-av-wrap">
				<VaporBanner variant="sunset" />
			</div>
		</div>
		<div class="surface-preview-body">
			<div class="surface-preview-name">dreambyte</div>
			<div class="surface-preview-handle">@dreambyte@headwater.example</div>
			<div class="surface-preview-bio">living in a soft world</div>
			<div class="stat-row">
				{#each profileStats as stat}
					<div class="stat">
						<div class="stat-label">{stat.label}</div>
						<div class="stat-value">{stat.value}</div>
					</div>
				{/each}
			</div>
			<div class="surface-preview-note">This is how your profile appears to other users.</div>
		</div>
	</div>
{:else if kind === 'profile-tips'}
	<div class="card surface-card">
		<div class="card-head surface-head-quiet">
			<span class="surface-tip-title"><Icon name="info" width={14} height={14} />Profile tips</span>
		</div>
		<div class="surface-tip-list">
			{#each profileTips as tip}
				<div class="surface-tip">
					<Icon name={tip.icon} width={14} height={14} />
					<span>{tip.text}</span>
				</div>
			{/each}
		</div>
		<button type="button" class="card-foot">Learn more about profiles →</button>
	</div>
{/if}

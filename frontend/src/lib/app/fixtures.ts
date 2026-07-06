import { pleromaFixtures } from '$lib/pleroma/fixtures';
import { adaptPleromaStatus, adaptPleromaStatuses } from '$lib/pleroma/ui';
import type { ThreadPost } from '$lib/social/types';

export const appTimelinePosts = adaptPleromaStatuses(pleromaFixtures.timelines.home, { timelines: ['home'] });
export const publicTimelinePosts = adaptPleromaStatuses(pleromaFixtures.timelines.public, { timelines: ['federated'] });
export const localTimelinePosts = [adaptPleromaStatus(pleromaFixtures.status, { timelines: ['local'] })];
export const federatedTimelinePosts = publicTimelinePosts;
export const focusedThreadPost = appTimelinePosts[0];

export const appTrends = [
	{ rank: 1, tag: '#fediverse', count: '12.4K' },
	{ rank: 2, tag: '#IndieWeb', count: '6,213' },
	{ rank: 3, tag: '#pleroma', count: '5,105' },
	{ rank: 4, tag: '#vaporwave', count: '3,901' },
	{ rank: 5, tag: '#selfhosted', count: '2,844' }
];

export const followSuggestions = [
	{ id: 'nyan', name: 'nyan.binary', handle: '@nyan@catgirl.cloud', avatar: 'anime' },
	{
		id: 'datagram',
		name: 'datagram',
		handle: '@datagram@a-very-long-retro-instance-name.social',
		avatar: 'pc'
	},
	{ id: 'soft', name: 'soft.hertz', handle: '@soft.hertz@kolektiva.social', avatar: 'grad' }
];

export const appShortcuts = [
	{ label: 'Compose new post', key: 'N' },
	{ label: 'Direct messages', key: 'M' },
	{ label: 'Bookmarks', key: 'B' },
	{ label: 'Lists', key: 'L' },
	{ label: 'User settings', key: 'S' }
];

export const threadAncestors: ThreadPost[] = [
	{
		id: 'ancestor-gridwave',
		name: 'gridwave',
		handle: '@gridwave@retro.social',
		time: '5h',
		body: 'anyone else feel like the web got a little too loud lately?',
		avatar: 'pc',
		replies: 18,
		boosts: 42,
		favorites: 210,
		actions: { reply: false, boost: false, favorite: false }
	}
];

export const initialThreadReplies: ThreadPost[] = [
	{
		id: 'reply-datagram',
		name: 'datagram',
		handle: '@datagram@retro.social',
		time: '34m',
		body: 'we used to log off. when did that stop being a thing.',
		avatar: 'pc',
		replies: 4,
		boosts: 12,
		favorites: 64,
		actions: { reply: false, boost: false, favorite: false },
		nestedReplies: [
			{
				id: 'reply-orbit',
				name: 'orbit',
				handle: '@orbit@spacebear.net',
				time: '20m',
				body: 'around the time the algorithm replaced the timeline.',
				avatar: 'orb',
				replies: 0,
				boosts: 5,
				favorites: 22,
				actions: { reply: false, boost: false, favorite: false }
			}
		]
	},
	{
		id: 'reply-nyan',
		name: 'nyan.binary',
		handle: '@nyan@catgirl.cloud',
		time: '12m',
		body: 'this is the energy i needed today.',
		avatar: 'orb',
		replies: 2,
		boosts: 3,
		favorites: 18,
		actions: { reply: false, boost: false, favorite: false },
		nestedReplies: [
			{
				id: 'reply-dreambyte',
				name: 'dreambyte',
				handle: '@dreambyte@deltanet.example',
				time: '8m',
				body: 'saving this thread for later.',
				avatar: 'grad-1',
				replies: 0,
				boosts: 0,
				favorites: 4,
				actions: { reply: false, boost: false, favorite: false }
			}
		]
	},
	{
		id: 'reply-soft',
		name: 'soft.hertz',
		handle: '@soft.hertz@kolektiva.social',
		time: '22m',
		body: 'touched grass too. recommend the slow internet diet.',
		avatar: 'grad-3',
		replies: 0,
		boosts: 7,
		favorites: 31,
		actions: { reply: false, boost: false, favorite: false }
	}
];

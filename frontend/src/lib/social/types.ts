export type TimelineView = 'home' | 'local' | 'federated';
export type PostAction = 'reply' | 'boost' | 'favorite';
export type ReplySort = 'top' | 'newest';
export type AvatarVariant = 'grad-1' | 'grad-2' | 'grad-3' | 'orb' | 'pc';
export type MediaVariant = 'sunset' | 'city' | 'space';
export type ActionState = Record<PostAction, boolean>;

export type SocialNotificationKind = 'fav' | 'boost' | 'reply' | 'mention' | 'follow' | 'follow_req' | 'poll' | 'reaction' | 'unknown';

export type SocialNotificationActor = {
	name: string;
	handle?: string;
	av: MediaVariant;
	avatarUrl?: string | null;
	emojis?: CustomEmoji[];
};

export type SocialNotificationPostRef = {
	excerpt: string;
	tStamp?: string;
};

export type SocialNotificationTarget =
	| { route: 'thread'; statusId: string }
	| { route: 'profile'; accountHandle: string; accountId?: string }
	| { route: 'none' };

export type SocialNotificationData = {
	id: string;
	kind: SocialNotificationKind;
	read: boolean;
	time: string;
	t: number;
	who: SocialNotificationActor[];
	post?: SocialNotificationPostRef;
	reactionEmoji?: { name: string; url?: string | null };
	bio?: string;
	on?: string;
	target?: SocialNotificationTarget;
	createdAt?: string;
	rawType?: string;
};

export type CustomEmoji = {
	shortcode: string;
	url: string;
	staticUrl?: string;
};

export type PhotoAttachment = {
	kind: 'photo';
	src: string;
	alt?: string;
	cw?: boolean;
	filename?: string;
};

export type VideoAttachment = {
	kind: 'video';
	src?: string;
	posterUrl?: string;
	title?: string;
	duration?: string;
	poster?: MediaVariant;
	cc?: boolean;
	caption?: string;
	start?: number;
	filename?: string;
};

export type AudioAttachment = {
	kind: 'audio';
	src?: string;
	title: string;
	byline?: string;
	duration?: string;
	cover?: string;
	start?: number;
	filename?: string;
};

export type PollChoice = {
	id?: string;
	label: string;
	votes?: number;
};

export type PollAttachment = {
	kind: 'poll';
	id?: string;
	choices?: PollChoice[];
	totalVotes?: number;
	multi?: boolean;
	endsIn?: string;
	endedAgo?: string;
	myVote?: string | string[] | null;
	voted?: boolean;
	expired?: boolean;
};

export type PostAttachment = PhotoAttachment | VideoAttachment | AudioAttachment | PollAttachment;

export type QuotedPostView = {
	href?: string;
	name: string;
	nameEmojis?: CustomEmoji[];
	handle: string;
	time: string;
	createdAt?: string;
	body: string;
	bodyEmojis?: CustomEmoji[];
	mentionAccts?: Record<string, string>;
	avatar?: AvatarVariant;
	avClass?: string;
	avatarUrl?: string | null;
	avatarBanner?: MediaVariant | 'pixel-window';
	replies?: number;
	boosts?: number;
	favs?: number;
	attachments?: PostAttachment[];
};

export type BoostAttributionView = {
	name: string;
	nameEmojis?: CustomEmoji[];
	handle: string;
	time?: string;
	createdAt?: string;
	avatar?: AvatarVariant;
	avatarUrl?: string | null;
};

export type SocialPost = {
	id: string;
	actionStatusId?: string;
	threadStatusId?: string;
	name: string;
	nameEmojis?: CustomEmoji[];
	handle: string;
	time: string;
	createdAt?: string;
	cw?: string;
	body: string;
	bodyEmojis?: CustomEmoji[];
	avatar: AvatarVariant;
	avatarUrl?: string | null;
	media?: MediaVariant;
	attachments?: PostAttachment[];
	addressees?: string[];
	/** Addressee handle (lowercased) -> their chosen name, when known (Headwater mentions). */
	addresseeNames?: Record<string, string>;
	/** Addressee handle (lowercased) -> my local petname, when set (Headwater mentions). */
	addresseePetnames?: Record<string, string>;
	/** Body-mention handle (lowercased) -> render label (petname-first). */
	mentionNames?: Record<string, string>;
	/** The author's self-chosen name (Headwater petnames; name above prefers my petname). */
	authName?: string;
	/** Key confirmation: attribution is signature-only, no pinned key yet. */
	authorUnconfirmed?: boolean;
	/** My local key-bound petname for the author, when set. */
	petname?: string;
	boostedBy?: BoostAttributionView;
	copyJson?: unknown;
	quotedPost?: QuotedPostView;
	mentionAccts?: Record<string, string>;
	replies: number;
	boosts: number;
	favorites: number;
	actions: ActionState;
};

export type TimelinePost = SocialPost & {
	timelines: TimelineView[];
};

export type ThreadPost = SocialPost & {
	fullTime?: string;
	source?: string;
	views?: string;
	bookmarks?: number;
	nestedReplies?: ThreadPost[];
};

import type { PleromaMediaAttachment } from '$lib/pleroma/types';

export type ComposerMentionAccount = {
	id: string;
	username: string;
	displayName: string;
	/** Their self-chosen name (Headwater petnames). */
	authName?: string | null;
	/** My local petname — autocomplete matches it and it should rank first. */
	petname?: string | null;
	acct: string;
	avatarUrl?: string | null;
	avClass?: string;
};

export type ComposerEmoji = {
	shortcode: string;
	url: string;
	staticUrl?: string;
	pack?: string;
};

type ComposerUploadBase = {
	localId: string;
	name: string;
	kind: 'photo' | 'audio' | 'video' | 'file';
	progress: number;
};

export type ComposerUpload =
	| (ComposerUploadBase & { status: 'uploading'; media?: undefined; error?: undefined })
	| (ComposerUploadBase & { status: 'uploaded'; media: PleromaMediaAttachment; error?: undefined })
	| (ComposerUploadBase & { status: 'error'; media?: undefined; error: string });

export type ComposerPollDraft = {
	choices: string[];
	duration: string;
	multi: boolean;
	hideUntil: boolean;
};

export type ComposerPollPayload = {
	options: string[];
	expiresIn: number;
	multiple: boolean;
	hideTotals: boolean;
};

export const COMPOSER_MAX_UPLOADS = 1;
export const COMPOSER_MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

// Pleroma tags packs as `pack:<name>` in tags/category on the custom emoji
// manifest; untagged emoji fall back to a shared "custom" pack.
export const customEmojiPack = (emoji: { tags?: unknown; category?: unknown }): string => {
	const tags = Array.isArray(emoji.tags) ? emoji.tags.filter((tag): tag is string => typeof tag === 'string') : [];
	const raw = tags[0] ?? (typeof emoji.category === 'string' ? emoji.category : '');
	const cleaned = raw.replace(/^pack:/, '').trim();
	return cleaned || 'custom';
};

const durationSeconds: Record<string, number> = {
	'5m': 5 * 60,
	'1h': 60 * 60,
	'6h': 6 * 60 * 60,
	'24h': 24 * 60 * 60,
	'3d': 3 * 24 * 60 * 60,
	'7d': 7 * 24 * 60 * 60
};

export const createComposerPollDraft = (): ComposerPollDraft => ({
	choices: ['', '', ''],
	duration: '24h',
	multi: false,
	hideUntil: true
});

export const composerUploadKind = (file: File): ComposerUpload['kind'] =>
	file.type.startsWith('image/') ? 'photo' :
	file.type.startsWith('audio/') ? 'audio' :
	file.type.startsWith('video/') ? 'video' :
	'file';

export const isComposerUploadType = (file: File) => file.type.startsWith('image/') || file.type.startsWith('audio/') || file.type.startsWith('video/');

export const composerUploadError = (file: File, error: string): ComposerUpload => ({
	localId: `${Date.now()}-error-${file.name}`,
	name: file.name,
	kind: composerUploadKind(file),
	progress: 0,
	status: 'error',
	error
});

export const composerUploadBadge = (kind: ComposerUpload['kind']) => kind === 'audio' ? 'WAV' : kind === 'video' ? 'MP4' : kind === 'photo' ? 'IMG' : 'FILE';

export const getComposerUploadedMediaIds = (uploads: ComposerUpload[]) => uploads.flatMap((upload) =>
	upload.status === 'uploaded' && upload.media.id ? [upload.media.id] : []
);

export const hasComposerUploadsPending = (uploads: ComposerUpload[]) => uploads.some((upload) => upload.status === 'uploading');

// Same pragmatic full-address shape the daemon accepts. This is only an early
// obvious-invalid guard; the daemon remains authoritative for key reachability.
const ADDRESS_MENTION_PATTERN =
	/(?<![\w@.])@[A-Za-z0-9._%+-]+@[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*\.[A-Za-z]{2,}(?![\w@.-])/;

export const hasComposerAddressMention = (body: string) => ADDRESS_MENTION_PATTERN.test(body);

export const composerPollPayload = (poll: ComposerPollDraft): ComposerPollPayload | null => {
	const options = poll.choices.map((choice) => choice.trim()).filter(Boolean);
	if (options.length < 2) return null;

	return {
		options,
		expiresIn: durationSeconds[poll.duration] ?? durationSeconds['24h'],
		multiple: poll.multi,
		hideTotals: poll.hideUntil
	};
};

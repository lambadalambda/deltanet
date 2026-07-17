import type { PleromaInstance } from './types';

export type InstanceCapabilities = {
	bookmarks: boolean;
	statusDeletion: boolean;
	accountModeration: boolean;
	mediaDescription: boolean;
	chats: boolean;
	polls: boolean;
	unlistedVisibility: boolean;
	contentWarnings: boolean;
	extendedProfile: boolean;
};

export const NO_MUTABLE_CAPABILITIES: InstanceCapabilities = {
	bookmarks: false,
	statusDeletion: false,
	accountModeration: false,
	mediaDescription: false,
	chats: false,
	polls: false,
	unlistedVisibility: false,
	contentWarnings: false,
	extendedProfile: false
};

const PLEROMA_CAPABILITIES: InstanceCapabilities = {
	bookmarks: true,
	statusDeletion: true,
	accountModeration: true,
	mediaDescription: true,
	chats: true,
	polls: true,
	unlistedVisibility: true,
	contentWarnings: true,
	extendedProfile: true
};

const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const capabilitiesForInstance = (instance: PleromaInstance | null): InstanceCapabilities => {
	if (!instance) return NO_MUTABLE_CAPABILITIES;
	const configuration = record(instance.configuration);
	const headwater = record(configuration?.headwater) ?? record(configuration?.deltanet);
	// No Headwater metadata means this is an ordinary Pleroma-compatible node.
	if (!headwater) return PLEROMA_CAPABILITIES;
	const capabilities = record(headwater.capabilities);
	if (!capabilities) return NO_MUTABLE_CAPABILITIES;
	return {
		bookmarks: capabilities.bookmarks === true,
		statusDeletion: capabilities.status_deletion === true,
		accountModeration: capabilities.account_moderation === true,
		mediaDescription: capabilities.media_description === true,
		chats: capabilities.chats === true,
		polls: capabilities.polls === true,
		unlistedVisibility: capabilities.unlisted_visibility === true,
		contentWarnings: capabilities.content_warnings === true,
		extendedProfile: capabilities.extended_profile === true
	};
};

export const mediaTypesForInstance = (instance: PleromaInstance | null): string[] => {
	if (!instance) return [];
	const configuration = record(instance.configuration);
	const media = record(configuration?.media_attachments);
	const types = media?.supported_mime_types;
	return Array.isArray(types) && types.every((type) => typeof type === 'string')
		? types
		: ['image/*', 'audio/*', 'video/*'];
};

export const supportsMediaType = (mime: string, supported: readonly string[]): boolean =>
	supported.some((candidate) => candidate === mime || (candidate.endsWith('/*') && mime.startsWith(candidate.slice(0, -1))));

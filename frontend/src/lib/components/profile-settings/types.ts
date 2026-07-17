export type ProfileSettings = {
	displayName: string;
	username: string;
	instance: string;
	bio: string;
	website: string;
	location: string;
	discoverable: boolean;
	indexable: boolean;
	showFollowerCount: boolean;
};

export const createDefaultProfileSettings = (): ProfileSettings => ({
	displayName: 'dreambyte',
	username: 'dreambyte',
	instance: 'headwater.example',
	bio: 'living in a soft world',
	website: 'https://headwater.example/@dreambyte',
	location: 'soft web district',
	discoverable: true,
	indexable: false,
	showFollowerCount: true
});

export const cloneProfileSettings = (settings: ProfileSettings): ProfileSettings => ({ ...settings });

export const profileSettingsEqual = (first: ProfileSettings, second: ProfileSettings) =>
	first.displayName === second.displayName &&
	first.username === second.username &&
	first.instance === second.instance &&
	first.bio === second.bio &&
	first.website === second.website &&
	first.location === second.location &&
	first.discoverable === second.discoverable &&
	first.indexable === second.indexable &&
	first.showFollowerCount === second.showFollowerCount;

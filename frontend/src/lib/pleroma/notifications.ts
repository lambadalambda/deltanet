import type { PleromaSession } from './types';

export const NOTIFICATION_POLL_INTERVAL_MS = 60_000;
export const NOTIFICATION_POLL_EVENT = 'headwater:poll-notifications';
export const LEGACY_NOTIFICATION_POLL_EVENT = 'deltanet:poll-notifications';

type NotificationSessionKey = Pick<PleromaSession, 'instanceUrl'> & { account: NonNullable<PleromaSession['account']> };

export const notificationLastSeenStorageKey = (session: NotificationSessionKey) => {
	const accountKey = session.account.id;
	return `headwater.notifications.lastSeenAt.${session.instanceUrl}.${accountKey}`;
};

const legacyNotificationLastSeenStorageKey = (session: NotificationSessionKey) =>
	`deltanet.notifications.lastSeenAt.${session.instanceUrl}.${session.account.id}`;

export const readNotificationLastSeenAt = (storage: Storage, session: NotificationSessionKey) => {
	try {
		const key = notificationLastSeenStorageKey(session);
		const value = storage.getItem(key);
		if (value && Number.isFinite(Date.parse(value))) return value;

		const legacyKey = legacyNotificationLastSeenStorageKey(session);
		const legacy = storage.getItem(legacyKey);
		if (!legacy || !Number.isFinite(Date.parse(legacy))) return null;
		storage.setItem(key, legacy);
		return legacy;
	} catch {
		return null;
	}
};

export const writeNotificationLastSeenAt = (storage: Storage, session: NotificationSessionKey, lastSeenAt: string) => {
	try {
		storage.setItem(notificationLastSeenStorageKey(session), lastSeenAt);
		try {
			storage.setItem(legacyNotificationLastSeenStorageKey(session), lastSeenAt);
		} catch {
			// The Headwater key is authoritative; rollback compatibility is best-effort.
		}
	} catch {
		// Notification read state is a local enhancement; storage failures should not break the route.
	}
};

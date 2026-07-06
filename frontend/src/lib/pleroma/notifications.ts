import type { PleromaSession } from './types';

export const NOTIFICATION_POLL_INTERVAL_MS = 60_000;
export const NOTIFICATION_POLL_EVENT = 'deltanet:poll-notifications';

type NotificationSessionKey = Pick<PleromaSession, 'instanceUrl'> & { account: NonNullable<PleromaSession['account']> };

export const notificationLastSeenStorageKey = (session: NotificationSessionKey) => {
	const accountKey = session.account.id;
	return `deltanet.notifications.lastSeenAt.${session.instanceUrl}.${accountKey}`;
};

export const readNotificationLastSeenAt = (storage: Storage, session: NotificationSessionKey) => {
	try {
		const value = storage.getItem(notificationLastSeenStorageKey(session));
		return value && Number.isFinite(Date.parse(value)) ? value : null;
	} catch {
		return null;
	}
};

export const writeNotificationLastSeenAt = (storage: Storage, session: NotificationSessionKey, lastSeenAt: string) => {
	try {
		storage.setItem(notificationLastSeenStorageKey(session), lastSeenAt);
	} catch {
		// Notification read state is a local enhancement; storage failures should not break the route.
	}
};

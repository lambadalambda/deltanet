import { createPleromaHttp, normalizeInstanceUrl, type FetchLike } from './http';
import type { PleromaNotification, PleromaStatus } from './types';

type StreamName = 'user' | 'public' | 'public:local';

type WebSocketLike = {
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: Event) => void) | null;
	onclose: ((event: Event) => void) | null;
	close: () => void;
};

type WebSocketFactory = new (url: string) => WebSocketLike;

export type PleromaStreamingMessage = {
	event: string;
	payload: unknown;
	status?: PleromaStatus;
	notification?: PleromaNotification;
};

type TimelineStreamOptions = {
	instanceUrl: string;
	accessToken: string;
	stream?: StreamName;
	fetch?: FetchLike;
	WebSocketImpl?: WebSocketFactory;
	onUpdate?: (status: PleromaStatus) => void;
	onNotification?: (notification: PleromaNotification) => void;
	onOpen?: (event: unknown) => void;
	onError?: (error: unknown) => void;
	onClose?: (event: unknown) => void;
};

type StreamingUrlInput = Pick<TimelineStreamOptions, 'instanceUrl' | 'stream'> & { ticket: string };

const parsePayload = (payload: unknown) => {
	if (typeof payload !== 'string') return payload;

	try {
		return JSON.parse(payload) as unknown;
	} catch {
		return payload;
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const isPleromaAccountPayload = (payload: unknown) => {
	if (!isRecord(payload)) return false;

	return typeof payload.id === 'string' &&
		typeof payload.username === 'string' &&
		typeof payload.acct === 'string' &&
		typeof payload.display_name === 'string';
};

const isPleromaStatusPayload = (payload: unknown): payload is PleromaStatus => {
	if (!isRecord(payload) || !isRecord(payload.account) || !isRecord(payload.pleroma)) return false;

	return typeof payload.id === 'string' &&
		typeof payload.uri === 'string' &&
		typeof payload.url === 'string' &&
		typeof payload.content === 'string' &&
		typeof payload.created_at === 'string' &&
		Array.isArray(payload.media_attachments) &&
		Array.isArray(payload.mentions) &&
		isPleromaAccountPayload(payload.account);
};

const isPleromaNotificationPayload = (payload: unknown): payload is PleromaNotification => {
	if (!isRecord(payload) || !isPleromaAccountPayload(payload.account)) return false;
	const status = payload.status;

	return typeof payload.id === 'string' &&
		typeof payload.type === 'string' &&
		typeof payload.created_at === 'string' &&
		(status == null || isPleromaStatusPayload(status));
};

export const buildPleromaStreamingUrl = ({ instanceUrl, ticket, stream = 'user' }: StreamingUrlInput) => {
	const origin = normalizeInstanceUrl(instanceUrl);
	const url = new URL('/api/v1/streaming/', origin);
	url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
	url.searchParams.set('stream', stream);
	url.searchParams.set('ticket', ticket);

	return url.toString();
};

export const fetchPleromaStreamingTicket = async ({
	instanceUrl,
	accessToken,
	fetch,
	signal
}: Pick<TimelineStreamOptions, 'instanceUrl' | 'accessToken' | 'fetch'> & { signal?: AbortSignal }) => {
	const http = createPleromaHttp({ instanceUrl, accessToken, fetch });
	return http.request<{ ticket: string; expires_at: number }>({
		method: 'POST',
		path: '/api/headwater/streaming/token',
		signal,
		auth: 'required'
	});
};

export const parsePleromaStreamingMessage = (data: unknown): PleromaStreamingMessage | null => {
	if (typeof data !== 'string') return null;

	try {
		const message = JSON.parse(data) as unknown;
		if (!message || typeof message !== 'object' || !('event' in message)) return null;

		const event = typeof message.event === 'string' ? message.event : '';
		const payload = parsePayload('payload' in message ? message.payload : undefined);

		return {
			event,
			payload,
			status: event === 'update' && isPleromaStatusPayload(payload) ? payload : undefined,
			notification: event === 'notification' && isPleromaNotificationPayload(payload) ? payload : undefined
		};
	} catch {
		return null;
	}
};

export const openPleromaTimelineStream = ({
	instanceUrl,
	accessToken,
	stream = 'user',
	fetch,
	WebSocketImpl,
	onUpdate,
	onNotification,
	onOpen,
	onError,
	onClose
}: TimelineStreamOptions) => {
	const SocketImpl = WebSocketImpl ?? globalThis.WebSocket as unknown as WebSocketFactory | undefined;
	if (!SocketImpl) {
		onError?.(new Error('WebSocket is not available in this browser.'));
		return { close: () => undefined };
	}

	let socket: WebSocketLike | null = null;
	let closed = false;
	const ticketRequest = new AbortController();
	void (async () => {
		const { ticket } = await fetchPleromaStreamingTicket({
			instanceUrl,
			accessToken,
			fetch,
			signal: ticketRequest.signal
		});
		if (closed) return;

		socket = new SocketImpl(buildPleromaStreamingUrl({ instanceUrl, ticket, stream }));
		socket.onopen = (event) => {
			if (!closed) onOpen?.(event);
		};
		socket.onmessage = (event) => {
			if (closed) return;
			const message = parsePleromaStreamingMessage(event.data);
			if (!message?.status && !message?.notification) return;

			try {
				if (message.status) onUpdate?.(message.status);
				if (message.notification) onNotification?.(message.notification);
			} catch (error) {
				if (!closed) onError?.(error);
			}
		};
		socket.onerror = (event) => {
			if (!closed) onError?.(event);
		};
		socket.onclose = (event) => {
			if (!closed) onClose?.(event);
		};
	})().catch((error) => {
		if (!closed) onError?.(error);
	});

	return {
		close: () => {
			if (closed) return;
			closed = true;
			ticketRequest.abort();
			if (!socket) return;
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			socket.close();
		}
	};
};

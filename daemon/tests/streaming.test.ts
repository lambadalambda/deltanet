import { describe, expect, it, vi } from 'vitest';
import {
  createStreamingEvents,
  createStreamingHub,
  resolveStreamName,
  type StreamingSocket,
  type StreamingWsContext,
} from '../src/streaming.js';

/** A fake socket that just records every frame it's sent. */
const makeFakeSocket = (readyState?: number): StreamingSocket & { sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    readyState,
    send(data: string) {
      sent.push(data);
    },
  };
};

describe('streaming hub: frame format', () => {
  it('sends an update frame shaped {stream:[...], event, payload: JSON string}', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user']);

    hub.broadcastUpdate({ id: '42', content: '<p>hi</p>' }, 42);

    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!);
    expect(frame.stream).toEqual(['user']);
    expect(frame.event).toBe('update');
    expect(typeof frame.payload).toBe('string');
    expect(JSON.parse(frame.payload)).toEqual({ id: '42', content: '<p>hi</p>' });
  });

  it('sends a notification frame the same way, event "notification"', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user']);

    hub.broadcastNotification({ id: '1', type: 'favourite' });

    const frame = JSON.parse(socket.sent[0]!);
    expect(frame.stream).toEqual(['user']);
    expect(frame.event).toBe('notification');
    expect(JSON.parse(frame.payload)).toEqual({ id: '1', type: 'favourite' });
  });

  it('round-trips exactly the way the frontend parser expects (double JSON-encoded payload)', () => {
    // Mirrors ../frontend/src/lib/pleroma/streaming.ts's
    // parsePleromaStreamingMessage: JSON.parse the frame, then JSON.parse
    // `payload` again.
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user']);
    hub.broadcastUpdate({ id: '7' }, 7);

    const outer = JSON.parse(socket.sent[0]!) as { event: string; payload: unknown };
    expect(outer.event).toBe('update');
    expect(typeof outer.payload).toBe('string');
    const inner = JSON.parse(outer.payload as string);
    expect(inner).toEqual({ id: '7' });
  });
});

describe('streaming hub: stream filtering', () => {
  it('broadcastUpdate reaches user, public, and public:local subscribers', () => {
    const hub = createStreamingHub();
    const userSocket = makeFakeSocket();
    const publicSocket = makeFakeSocket();
    const localSocket = makeFakeSocket();
    hub.register(userSocket, ['user']);
    hub.register(publicSocket, ['public']);
    hub.register(localSocket, ['public:local']);

    hub.broadcastUpdate({ id: '1' }, 1);

    expect(userSocket.sent).toHaveLength(1);
    expect(publicSocket.sent).toHaveLength(1);
    expect(localSocket.sent).toHaveLength(1);
  });

  it('broadcastNotification reaches only user subscribers, not public/public:local', () => {
    const hub = createStreamingHub();
    const userSocket = makeFakeSocket();
    const publicSocket = makeFakeSocket();
    const localSocket = makeFakeSocket();
    hub.register(userSocket, ['user']);
    hub.register(publicSocket, ['public']);
    hub.register(localSocket, ['public:local']);

    hub.broadcastNotification({ id: '1', type: 'mention' });

    expect(userSocket.sent).toHaveLength(1);
    expect(publicSocket.sent).toHaveLength(0);
    expect(localSocket.sent).toHaveLength(0);
  });

  it('a socket subscribed to multiple streams only receives one frame per broadcast', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user', 'public']);

    hub.broadcastUpdate({ id: '1' }, 1);

    expect(socket.sent).toHaveLength(1);
  });

  it('an unregistered stream name never receives frames', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['public']);

    hub.broadcastNotification({ id: '1' });

    expect(socket.sent).toHaveLength(0);
  });
});

describe('streaming hub: dedupe by msgId', () => {
  it('streams a status at most once even if broadcastUpdate is called twice for the same msgId', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user']);

    hub.broadcastUpdate({ id: '1' }, 1);
    hub.broadcastUpdate({ id: '1' }, 1); // e.g. MsgsChanged re-firing for the same message

    expect(socket.sent).toHaveLength(1);
  });

  it('exposes hasStreamed to check dedupe state', () => {
    const hub = createStreamingHub();
    expect(hub.hasStreamed(5)).toBe(false);
    hub.broadcastUpdate({ id: '5' }, 5);
    expect(hub.hasStreamed(5)).toBe(true);
  });

  it('different msgIds are not deduped against each other', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user']);

    hub.broadcastUpdate({ id: '1' }, 1);
    hub.broadcastUpdate({ id: '2' }, 2);

    expect(socket.sent).toHaveLength(2);
  });

  it('bounds the dedupe set to the last ~1000 ids, forgetting the oldest', () => {
    const hub = createStreamingHub();
    for (let i = 0; i < 1000; i++) hub.broadcastUpdate({ id: String(i) }, i);
    expect(hub.hasStreamed(0)).toBe(true);

    // Pushing one more evicts the oldest (id 0).
    hub.broadcastUpdate({ id: '1000' }, 1000);
    expect(hub.hasStreamed(0)).toBe(false);
    expect(hub.hasStreamed(1000)).toBe(true);
  });
});

describe('streaming hub: registration lifecycle', () => {
  it('register returns an unregister function; unregistered sockets receive nothing further', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    const unregister = hub.register(socket, ['user']);

    hub.broadcastUpdate({ id: '1' }, 1);
    expect(socket.sent).toHaveLength(1);

    unregister();
    hub.broadcastUpdate({ id: '2' }, 2);
    expect(socket.sent).toHaveLength(1);
  });

  it('unregister(socket) also works directly (close/error handlers)', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user']);
    expect(hub.size()).toBe(1);

    hub.unregister(socket);
    expect(hub.size()).toBe(0);

    hub.broadcastUpdate({ id: '1' }, 1);
    expect(socket.sent).toHaveLength(0);
  });

  it('unregistering twice is a harmless no-op', () => {
    const hub = createStreamingHub();
    const socket = makeFakeSocket();
    hub.register(socket, ['user']);
    hub.unregister(socket);
    expect(() => hub.unregister(socket)).not.toThrow();
  });

  it('skips sockets whose readyState indicates they are not open (e.g. CLOSING/CLOSED)', () => {
    const hub = createStreamingHub();
    const closingSocket = makeFakeSocket(2); // CLOSING
    hub.register(closingSocket, ['user']);

    hub.broadcastUpdate({ id: '1' }, 1);

    expect(closingSocket.sent).toHaveLength(0);
  });

  it('sends to a socket with readyState OPEN (1), and to one with no readyState at all', () => {
    const hub = createStreamingHub();
    const openSocket = makeFakeSocket(1);
    const noStateSocket = makeFakeSocket();
    hub.register(openSocket, ['user']);
    hub.register(noStateSocket, ['user']);

    hub.broadcastUpdate({ id: '1' }, 1);

    expect(openSocket.sent).toHaveLength(1);
    expect(noStateSocket.sent).toHaveLength(1);
  });
});

describe('resolveStreamName', () => {
  it('defaults to "user" when no stream param is given', () => {
    expect(resolveStreamName(undefined)).toBe('user');
  });

  it('accepts "public" and "public:local" verbatim', () => {
    expect(resolveStreamName('public')).toBe('public');
    expect(resolveStreamName('public:local')).toBe('public:local');
  });

  it('falls back to "user" for an unrecognized stream value', () => {
    expect(resolveStreamName('bogus')).toBe('user');
  });
});

describe('createStreamingEvents: route-level onOpen/onClose/onError wiring', () => {
  const makeFakeWsContext = (raw?: { ping?: () => void }): StreamingWsContext & { sent: string[] } => {
    const sent: string[] = [];
    return {
      sent,
      raw,
      send(data: string) {
        sent.push(data);
      },
    };
  };

  it('onOpen registers the socket for the requested stream, and broadcasts reach it', () => {
    const hub = createStreamingHub();
    const events = createStreamingEvents(hub, 'public');
    const ws = makeFakeWsContext();

    events.onOpen(undefined, ws);
    expect(hub.size()).toBe(1);

    hub.broadcastUpdate({ id: '1' }, 1);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!).stream).toEqual(['public']);
  });

  it('defaults to the "user" stream when no stream param is passed', () => {
    const hub = createStreamingHub();
    const events = createStreamingEvents(hub, undefined);
    const ws = makeFakeWsContext();

    events.onOpen(undefined, ws);
    hub.broadcastNotification({ id: '1' });

    expect(ws.sent).toHaveLength(1);
  });

  it('onClose unregisters the socket, so later broadcasts do not reach it', () => {
    const hub = createStreamingHub();
    const events = createStreamingEvents(hub, 'user');
    const ws = makeFakeWsContext();

    events.onOpen(undefined, ws);
    events.onClose(undefined, ws);

    expect(hub.size()).toBe(0);
    hub.broadcastNotification({ id: '1' });
    expect(ws.sent).toHaveLength(0);
  });

  it('onError also unregisters the socket (same cleanup as onClose)', () => {
    const hub = createStreamingHub();
    const events = createStreamingEvents(hub, 'user');
    const ws = makeFakeWsContext();

    events.onOpen(undefined, ws);
    events.onError(undefined, ws);

    expect(hub.size()).toBe(0);
  });

  it('starts a ping interval on open that calls ws.raw.ping(), and clears it on close', () => {
    vi.useFakeTimers();
    try {
      const hub = createStreamingHub();
      const ping = vi.fn();
      const events = createStreamingEvents(hub, 'user');
      const ws = makeFakeWsContext({ ping });

      events.onOpen(undefined, ws);
      vi.advanceTimersByTime(30_000);
      expect(ping).toHaveBeenCalledTimes(1);

      events.onClose(undefined, ws);
      vi.advanceTimersByTime(60_000);
      expect(ping).toHaveBeenCalledTimes(1); // no further calls after cleanup
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates a socket whose raw has no ping() at all (e.g. a plain test fake)', () => {
    vi.useFakeTimers();
    try {
      const hub = createStreamingHub();
      const events = createStreamingEvents(hub, 'user');
      const ws = makeFakeWsContext(); // no `raw` at all

      events.onOpen(undefined, ws);
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up (and unregisters) if ws.raw.ping() throws', () => {
    vi.useFakeTimers();
    try {
      const hub = createStreamingHub();
      const events = createStreamingEvents(hub, 'user');
      const ws = makeFakeWsContext({
        ping: () => {
          throw new Error('socket gone');
        },
      });

      events.onOpen(undefined, ws);
      expect(hub.size()).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(hub.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

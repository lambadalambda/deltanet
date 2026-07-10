import { expect, test } from '@playwright/test';
import { get } from 'svelte/store';
import { createPleromaAuth, guardPleromaAuthState, isPleromaAuthFailure } from './auth';
import {
	createMemoryPleromaStorage,
	PENDING_OAUTH_TTL_MS,
	PLEROMA_PENDING_OAUTH_KEY,
	readPendingOAuth,
	readPleromaSession,
	storePendingOAuth,
	storePleromaSession
} from './session';
import type { PendingPleromaOAuth, PleromaSession } from './types';

const createPendingOAuth = (): PendingPleromaOAuth => ({
	instanceUrl: 'https://pleroma.example',
	clientId: 'client-id',
	clientSecret: 'client-secret',
	redirectUri: 'http://localhost:4173/auth/callback',
	scopes: ['read', 'write', 'follow', 'push'],
	state: 'oauth-state',
	createdAt: Date.now()
});

const createSession = (): PleromaSession => ({
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow push',
	createdAt: 1700000001000
});

test('reactive auth boundary restores pending OAuth and publishes lifecycle updates', () => {
	const sessionStorage = createMemoryPleromaStorage();
	const pendingStorage = createMemoryPleromaStorage();
	const pending = createPendingOAuth();
	storePendingOAuth(pendingStorage, pending);

	const auth = createPleromaAuth({ browser: true, sessionStorage, pendingStorage });
	const states: string[] = [];
	const unsubscribe = auth.state.subscribe((state) => states.push(state.status));

	expect(get(auth.state)).toMatchObject({ status: 'authenticating', pending });

	const session = createSession();
	auth.completeOAuth(session);
	expect(get(auth.state)).toMatchObject({ status: 'authenticated', session });
	expect(readPleromaSession(sessionStorage)).toMatchObject(session);
	expect(readPendingOAuth(pendingStorage)).toBeNull();

	auth.signOut();
	expect(get(auth.state)).toEqual({ status: 'unauthenticated' });
	expect(readPleromaSession(sessionStorage)).toBeNull();
	expect(readPendingOAuth(pendingStorage)).toBeNull();
	expect(states).toEqual(['authenticating', 'authenticated', 'unauthenticated']);
	unsubscribe();
});

test('auth boundary prefers restored sessions, starts pending OAuth, and clears split storage', () => {
	const sessionStorage = createMemoryPleromaStorage();
	const pendingStorage = createMemoryPleromaStorage();
	const stalePending = { ...createPendingOAuth(), createdAt: Date.now() - PENDING_OAUTH_TTL_MS - 1 };
	const session = createSession();
	storePendingOAuth(pendingStorage, stalePending);
	storePleromaSession(sessionStorage, session);

	const auth = createPleromaAuth({ browser: true, sessionStorage, pendingStorage });
	expect(get(auth.state)).toMatchObject({ status: 'authenticated', session });
	expect(pendingStorage.getItem(PLEROMA_PENDING_OAUTH_KEY)).toBeNull();
	expect(auth.requireAuthenticated()).toMatchObject({ allowed: true, session });

	const nextPending = { ...createPendingOAuth(), state: 'next-state' };
	auth.startOAuth(nextPending);
	expect(get(auth.state)).toMatchObject({ status: 'authenticating', pending: nextPending });
	expect(readPendingOAuth(pendingStorage)).toMatchObject(nextPending);

	auth.clearPendingOAuth();
	expect(readPendingOAuth(pendingStorage)).toBeNull();
	expect(get(auth.state)).toMatchObject({ status: 'authenticated', session });

	auth.signOut();
	expect(readPleromaSession(sessionStorage)).toBeNull();
	expect(readPendingOAuth(pendingStorage)).toBeNull();
});

test('auth boundary does not read browser storage during SSR construction or refresh', () => {
	let reads = 0;
	const throwingStorage = {
		getItem: () => {
			reads += 1;
			throw new Error('SSR storage should not be read');
		},
		setItem: () => {
			throw new Error('SSR storage should not be written');
		},
		removeItem: () => {
			throw new Error('SSR storage should not be cleared');
		}
	};

	const auth = createPleromaAuth({ browser: false, sessionStorage: throwingStorage, pendingStorage: throwingStorage });
	expect(get(auth.state)).toEqual({ status: 'unauthenticated' });
	expect(auth.refresh()).toEqual({ status: 'unauthenticated' });
	expect(reads).toBe(0);
});

test('auth boundary degrades safely when browser storage operations fail', () => {
	const throwingStorage = {
		getItem: () => {
			throw new Error('storage read failed');
		},
		setItem: () => {
			throw new Error('storage write failed');
		},
		removeItem: () => {
			throw new Error('storage clear failed');
		}
	};

	const auth = createPleromaAuth({ browser: true, sessionStorage: throwingStorage, pendingStorage: throwingStorage });
	expect(get(auth.state)).toEqual({ status: 'unauthenticated' });
	expect(auth.refresh()).toEqual({ status: 'unauthenticated' });
	expect(auth.startOAuth(createPendingOAuth())).toEqual({ status: 'unauthenticated' });
	expect(auth.getPendingOAuth()).toBeNull();
	expect(auth.completeOAuth(createSession())).toEqual({ status: 'unauthenticated' });
	expect(auth.clearPendingOAuth()).toEqual({ status: 'unauthenticated' });
	expect(auth.signOut()).toEqual({ status: 'unauthenticated' });
});

test('auth boundary preserves valid sessions when pending storage is unavailable', () => {
	const sessionStorage = createMemoryPleromaStorage();
	const pendingStorage = {
		getItem: () => {
			throw new Error('pending storage read failed');
		},
		setItem: () => {
			throw new Error('pending storage write failed');
		},
		removeItem: () => {
			throw new Error('pending storage clear failed');
		}
	};
	const session = createSession();
	storePleromaSession(sessionStorage, session);

	const auth = createPleromaAuth({ browser: true, sessionStorage, pendingStorage });
	expect(get(auth.state)).toMatchObject({ status: 'authenticated', session });
	expect(auth.requireAuthenticated()).toMatchObject({ allowed: true, session });
	expect(auth.getPendingOAuth()).toBeNull();
	expect(get(auth.state)).toMatchObject({ status: 'authenticated', session });
	expect(auth.clearPendingOAuth()).toMatchObject({ status: 'authenticated', session });
	expect(auth.startOAuth(createPendingOAuth())).toMatchObject({ status: 'authenticated', session });
});

test('OAuth completion remains authenticated when pending cleanup fails after session write', () => {
	const backingStorage = createMemoryPleromaStorage();
	const sessionStorage = {
		getItem: backingStorage.getItem,
		setItem: backingStorage.setItem,
		removeItem: () => {
			throw new Error('legacy pending cleanup failed');
		}
	};
	const pendingStorage = {
		getItem: () => null,
		setItem: () => {
			throw new Error('pending storage write failed');
		},
		removeItem: () => {
			throw new Error('pending cleanup failed');
		}
	};
	const session = createSession();
	const auth = createPleromaAuth({ browser: true, sessionStorage, pendingStorage });

	expect(auth.completeOAuth(session)).toMatchObject({ status: 'authenticated', session });
	expect(readPleromaSession(sessionStorage)).toMatchObject(session);
	expect(get(auth.state)).toMatchObject({ status: 'authenticated', session });
});

test('expired pending OAuth reads synchronize the reactive auth state', () => {
	let now = Date.now();
	const sessionStorage = createMemoryPleromaStorage();
	const pendingStorage = createMemoryPleromaStorage();
	const auth = createPleromaAuth({ browser: true, sessionStorage, pendingStorage, now: () => now });
	const pending = { ...createPendingOAuth(), createdAt: now };

	auth.startOAuth(pending);
	expect(get(auth.state)).toMatchObject({ status: 'authenticating', pending });

	now += PENDING_OAUTH_TTL_MS + 1;
	expect(auth.getPendingOAuth()).toBeNull();
	expect(get(auth.state)).toEqual({ status: 'unauthenticated' });
	expect(pendingStorage.getItem(PLEROMA_PENDING_OAUTH_KEY)).toBeNull();
});

test('auth failure policy signs out on 401 and 403 with a root redirect', () => {
	const sessionStorage = createMemoryPleromaStorage();
	const pendingStorage = createMemoryPleromaStorage();
	storePleromaSession(sessionStorage, createSession());
	storePendingOAuth(pendingStorage, createPendingOAuth());

	const auth = createPleromaAuth({ browser: true, sessionStorage, pendingStorage });
	expect(isPleromaAuthFailure({ kind: 'http', status: 401, path: '/api/v1/timelines/home', message: 'expired', response: null })).toBe(true);
	expect(isPleromaAuthFailure({ kind: 'http', status: 403, path: '/api/v1/timelines/home', message: 'forbidden', response: null })).toBe(true);
	expect(isPleromaAuthFailure({ kind: 'http', status: 500, path: '/api/v1/timelines/home', message: 'sad', response: null })).toBe(false);

	const handled = auth.handleAuthFailure({
		kind: 'http',
		status: 403,
		path: '/api/v1/timelines/home',
		message: 'forbidden',
		response: null
	});
	expect(handled).toEqual({ handled: true, redirectTo: '/', state: { status: 'unauthenticated' } });
	expect(readPleromaSession(sessionStorage)).toBeNull();
	expect(readPendingOAuth(pendingStorage)).toBeNull();
});

test('guard primitives allow authenticated sessions and redirect other auth states', () => {
	const session = createSession();
	expect(guardPleromaAuthState({ status: 'authenticated', session })).toMatchObject({ allowed: true, session });
	expect(guardPleromaAuthState({ status: 'authenticating', pending: createPendingOAuth() })).toEqual({
		allowed: false,
		reason: 'authenticating',
		redirectTo: '/'
	});
	expect(guardPleromaAuthState({ status: 'unauthenticated' }, { redirectTo: '/sign-in' })).toEqual({
		allowed: false,
		reason: 'unauthenticated',
		redirectTo: '/sign-in'
	});
});

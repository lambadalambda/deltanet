import { createPleromaHttp, normalizeInstanceUrl, type FetchLike } from './http';
import type { PleromaOAuthApp, PleromaOAuthCallback, PleromaScope, PleromaToken } from './types';

type RegisterOAuthAppInput = {
	instanceUrl: string;
	clientName: string;
	redirectUri: string;
	scopes: readonly PleromaScope[];
	enrollmentCode?: string;
	website?: string;
	fetch?: FetchLike;
};

type RawOAuthApp = {
	id?: string;
	name: string;
	website?: string | null;
	redirect_uri: string;
	client_id: string;
	client_secret: string;
	vapid_key?: string;
};

type ExchangeOAuthCodeInput = {
	instanceUrl: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	code: string;
	fetch?: FetchLike;
};

type RawToken = {
	access_token: string;
	token_type: string;
	scope: string;
	created_at?: number;
};

type BuildAuthorizationInput = {
	instanceUrl: string;
	clientId: string;
	redirectUri: string;
	scopes: readonly PleromaScope[];
	state: string;
	forceLogin?: boolean;
};

type RevokeOAuthTokenInput = {
	instanceUrl: string;
	accessToken: string;
	signal?: AbortSignal;
	fetch?: FetchLike;
};

const scopeString = (scopes: readonly PleromaScope[]) => scopes.join(' ');
export const DELTANET_OAUTH_SCOPES = ['read', 'write', 'follow', 'push'] as const satisfies readonly PleromaScope[];

const mapOAuthApp = (app: RawOAuthApp): PleromaOAuthApp => ({
	id: app.id,
	name: app.name,
	website: app.website,
	redirectUri: app.redirect_uri,
	clientId: app.client_id,
	clientSecret: app.client_secret,
	vapidKey: app.vapid_key
});

const mapToken = (token: RawToken): PleromaToken => ({
	accessToken: token.access_token,
	tokenType: token.token_type,
	scope: token.scope,
	createdAt: token.created_at
});

export const registerOAuthApp = async ({
	instanceUrl,
	clientName,
	redirectUri,
	scopes,
	enrollmentCode,
	website,
	fetch
}: RegisterOAuthAppInput) => {
	const http = createPleromaHttp({ instanceUrl, fetch });
	const form = new URLSearchParams({
		client_name: clientName,
		redirect_uris: redirectUri,
		scopes: scopeString(scopes)
	});

	if (enrollmentCode) form.set('enrollment_code', enrollmentCode);
	if (website) form.set('website', website);

	const app = await http.request<RawOAuthApp>({
		method: 'POST',
		path: '/api/v1/apps',
		form,
		auth: 'none'
	});

	return mapOAuthApp(app);
};

export const buildAuthorizationUrl = ({
	instanceUrl,
	clientId,
	redirectUri,
	scopes,
	state,
	forceLogin
}: BuildAuthorizationInput) => {
	const url = new URL('/oauth/authorize', normalizeInstanceUrl(instanceUrl));
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', scopeString(scopes));
	url.searchParams.set('state', state);
	if (forceLogin !== undefined) url.searchParams.set('force_login', String(forceLogin));

	return url.toString();
};

export const parseOAuthCallback = (input: string | URL): PleromaOAuthCallback => {
	const url = input instanceof URL ? input : new URL(input, 'http://localhost/auth/callback');
	const params = url.searchParams.size > 0 ? url.searchParams : new URLSearchParams(url.hash.replace(/^#/, ''));
	const state = params.get('state') ?? undefined;
	const error = params.get('error');

	if (error) {
		return {
			status: 'error',
			error,
			description: params.get('error_description') ?? undefined,
			state
		};
	}

	const code = params.get('code');
	if (!code) return { status: 'missing_code', state };

	return { status: 'success', code, state };
};

export const exchangeOAuthCode = async ({
	instanceUrl,
	clientId,
	clientSecret,
	redirectUri,
	code,
	fetch
}: ExchangeOAuthCodeInput) => {
	const http = createPleromaHttp({ instanceUrl, fetch });
	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirectUri,
		code
	});

	const token = await http.request<RawToken>({
		method: 'POST',
		path: '/oauth/token',
		form,
		auth: 'none'
	});

	return mapToken(token);
};

export const revokeOAuthToken = async ({ instanceUrl, accessToken, signal, fetch }: RevokeOAuthTokenInput) => {
	const http = createPleromaHttp({ instanceUrl, accessToken, fetch });
	await http.request<Record<string, never>>({
		method: 'POST',
		path: '/oauth/revoke',
		form: new URLSearchParams({ token: accessToken }),
		signal,
		auth: 'required'
	});
};

export const createOAuthState = () => {
	if (!globalThis.crypto?.getRandomValues || !globalThis.btoa) {
		throw new Error('Secure browser crypto is required to start OAuth.');
	}

	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);

	return globalThis
		.btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
};

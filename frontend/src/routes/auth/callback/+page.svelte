<script lang="ts">
	import {
		clearPendingOAuth,
		createPleromaClient,
		exchangeOAuthCode,
		parseOAuthCallback,
		readPendingOAuth,
		storePleromaSession,
		writePleromaSession
	} from '$lib/pleroma';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	type CallbackState =
		| { status: 'loading' }
		| { status: 'success'; instanceHost: string }
		| { status: 'cancelled'; description: string }
		| { status: 'missing-pending' }
		| { status: 'missing-code' }
		| { status: 'state-mismatch' }
		| { status: 'error'; message: string };

	let callbackState = $state<CallbackState>({ status: 'loading' });

	const clearPending = () => clearPendingOAuth(sessionStorage);
	const enrichStoredSessionAccount = async (session: Parameters<typeof writePleromaSession>[1]) => {
		try {
			const client = createPleromaClient({
				instanceUrl: session.instanceUrl,
				accessToken: session.accessToken,
				fetch: window.fetch.bind(window)
			});
			const account = await client.getOwnAccount();
			writePleromaSession(localStorage, { ...session, account });
		} catch {
			// The token is valid even if profile enrichment has to wait until app load.
		}
	};
	const completeCallback = async () => {
		const pending = readPendingOAuth(sessionStorage);
		if (!pending) {
			callbackState = { status: 'missing-pending' };
			return;
		}

		const callback = parseOAuthCallback(page.url);
		if (callback.status === 'error') {
			clearPending();
			callbackState = {
				status: 'cancelled',
				description: callback.description ?? callback.error
			};
			return;
		}

		if (callback.status === 'missing_code') {
			clearPending();
			callbackState = { status: 'missing-code' };
			return;
		}

		if (callback.state !== pending.state) {
			clearPending();
			callbackState = { status: 'state-mismatch' };
			return;
		}

		try {
			const token = await exchangeOAuthCode({
				instanceUrl: pending.instanceUrl,
				clientId: pending.clientId,
				clientSecret: pending.clientSecret,
				redirectUri: pending.redirectUri,
				code: callback.code,
				fetch: window.fetch.bind(window)
			});
			const session = {
				instanceUrl: pending.instanceUrl,
				accessToken: token.accessToken,
				tokenType: token.tokenType,
				scope: token.scope,
				createdAt: token.createdAt ?? Date.now()
			};
			storePleromaSession(localStorage, session);
			clearPending();
			callbackState = { status: 'success', instanceHost: new URL(pending.instanceUrl).hostname };
			void enrichStoredSessionAccount(session);
		} catch (error) {
			callbackState = {
				status: 'error',
				message: error instanceof Error ? error.message : 'DeltaNet could not finish OAuth sign-in.'
			};
		}
	};

	onMount(() => {
		void completeCallback();
	});
</script>

<svelte:head>
	<title>DeltaNet · OAuth Callback</title>
</svelte:head>

<main class="auth-callback-page">
	<section class="card auth-callback-card">
		{#if callbackState.status === 'loading'}
			<div role="status" aria-label="Request status">Completing Pleroma authorization...</div>
		{:else if callbackState.status === 'success'}
			<h1>Signed in to {callbackState.instanceHost}</h1>
			<p>DeltaNet stored an OAuth token from your server.</p>
			<a class="auth-callback-link" href="/app/home">Open DeltaNet</a>
		{:else if callbackState.status === 'cancelled'}
			<h1>Authorization was cancelled</h1>
			<p>{callbackState.description}</p>
			<a href="/#oauth">Return to sign in</a>
		{:else if callbackState.status === 'missing-pending'}
			<h1>No pending Pleroma authorization</h1>
			<p>Start sign-in again from the landing page.</p>
			<a href="/#oauth">Return to sign in</a>
		{:else if callbackState.status === 'missing-code'}
			<h1>Authorization code was missing</h1>
			<p>Your server returned without an OAuth code.</p>
			<a href="/#oauth">Return to sign in</a>
		{:else if callbackState.status === 'state-mismatch'}
			<h1>Authorization state did not match</h1>
			<p>The OAuth state did not match the pending sign-in request.</p>
			<a href="/#oauth">Return to sign in</a>
		{:else}
			<h1>OAuth sign-in failed</h1>
			<p>{callbackState.message}</p>
			<a href="/#oauth">Return to sign in</a>
		{/if}
	</section>
</main>

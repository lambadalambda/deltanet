<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		buildAuthorizationUrl,
		createOAuthState,
		defaultDeltanetInstanceUrl,
		DELTANET_DEFAULT_RELAY,
		fetchDeltanetStatus,
		registerOAuthApp,
		readPleromaSession,
		signupDeltanet,
		storePendingOAuth
	} from '$lib/pleroma';
	import type { PendingPleromaOAuth, PleromaScope } from '$lib/pleroma';
	import Icon from '$lib/rebuild/Icon.svelte';
	import { env } from '$env/dynamic/public';
	import { onMount } from 'svelte';

	type AuthMode = 'signin' | 'signup';
	type AuthStep = 'enter' | 'signup-success' | 'redirect';

	const scopes = ['read', 'write', 'follow'] as const satisfies readonly PleromaScope[];

	let mode = $state<AuthMode>('signin');
	let authStep = $state<AuthStep>('enter');
	let instance = $state('');
	let showAdvanced = $state(false);
	let authorizationUrl = $state('');
	let authError = $state('');
	let authAttempt = 0;

	let displayName = $state('');
	let relay = $state(DELTANET_DEFAULT_RELAY);
	let signupPending = $state(false);
	let signupError = $state('');
	let signupAddress = $state('');

	const selectedInstanceUrl = $derived((() => {
		const trimmed = instance.trim().replace(/\/$/, '');
		return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	})());
	const continueDisabled = $derived(!instance.trim());
	const signupDisabled = $derived(!displayName.trim() || signupPending);

	const selectMode = (nextMode: AuthMode) => {
		mode = nextMode;
		authStep = 'enter';
		authError = '';
		authorizationUrl = '';
		signupError = '';
	};
	const cancelRedirect = () => {
		authAttempt += 1;
		authStep = 'enter';
		authError = '';
		authorizationUrl = '';
		sessionStorage.removeItem('deltanet.oauth.pending');
	};
	const startOAuth = async () => {
		if (!instance.trim()) return;

		const attempt = authAttempt + 1;
		authAttempt = attempt;
		authStep = 'redirect';
		authError = '';
		authorizationUrl = '';

		const redirectUri = `${window.location.origin}/auth/callback`;
		try {
			const app = await registerOAuthApp({
				instanceUrl: selectedInstanceUrl,
				clientName: 'DeltaNet',
				redirectUri,
				scopes,
				website: window.location.origin,
				fetch: window.fetch.bind(window)
			});

			if (attempt !== authAttempt || authStep !== 'redirect') return;

			const state = createOAuthState();
			const pending = {
				instanceUrl: selectedInstanceUrl,
				clientId: app.clientId,
				clientSecret: app.clientSecret,
				redirectUri,
				scopes,
				state,
				createdAt: Date.now()
			} satisfies PendingPleromaOAuth;
			const url = buildAuthorizationUrl({
				instanceUrl: selectedInstanceUrl,
				clientId: app.clientId,
				redirectUri,
				scopes,
				state
			});

			storePendingOAuth(sessionStorage, pending);
			authorizationUrl = url;
		} catch (error) {
			if (attempt !== authAttempt) return;
			authError = error instanceof Error ? error.message : 'Could not start OAuth with this node.';
		}
	};

	const submitSignup = async () => {
		if (signupDisabled) return;

		signupPending = true;
		signupError = '';
		try {
			const result = await signupDeltanet({
				instanceUrl: selectedInstanceUrl,
				displayName: displayName.trim(),
				relay: relay.trim() || undefined,
				fetch: window.fetch.bind(window)
			});
			signupAddress = result.acct;
			authStep = 'signup-success';
			signupPending = false;
			await new Promise((resolve) => window.setTimeout(resolve, 900));
			if (authStep !== 'signup-success') return;
			void startOAuth();
		} catch (error) {
			signupPending = false;
			if (error && typeof error === 'object' && 'kind' in error) {
				const typed = error as { kind: string; message: string };
				if (typed.kind === 'conflict') {
					selectMode('signin');
					signupError = '';
					authError = typed.message;
					return;
				}

				signupError = typed.message;
				return;
			}

			signupError = error instanceof Error ? error.message : 'Could not create an account on this node.';
		}
	};

	onMount(() => {
		if (readPleromaSession(localStorage)) {
			goto('/app/home');
			return;
		}

		instance = defaultDeltanetInstanceUrl({
			windowOrigin: window.location.origin,
			publicInstanceUrl: env.PUBLIC_PLEROMA_INSTANCE_URL
		});

		void (async () => {
			try {
				const status = await fetchDeltanetStatus({ instanceUrl: instance, fetch: window.fetch.bind(window) });
				mode = status.configured ? 'signin' : 'signup';
			} catch {
				// Default to sign-in if status can't be read; the field is still editable.
			}
		})();
	});
</script>

<svelte:head>
	<title>DeltaNet · Landing</title>
</svelte:head>

<div class="signedout">
	<header class="so-header" aria-label="DeltaNet landing">
		<div class="so-shell so-header-inner">
			<a class="so-brand" href="/" aria-label="DeltaNet home">
				<span class="brand-mark"><Icon name="sparkBig" /></span>
				<span class="brand-name">DeltaNet<sup>TM</sup></span>
			</a>
			<nav class="so-nav" aria-label="Public links">
				<a href="/public">Browse public</a>
				<a href="/design-system">Design system</a>
			</nav>
			<a class="so-mini-cta" href="/public">Open public timeline</a>
		</div>
	</header>

	<section class="so-hero">
		<div class="so-shell so-hero-grid">
			<div class="so-copy">
				<div class="so-eyebrow"><span></span> Your node · Encrypted email federation</div>
				<h1>A quieter corner of the social web.</h1>
				<p class="so-lede">DeltaNet is your own single-user node. It federates over encrypted email instead of ActivityPub: your identity is an email address on a chatmail relay, posts are delivered end-to-end encrypted, and following someone means joining their feed with an invite link. Servers only ever see ciphertext — never your posts, never your contacts.</p>
				<div class="so-stats" aria-label="How it works">
					<div><strong>1</strong><span>Account, this node</span></div>
					<div><strong>e2e</strong><span>Encrypted delivery</span></div>
					<div><strong>0</strong><span>Servers that can read you</span></div>
				</div>
			</div>

			<section id="oauth" class="so-auth" aria-label="DeltaNet sign-in and account creation">
				<div class="so-auth-tabs" role="tablist" aria-label="Authentication mode">
					<button type="button" role="tab" aria-selected={mode === 'signin'} class:active={mode === 'signin'} onclick={() => selectMode('signin')}>Sign in</button>
					<button type="button" role="tab" aria-selected={mode === 'signup'} class:active={mode === 'signup'} onclick={() => selectMode('signup')}>Create account</button>
				</div>

				{#if authStep === 'enter' && mode === 'signin'}
					<div class="so-auth-body">
						<p class="so-blurb">Sign in to your node. DeltaNet redirects you there to authorize — no password is ever entered here.</p>
						{#if authError}
							<p class="so-error">{authError}</p>
						{/if}
						<button type="button" class="so-advanced-toggle" aria-expanded={showAdvanced} onclick={() => (showAdvanced = !showAdvanced)}>{showAdvanced ? 'Hide advanced' : 'Advanced: change home server'}</button>
						{#if showAdvanced}
							<div class="so-field">
								<label for="instance">Your home server</label>
								<div class="so-input-wrap">
									<input id="instance" aria-label="Your home server" value={instance} oninput={(event) => (instance = event.currentTarget.value)} placeholder="http://localhost:4030" />
								</div>
							</div>
						{/if}
						<button type="button" class="so-cta" disabled={continueDisabled} onclick={startOAuth}>Continue</button>
						<p class="so-footnote">DeltaNet never sees your password. Authorization is granted by your node via OAuth.</p>
					</div>
				{:else if authStep === 'enter' && mode === 'signup'}
					<div class="so-auth-body">
						<p class="so-blurb">Create the account for this node. You'll be assigned an email address on a chatmail relay — that's your identity on the network.</p>
						{#if signupError}
							<p class="so-error">{signupError}</p>
						{/if}
						<div class="so-field">
							<label for="display-name">Display name</label>
							<div class="so-input-wrap">
								<input id="display-name" aria-label="Display name" value={displayName} oninput={(event) => (displayName = event.currentTarget.value)} placeholder="Quiet Fox" />
							</div>
						</div>
						<button type="button" class="so-advanced-toggle" aria-expanded={showAdvanced} onclick={() => (showAdvanced = !showAdvanced)}>{showAdvanced ? 'Hide advanced' : 'Advanced: relay & home server'}</button>
						{#if showAdvanced}
							<div class="so-field">
								<label for="relay">Relay</label>
								<div class="so-input-wrap">
									<input id="relay" aria-label="Relay" value={relay} oninput={(event) => (relay = event.currentTarget.value)} placeholder={DELTANET_DEFAULT_RELAY} />
								</div>
								<p class="so-hint">This is the mail relay hosting your address.</p>
							</div>
							<div class="so-field">
								<label for="signup-instance">Your home server</label>
								<div class="so-input-wrap">
									<input id="signup-instance" aria-label="Your home server" value={instance} oninput={(event) => (instance = event.currentTarget.value)} placeholder="http://localhost:4030" />
								</div>
							</div>
						{/if}
						<button type="button" class="so-cta" disabled={signupDisabled} onclick={submitSignup}>{signupPending ? 'Creating account…' : 'Create account'}</button>
						<p class="so-footnote">Your address lives on the relay above. You can change it later.</p>
					</div>
				{:else if authStep === 'signup-success'}
					<div class="so-auth-body so-redirect">
						<h2>Account created</h2>
						<p>Your address is <strong>{signupAddress}</strong>.</p>
						<div class="so-chain" role="status">Continuing into sign-in...</div>
					</div>
				{:else}
					<div class="so-auth-body so-redirect">
						<div class="so-redirect-mark"><span class="brand-mark"><Icon name="sparkBig" /></span><Icon name="arrow" /><span class="so-globe"><Icon name="globe" /></span></div>
						<h2>Redirecting to {selectedInstanceUrl}</h2>
						<p>Your node will ask you to authorize DeltaNet. We will bring you right back.</p>
						{#if authorizationUrl}
							<a class="so-cta so-auth-link" href={authorizationUrl}>Open {selectedInstanceUrl} authorization</a>
						{:else if authError}
							<p class="so-error">{authError}</p>
						{:else}
							<div class="so-chain" role="status">Preparing secure OAuth request...</div>
						{/if}
						<button type="button" class="so-cancel" onclick={cancelRedirect}>Cancel redirect</button>
					</div>
				{/if}
			</section>
		</div>
	</section>

	<section class="so-band" aria-label="Principles">
		<div class="so-shell so-band-inner">
			<div><span>01</span><strong>Servers only see ciphertext.</strong><p>Posts are encrypted end-to-end before they ever leave this node. No relay, no admin, can read your feed.</p></div>
			<div><span>02</span><strong>Your identity is an email address.</strong><p>No usernames tied to a platform. Your address lives on a chatmail relay you choose.</p></div>
			<div><span>03</span><strong>Following is an invite link.</strong><p>No public firehose to search. Share a link, or receive one, to join a feed.</p></div>
		</div>
	</section>

	<section class="so-peek so-shell">
		<div>
			<p class="so-eyebrow">A look inside</p>
			<h2>The federated timeline, right now.</h2>
		</div>
		<a href="/public">View public timeline</a>
	</section>

	<section class="so-rules so-shell">
		<h2>Things we ask of each other.</h2>
		<p>Be generous with context, use content warnings when needed, and remember there are people on the other side of the screen.</p>
	</section>
</div>

<style>
	.signedout { min-height: 100vh; background: var(--bg); color: var(--ink); }
	.so-shell { width: min(1200px, calc(100vw - 48px)); margin: 0 auto; }
	.so-header { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--panel) 94%, transparent); backdrop-filter: blur(12px); }
	.so-header-inner { display: flex; align-items: center; gap: 24px; min-height: 68px; }
	.so-brand { display: inline-flex; align-items: center; gap: 12px; }
	.so-nav { display: flex; flex: 1; gap: 20px; }
	.so-nav a, .so-mini-cta { font-size: 13px; color: var(--ink-2); }
	.so-nav a:hover, .so-mini-cta:hover { color: var(--accent-ink); }
	.so-mini-cta { padding: 8px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel); }
	.so-hero { padding: clamp(36px, 7vw, 88px) 0; border-bottom: 1px solid var(--border); }
	.so-hero-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr); gap: clamp(28px, 6vw, 72px); align-items: start; }
	.so-eyebrow { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 14px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
	.so-eyebrow span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
	h1 { max-width: 680px; margin: 0; font-family: var(--serif); font-size: clamp(48px, 8vw, 88px); font-weight: 400; line-height: 0.96; letter-spacing: -0.04em; }
	.so-lede { max-width: 560px; margin: 24px 0 34px; color: var(--ink-2); font-size: 18px; line-height: 1.55; }
	.so-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--border-strong); border-bottom: 1px solid var(--border-strong); }
	.so-stats div { padding: 16px 14px; border-right: 1px solid var(--border); }
	.so-stats div:last-child { border-right: 0; }
	.so-stats strong { display: block; font-family: var(--serif); font-size: 28px; font-weight: 500; line-height: 1; color: var(--accent-ink); }
	.so-stats span { display: block; margin-top: 6px; font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
	.so-auth { overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--panel); box-shadow: 0 24px 60px rgba(28, 32, 70, 0.08), 0 2px 8px rgba(28, 32, 70, 0.04); }
	.so-auth-tabs { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--border); background: var(--panel-2); }
	.so-auth-tabs button { position: relative; padding: 14px; border-right: 1px solid var(--border); color: var(--muted); font-size: 13px; font-weight: 600; }
	.so-auth-tabs button:last-child { border-right: 0; }
	.so-auth-tabs button.active { background: var(--panel); color: var(--accent-ink); }
	.so-auth-tabs button.active::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; background: var(--accent); }
	.so-auth-body { padding: 22px; }
	.so-blurb { margin: 0 0 18px; color: var(--ink-2); font-size: 13px; line-height: 1.55; }
	.so-field { position: relative; margin-bottom: 14px; }
	.so-field label { display: block; margin-bottom: 6px; font-family: var(--mono); font-size: 9.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
	.so-input-wrap { display: flex; align-items: stretch; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--panel-2); }
	.so-input-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
	.so-input-wrap input { min-width: 0; flex: 1; padding: 11px 12px; border: 0; outline: 0; background: transparent; font-size: 14px; }
	.so-advanced-toggle { margin: 4px 0 14px; color: var(--muted); font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
	.so-advanced-toggle:hover { color: var(--accent-ink); }
	.so-hint { margin: 6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.4; }
	.so-cta { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 42px; padding: 11px 16px; border: 1px solid var(--accent-ink); border-radius: 4px; background: var(--accent-ink); color: white; font-weight: 700; }
	.so-cta:hover { background: var(--ink); border-color: var(--ink); }
	.so-cta:disabled { cursor: not-allowed; opacity: 0.55; background: var(--muted-2); border-color: var(--muted-2); }
	.so-auth-link { text-decoration: none; }
	.so-chain { margin-top: 14px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
	.so-footnote { margin: 14px 0 0; color: var(--muted); font-size: 11.5px; line-height: 1.5; }
	.so-redirect { text-align: center; }
	.so-redirect-mark { display: flex; align-items: center; justify-content: center; gap: 18px; margin-bottom: 16px; color: var(--muted); }
	.so-redirect-mark .brand-mark, .so-globe { width: 42px; height: 42px; }
	.so-globe { display: grid; place-items: center; border: 1px solid var(--border); border-radius: 4px; color: var(--accent-ink); background: var(--panel-2); }
	.so-redirect h2 { margin: 0 0 8px; font-family: var(--serif); font-size: 30px; font-weight: 500; line-height: 1; }
	.so-redirect p { margin: 0 auto 16px; max-width: 34ch; color: var(--muted); }
	.so-cancel { margin-top: 14px; color: var(--muted); font-size: 12px; }
	.so-cancel:hover { color: var(--accent-ink); }
	.so-error { color: var(--bad); margin: 0 0 14px; font-size: 12.5px; }
	.so-band { padding: 30px 0; background: var(--ink); color: var(--panel); }
	.so-band-inner { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; }
	.so-band span { display: block; margin-bottom: 8px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em; color: rgba(255,255,255,0.5); }
	.so-band strong { display: block; font-family: var(--serif); font-size: 22px; font-weight: 500; line-height: 1.15; }
	.so-band p { margin: 6px 0 0; color: rgba(255,255,255,0.7); font-size: 13px; line-height: 1.5; }
	.so-peek, .so-rules { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding-top: 64px; padding-bottom: 64px; border-bottom: 1px solid var(--border); }
	.so-peek h2, .so-rules h2 { margin: 0; font-family: var(--serif); font-size: clamp(32px, 5vw, 48px); font-weight: 400; line-height: 1.05; }
	.so-peek a { color: var(--accent-ink); }
	.so-rules { display: block; }
	.so-rules p { max-width: 58ch; color: var(--muted); }

	@media (max-width: 880px) {
		.so-shell { width: min(100% - 28px, 1200px); }
		.so-header-inner { gap: 12px; min-height: 58px; }
		.so-nav { display: flex; flex: initial; margin-left: auto; }
		.so-nav a:not(:first-child) { display: none; }
		.so-mini-cta { margin-left: auto; }
		.so-hero-grid { grid-template-columns: minmax(0, 1fr); }
		.so-stats, .so-band-inner { grid-template-columns: minmax(0, 1fr); }
		.so-stats div { border-right: 0; border-bottom: 1px solid var(--border); }
		.so-stats div:last-child { border-bottom: 0; }
	}

	@media (max-width: 560px) {
		.so-header .brand-mark { width: 36px; height: 36px; }
		.so-header .brand-name { font-size: 22px; }
		.so-mini-cta { display: none; }
		.so-hero { padding-top: 28px; }
		.so-auth-body { padding: 18px; }
		.so-peek { display: block; }
		.so-peek a { display: inline-block; margin-top: 18px; }
	}
</style>

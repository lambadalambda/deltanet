// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	interface Window {
		readonly headwaterDesktop?: Readonly<{
			writeClipboardText(text: string): Promise<void>;
			getStatus(): Promise<Readonly<{
				state: 'ready';
				origin: string;
				configured: boolean;
				backupRequired: boolean;
			}>>;
			getEnrollmentRevision(): Promise<number>;
			registerOAuthClient(afterRevision?: number): Promise<Readonly<{
				origin: string;
				clientId: string;
				clientSecret: string;
			}> | null>;
			acknowledgeOAuthClient(clientId: string): Promise<void>;
			selectBackup(): Promise<Readonly<{ filename: string }> | null>;
			createAccount(input: Readonly<{ displayName: string }>): Promise<Readonly<{
				origin: string;
				acct: string;
				client: Readonly<{ origin: string; clientId: string; clientSecret: string }> | null;
			}>>;
			restoreAccount(passphrase: string): Promise<Readonly<{
				origin: string;
				acct: string;
				client: Readonly<{ origin: string; clientId: string; clientSecret: string }> | null;
			}>>;
			saveBackup(input: Readonly<{ accessToken: string; passphrase: string }>): Promise<Readonly<{ filename: string }> | null>;
		}>;
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

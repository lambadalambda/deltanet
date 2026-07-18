// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	interface Window {
		readonly headwaterDesktop?: Readonly<{
			getStatus(): Promise<Readonly<{ state: 'ready'; origin: string }>>;
			getEnrollmentRevision(): Promise<number>;
			registerOAuthClient(afterRevision?: number): Promise<Readonly<{
				origin: string;
				clientId: string;
				clientSecret: string;
			}> | null>;
			acknowledgeOAuthClient(clientId: string): Promise<void>;
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

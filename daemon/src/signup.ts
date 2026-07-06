export type NewAccountCredentials = {
  addr: string;
  password: string;
};

/**
 * Registers a fresh chatmail account against a relay's `POST /new` endpoint.
 * `fetchImpl` is injectable so unit tests never hit the real network.
 */
export const registerAccount = async (
  relay: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NewAccountCredentials> => {
  const res = await fetchImpl(`${relay}/new`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`registration failed: ${res.status} ${await res.text()}`);
  }
  const { email, password } = (await res.json()) as { email: string; password: string };
  return { addr: email, password };
};

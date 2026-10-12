/**
 * For tests that mock `utils/api` with a `smartFetch` stub: builds an
 * `apiJson` that goes through that stub, with the same contract as the real
 * one (JSON body, throws the server's `{ error }` on non-2xx or a null
 * response). Use it inside the `vi.mock` factory:
 *
 *   vi.mock('../../utils/api', async () => {
 *       const { apiJsonVia } = await import('../../test-utils/apiMock');
 *       return { smartFetch: mocks.smartFetch, apiJson: apiJsonVia(mocks.smartFetch) };
 *   });
 *
 * It must not import `utils/api` itself, because that module is the mocked one.
 */
interface ResponseLike {
    ok: boolean;
    status?: number;
    json: () => Promise<unknown>;
}

type SmartFetchLike = (url: string, init?: RequestInit) => Promise<ResponseLike | null | undefined>;

export const apiJsonVia =
    (smartFetch: SmartFetchLike) =>
    async <T = unknown>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> => {
        const init: RequestInit = { method: options.method ?? 'GET' };
        if (options.body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(options.body);
        }
        const res = await smartFetch(url, init);
        if (!res) throw new Error('Network error or rate limited');
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        if (!res.ok) {
            throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status ?? 'error'})`);
        }
        return data as T;
    };

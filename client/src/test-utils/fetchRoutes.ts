import { vi } from 'vitest';

export interface FetchCall {
    method: string;
    url: string;
    body: unknown;
}

type Handler = (call: FetchCall) => { status?: number; body: unknown } | unknown;

/**
 * Replaces global fetch with a router keyed by "METHOD /path" (query string
 * ignored). Handlers return a body, or `{ status, body }` for errors.
 * Unmatched requests answer 404. Returns the list of calls made.
 */
export function mockFetchRoutes(routes: Record<string, Handler>): FetchCall[] {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init: RequestInit = {}) => {
            const method = (init.method ?? 'GET').toUpperCase();
            const url = String(input);
            const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
            const call = { method, url, body };
            calls.push(call);
            const handler = routes[`${method} ${url.split('?')[0]}`];
            let status = 200;
            let payload: unknown = { error: 'not found' };
            if (!handler) {
                status = 404;
            } else {
                const result = handler(call);
                if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
                    status = (result as { status: number }).status;
                    payload = (result as { body: unknown }).body;
                } else {
                    payload = result;
                }
            }
            return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
        })
    );
    return calls;
}

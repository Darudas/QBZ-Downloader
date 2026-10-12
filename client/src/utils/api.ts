import { normalizePasswordForAuth } from './crypto';

export const smartFetch = async (url: string, options: RequestInit = {}) => {
    const password = await normalizePasswordForAuth(sessionStorage.getItem('dashboard_password'));
    if (password) {
        options.headers = {
            ...options.headers,
            'x-password': password
        };
    }

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            // Don't trigger the dashboard lock modal if the 401 comes from login or onboarding
            const isAuthRoute = url.includes('/api/login') || url.includes('/api/onboarding');
            if (!isAuthRoute) {
                window.dispatchEvent(new CustomEvent('auth:unauthorized'));
            }
        }
        if (res.status === 429) {
            console.warn('Rate limited by server');
            return null;
        }
        return res;
    } catch (err) {
        console.error(`Fetch error for ${url}:`, err);
        return null;
    }
};

export const getQualityLabel = (quality: number | string) => {
    const q = Number(quality);
    if (q === 27) return 'Hi-Res 24/192';
    if (q === 7) return 'Hi-Res 24/96';
    if (q === 6) return 'CD 16/44.1';
    if (q === 5) return 'MP3 320';
    return 'Unknown';
};

export class ApiError extends Error {
    constructor(message: string, readonly status: number | null) {
        super(message);
        this.name = 'ApiError';
    }
}

/**
 * smartFetch plus JSON: sends `body` as JSON when given, throws an ApiError
 * with the server's `{ error }` message on a non-2xx answer, a network error
 * or rate limiting, and returns the parsed response body otherwise.
 */
export async function apiJson<T = unknown>(
    url: string,
    options: { method?: string; body?: unknown } = {}
): Promise<T> {
    const init: RequestInit = { method: options.method ?? 'GET' };
    if (options.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(options.body);
    }
    const res = await smartFetch(url, init);
    if (!res) throw new ApiError('Network error or rate limited', null);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const message = data && typeof data.error === 'string' ? data.error : `Request failed (${res.status})`;
        throw new ApiError(message, res.status);
    }
    return data as T;
}

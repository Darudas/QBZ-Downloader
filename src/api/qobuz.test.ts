import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QobuzAPI } from './qobuz.js';
import { CONFIG } from '../config.js';
import { cacheService } from '../utils/cache.js';
import { tokenManager } from '../utils/token.js';
import {
    APIError,
    AuthenticationError,
    ForbiddenError,
    NotFoundError,
    QobuzError,
    RateLimitError,
    ValidationError
} from '../utils/errors.js';

type RequestConfig = {
    method: 'GET' | 'POST';
    url: string;
    params?: Record<string, unknown>;
    data?: URLSearchParams;
    headers?: Record<string, string>;
};

const { mockClient, mockGet, mockPost, interceptorHandlers } = vi.hoisted(() => {
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const interceptorHandlers = {
        request: [] as Array<(config: { headers: Record<string, unknown> }) => unknown>,
        responseError: [] as Array<(error: unknown) => Promise<unknown>>
    };
    // The API uses client.request(); route it to get/post mocks so tests can
    // assert on either. GET calls keep the (url, config) shape of axios.get.
    const mockRequest = vi.fn((config: { method: string; url: string; data?: unknown }) =>
        config.method === 'POST'
            ? mockPost(config.url, config.data, config)
            : mockGet(config.url, config)
    );
    return {
        mockGet,
        mockPost,
        interceptorHandlers,
        mockClient: {
            get: mockGet,
            post: mockPost,
            request: mockRequest,
            interceptors: {
                request: {
                    use: vi.fn((handler) => {
                        interceptorHandlers.request.push(handler);
                    })
                },
                response: {
                    use: vi.fn((_ok, onError) => {
                        interceptorHandlers.responseError.push(onError);
                    })
                }
            }
        }
    };
});

vi.mock('../utils/http.js', () => ({
    createAxiosInstance: vi.fn(() => mockClient)
}));

vi.mock('../utils/cache.js', () => ({
    USER_CACHE_PREFIX: 'u:',
    cacheService: {
        get: vi.fn(() => null),
        set: vi.fn(),
        delete: vi.fn(),
        deleteByPrefix: vi.fn(() => 0)
    }
}));

vi.mock('../utils/logger.js', () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        success: vi.fn()
    }
}));

vi.mock('../utils/token.js', () => ({
    tokenManager: {
        markInvalid: vi.fn(),
        getToken: vi.fn(() => 'token'),
        getStatus: vi.fn(() => ({ configured: true, valid: null, lastValidated: null })),
        clearValidation: vi.fn()
    }
}));

vi.mock('../services/settings.js', () => ({
    settingsService: {
        get: vi.fn(),
        set: vi.fn()
    }
}));

vi.mock('../config.js', () => ({
    CONFIG: {
        api: { baseUrl: 'https://example.test' },
        credentials: {
            appId: 'app-id',
            appSecret: 'app-secret',
            token: 'token',
            userId: 'user-id'
        },
        download: {
            retryAttempts: 2,
            retryDelay: 1000,
            concurrent: 2
        }
    },
    normalizeDownloadQuality: vi.fn((value) => Number(value))
}));

const httpError = (
    status: number,
    message = `HTTP ${status}`,
    headers: Record<string, string> = {}
) => ({
    message: `Request failed with status code ${status}`,
    response: { status, headers, data: { status: 'error', code: status, message } }
});

const timeoutError = () => ({ message: 'timeout of 30000ms exceeded', code: 'ECONNABORTED' });

/** Run all (fake) timers until the promise settles; rethrows its rejection. */
async function settle<T>(promise: Promise<T>): Promise<T> {
    const guarded = promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
    );
    await vi.runAllTimersAsync();
    const result = await guarded;
    if (result.ok) return result.value;
    throw result.error;
}

async function settleError(promise: Promise<unknown>): Promise<unknown> {
    try {
        await settle(promise);
    } catch (error) {
        return error;
    }
    throw new Error('Expected the promise to reject');
}

const postCall = (index = 0) => {
    const call = mockPost.mock.calls[index];
    if (!call) throw new Error(`No POST call #${index}`);
    const [url, data, config] = call as [string, URLSearchParams, RequestConfig];
    return { url, form: Object.fromEntries(data.entries()), config };
};

const getCall = (index = 0) => {
    const call = mockGet.mock.calls[index];
    if (!call) throw new Error(`No GET call #${index}`);
    const [url, config] = call as [string, RequestConfig];
    return { url, params: config.params ?? {}, config };
};

const flushPromises = async () => {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
};

describe('QobuzAPI playlist pagination', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockGet.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should fetch all playlist track pages', async () => {
        const api = new QobuzAPI();
        mockGet
            .mockResolvedValueOnce({
                data: {
                    id: 'playlist-1',
                    name: 'Playlist',
                    tracks: {
                        items: [{ id: 'track-1' }, { id: 'track-2' }],
                        total: 3
                    }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    id: 'playlist-1',
                    name: 'Playlist',
                    tracks: {
                        items: [{ id: 'track-3' }],
                        total: 3
                    }
                }
            });

        const resultPromise = api.getPlaylist('playlist-1');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(250);
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.data?.tracks.items).toEqual([
            { id: 'track-1' },
            { id: 'track-2' },
            { id: 'track-3' }
        ]);
        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(mockGet.mock.calls[0]?.[1].params).toMatchObject({ limit: 100, offset: 0 });
        expect(mockGet.mock.calls[1]?.[1].params).toMatchObject({ limit: 100, offset: 2 });
    });

    it('should fail when playlist pagination ends before the total is reached', async () => {
        const api = new QobuzAPI();
        mockGet
            .mockResolvedValueOnce({
                data: {
                    id: 'playlist-1',
                    name: 'Playlist',
                    tracks: {
                        items: [{ id: 'track-1' }, { id: 'track-2' }],
                        total: 3
                    }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    id: 'playlist-1',
                    name: 'Playlist',
                    tracks: { items: [], total: 3 }
                }
            });

        const resultPromise = api.getPlaylist('playlist-1');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(250);
        const result = await resultPromise;

        expect(result).toEqual({ success: false, error: 'API Error' });
    });
});

describe('QobuzAPI rate limiting and retry handling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockGet.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should honor Retry-After when retrying 429 responses', async () => {
        const api = new QobuzAPI();
        mockGet
            .mockRejectedValueOnce({
                message: 'Too Many Requests',
                response: {
                    status: 429,
                    headers: { 'retry-after': '2' },
                    data: { message: 'Too Many Requests' }
                }
            })
            .mockResolvedValueOnce({ data: { id: 'track-1' } });

        const resultPromise = api.getTrack('track-1');
        await flushPromises();

        expect(mockGet).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1999);
        expect(mockGet).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        const result = await resultPromise;

        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ success: true, data: { id: 'track-1' } });
    });

    it('should serialize bursts through the request rate limiter', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { ok: true } });

        const first = api.getTrack('track-1');
        const second = api.getAlbum('album-1');
        await flushPromises();

        expect(mockGet).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(249);
        expect(mockGet).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await Promise.all([first, second]);

        expect(mockGet).toHaveBeenCalledTimes(2);
    });
});

describe('QobuzAPI getFileUrl format_id=1 handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGet.mockReset();
    });

    it('should return early with format_id=1 for genuine preview (sample=true)', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/preview.flac',
                format_id: 1,
                sample: true,
                duration: 30,
                bit_depth: 24,
                sampling_rate: 96,
                mime_type: 'audio/flac'
            }
        });

        const result = await api.getFileUrl('track-1', 27);

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data.format_id).toBe(1);
        expect(result.data.quality_verified).toBe(false);
        expect(result.data.sample).toBe(true);
    });

    it('should return early with format_id=1 for genuine preview (duration=30)', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/preview.flac',
                format_id: 1,
                sample: false,
                duration: 30,
                bit_depth: 24,
                sampling_rate: 96,
                mime_type: 'audio/flac'
            }
        });

        const result = await api.getFileUrl('track-2', 27);

        expect(result.success).toBe(true);
        expect(result.data.format_id).toBe(1);
        expect(result.data.quality_verified).toBe(false);
    });

    it('should return early with format_id=1 for genuine preview (duration=15)', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/preview.flac',
                format_id: 1,
                sample: false,
                duration: 15,
                bit_depth: 24,
                mime_type: 'audio/flac'
            }
        });

        const result = await api.getFileUrl('track-3', 27);

        expect(result.success).toBe(true);
        expect(result.data.format_id).toBe(1);
        expect(result.data.quality_verified).toBe(false);
    });

    it('should fall through to quality detection for false positive format_id=1 with 24-bit/96kHz', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/track.flac',
                format_id: 1,
                sample: false,
                duration: 300,
                bit_depth: 24,
                sampling_rate: 96,
                mime_type: 'audio/flac'
            }
        });

        const result = await api.getFileUrl('track-4', 27);

        expect(result.success).toBe(true);
        expect(result.data.format_id).toBe(7);
        expect(result.data.quality_verified).toBe(true);
    });

    it('should fall through to quality detection for false positive format_id=1 with 24-bit/192kHz', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/track.flac',
                format_id: 1,
                sample: false,
                duration: 450,
                bit_depth: 24,
                sampling_rate: 192,
                mime_type: 'audio/flac'
            }
        });

        const result = await api.getFileUrl('track-5', 27);

        expect(result.success).toBe(true);
        expect(result.data.format_id).toBe(27);
        expect(result.data.quality_verified).toBe(true);
    });

    it('should detect format from bit_depth=16 even when format_id=1', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/track.flac',
                format_id: 1,
                sample: false,
                duration: 240,
                bit_depth: 16,
                sampling_rate: 44.1,
                mime_type: 'audio/flac'
            }
        });

        const result = await api.getFileUrl('track-6', 27);

        expect(result.success).toBe(true);
        expect(result.data.format_id).toBe(6);
        expect(result.data.quality_verified).toBe(true);
    });

    it('should detect MP3 format from mime_type even when format_id=1', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/track.mp3',
                format_id: 1,
                sample: false,
                duration: 200,
                mime_type: 'audio/mpeg'
            }
        });

        const result = await api.getFileUrl('track-7', 27);

        expect(result.success).toBe(true);
        expect(result.data.format_id).toBe(5);
        expect(result.data.quality_verified).toBe(true);
    });

    it('should preserve format_id=27 for normal high-res track', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/track.flac',
                format_id: 27,
                sample: false,
                duration: 360,
                bit_depth: 24,
                sampling_rate: 192,
                mime_type: 'audio/flac'
            }
        });

        const result = await api.getFileUrl('track-8', 27);

        expect(result.success).toBe(true);
        expect(result.data.format_id).toBe(27);
        expect(result.data.quality_verified).toBe(true);
    });

    it('should stay format_id=1 for false positive with no quality metadata', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                url: 'https://example.test/track.flac',
                format_id: 1,
                sample: false,
                duration: 300
            }
        });

        const result = await api.getFileUrl('track-9', 27);

        expect(result.success).toBe(true);
        // Falls through but no bit_depth/mime_type to determine quality → stays 1
        expect(result.data.format_id).toBe(1);
        // qualityVerified starts as true because rawFormatId > 0
        // downloadTrack safety net rejects via format_id === 1 check
    });
});

describe('QobuzAPI without an app id', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGet.mockReset();
    });

    it('fails fast with a setup hint instead of calling Qobuz', async () => {
        const api = new QobuzAPI();
        Object.defineProperty(api, 'appId', { get: () => '' });
        await expect(api.getTrack('track-1')).rejects.toThrow('Add your Qobuz credentials');
        expect(mockGet).not.toHaveBeenCalled();
    });
});

describe('QobuzAPI transport', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockGet.mockReset();
        mockPost.mockReset();
        interceptorHandlers.request.length = 0;
        interceptorHandlers.responseError.length = 0;
        CONFIG.credentials.token = 'token';
        CONFIG.credentials.userId = 'user-id';
    });

    afterEach(() => {
        vi.useRealTimers();
        CONFIG.credentials.token = 'token';
        CONFIG.credentials.userId = 'user-id';
    });

    it('sends X-App-Id and X-User-Auth-Token headers from the request interceptor', () => {
        new QobuzAPI();
        const handler = interceptorHandlers.request.at(-1)!;
        const config = { headers: {} as Record<string, unknown> };
        handler(config);
        expect(config.headers).toEqual({ 'X-App-Id': 'app-id', 'X-User-Auth-Token': 'token' });
    });

    it('reads credentials per request and omits the token header when logged out', () => {
        new QobuzAPI();
        const handler = interceptorHandlers.request.at(-1)!;
        CONFIG.credentials.token = '';
        const config = { headers: {} as Record<string, unknown> };
        handler(config);
        expect(config.headers).toEqual({ 'X-App-Id': 'app-id' });
    });

    it('marks the token invalid only on 401, never on 403', async () => {
        new QobuzAPI();
        const onError = interceptorHandlers.responseError.at(-1)!;

        const forbidden = { response: { status: 403 } };
        await expect(onError(forbidden)).rejects.toBe(forbidden);
        expect(tokenManager.markInvalid).not.toHaveBeenCalled();

        const unauthorized = { response: { status: 401 } };
        await expect(onError(unauthorized)).rejects.toBe(unauthorized);
        expect(tokenManager.markInvalid).toHaveBeenCalledTimes(1);
    });

    it('POSTs writes as a form body carrying the credentials, never in the URL', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { status: 'success' } });

        const result = await settle(api.addFavorites({ albumIds: ['abc123'], trackIds: [1, '2'] }));

        expect(result).toEqual({ success: true, data: { status: 'success' } });
        const { url, form, config } = postCall();
        expect(url).toBe('/favorite/create');
        expect(config.method).toBe('POST');
        expect(config.params).toBeUndefined();
        expect(config.url).not.toContain('token');
        expect(config.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
        expect(form).toEqual({
            album_ids: 'abc123',
            track_ids: '1,2',
            app_id: 'app-id',
            user_auth_token: 'token'
        });
    });

    it('sends new GET reads with app_id/user_auth_token query params', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { albums: { items: [], total: 0, offset: 5, limit: 10 } } });

        await settle(api.getUserFavorites('albums', 10, 5));

        const { url, params, config } = getCall();
        expect(url).toBe('/favorite/getUserFavorites');
        expect(config.method).toBe('GET');
        expect(params).toEqual({
            type: 'albums',
            limit: 10,
            offset: 5,
            app_id: 'app-id',
            user_auth_token: 'token'
        });
    });

    it('treats an HTTP 200 body with status "error" as an APIError without retrying', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { status: 'error', code: 400, message: 'Invalid argument' } });

        const error = await settleError(api.getGenres());

        expect(error).toBeInstanceOf(APIError);
        expect(error).toMatchObject({ message: 'Invalid argument', statusCode: 400 });
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('maps status "error" bodies with code 401 to AuthenticationError and invalidates the token', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { status: 'error', code: 401, message: 'User authentication is required' } });

        const error = await settleError(api.getGenres());

        expect(error).toBeInstanceOf(AuthenticationError);
        expect(tokenManager.markInvalid).toHaveBeenCalledTimes(1);
    });

    it('maps status "error" bodies with code 404 to NotFoundError', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { status: 'error', code: '404', message: 'No result' } });

        const error = await settleError(api.deletePlaylist(42));
        expect(error).toBeInstanceOf(NotFoundError);
    });

    it('does not mistake a success status body for an error', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { status: 'success' } });
        await expect(settle(api.subscribePlaylist(7))).resolves.toEqual({
            success: true,
            data: { status: 'success' }
        });
    });
});

describe('QobuzAPI retry policies', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockGet.mockReset();
        mockPost.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not retry playlist/create after a timeout', async () => {
        const api = new QobuzAPI();
        mockPost.mockRejectedValue(timeoutError());

        const error = await settleError(api.createPlaylist({ name: 'Mix' }));

        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).statusCode).toBeNull();
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('does not retry playlist/create on a 5xx', async () => {
        const api = new QobuzAPI();
        mockPost.mockRejectedValue(httpError(503, 'Service Unavailable'));

        const error = await settleError(api.createPlaylist({ name: 'Mix' }));

        expect(error).toMatchObject({ statusCode: 503 });
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('retries playlist/create on 429 and honours Retry-After', async () => {
        const api = new QobuzAPI();
        mockPost
            .mockRejectedValueOnce(httpError(429, 'Too Many Requests', { 'retry-after': '3' }))
            .mockResolvedValueOnce({ data: { id: 99, name: 'Mix' } });

        const promise = api.createPlaylist({ name: 'Mix' });
        await vi.advanceTimersByTimeAsync(0);
        expect(mockPost).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2999);
        expect(mockPost).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        const result = await promise;

        expect(mockPost).toHaveBeenCalledTimes(2);
        expect(result.data).toEqual({ id: 99, name: 'Mix' });
    });

    it('does not retry playlist/update after a timeout', async () => {
        const api = new QobuzAPI();
        mockPost.mockRejectedValue(timeoutError());

        await settleError(api.updatePlaylist(5, { name: 'New' }));
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('retries addTracks only on 429 when duplicates are allowed', async () => {
        const api = new QobuzAPI();
        mockPost.mockRejectedValue(httpError(500, 'Internal'));

        await settleError(api.addTracksToPlaylist(5, [1, 2], false));
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('retries addTracks with no_duplicate=true like any idempotent call', async () => {
        const api = new QobuzAPI();
        mockPost
            .mockRejectedValueOnce(httpError(500, 'Internal'))
            .mockResolvedValueOnce({ data: { id: 5, tracks_count: 2 } });

        const result = await settle(api.addTracksToPlaylist(5, [1, 2]));

        expect(mockPost).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true);
    });

    it('retries idempotent favorite writes on 5xx and timeouts', async () => {
        const api = new QobuzAPI();
        mockPost
            .mockRejectedValueOnce(httpError(502))
            .mockRejectedValueOnce(timeoutError())
            .mockResolvedValueOnce({ data: { status: 'success' } });

        const result = await settle(api.removeFavorites({ artistIds: [3] }));

        expect(mockPost).toHaveBeenCalledTimes(3);
        expect(result.success).toBe(true);
    });

    it('throws RateLimitError once 429 retries are exhausted', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(429, 'Slow down', { 'retry-after': '1' }));

        const error = await settleError(api.getTrack('1'));

        expect(error).toBeInstanceOf(RateLimitError);
        expect(error).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED', retryAfterMs: 1000 });
        expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it('does not retry 4xx reads', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(404, 'Track not found'));

        const error = await settleError(api.getTrack('1'));

        expect(error).toBeInstanceOf(NotFoundError);
        expect(mockGet).toHaveBeenCalledTimes(1);
    });
});

describe('QobuzAPI error mapping', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockGet.mockReset();
        mockPost.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('maps 401 to AuthenticationError with statusCode 401', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(401, 'User authentication is required'));

        const error = await settleError(api.getAlbum('abc'));

        expect(error).toBeInstanceOf(AuthenticationError);
        expect(error).toMatchObject({
            statusCode: 401,
            code: 'AUTH_ERROR',
            message: 'User authentication is required'
        });
    });

    it('maps 403 to ForbiddenError (an APIError), not AuthenticationError', async () => {
        const api = new QobuzAPI();
        mockPost.mockRejectedValue(httpError(403, 'Not allowed'));

        const error = await settleError(api.deletePlaylist(1));

        expect(error).toBeInstanceOf(ForbiddenError);
        expect(error).toBeInstanceOf(APIError);
        expect(error).not.toBeInstanceOf(AuthenticationError);
        expect(error).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('passes QobuzError instances through handleApiError unchanged', () => {
        const api = new QobuzAPI();
        const original = new ForbiddenError('nope');
        expect(() => api.handleApiError(original)).toThrow(original);
    });

    it('uses a generic message for errors without one', () => {
        const api = new QobuzAPI();
        expect(() => api.handleApiError({})).toThrow(new APIError('Unknown error'));
    });

    it('rethrows getTrack errors from getLyrics without re-wrapping them', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(401, 'User authentication is required'));

        const error = await settleError(api.getLyrics('1'));

        expect(error).toBeInstanceOf(AuthenticationError);
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('rethrows getAlbum errors from getGoodies without re-wrapping them', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(403, 'Region locked'));

        const error = await settleError(api.getGoodies('abc'));

        expect(error).toBeInstanceOf(ForbiddenError);
    });

    it('stops the getFileUrl fallback chain on 401', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(401, 'User authentication is required'));

        const error = await settleError(api.getFileUrl('1', 27));

        expect(error).toBeInstanceOf(AuthenticationError);
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('stops the getFileUrl fallback chain on a bad-signature 400', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(400, 'Invalid Request Signature parameter (request_sig)'));

        const error = await settleError(api.getFileUrl('1', 27));

        expect(error).toBeInstanceOf(APIError);
        expect((error as Error).message).toContain('request_sig');
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('keeps the getFileUrl quality fallback for other errors', async () => {
        const api = new QobuzAPI();
        mockGet
            .mockRejectedValueOnce(httpError(404, 'Format unavailable'))
            .mockRejectedValueOnce(httpError(404, 'Format unavailable'))
            .mockResolvedValueOnce({
                data: { url: 'https://example.test/t.flac', format_id: 6, bit_depth: 16, duration: 200 }
            });

        const result = await settle(api.getFileUrl('1', 27));

        expect(result.success).toBe(true);
        expect(mockGet.mock.calls.map((call) => (call[1] as RequestConfig).params?.format_id)).toEqual([
            27, 7, 6
        ]);
    });

    it('surfaces the last error when every getFileUrl fallback fails', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(httpError(404, 'Format unavailable'));

        const error = await settleError(api.getFileUrl('1', 27));

        expect(error).toBeInstanceOf(NotFoundError);
        expect(mockGet).toHaveBeenCalledTimes(5);
    });
});

describe('QobuzAPI user library methods', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockGet.mockReset();
        mockPost.mockReset();
        vi.mocked(cacheService.get).mockImplementation(() => null);
        CONFIG.credentials.token = 'token';
        CONFIG.credentials.userId = 'user-id';
    });

    afterEach(() => {
        vi.useRealTimers();
        CONFIG.credentials.token = 'token';
        CONFIG.credentials.userId = 'user-id';
    });

    it('rejects unknown favorite types before any request', async () => {
        const api = new QobuzAPI();
        const error = await settleError(api.getUserFavorites('labels' as never));
        expect(error).toBeInstanceOf(ValidationError);
        expect(mockGet).not.toHaveBeenCalled();
    });

    it('requires a logged-in user for library reads', async () => {
        const api = new QobuzAPI();
        CONFIG.credentials.token = '';
        const error = await settleError(api.getUserFavorites('albums'));
        expect(error).toBeInstanceOf(AuthenticationError);
        expect(mockGet).not.toHaveBeenCalled();
        expect(tokenManager.markInvalid).not.toHaveBeenCalled();
    });

    it('caches favorites per user for 120s and serves cache hits', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: { tracks: { items: [{ id: 1 }], total: 1, offset: 0, limit: 50 } }
        });

        const result = await settle(api.getUserFavorites('tracks'));

        expect(result.data?.tracks?.items).toEqual([{ id: 1 }]);
        expect(cacheService.set).toHaveBeenCalledWith(
            'u:user-id:fav:list:tracks:0:50',
            expect.anything(),
            120
        );

        vi.mocked(cacheService.get).mockImplementation((key: string) =>
            key === 'u:user-id:fav:list:tracks:0:50' ? { tracks: { items: [], total: 0 } } : null
        );
        const cached = await settle(api.getUserFavorites('tracks'));
        expect(cached.data).toEqual({ tracks: { items: [], total: 0 } });
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('scopes cache keys by token hash when no user id is configured', async () => {
        const api = new QobuzAPI();
        CONFIG.credentials.userId = '';
        mockGet.mockResolvedValue({ data: { albums: [], tracks: [], artists: [] } });

        await settle(api.getUserFavoriteIds());

        const key = vi.mocked(cacheService.set).mock.calls[0]?.[0];
        expect(key).toMatch(/^u:t[0-9a-f]{16}:fav:ids$/);
        expect(key).not.toContain('token');
    });

    it('fills missing pagination fields on favorites pages', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { albums: { items: [{ id: 'a' }] } } });

        const result = await settle(api.getUserFavorites('albums', 20, 40));

        expect(result.data?.albums).toEqual({ items: [{ id: 'a' }], total: 41, offset: 40, limit: 20 });
    });

    it('normalizes favorite ids and pages when a list is full', async () => {
        const api = new QobuzAPI();
        const firstTracks = Array.from({ length: 5000 }, (_, i) => i + 1);
        mockGet
            .mockResolvedValueOnce({
                data: { albums: ['abc', 123], tracks: firstTracks, artists: ['7', 'x'], labels: [9] }
            })
            .mockResolvedValueOnce({ data: { albums: [], tracks: [5001], artists: [], labels: [] } });

        const result = await settle(api.getUserFavoriteIds());

        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(getCall(0).params).toMatchObject({ limit: 5000, offset: 0 });
        expect(getCall(1).params).toMatchObject({ limit: 5000, offset: 5000 });
        expect(result.data?.albums).toEqual(['abc', '123']);
        expect(result.data?.tracks).toHaveLength(5001);
        expect(result.data?.artists).toEqual([7]);
        expect(result.data?.labels).toEqual([9]);
        expect(cacheService.set).toHaveBeenCalledWith('u:user-id:fav:ids', expect.anything(), 60);
    });

    it('stops paging favorite ids when the server ignores the offset', async () => {
        const api = new QobuzAPI();
        const tracks = Array.from({ length: 5000 }, (_, i) => i + 1);
        mockGet.mockResolvedValue({ data: { albums: [], tracks, artists: [] } });

        await settle(api.getUserFavoriteIds());

        expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('validates and dedupes favorite ids and invalidates the favorites cache', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { status: 'success' } });

        await settle(api.removeFavorites({ trackIds: ['5', 5, '005'], artistIds: [] }));

        const { url, form } = postCall();
        expect(url).toBe('/favorite/delete');
        expect(form.track_ids).toBe('5');
        expect(form.artist_ids).toBeUndefined();
        expect(cacheService.deleteByPrefix).toHaveBeenCalledWith('u:user-id:fav:');
    });

    it('rejects invalid or empty favorite id lists without calling Qobuz', async () => {
        const api = new QobuzAPI();
        expect(await settleError(api.addFavorites({}))).toBeInstanceOf(ValidationError);
        expect(await settleError(api.addFavorites({ trackIds: ['12a'] }))).toBeInstanceOf(ValidationError);
        expect(await settleError(api.addFavorites({ albumIds: ['../x'] }))).toBeInstanceOf(ValidationError);
        expect(await settleError(api.addFavorites({ artistIds: [0] }))).toBeInstanceOf(ValidationError);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('lists user playlists with explicit default filter and normalized pages', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { playlists: { items: [{ id: 1, name: 'A' }], total: 1 } } });

        const result = await settle(api.getUserPlaylists());

        expect(getCall().url).toBe('/playlist/getUserPlaylists');
        expect(getCall().params).toMatchObject({ filter: 'owner,subscriber', limit: 50, offset: 0 });
        expect(result.data?.playlists).toEqual({
            items: [{ id: 1, name: 'A' }],
            total: 1,
            offset: 0,
            limit: 50
        });
        expect(cacheService.set).toHaveBeenCalledWith(
            'u:user-id:playlists:list:owner,subscriber:0:50',
            expect.anything(),
            120
        );
        expect(await settleError(api.getUserPlaylists({ filter: 'all' as never }))).toBeInstanceOf(
            ValidationError
        );
    });

    it('fetches exactly one playlist page and keeps playlist_track_id', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: {
                id: 10,
                name: 'P',
                tracks: {
                    items: [{ id: 1, playlist_track_id: 3775131234 }],
                    total: 900,
                    offset: 100,
                    limit: 500
                }
            }
        });

        const result = await settle(api.getPlaylistPage('10', 9999, 100));

        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(getCall().url).toBe('/playlist/get');
        expect(getCall().params).toMatchObject({ playlist_id: '10', extra: 'tracks', limit: 500, offset: 100 });
        expect(result.data?.tracks.items[0]?.playlist_track_id).toBe(3775131234);
        expect(result.data?.tracks.total).toBe(900);
    });

    it('returns an empty normalized page for playlists without track data', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { id: 10, name: 'P', tracks_count: 0 } });

        const result = await settle(api.getPlaylistPage(10));

        expect(result.data?.tracks).toEqual({ items: [], total: 0, offset: 0, limit: 50 });
    });

    it('creates private playlists by default and never sends collaborative without public', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { id: 1, name: 'Mix' } });

        await settle(api.createPlaylist({ name: '  Mix  ', isCollaborative: true, trackIds: [3, '4'] }));

        expect(postCall().url).toBe('/playlist/create');
        expect(postCall().form).toEqual({
            name: 'Mix',
            description: '',
            is_public: 'false',
            is_collaborative: 'false',
            track_ids: '3,4',
            app_id: 'app-id',
            user_auth_token: 'token'
        });
        expect(cacheService.deleteByPrefix).toHaveBeenCalledWith('u:user-id:playlists:');
    });

    it('creates public collaborative playlists when asked', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { id: 1 } });

        await settle(
            api.createPlaylist({ name: 'Mix', description: 'd', isPublic: true, isCollaborative: true, albumId: 'abc' })
        );

        expect(postCall().form).toMatchObject({
            description: 'd',
            is_public: 'true',
            is_collaborative: 'true',
            album_id: 'abc'
        });
        expect(await settleError(api.createPlaylist({ name: '   ' }))).toBeInstanceOf(ValidationError);
    });

    it('updates only the given playlist fields and never sends track_ids', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { id: 5 } });

        await settle(api.updatePlaylist(5, { description: 'new', isPublic: false }));

        expect(postCall().url).toBe('/playlist/update');
        expect(postCall().form).toEqual({
            playlist_id: '5',
            description: 'new',
            is_public: 'false',
            is_collaborative: 'false',
            app_id: 'app-id',
            user_auth_token: 'token'
        });
        expect(await settleError(api.updatePlaylist(5, {}))).toBeInstanceOf(ValidationError);
        expect(await settleError(api.updatePlaylist(5, { name: ' ' }))).toBeInstanceOf(ValidationError);
    });

    it('deletes playlists and toggles subscriptions with playlist_id', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { status: 'success' } });

        await settle(api.deletePlaylist('12'));
        await settle(api.subscribePlaylist(13));
        await settle(api.unsubscribePlaylist(14));

        expect(mockPost.mock.calls.map((call) => call[0])).toEqual([
            '/playlist/delete',
            '/playlist/subscribe',
            '/playlist/unsubscribe'
        ]);
        expect(postCall(0).form.playlist_id).toBe('12');
        expect(postCall(1).form.playlist_id).toBe('13');
        expect(postCall(2).form.playlist_id).toBe('14');
    });

    it('adds tracks with no_duplicate and keeps duplicates only when allowed', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { id: 5 } });

        await settle(api.addTracksToPlaylist(5, [1, '1', 2]));
        await settle(api.addTracksToPlaylist(5, [1, 1], false));

        expect(postCall(0).url).toBe('/playlist/addTracks');
        expect(postCall(0).form).toMatchObject({ playlist_id: '5', track_ids: '1,2', no_duplicate: 'true' });
        expect(postCall(1).form).toMatchObject({ track_ids: '1,1', no_duplicate: 'false' });
        expect(await settleError(api.addTracksToPlaylist(5, []))).toBeInstanceOf(ValidationError);
    });

    it('removes playlist entries by playlist_track_ids (large ids kept as strings)', async () => {
        const api = new QobuzAPI();
        mockPost.mockResolvedValue({ data: { status: 'success' } });

        await settle(api.removeTracksFromPlaylist(5, ['3775131234', 12]));

        expect(postCall().url).toBe('/playlist/deleteTracks');
        expect(postCall().form).toMatchObject({ playlist_id: '5', playlist_track_ids: '3775131234,12' });
        expect(postCall().form.track_ids).toBeUndefined();
    });

    it('lists purchases with and without a type', async () => {
        const api = new QobuzAPI();
        mockGet
            .mockResolvedValueOnce({ data: { albums: { items: [{ id: 'a' }], total: 1 } } })
            .mockResolvedValueOnce({ data: { albums: { items: [], total: 0 }, tracks: { items: [], total: 0 } } });

        const albums = await settle(api.getUserPurchases('albums', 10, 0));
        await settle(api.getUserPurchases());

        expect(getCall(0).url).toBe('/purchase/getUserPurchases');
        expect(getCall(0).params).toMatchObject({ type: 'albums', limit: 10, offset: 0 });
        expect(getCall(1).params.type).toBeUndefined();
        expect(albums.data?.albums).toEqual({ items: [{ id: 'a' }], total: 1, offset: 0, limit: 10 });
        expect(cacheService.set).toHaveBeenCalledWith('u:user-id:purchases:list:albums:0:10', expect.anything(), 120);
        expect(await settleError(api.getUserPurchases('artists' as never))).toBeInstanceOf(ValidationError);
    });

    it('fetches purchase ids from purchase/getUserPurchasesIds', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { albums: { total: 1, items: [{ id: 'a' }] } } });

        const result = await settle(api.getUserPurchaseIds());

        expect(getCall().url).toBe('/purchase/getUserPurchasesIds');
        expect(result.data?.albums.items).toEqual([{ id: 'a' }]);
        expect(result.data?.tracks).toEqual({ total: 0, items: [] });
    });

    it('fetches the last-update timestamps', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { last_update: { favorite: 1700000000 } } });

        const result = await settle(api.getLastUpdate());

        expect(getCall().url).toBe('/user/lastUpdate');
        expect(result.data?.last_update.favorite).toBe(1700000000);
    });
});

describe('QobuzAPI catalog and discovery methods', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockGet.mockReset();
        vi.mocked(cacheService.get).mockImplementation(() => null);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('requests featured albums with genre_id and validates the type', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { albums: { items: [], total: 0 } } });

        const result = await settle(api.getFeaturedAlbums('new-releases', { genreId: '112', offset: 25 }));

        expect(getCall().url).toBe('/album/getFeatured');
        expect(getCall().params).toMatchObject({ type: 'new-releases', genre_id: '112', limit: 25, offset: 25 });
        expect(result.data?.albums).toEqual({ items: [], total: 0, offset: 25, limit: 25 });
        expect(await settleError(api.getFeaturedAlbums('editors-picks' as never))).toBeInstanceOf(ValidationError);
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('requests featured playlists with genre_ids', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { playlists: { items: [{ id: 1 }], total: 1 } } });

        await settle(api.getFeaturedPlaylists('editor-picks', { genreId: 64, limit: 10 }));

        expect(getCall().url).toBe('/playlist/getFeatured');
        expect(getCall().params).toMatchObject({ type: 'editor-picks', genre_ids: '64', limit: 10 });
        expect(getCall().params.genre_id).toBeUndefined();
    });

    it('fetches a label page with extra=albums', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({
            data: { id: 7, name: 'Label', albums_count: 3, albums: { items: [{ id: 'a' }], total: 3, offset: 1, limit: 1 } }
        });

        const result = await settle(api.getLabel('7', 1, 1));

        expect(getCall().url).toBe('/label/get');
        expect(getCall().params).toMatchObject({ label_id: '7', extra: 'albums', limit: 1, offset: 1 });
        expect(result.data?.name).toBe('Label');
        expect(result.data?.albums).toEqual({ items: [{ id: 'a' }], total: 3, offset: 1, limit: 1 });
        expect(await settleError(api.getLabel('abc'))).toBeInstanceOf(ValidationError);
    });

    it('clamps similar-artists limit to 100', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { artists: { items: [], total: 0 } } });

        await settle(api.getSimilarArtists(5, 1000));

        expect(getCall().url).toBe('/artist/getSimilarArtists');
        expect(getCall().params).toMatchObject({ artist_id: '5', limit: 100, offset: 0 });
    });

    it('requests artist releases with defaults and validated options', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { has_more: true, items: [{ id: 'r1', title: 'R' }] } });

        const result = await settle(api.getArtistReleases(9));
        await settle(
            api.getArtistReleases(9, {
                releaseType: ['album', 'epSingle', 'album'],
                sort: 'relevant',
                order: 'asc',
                limit: 500,
                offset: 10,
                trackSize: 99
            })
        );

        expect(getCall(0).url).toBe('/artist/getReleasesList');
        expect(getCall(0).params).toMatchObject({
            artist_id: '9',
            release_type: 'all',
            sort: 'release_date',
            order: 'desc',
            limit: 50,
            offset: 0
        });
        expect(getCall(0).params.track_size).toBeUndefined();
        expect(getCall(1).params).toMatchObject({
            release_type: 'album,epSingle',
            sort: 'relevant',
            order: 'asc',
            limit: 100,
            offset: 10,
            track_size: 30
        });
        expect(result.data).toEqual({ has_more: true, items: [{ id: 'r1', title: 'R' }] });
        expect(await settleError(api.getArtistReleases(9, { sort: 'popularity' as never }))).toBeInstanceOf(
            ValidationError
        );
    });

    it('pages album/get to collect every track id of a box set', async () => {
        const api = new QobuzAPI();
        mockGet
            .mockResolvedValueOnce({
                data: { id: 'box', tracks_count: 3, tracks: { items: [{ id: 1 }, { id: 2 }], total: 3, offset: 0, limit: 2 } }
            })
            .mockResolvedValueOnce({
                data: { id: 'box', tracks: { items: [{ id: 3 }], total: 3, offset: 2, limit: 2 } }
            });

        const result = await settle(api.getAlbumTrackIds('box'));

        expect(result.data).toEqual(['1', '2', '3']);
        expect(getCall(0).params).toMatchObject({ album_id: 'box', limit: 500, offset: 0 });
        expect(getCall(1).params).toMatchObject({ offset: 2 });
    });

    it('accepts playlist searches and clamps limit/offset', async () => {
        const api = new QobuzAPI();
        mockGet.mockResolvedValue({ data: { playlists: { items: [], total: 0, offset: 0, limit: 500 } } });

        await settle(api.search('jazz', 'playlists', 1000, -5));
        await settle(api.search('jazz', 'track', 0));

        expect(getCall(0).params).toMatchObject({ query: 'jazz', type: 'playlists', limit: 500, offset: 0 });
        expect(getCall(1).params).toMatchObject({ type: 'tracks', limit: 1 });
        expect(await settleError(api.search('jazz', 'bogus'))).toBeInstanceOf(ValidationError);
        expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('delegates parseUrl to the shared URL parser', () => {
        const api = new QobuzAPI();
        expect(api.parseUrl('https://open.qobuz.com/label/123')).toEqual({ type: 'label', id: '123' });
        expect(api.parseUrl('12345')).toBeNull();
    });

    it('all thrown errors are QobuzError subclasses', async () => {
        const api = new QobuzAPI();
        mockGet.mockRejectedValue(new TypeError('boom'));
        vi.useRealTimers();
        CONFIG.download.retryAttempts = 0;
        try {
            const error = await api.getGenres().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(QobuzError);
            expect((error as Error).message).toBe('boom');
        } finally {
            CONFIG.download.retryAttempts = 2;
        }
    });
});

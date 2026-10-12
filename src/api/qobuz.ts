import { createAxiosInstance } from '../utils/http.js';
import { cacheService, USER_CACHE_PREFIX } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { AxiosInstance, AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import crypto from 'crypto';
import { CONFIG, normalizeDownloadQuality } from '../config.js';
import {
    APIError,
    AuthenticationError,
    QobuzError,
    ValidationError,
    createApiError
} from '../utils/errors.js';
import { tokenManager } from '../utils/token.js';
import {
    QOBUZ_ALBUM_ID_PATTERN,
    QOBUZ_ARTIST_RELEASE_SORTS,
    QOBUZ_ARTIST_RELEASE_TYPES,
    QOBUZ_FAVORITE_TYPES,
    QOBUZ_FEATURED_ALBUM_TYPES,
    QOBUZ_FEATURED_PLAYLIST_TYPES,
    QOBUZ_MAX_PAGE_LIMIT,
    QOBUZ_MAX_RELEASES_LIMIT,
    QOBUZ_MAX_SIMILAR_ARTISTS_LIMIT,
    QOBUZ_NUMERIC_ID_PATTERN,
    QOBUZ_PLAYLIST_FILTERS,
    QOBUZ_PURCHASE_TYPES,
    QOBUZ_SEARCH_TYPES,
    QOBUZ_SORT_ORDERS
} from '../constants.js';
import { parseQobuzUrl, type ParsedQobuzUrl } from '../utils/validator.js';
import { settingsService } from '../services/settings.js';

import {
    Album,
    ApiResponse,
    Artist,
    ArtistReleases,
    ArtistReleaseSort,
    ArtistReleaseType,
    FavoriteIds,
    FavoriteType,
    FeaturedAlbums,
    FeaturedAlbumType,
    FeaturedPlaylists,
    FeaturedPlaylistType,
    Track,
    UserInfo,
    SearchResults,
    SearchType,
    LyricsResult,
    Label,
    LastUpdate,
    Playlist,
    PlaylistFilter,
    PlaylistListItem,
    PlaylistPage,
    PurchaseIds,
    PurchasedAlbum,
    PurchasedTrack,
    Purchases,
    PurchaseType,
    ArtistDetails,
    FileUrlData,
    SimilarArtists,
    SortOrder,
    StatusResponse,
    UserFavorites,
    UserPlaylists
} from '../types/qobuz.js';

export type { ApiResponse } from '../types/qobuz.js';

export function isSampleStream(data: { sample?: unknown; duration?: unknown }): boolean {
    return !!(data.sample || (typeof data.duration === 'number' && data.duration <= 30));
}

export type HttpMethod = 'GET' | 'POST';

/**
 * - `idempotent`: retry on network errors/timeouts, 429 and 5xx (safe to repeat).
 * - `rate-limit-only`: retry ONLY on 429 (the request was rejected before it ran).
 *   Used for writes that would duplicate data if repeated after a timeout.
 */
export type RetryPolicy = 'idempotent' | 'rate-limit-only';

type FormValue = string | number | boolean | null | undefined;

export interface QobuzRequestPayload {
    /** Query string parameters. */
    params?: Record<string, unknown>;
    /** application/x-www-form-urlencoded body (POST). */
    form?: Record<string, FormValue>;
}

export interface QobuzRequestOptions {
    retry?: RetryPolicy;
}

export interface FavoriteIdsInput {
    albumIds?: ReadonlyArray<string>;
    trackIds?: ReadonlyArray<string | number>;
    artistIds?: ReadonlyArray<string | number>;
}

export interface UserPlaylistsOptions {
    filter?: PlaylistFilter;
    limit?: number;
    offset?: number;
}

export interface CreatePlaylistParams {
    name: string;
    description?: string;
    /** Qobuz defaults new playlists to public; we always send false unless asked. */
    isPublic?: boolean;
    /** Forced to false when the playlist is not public. */
    isCollaborative?: boolean;
    trackIds?: ReadonlyArray<string | number>;
    albumId?: string;
}

export interface UpdatePlaylistParams {
    name?: string;
    description?: string;
    isPublic?: boolean;
    isCollaborative?: boolean;
}

export interface FeaturedOptions {
    genreId?: string | number;
    limit?: number;
    offset?: number;
}

export interface ArtistReleasesOptions {
    releaseType?: ArtistReleaseType | ReadonlyArray<ArtistReleaseType>;
    sort?: ArtistReleaseSort;
    order?: SortOrder;
    limit?: number;
    offset?: number;
    /** Tracks embedded per release (0..30). Omitted → server default. */
    trackSize?: number;
}

const USER_LIST_TTL_SECONDS = 120;
const FAVORITE_IDS_TTL_SECONDS = 60;
const FEATURED_TTL_SECONDS = 900;
const CATALOG_TTL_SECONDS = 1800;
const FAVORITE_IDS_PAGE_SIZE = 5000;
const FAVORITE_IDS_MAX_PAGES = 10;
const ALBUM_TRACKS_PAGE_SIZE = 500;
const ALBUM_TRACKS_MAX = 2000;

const SEARCH_TYPE_ALIASES: Readonly<Record<string, SearchType>> = {
    album: 'albums',
    track: 'tracks',
    artist: 'artists',
    playlist: 'playlists'
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    if (value === undefined || value === null || value === '') return fallback;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clampLimit(value: unknown, fallback: number, max: number = QOBUZ_MAX_PAGE_LIMIT): number {
    return clampInt(value, 1, max, Math.min(fallback, max));
}

function clampOffset(value: unknown): number {
    return clampInt(value, 0, Number.MAX_SAFE_INTEGER, 0);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
        return value as T;
    }
    throw new ValidationError(`Invalid ${field}: expected one of ${allowed.join(', ')}`);
}

function normalizeNumericId(value: unknown, field: string): string {
    const text =
        typeof value === 'number'
            ? Number.isSafeInteger(value) && value > 0
                ? String(value)
                : ''
            : typeof value === 'string'
              ? value.trim()
              : '';
    if (!QOBUZ_NUMERIC_ID_PATTERN.test(text) || /^0+$/.test(text)) {
        throw new ValidationError(`Invalid ${field}: expected a positive integer id`);
    }
    return text.replace(/^0+/, '');
}

function normalizeAlbumId(value: unknown, field = 'album id'): string {
    const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
    if (!QOBUZ_ALBUM_ID_PATTERN.test(text)) {
        throw new ValidationError(`Invalid ${field}: expected an alphanumeric Qobuz album id`);
    }
    return text;
}

function normalizeIdList(
    values: ReadonlyArray<unknown> | undefined,
    normalize: (value: unknown) => string
): string[] {
    if (!values) return [];
    if (!Array.isArray(values)) throw new ValidationError('Id lists must be arrays');
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const id = normalize(value);
        if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

function toFormBody(form: Record<string, FormValue>): URLSearchParams {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
        if (value === undefined || value === null) continue;
        body.append(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
    }
    return body;
}

function toNumberArray(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    const out: number[] = [];
    for (const item of value) {
        const n = typeof item === 'number' ? item : Number(item);
        if (Number.isSafeInteger(n) && n > 0) out.push(n);
    }
    return out;
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => typeof item === 'string' || typeof item === 'number')
        .map((item) => String(item))
        .filter((item) => item.length > 0);
}

function normalizePaginated<T>(
    raw: unknown,
    offset: number,
    limit: number
): { items: T[]; total: number; offset: number; limit: number } {
    const page = (raw && typeof raw === 'object' ? raw : {}) as {
        items?: unknown;
        total?: unknown;
        offset?: unknown;
        limit?: unknown;
    };
    const items = Array.isArray(page.items) ? (page.items as T[]) : [];
    const total = typeof page.total === 'number' && page.total >= 0 ? page.total : offset + items.length;
    return {
        items,
        total,
        offset: typeof page.offset === 'number' && page.offset >= 0 ? page.offset : offset,
        limit: typeof page.limit === 'number' && page.limit > 0 ? page.limit : limit
    };
}

export class QobuzAPI {
    baseUrl: string;
    client: AxiosInstance;
    private nextRequestAt = 0;
    private rateLimitUntil = 0;
    private requestSchedule: Promise<void> = Promise.resolve();
    private readonly minRequestIntervalMs = 250;
    private readonly maxBackoffMs = 5 * 60 * 1000;

    get appId() {
        return CONFIG.credentials.appId;
    }
    set appId(val: string) {
        settingsService.set('QOBUZ_APP_ID', val);
    }

    get appSecret() {
        return CONFIG.credentials.appSecret;
    }
    set appSecret(val: string) {
        settingsService.set('QOBUZ_APP_SECRET', val);
    }

    get token() {
        return CONFIG.credentials.token;
    }
    set token(val: string) {
        settingsService.set('QOBUZ_USER_AUTH_TOKEN', val);
    }

    get userId() {
        return CONFIG.credentials.userId;
    }
    set userId(val: string) {
        settingsService.set('QOBUZ_USER_ID', val);
    }

    constructor() {
        this.baseUrl = CONFIG.api.baseUrl;

        this.client = createAxiosInstance({
            baseURL: this.baseUrl,
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        // Credentials are read per request so account switches apply immediately.
        this.client.interceptors.request.use((config) => {
            config.headers['X-App-Id'] = this.appId;
            const token = this.token;
            if (token) {
                config.headers['X-User-Auth-Token'] = token;
            }
            return config;
        });

        this.setupInterceptors();
    }

    setupInterceptors() {
        this.client.interceptors.response.use(
            (response) => response,
            async (error) => {
                // Only a 401 means the token is bad. A 403 is a permission problem
                // (region, subscription, someone else's playlist) and must not log
                // the user out.
                if (error?.response?.status === 401) {
                    tokenManager.markInvalid();
                }
                return Promise.reject(error);
            }
        );
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async waitForRequestSlot(): Promise<void> {
        const scheduled = this.requestSchedule.then(async () => {
            const now = Date.now();
            const waitUntil = Math.max(this.nextRequestAt, this.rateLimitUntil);
            const delay = Math.max(0, waitUntil - now);
            if (delay > 0) {
                logger.debug(`Qobuz API rate limit wait: ${delay}ms`, 'API');
                await this.sleep(delay);
            }
            this.nextRequestAt = Date.now() + this.minRequestIntervalMs;
        });

        this.requestSchedule = scheduled.catch(() => undefined);
        await scheduled;
    }

    private parseRetryAfterMs(error: AxiosError): number | null {
        const headers = error?.response?.headers as Record<string, unknown> | undefined;
        const rawValue = headers?.['retry-after'] ?? headers?.['Retry-After'];
        const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;

        if (typeof value !== 'string' && typeof value !== 'number') return null;

        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
            return Math.max(0, seconds * 1000);
        }

        const retryDate = Date.parse(String(value));
        if (Number.isNaN(retryDate)) return null;

        return Math.max(0, retryDate - Date.now());
    }

    private getBackoffDelayMs(error: AxiosError, attempt: number): number {
        const retryAfterMs = this.parseRetryAfterMs(error);
        if (error.response?.status === 429 && retryAfterMs !== null) {
            if (retryAfterMs > this.maxBackoffMs) {
                logger.warn(
                    `Qobuz asked for a ${Math.round(retryAfterMs / 1000)}s pause; capping at ${Math.round(this.maxBackoffMs / 1000)}s`,
                    'API'
                );
            }
            // Uncapped, a single hostile or mistaken Retry-After stalls every
            // Qobuz call for the lifetime of the process.
            return Math.min(retryAfterMs, this.maxBackoffMs);
        }

        const baseDelay = Math.max(250, CONFIG.download.retryDelay ?? 1000);
        const exponentialDelay = baseDelay * 2 ** attempt;
        const jitter = Math.floor(Math.random() * Math.min(1000, baseDelay));
        return Math.min(exponentialDelay + jitter, this.maxBackoffMs);
    }

    private shouldRetryRequest(error: AxiosError, policy: RetryPolicy = 'idempotent'): boolean {
        const status = error?.response?.status;
        if (policy === 'rate-limit-only') {
            return status === 429;
        }
        return !status || status === 429 || status >= 500;
    }

    /** HTTP 200 bodies of the form `{"status":"error","code":...,"message":...}` are failures. */
    private assertNotErrorBody(data: unknown): void {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        const body = data as { status?: unknown; code?: unknown; message?: unknown };
        if (body.status !== 'error') return;

        const code =
            typeof body.code === 'number' ? body.code : Number.parseInt(String(body.code ?? ''), 10);
        const statusCode = Number.isInteger(code) && code >= 400 && code < 600 ? code : null;
        const message =
            typeof body.message === 'string' && body.message.trim()
                ? body.message
                : 'Qobuz API returned an error';
        if (statusCode === 401) {
            tokenManager.markInvalid();
        }
        throw createApiError(statusCode, message);
    }

    /**
     * Single transport for every Qobuz call: shared FIFO rate limiter, retry
     * policy, form-encoded POST bodies and `{"status":"error"}` detection.
     * Throws the raw axios error (callers map it with handleApiError) or a
     * QobuzError for error bodies.
     */
    private async request<T = unknown>(
        method: HttpMethod,
        endpoint: string,
        payload: QobuzRequestPayload = {},
        options: QobuzRequestOptions = {}
    ): Promise<AxiosResponse<T>> {
        const policy = options.retry ?? 'idempotent';
        const maxRetries = Math.max(0, CONFIG.download.retryAttempts ?? 3);

        const config: AxiosRequestConfig = { method, url: endpoint };
        if (payload.params) {
            config.params = payload.params;
        }
        if (payload.form) {
            config.data = toFormBody(payload.form);
            config.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            await this.waitForRequestSlot();

            let response: AxiosResponse<T>;
            try {
                response = await this.client.request<T>(config);
            } catch (error) {
                const axiosError = error as AxiosError;
                if (!this.shouldRetryRequest(axiosError, policy) || attempt >= maxRetries) {
                    throw error;
                }

                const delay = this.getBackoffDelayMs(axiosError, attempt);
                if (axiosError.response?.status === 429) {
                    this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + delay);
                    logger.warn(
                        `Qobuz API rate limited; retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
                        'API'
                    );
                } else {
                    logger.warn(
                        `Qobuz API request failed; retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
                        'API'
                    );
                }

                await this.sleep(delay);
                continue;
            }

            this.assertNotErrorBody(response.data);
            return response;
        }

        throw new APIError('Qobuz API retry loop exhausted');
    }

    /** GET with the idempotent retry policy (kept for the existing read methods). */
    private getWithRateLimit<T = unknown>(
        endpoint: string,
        config: AxiosRequestConfig
    ): Promise<AxiosResponse<T>> {
        return this.request<T>(
            'GET',
            endpoint,
            config.params ? { params: config.params as Record<string, unknown> } : {}
        );
    }

    /** Auth for GET reads: same proven query-param style as the existing methods. */
    private authParams(): { app_id: string; user_auth_token: string } {
        return { app_id: this.appId, user_auth_token: this.token };
    }

    /** POST writes put credentials in the form body, never in the URL. */
    private post<T = unknown>(
        endpoint: string,
        fields: Record<string, FormValue>,
        retry: RetryPolicy
    ): Promise<AxiosResponse<T>> {
        return this.request<T>(
            'POST',
            endpoint,
            { form: { ...fields, app_id: this.appId, user_auth_token: this.token } },
            { retry }
        );
    }

    private requireUserToken(): void {
        if (!this.token) {
            throw new AuthenticationError(
                'No Qobuz account is logged in. Add your Qobuz credentials in Settings first.'
            );
        }
    }

    /** Cache scope of the current user: the user id, or a hash of the token. */
    private userCacheScope(): string {
        const userId = String(this.userId ?? '').trim();
        if (userId) return userId;
        const tokenHash = crypto
            .createHash('sha256')
            .update(this.token || '')
            .digest('hex')
            .slice(0, 16);
        return `t${tokenHash}`;
    }

    private userCacheKey(...parts: Array<string | number>): string {
        return `${USER_CACHE_PREFIX}${this.userCacheScope()}:${parts.join(':')}`;
    }

    private invalidateUserCache(section: 'fav' | 'playlists' | 'purchases'): void {
        cacheService.deleteByPrefix(`${USER_CACHE_PREFIX}${this.userCacheScope()}:${section}:`);
    }

    private readCache<T>(key: string): T | null {
        const cached = cacheService.get(key);
        return cached === null || cached === undefined ? null : (cached as T);
    }

    generateSignature(endpoint: string, params: Record<string, string | number | boolean>) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const secret = CONFIG.credentials.appSecret;

        // Remove slashes but KEEP case for signature base
        let data = endpoint.replace(/\//g, '');

        // Sort parameters alphabetically
        const sortedKeys = Object.keys(params).sort();
        for (const key of sortedKeys) {
            const val = params[key];
            if (val !== undefined && val !== null) {
                data += key + val.toString();
            }
        }

        data += timestamp + secret;

        logger.debug(`[QobuzAPI] Signature Data: ${data.replace(secret, 'REDACTED')}`, 'API');

        const signature = crypto.createHash('md5').update(data).digest('hex');

        return { timestamp: parseInt(timestamp), signature };
    }

    async getTrack(trackId: string | number): Promise<ApiResponse<Track>> {
        const cacheKey = `track:${trackId}`;
        const cached = this.readCache<Track>(cacheKey);
        if (cached) return { success: true, data: cached };

        try {
            const response = await this.getWithRateLimit<Track>('/track/get', {
                params: {
                    track_id: trackId,
                    app_id: this.appId,
                    user_auth_token: this.token,
                    extra: 'track_url,lyrics'
                }
            });
            cacheService.set(cacheKey, response.data, 3600);
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async getAlbum(albumId: string | number): Promise<ApiResponse<Album>> {
        const cacheKey = `album:${albumId}`;
        const cached = this.readCache<Album>(cacheKey);
        if (cached) return { success: true, data: cached };

        try {
            const response = await this.getWithRateLimit<Album>('/album/get', {
                params: {
                    album_id: albumId,
                    app_id: this.appId,
                    user_auth_token: this.token,
                    extra: 'albumsFromSameArtist,focus'
                }
            });
            cacheService.set(cacheKey, response.data, 3600);
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async getArtist(
        artistId: string | number,
        albumOffset = 0,
        albumLimit = 20,
        trackOffset = 0,
        trackLimit = 25
    ): Promise<ApiResponse<ArtistDetails>> {
        const cacheKey = `artist:${artistId}:${albumOffset}:${albumLimit}:${trackOffset}:${trackLimit}`;
        const cached = this.readCache<ArtistDetails>(cacheKey);
        if (cached) return { success: true, data: cached };

        try {
            const response = await this.getWithRateLimit<ArtistDetails>('/artist/get', {
                params: {
                    artist_id: artistId,
                    app_id: this.appId,
                    user_auth_token: this.token,
                    extra: 'albums,tracks,focus',
                    album_offset: albumOffset,
                    album_limit: albumLimit,
                    track_offset: trackOffset,
                    track_limit: trackLimit,
                    offset: albumOffset,
                    limit: albumLimit
                }
            });

            if (response.data?.albums) {
                logger.debug(
                    `[QobuzAPI] Artist Album Response - Requested Offset: ${albumOffset} | Returned: ${response.data.albums.offset} | Count: ${response.data.albums.items?.length}`
                );
            }

            cacheService.set(cacheKey, response.data, 1800);
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async getArtistAlbums(
        artistId: string | number,
        limit = 20,
        offset = 0
    ): Promise<ApiResponse<ArtistDetails>> {
        try {
            const response = await this.getWithRateLimit<ArtistDetails>('/artist/get', {
                params: {
                    artist_id: artistId,
                    app_id: this.appId,
                    user_auth_token: this.token,
                    extra: 'albums',
                    album_limit: limit,
                    album_offset: offset,
                    offset: offset,
                    limit: limit
                }
            });
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async getPlaylist(playlistId: string | number): Promise<ApiResponse<Playlist>> {
        try {
            const params = {
                playlist_id: playlistId,
                app_id: this.appId,
                user_auth_token: this.token,
                extra: 'tracks,subscribers',
                limit: 100
            };
            const response = await this.getWithRateLimit<Playlist>('/playlist/get', {
                params: { ...params, offset: 0 }
            });
            const playlist = response.data;
            const tracks = [...playlist.tracks.items];
            let offset = tracks.length;

            while (tracks.length < playlist.tracks.total) {
                const nextPage = await this.getWithRateLimit<Playlist>('/playlist/get', {
                    params: { ...params, offset }
                });
                const pageItems = nextPage.data?.tracks?.items ?? [];
                if (pageItems.length === 0) {
                    return { success: false, error: 'API Error' };
                }

                tracks.push(...pageItems);
                offset += pageItems.length;
            }

            playlist.tracks.items = tracks;
            return { success: true, data: playlist };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async getGenres(): Promise<ApiResponse> {
        try {
            const response = await this.getWithRateLimit('/genre/list', {
                params: {
                    app_id: this.appId,
                    user_auth_token: this.token
                }
            });
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * Catalog search. `type` accepts albums|tracks|artists|playlists (singular
     * aliases are mapped); `limit` is clamped to 1..500 and `offset` to >= 0.
     */
    async search(
        query: string,
        type: SearchType | string = 'albums',
        limit = 20,
        offset = 0
    ): Promise<ApiResponse<SearchResults>> {
        try {
            const normalizedType = oneOf<SearchType>(
                SEARCH_TYPE_ALIASES[String(type).toLowerCase()] ?? String(type).toLowerCase(),
                QOBUZ_SEARCH_TYPES,
                'search type'
            );
            const response = await this.getWithRateLimit<SearchResults>('/catalog/search', {
                params: {
                    query: query,
                    type: normalizedType,
                    limit: clampLimit(limit, 20),
                    offset: clampOffset(offset),
                    app_id: this.appId,
                    user_auth_token: this.token
                }
            });
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * A 401 or a bad signature/app id (400) will fail the same way for every
     * format: running the 27→7→6→5→1 fallback chain would only cost five more
     * rate-limited requests.
     */
    private isUnrecoverableFileUrlError(error: unknown): boolean {
        if (error instanceof AuthenticationError) return true;
        const status =
            error instanceof APIError
                ? error.statusCode
                : (error as AxiosError | undefined)?.response?.status;
        if (status === 401) return true;
        if (status === 400) {
            const data = (error as AxiosError | undefined)?.response?.data as
                | Record<string, unknown>
                | undefined;
            const raw = data?.message ?? data?.error ?? (error as Error | undefined)?.message ?? '';
            return /signature|request_sig|app_id/i.test(String(raw));
        }
        return false;
    }

    async getFileUrl(
        trackId: string | number,
        formatId: number | string = 27
    ): Promise<ApiResponse> {
        try {
            const requestedFormatId = normalizeDownloadQuality(formatId, 27);
            const sigParams: Record<string, string | number | boolean> = {
                track_id: trackId,
                format_id: requestedFormatId,
                intent: 'stream'
            };
            const { timestamp, signature } = this.generateSignature('track/getFileUrl', sigParams);

            const response = await this.getWithRateLimit<FileUrlData>('/track/getFileUrl', {
                params: {
                    track_id: trackId,
                    format_id: requestedFormatId,
                    intent: 'stream',
                    request_ts: timestamp,
                    request_sig: signature,
                    app_id: this.appId,
                    user_auth_token: this.token
                }
            });

            if (response.data) {
                const rawFormatId = Number(response.data.format_id || 0);

                if (rawFormatId === 1) {
                    // Distinguish between a GENUINE preview (sample flag or <=30s duration)
                    // and a false positive where the API returns format_id=1 but the track
                    // is actually a full-length 24-bit track carrying bit_depth/sampling_rate.
                    const isPreview =
                        response.data.sample === true ||
                        (typeof response.data.duration === 'number' &&
                            response.data.duration <= 30);

                    if (isPreview) {
                        logger.warn(`Track ${trackId} returned format 1 (preview/sample)`, 'API');
                        const debugInfo = {
                            duration: response.data.duration,
                            sample: response.data.sample,
                            restrictions: response.data.restrictions,
                            format_id: 1
                        };
                        logger.debug(
                            `Sample Details: ${JSON.stringify(debugInfo, null, 2)}`,
                            'API'
                        );
                        response.data.quality_verified = false;
                        return { success: true, data: response.data };
                    }

                    // Not a preview — fall through to quality detection which will
                    // overwrite format_id based on bit_depth/sampling_rate/mime_type,
                    // allowing full-length tracks served at format_id=1 to download.
                    logger.debug(
                        `Track ${trackId} returned format_id=1 but is not a preview ` +
                            `(sample=${response.data.sample}, duration=${response.data.duration}) — ` +
                            'falling through to quality detection',
                        'API'
                    );
                }

                let detectedFormat = rawFormatId > 0 ? rawFormatId : requestedFormatId;
                let qualityVerified = rawFormatId > 0;
                const { bit_depth, sampling_rate, mime_type } = response.data;

                if (mime_type === 'audio/mpeg' || mime_type === 'audio/mp3') {
                    detectedFormat = 5;
                    qualityVerified = true;
                } else if (bit_depth === 16) {
                    detectedFormat = 6;
                    qualityVerified = true;
                } else if (bit_depth === 24) {
                    if ((sampling_rate || 0) >= 176.4) {
                        detectedFormat = 27;
                    } else {
                        detectedFormat = 7;
                    }
                    qualityVerified = true;
                } else if (!rawFormatId) {
                    logger.warn(
                        `Track ${trackId} did not return quality metadata for requested format ${requestedFormatId}`,
                        'API'
                    );
                }

                response.data.format_id = detectedFormat;
                response.data.quality_verified = qualityVerified;

                if (isSampleStream(response.data)) {
                    logger.warn(`Track ${trackId} returned as a SAMPLE/PREVIEW (30s limit)`, 'API');

                    const debugInfo = {
                        duration: response.data.duration,
                        sample: response.data.sample,
                        restrictions: response.data.restrictions,
                        format_id: response.data.format_id
                    };

                    logger.debug(`Sample Details: ${JSON.stringify(debugInfo, null, 2)}`, 'API');
                }
            }

            return { success: true, data: response.data };
        } catch (error) {
            if (this.isUnrecoverableFileUrlError(error)) {
                this.handleApiError(error);
            }

            const requestedFormatId = normalizeDownloadQuality(formatId, 27);

            if (requestedFormatId === 27) {
                return await this.getFileUrl(trackId, 7);
            } else if (requestedFormatId === 7) {
                return await this.getFileUrl(trackId, 6);
            } else if (requestedFormatId === 6) {
                return await this.getFileUrl(trackId, 5);
            } else if (requestedFormatId === 5) {
                // Last resort: format 1 is often used for 30s preview
                return await this.getFileUrl(trackId, 1);
            }
            this.handleApiError(error);
        }
    }

    async getUserInfo(): Promise<ApiResponse<UserInfo>> {
        if (!this.appId) {
            return { success: false, error: 'App ID is not configured' };
        }
        try {
            const response = await this.getWithRateLimit<UserInfo>('/user/get', {
                params: {
                    user_id: this.userId,
                    app_id: this.appId,
                    user_auth_token: this.token
                }
            });
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async getLyrics(trackId: string | number): Promise<ApiResponse<LyricsResult>> {
        try {
            const trackInfo = await this.getTrack(trackId);
            if (trackInfo.success && trackInfo.data && trackInfo.data.lyrics) {
                return {
                    success: true,
                    data: {
                        success: true,
                        synced: trackInfo.data.lyrics.sync || null,
                        unsynced: trackInfo.data.lyrics.text || null,
                        copyright: trackInfo.data.lyrics.copyright || null,
                        writer: trackInfo.data.lyrics.writer || null
                    }
                };
            }
            return { success: false, error: 'No lyrics available' };
        } catch (error) {
            // getTrack already mapped the error: rethrow it unchanged.
            this.handleApiError(error);
        }
    }

    async getGoodies(albumId: string | number): Promise<ApiResponse> {
        try {
            const albumInfo = await this.getAlbum(albumId);
            if (albumInfo.success && albumInfo.data && albumInfo.data.goodies) {
                return { success: true, data: albumInfo.data.goodies };
            }
            return { success: false, error: 'No goodies available' };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    // ------------------------------------------------------------------
    // User library: favorites
    // ------------------------------------------------------------------

    /** One page of the user's favorites (unsigned). Cached per user for 120s. */
    async getUserFavorites(
        type: FavoriteType,
        limit = 50,
        offset = 0
    ): Promise<ApiResponse<UserFavorites>> {
        try {
            const favoriteType = oneOf<FavoriteType>(type, QOBUZ_FAVORITE_TYPES, 'favorite type');
            this.requireUserToken();
            const pageLimit = clampLimit(limit, 50);
            const pageOffset = clampOffset(offset);
            const cacheKey = this.userCacheKey('fav', 'list', favoriteType, pageOffset, pageLimit);
            const cached = this.readCache<UserFavorites>(cacheKey);
            if (cached) return { success: true, data: cached };

            const response = await this.request<UserFavorites>('GET', '/favorite/getUserFavorites', {
                params: {
                    type: favoriteType,
                    limit: pageLimit,
                    offset: pageOffset,
                    ...this.authParams()
                }
            });
            const raw: UserFavorites = response.data ?? {};
            const data: UserFavorites = { ...raw };
            if (favoriteType === 'albums') {
                data.albums = normalizePaginated<Album>(raw.albums, pageOffset, pageLimit);
            } else if (favoriteType === 'tracks') {
                data.tracks = normalizePaginated<Track>(raw.tracks, pageOffset, pageLimit);
            } else {
                data.artists = normalizePaginated<Artist>(raw.artists, pageOffset, pageLimit);
            }
            cacheService.set(cacheKey, data, USER_LIST_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * All favorite ids of the user (album ids as strings, others as numbers).
     * Pages through `favorite/getUserFavoriteIds` when a list hits the page size.
     * Cached per user for 60s.
     */
    async getUserFavoriteIds(): Promise<ApiResponse<FavoriteIds>> {
        try {
            this.requireUserToken();
            const cacheKey = this.userCacheKey('fav', 'ids');
            const cached = this.readCache<FavoriteIds>(cacheKey);
            if (cached) return { success: true, data: cached };

            const albums = new Set<string>();
            const tracks = new Set<number>();
            const artists = new Set<number>();
            const labels = new Set<number>();
            const sizeOf = () => albums.size + tracks.size + artists.size + labels.size;

            for (let page = 0; page < FAVORITE_IDS_MAX_PAGES; page++) {
                const response = await this.request<Record<string, unknown>>(
                    'GET',
                    '/favorite/getUserFavoriteIds',
                    {
                        params: {
                            limit: FAVORITE_IDS_PAGE_SIZE,
                            offset: page * FAVORITE_IDS_PAGE_SIZE,
                            ...this.authParams()
                        }
                    }
                );
                const data = response.data ?? {};
                const before = sizeOf();
                toStringArray(data.albums).forEach((id) => albums.add(id));
                toNumberArray(data.tracks).forEach((id) => tracks.add(id));
                toNumberArray(data.artists).forEach((id) => artists.add(id));
                toNumberArray(data.labels).forEach((id) => labels.add(id));

                const pageFull = ['albums', 'tracks', 'artists', 'labels'].some(
                    (key) => Array.isArray(data[key]) && (data[key] as unknown[]).length >= FAVORITE_IDS_PAGE_SIZE
                );
                // Stop when no list is full, or the server ignored the offset.
                if (!pageFull || sizeOf() === before) break;
            }

            const result: FavoriteIds = {
                albums: [...albums],
                tracks: [...tracks],
                artists: [...artists],
                labels: [...labels]
            };
            cacheService.set(cacheKey, result, FAVORITE_IDS_TTL_SECONDS);
            return { success: true, data: result };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    private buildFavoriteForm(ids: FavoriteIdsInput): Record<string, string> {
        const albumIds = normalizeIdList(ids.albumIds, (v) => normalizeAlbumId(v));
        const trackIds = normalizeIdList(ids.trackIds, (v) => normalizeNumericId(v, 'track id'));
        const artistIds = normalizeIdList(ids.artistIds, (v) => normalizeNumericId(v, 'artist id'));
        if (albumIds.length + trackIds.length + artistIds.length === 0) {
            throw new ValidationError('At least one album, track or artist id is required');
        }
        const form: Record<string, string> = {};
        if (albumIds.length) form.album_ids = albumIds.join(',');
        if (trackIds.length) form.track_ids = trackIds.join(',');
        if (artistIds.length) form.artist_ids = artistIds.join(',');
        return form;
    }

    /** favorite/create (idempotent). Callers should chunk to <= 100 ids. */
    async addFavorites(ids: FavoriteIdsInput): Promise<ApiResponse<StatusResponse>> {
        try {
            const form = this.buildFavoriteForm(ids);
            this.requireUserToken();
            const response = await this.post<StatusResponse>('/favorite/create', form, 'idempotent');
            this.invalidateUserCache('fav');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** favorite/delete (idempotent). Callers should chunk to <= 100 ids. */
    async removeFavorites(ids: FavoriteIdsInput): Promise<ApiResponse<StatusResponse>> {
        try {
            const form = this.buildFavoriteForm(ids);
            this.requireUserToken();
            const response = await this.post<StatusResponse>('/favorite/delete', form, 'idempotent');
            this.invalidateUserCache('fav');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    // ------------------------------------------------------------------
    // User library: playlists
    // ------------------------------------------------------------------

    /** The user's own and/or followed playlists. Cached per user for 120s. */
    async getUserPlaylists(options: UserPlaylistsOptions = {}): Promise<ApiResponse<UserPlaylists>> {
        try {
            const filter = oneOf<PlaylistFilter>(
                options.filter ?? 'owner,subscriber',
                QOBUZ_PLAYLIST_FILTERS,
                'playlist filter'
            );
            this.requireUserToken();
            const pageLimit = clampLimit(options.limit, 50);
            const pageOffset = clampOffset(options.offset);
            const cacheKey = this.userCacheKey('playlists', 'list', filter, pageOffset, pageLimit);
            const cached = this.readCache<UserPlaylists>(cacheKey);
            if (cached) return { success: true, data: cached };

            const response = await this.request<UserPlaylists>('GET', '/playlist/getUserPlaylists', {
                params: {
                    filter,
                    limit: pageLimit,
                    offset: pageOffset,
                    ...this.authParams()
                }
            });
            const data: UserPlaylists = {
                ...(response.data ?? {}),
                playlists: normalizePaginated<PlaylistListItem>(
                    response.data?.playlists,
                    pageOffset,
                    pageLimit
                )
            };
            cacheService.set(cacheKey, data, USER_LIST_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * One page of a playlist with its track entries (each keeps
     * `playlist_track_id`, needed to remove entries). Not cached and never
     * fetches more than the requested page.
     */
    async getPlaylistPage(
        playlistId: string | number,
        limit = 50,
        offset = 0
    ): Promise<ApiResponse<PlaylistPage>> {
        try {
            const id = normalizeNumericId(playlistId, 'playlist id');
            const pageLimit = clampLimit(limit, 50);
            const pageOffset = clampOffset(offset);
            const response = await this.request<PlaylistPage>('GET', '/playlist/get', {
                params: {
                    playlist_id: id,
                    extra: 'tracks',
                    limit: pageLimit,
                    offset: pageOffset,
                    ...this.authParams()
                }
            });
            const raw = (response.data ?? {}) as PlaylistPage;
            const tracks = normalizePaginated<PlaylistPage['tracks']['items'][number]>(
                raw.tracks,
                pageOffset,
                pageLimit
            );
            if (!raw.tracks || typeof raw.tracks.total !== 'number') {
                tracks.total =
                    typeof raw.tracks_count === 'number'
                        ? raw.tracks_count
                        : pageOffset + tracks.items.length;
            }
            return { success: true, data: { ...raw, tracks } };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** playlist/create. Not retried after a timeout (it could create a duplicate). */
    async createPlaylist(params: CreatePlaylistParams): Promise<ApiResponse<PlaylistListItem>> {
        try {
            const name = typeof params.name === 'string' ? params.name.trim() : '';
            if (!name) throw new ValidationError('Playlist name is required');
            const isPublic = params.isPublic === true;
            const trackIds = normalizeIdList(params.trackIds, (v) => normalizeNumericId(v, 'track id'));
            const albumId = params.albumId !== undefined ? normalizeAlbumId(params.albumId) : undefined;
            this.requireUserToken();

            const response = await this.post<PlaylistListItem>(
                '/playlist/create',
                {
                    name,
                    description: params.description ?? '',
                    is_public: isPublic,
                    is_collaborative: isPublic && params.isCollaborative === true,
                    track_ids: trackIds.length ? trackIds.join(',') : undefined,
                    album_id: albumId
                },
                'rate-limit-only'
            );
            this.invalidateUserCache('playlists');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * playlist/update with only the given fields. Never sends `track_ids`
     * (that would replace every track). Retried only on 429.
     */
    async updatePlaylist(
        playlistId: string | number,
        patch: UpdatePlaylistParams
    ): Promise<ApiResponse<PlaylistListItem>> {
        try {
            const id = normalizeNumericId(playlistId, 'playlist id');
            const form: Record<string, FormValue> = { playlist_id: id };
            if (patch.name !== undefined) {
                const name = String(patch.name).trim();
                if (!name) throw new ValidationError('Playlist name cannot be empty');
                form.name = name;
            }
            if (patch.description !== undefined) form.description = String(patch.description);
            if (patch.isPublic !== undefined) form.is_public = patch.isPublic === true;
            if (patch.isCollaborative !== undefined) {
                form.is_collaborative = patch.isCollaborative === true && patch.isPublic !== false;
            } else if (patch.isPublic === false) {
                form.is_collaborative = false;
            }
            if (Object.keys(form).length === 1) {
                throw new ValidationError('Nothing to update');
            }
            this.requireUserToken();

            const response = await this.post<PlaylistListItem>('/playlist/update', form, 'rate-limit-only');
            this.invalidateUserCache('playlists');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async deletePlaylist(playlistId: string | number): Promise<ApiResponse<StatusResponse>> {
        try {
            const id = normalizeNumericId(playlistId, 'playlist id');
            this.requireUserToken();
            const response = await this.post<StatusResponse>(
                '/playlist/delete',
                { playlist_id: id },
                'idempotent'
            );
            this.invalidateUserCache('playlists');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * playlist/addTracks. With `noDuplicate` (default) the call is idempotent and
     * retried normally; with duplicates allowed it is retried only on 429.
     * Callers should chunk to <= 50 ids.
     */
    async addTracksToPlaylist(
        playlistId: string | number,
        trackIds: ReadonlyArray<string | number>,
        noDuplicate = true
    ): Promise<ApiResponse<PlaylistListItem>> {
        try {
            const id = normalizeNumericId(playlistId, 'playlist id');
            const ids = noDuplicate
                ? normalizeIdList(trackIds, (v) => normalizeNumericId(v, 'track id'))
                : (Array.isArray(trackIds) ? trackIds : []).map((v) => normalizeNumericId(v, 'track id'));
            if (ids.length === 0) throw new ValidationError('At least one track id is required');
            this.requireUserToken();

            const response = await this.post<PlaylistListItem>(
                '/playlist/addTracks',
                { playlist_id: id, track_ids: ids.join(','), no_duplicate: noDuplicate },
                noDuplicate ? 'idempotent' : 'rate-limit-only'
            );
            this.invalidateUserCache('playlists');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** playlist/deleteTracks: takes playlist entry ids (`playlist_track_id`), not track ids. */
    async removeTracksFromPlaylist(
        playlistId: string | number,
        playlistTrackIds: ReadonlyArray<string | number>
    ): Promise<ApiResponse<PlaylistListItem>> {
        try {
            const id = normalizeNumericId(playlistId, 'playlist id');
            const entryIds = normalizeIdList(playlistTrackIds, (v) =>
                normalizeNumericId(v, 'playlist track id')
            );
            if (entryIds.length === 0) {
                throw new ValidationError('At least one playlist track id is required');
            }
            this.requireUserToken();

            const response = await this.post<PlaylistListItem>(
                '/playlist/deleteTracks',
                { playlist_id: id, playlist_track_ids: entryIds.join(',') },
                'idempotent'
            );
            this.invalidateUserCache('playlists');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    async subscribePlaylist(playlistId: string | number): Promise<ApiResponse<StatusResponse>> {
        return this.playlistSubscription('/playlist/subscribe', playlistId);
    }

    async unsubscribePlaylist(playlistId: string | number): Promise<ApiResponse<StatusResponse>> {
        return this.playlistSubscription('/playlist/unsubscribe', playlistId);
    }

    private async playlistSubscription(
        endpoint: '/playlist/subscribe' | '/playlist/unsubscribe',
        playlistId: string | number
    ): Promise<ApiResponse<StatusResponse>> {
        try {
            const id = normalizeNumericId(playlistId, 'playlist id');
            this.requireUserToken();
            const response = await this.post<StatusResponse>(endpoint, { playlist_id: id }, 'idempotent');
            this.invalidateUserCache('playlists');
            return { success: true, data: response.data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    // ------------------------------------------------------------------
    // User library: purchases
    // ------------------------------------------------------------------

    /** Purchased albums/tracks (both when `type` is omitted). Cached per user for 120s. */
    async getUserPurchases(
        type?: PurchaseType,
        limit = 50,
        offset = 0
    ): Promise<ApiResponse<Purchases>> {
        try {
            const purchaseType =
                type === undefined ? undefined : oneOf<PurchaseType>(type, QOBUZ_PURCHASE_TYPES, 'purchase type');
            this.requireUserToken();
            const pageLimit = clampLimit(limit, 50);
            const pageOffset = clampOffset(offset);
            const cacheKey = this.userCacheKey(
                'purchases',
                'list',
                purchaseType ?? 'all',
                pageOffset,
                pageLimit
            );
            const cached = this.readCache<Purchases>(cacheKey);
            if (cached) return { success: true, data: cached };

            const params: Record<string, unknown> = {
                limit: pageLimit,
                offset: pageOffset,
                ...this.authParams()
            };
            if (purchaseType) params.type = purchaseType;
            const response = await this.request<Purchases>('GET', '/purchase/getUserPurchases', {
                params
            });
            const raw: Purchases = response.data ?? {};
            const data: Purchases = { ...raw };
            if (raw.albums !== undefined || purchaseType === 'albums') {
                data.albums = normalizePaginated<PurchasedAlbum>(raw.albums, pageOffset, pageLimit);
            }
            if (raw.tracks !== undefined || purchaseType === 'tracks') {
                data.tracks = normalizePaginated<PurchasedTrack>(raw.tracks, pageOffset, pageLimit);
            }
            cacheService.set(cacheKey, data, USER_LIST_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** All purchased album/track ids (not paginated by Qobuz). Cached per user for 120s. */
    async getUserPurchaseIds(): Promise<ApiResponse<PurchaseIds>> {
        try {
            this.requireUserToken();
            const cacheKey = this.userCacheKey('purchases', 'ids');
            const cached = this.readCache<PurchaseIds>(cacheKey);
            if (cached) return { success: true, data: cached };

            const response = await this.request<PurchaseIds>('GET', '/purchase/getUserPurchasesIds', {
                params: this.authParams()
            });
            const raw = (response.data ?? {}) as Partial<PurchaseIds>;
            const data: PurchaseIds = {
                ...raw,
                albums: {
                    total: raw.albums?.total ?? raw.albums?.items?.length ?? 0,
                    items: Array.isArray(raw.albums?.items) ? raw.albums.items : []
                },
                tracks: {
                    total: raw.tracks?.total ?? raw.tracks?.items?.length ?? 0,
                    items: Array.isArray(raw.tracks?.items) ? raw.tracks.items : []
                }
            };
            cacheService.set(cacheKey, data, USER_LIST_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    // ------------------------------------------------------------------
    // Discovery
    // ------------------------------------------------------------------

    /** album/getFeatured. Cached for 15 min (per account: content depends on the store). */
    async getFeaturedAlbums(
        type: FeaturedAlbumType,
        options: FeaturedOptions = {}
    ): Promise<ApiResponse<FeaturedAlbums>> {
        try {
            const featuredType = oneOf<FeaturedAlbumType>(type, QOBUZ_FEATURED_ALBUM_TYPES, 'featured album type');
            const genreId =
                options.genreId === undefined || options.genreId === ''
                    ? undefined
                    : normalizeNumericId(options.genreId, 'genre id');
            const pageLimit = clampLimit(options.limit, 25);
            const pageOffset = clampOffset(options.offset);
            const cacheKey = this.userCacheKey(
                'featured',
                'albums',
                featuredType,
                genreId ?? 'all',
                pageOffset,
                pageLimit
            );
            const cached = this.readCache<FeaturedAlbums>(cacheKey);
            if (cached) return { success: true, data: cached };

            const params: Record<string, unknown> = {
                type: featuredType,
                limit: pageLimit,
                offset: pageOffset,
                ...this.authParams()
            };
            if (genreId) params.genre_id = genreId;
            const response = await this.request<FeaturedAlbums>('GET', '/album/getFeatured', { params });
            const data: FeaturedAlbums = {
                ...(response.data ?? {}),
                albums: normalizePaginated<Album>(response.data?.albums, pageOffset, pageLimit)
            };
            cacheService.set(cacheKey, data, FEATURED_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** playlist/getFeatured (`genre_ids` filter). Cached for 15 min per account. */
    async getFeaturedPlaylists(
        type: FeaturedPlaylistType,
        options: FeaturedOptions = {}
    ): Promise<ApiResponse<FeaturedPlaylists>> {
        try {
            const featuredType = oneOf<FeaturedPlaylistType>(
                type,
                QOBUZ_FEATURED_PLAYLIST_TYPES,
                'featured playlist type'
            );
            const genreId =
                options.genreId === undefined || options.genreId === ''
                    ? undefined
                    : normalizeNumericId(options.genreId, 'genre id');
            const pageLimit = clampLimit(options.limit, 25);
            const pageOffset = clampOffset(options.offset);
            const cacheKey = this.userCacheKey(
                'featured',
                'playlists',
                featuredType,
                genreId ?? 'all',
                pageOffset,
                pageLimit
            );
            const cached = this.readCache<FeaturedPlaylists>(cacheKey);
            if (cached) return { success: true, data: cached };

            const params: Record<string, unknown> = {
                type: featuredType,
                limit: pageLimit,
                offset: pageOffset,
                ...this.authParams()
            };
            if (genreId) params.genre_ids = genreId;
            const response = await this.request<FeaturedPlaylists>('GET', '/playlist/getFeatured', {
                params
            });
            const data: FeaturedPlaylists = {
                ...(response.data ?? {}),
                playlists: normalizePaginated<PlaylistListItem>(
                    response.data?.playlists,
                    pageOffset,
                    pageLimit
                )
            };
            cacheService.set(cacheKey, data, FEATURED_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** label/get with one page of its albums (`extra=albums`). */
    async getLabel(labelId: string | number, limit = 25, offset = 0): Promise<ApiResponse<Label>> {
        try {
            const id = normalizeNumericId(labelId, 'label id');
            const pageLimit = clampLimit(limit, 25);
            const pageOffset = clampOffset(offset);
            const cacheKey = `label:${id}:${pageOffset}:${pageLimit}`;
            const cached = this.readCache<Label>(cacheKey);
            if (cached) return { success: true, data: cached };

            const response = await this.request<Label>('GET', '/label/get', {
                params: {
                    label_id: id,
                    extra: 'albums',
                    limit: pageLimit,
                    offset: pageOffset,
                    ...this.authParams()
                }
            });
            const raw = (response.data ?? {}) as Label;
            const albums = normalizePaginated<Album>(raw.albums, pageOffset, pageLimit);
            if (!raw.albums && typeof raw.albums_count === 'number') {
                albums.total = raw.albums_count;
            }
            const data: Label = { ...raw, albums };
            cacheService.set(cacheKey, data, CATALOG_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** artist/getSimilarArtists (limit 1..100). */
    async getSimilarArtists(
        artistId: string | number,
        limit = 25,
        offset = 0
    ): Promise<ApiResponse<SimilarArtists>> {
        try {
            const id = normalizeNumericId(artistId, 'artist id');
            const pageLimit = clampLimit(limit, 25, QOBUZ_MAX_SIMILAR_ARTISTS_LIMIT);
            const pageOffset = clampOffset(offset);
            const cacheKey = `similar-artists:${id}:${pageOffset}:${pageLimit}`;
            const cached = this.readCache<SimilarArtists>(cacheKey);
            if (cached) return { success: true, data: cached };

            const response = await this.request<SimilarArtists>('GET', '/artist/getSimilarArtists', {
                params: {
                    artist_id: id,
                    limit: pageLimit,
                    offset: pageOffset,
                    ...this.authParams()
                }
            });
            const data: SimilarArtists = {
                ...(response.data ?? {}),
                artists: normalizePaginated(response.data?.artists, pageOffset, pageLimit)
            };
            cacheService.set(cacheKey, data, CATALOG_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * artist/getReleasesList: `{has_more, items}` (no total). Defaults: all
     * release types, newest first, 50 per page (max 100).
     */
    async getArtistReleases(
        artistId: string | number,
        options: ArtistReleasesOptions = {}
    ): Promise<ApiResponse<ArtistReleases>> {
        try {
            const id = normalizeNumericId(artistId, 'artist id');
            const requestedTypes = options.releaseType === undefined
                ? ['all']
                : Array.isArray(options.releaseType)
                  ? options.releaseType
                  : [options.releaseType];
            const releaseTypes = [...new Set(requestedTypes)].map((value) =>
                oneOf<ArtistReleaseType>(value, QOBUZ_ARTIST_RELEASE_TYPES, 'release type')
            );
            if (releaseTypes.length === 0) releaseTypes.push('all');
            const sort = oneOf<ArtistReleaseSort>(
                options.sort ?? 'release_date',
                QOBUZ_ARTIST_RELEASE_SORTS,
                'sort'
            );
            const order = oneOf<SortOrder>(options.order ?? 'desc', QOBUZ_SORT_ORDERS, 'order');
            const pageLimit = clampLimit(options.limit, 50, QOBUZ_MAX_RELEASES_LIMIT);
            const pageOffset = clampOffset(options.offset);
            const trackSize =
                options.trackSize === undefined ? undefined : clampInt(options.trackSize, 0, 30, 0);
            const releaseType = releaseTypes.join(',');
            const cacheKey = `artist-releases:${id}:${releaseType}:${sort}:${order}:${pageOffset}:${pageLimit}:${trackSize ?? 'd'}`;
            const cached = this.readCache<ArtistReleases>(cacheKey);
            if (cached) return { success: true, data: cached };

            const params: Record<string, unknown> = {
                artist_id: id,
                release_type: releaseType,
                sort,
                order,
                limit: pageLimit,
                offset: pageOffset,
                ...this.authParams()
            };
            if (trackSize !== undefined) params.track_size = trackSize;
            const response = await this.request<ArtistReleases>('GET', '/artist/getReleasesList', {
                params
            });
            const raw = (response.data ?? {}) as Partial<ArtistReleases>;
            const items = Array.isArray(raw.items) ? raw.items : [];
            const data: ArtistReleases = {
                ...raw,
                items,
                has_more: typeof raw.has_more === 'boolean' ? raw.has_more : items.length >= pageLimit
            };
            cacheService.set(cacheKey, data, CATALOG_TTL_SECONDS);
            return { success: true, data };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * Track ids of an album in album order, paging `album/get` (500 per page)
     * so box sets are not truncated. Capped at 2000 tracks.
     */
    async getAlbumTrackIds(albumId: string): Promise<ApiResponse<string[]>> {
        try {
            const id = normalizeAlbumId(albumId);
            const ids: string[] = [];
            const seen = new Set<string>();
            let offset = 0;

            while (ids.length < ALBUM_TRACKS_MAX) {
                const response = await this.request<Album>('GET', '/album/get', {
                    params: {
                        album_id: id,
                        limit: ALBUM_TRACKS_PAGE_SIZE,
                        offset,
                        ...this.authParams()
                    }
                });
                const album = response.data;
                const items = Array.isArray(album?.tracks?.items) ? album.tracks.items : [];
                let added = 0;
                for (const track of items) {
                    if (track?.id === undefined || track.id === null) continue;
                    const trackId = String(track.id);
                    if (!seen.has(trackId)) {
                        seen.add(trackId);
                        ids.push(trackId);
                        added++;
                    }
                }
                const total =
                    typeof album?.tracks?.total === 'number'
                        ? album.tracks.total
                        : typeof album?.tracks_count === 'number'
                          ? album.tracks_count
                          : ids.length;
                if (items.length === 0 || added === 0 || ids.length >= total) break;
                const echoedLimit = album?.tracks?.limit;
                offset += typeof echoedLimit === 'number' && echoedLimit > 0 ? echoedLimit : items.length;
            }

            return { success: true, data: ids.slice(0, ALBUM_TRACKS_MAX) };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /** user/lastUpdate: unix timestamps of the last favorites/playlists/purchases change. */
    async getLastUpdate(): Promise<ApiResponse<LastUpdate>> {
        try {
            this.requireUserToken();
            const response = await this.request<LastUpdate>('GET', '/user/lastUpdate', {
                params: this.authParams()
            });
            const raw = (response.data ?? {}) as Partial<LastUpdate>;
            return {
                success: true,
                data: { ...raw, last_update: raw.last_update ?? {} }
            };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    /**
     * Map any failure to a QobuzError subclass and throw it. QobuzErrors pass
     * through unchanged (no double wrapping). Never serializes the axios error.
     */
    handleApiError(error: unknown): never {
        if (error instanceof QobuzError) {
            throw error;
        }

        const err = error as AxiosError | undefined;
        const statusCode = err?.response?.status ?? null;
        const data = err?.response?.data as Record<string, unknown> | undefined;
        const rawMessage = data?.message || data?.error || err?.message;
        const message = typeof rawMessage === 'string' && rawMessage ? rawMessage : 'Unknown error';
        const retryAfterMs = statusCode === 429 && err ? this.parseRetryAfterMs(err) : null;

        throw createApiError(statusCode, message, retryAfterMs);
    }

    /** @deprecated use parseQobuzUrl() from utils/validator.ts */
    parseUrl(url: string): ParsedQobuzUrl | null {
        return parseQobuzUrl(url);
    }
}

export const qobuzApi = new QobuzAPI();
export default qobuzApi;

import { z } from 'zod';
import qobuzApi from '../api/qobuz.js';
import { downloadQueue } from './queue/queue.js';
import { queueProcessor } from './queue-processor.js';
import { QueueRequestError, resolveQualityStrict, VALID_QUALITIES } from './queue/utils.js';
import {
    ACTIVE_QUEUE_STATUSES,
    DOWNLOAD_TYPES,
    DownloadType,
    QUEUE_PRIORITIES,
    QueueItem,
    QueueItemMetadata,
    QueueItemStatus,
    QueueMutationResult,
    QueuePriority,
    QueueStats
} from './queue/types.js';
import { validateEnvironment } from '../utils/env.js';
import { parseQobuzUrl } from '../utils/validator.js';
import { CONFIG } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * The single entry point the REST API and the MCP server use to start
 * downloads and control the queue. Inputs are validated here (route and tool
 * schemas only shape them), so both surfaces enforce the same rules.
 *
 * Errors are {@link QueueRequestError}s carrying an HTTP `statusCode`
 * (400 invalid input or missing credentials, 404 unknown item, 409 refused
 * state change) and a message that is safe to show.
 */

export { QueueRequestError, VALID_QUALITIES };

/** Qobuz album ids are opaque alphanumeric strings. */
export const ALBUM_ID_PATTERN = /^[A-Za-z0-9]{1,40}$/;
/** Track, artist, playlist and label ids are positive integers. */
export const NUMERIC_ID_PATTERN = /^\d{1,20}$/;

export const MAX_ENQUEUE_TRACK_IDS = 500;
export const MAX_ENQUEUE_URLS = 500;
export const QUEUE_LIST_DEFAULT_LIMIT = 25;
export const QUEUE_LIST_MAX_LIMIT = 100;

const MAX_TEXT_LENGTH = 300;
const SOURCE_PATTERN = /^[a-z0-9_-]{1,32}$/;

/* ------------------------------------------------------------------ */
/* Shared zod schemas (REST bodies, MCP tool inputs)                    */
/* ------------------------------------------------------------------ */

export const downloadTypeSchema = z.enum(DOWNLOAD_TYPES);
export const queuePrioritySchema = z.enum(QUEUE_PRIORITIES);

/** 5 = MP3 320, 6 = FLAC 16/44.1, 7 = FLAC 24/≤96, 27 = FLAC 24/≤192; aliases max/min/ask. */
export const downloadQualitySchema = z.union([
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(27),
    z.enum(['5', '6', '7', '27', 'max', 'min', 'ask', ''])
]);

/** A Qobuz id as number or string; the per-type format is checked by the service. */
export const contentIdSchema = z.union([
    z.string().trim().min(1).max(40),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
]);

export const queueStatusFilterSchema = z.enum([
    'pending',
    'downloading',
    'processing',
    'uploading',
    'completed',
    'partial',
    'failed',
    'cancelled',
    'active'
]);

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface EnqueueRequest {
    type: DownloadType;
    id: string | number;
    /** 5, 6, 7, 27 or 'max'/'min'; empty/'ask' uses the configured default. */
    quality?: number | string | null;
    priority?: QueuePriority;
    /** Album only: enqueue just these tracks of the album (one track item each). */
    trackIds?: ReadonlyArray<string | number>;
    /** Skip files that already exist on disk (default true). */
    skipExisting?: boolean;
    /** Optional display title until the processor resolves the real one. */
    title?: string;
    /** Short tag stored on the item (`dashboard`, `mcp`, ...). */
    source?: string;
}

export interface EnqueuedItem {
    queueId: string;
    type: DownloadType;
    id: string;
    title?: string;
    /** True when the content was already queued and the existing item was returned. */
    deduped: boolean;
    status: QueueItemStatus;
}

export interface EnqueueResult {
    items: EnqueuedItem[];
    /** Items newly added to the queue. */
    queued: number;
    /** Requests that matched an item that was already queued. */
    deduped: number;
}

export interface UrlEnqueueResult {
    url: string;
    ok: boolean;
    type?: DownloadType;
    id?: string;
    queueId?: string;
    title?: string;
    deduped?: boolean;
    error?: string;
}

export interface EnqueueUrlsResult {
    results: UrlEnqueueResult[];
    queued: number;
    deduped: number;
    failed: number;
}

export interface EnqueueUrlsOptions {
    priority?: QueuePriority;
    skipExisting?: boolean;
    source?: string;
}

/** A queue item without the bulky or internal parts of its metadata. */
export interface CompactQueueItem {
    id: string;
    type: DownloadType;
    contentId: string;
    title?: string;
    artist?: string;
    album?: string;
    status: QueueItemStatus;
    priority: QueuePriority;
    progress: number;
    quality: number;
    error?: string;
    filePath?: string;
    retryCount: number;
    maxRetries: number;
    addedAt?: string;
    startedAt?: string;
    completedAt?: string;
    /** 1-based place among pending items in processing order. */
    position?: number;
    awaitingRetry?: boolean;
    /** Scalar facts from the item metadata (source, parent item, fan-out counts, ...). */
    details?: Record<string, string | number | boolean>;
}

export type QueueStatusFilter = QueueItemStatus | 'active';

export interface QueueListOptions {
    status?: QueueStatusFilter;
    limit?: number;
    offset?: number;
}

export interface QueueListResult {
    items: CompactQueueItem[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
    stats: QueueStats;
    paused: boolean;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const DETAIL_KEYS = [
    'source',
    'parentQueueId',
    'albumId',
    'artistId',
    'labelId',
    'playlistId',
    'playlistTitle',
    'isUpgrade',
    'forceRedownload',
    'albumsQueued',
    'albumsDeduped',
    'albumsSkipped',
    'albumsTotal',
    'truncated'
] as const;

const capText = (value: unknown, max = MAX_TEXT_LENGTH): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
};

const toIso = (value: unknown): string | undefined => {
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
};

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (value === undefined || value === null || !Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

function summarizeMetadata(
    metadata: QueueItemMetadata | null | undefined
): Record<string, string | number | boolean> | undefined {
    if (!metadata) return undefined;
    const details: Record<string, string | number | boolean> = {};
    for (const key of DETAIL_KEYS) {
        const value = metadata[key];
        if (typeof value === 'string') {
            const text = capText(value, 200);
            if (text) details[key] = text;
        } else if (typeof value === 'number' && Number.isFinite(value)) {
            details[key] = value;
        } else if (typeof value === 'boolean') {
            details[key] = value;
        }
    }
    if (Array.isArray(metadata.batchFiles)) {
        details.fileCount = metadata.batchFiles.length;
    }
    return Object.keys(details).length > 0 ? details : undefined;
}

export function toCompactQueueItem(item: QueueItem, position?: number): CompactQueueItem {
    const compact: CompactQueueItem = {
        id: item.id,
        type: item.type,
        contentId: String(item.contentId),
        status: item.status,
        priority: item.priority,
        progress: Number.isFinite(item.progress) ? item.progress : 0,
        quality: item.quality,
        retryCount: item.retryCount ?? 0,
        maxRetries: item.maxRetries ?? 0
    };
    const title = capText(item.title);
    const artist = capText(item.artist);
    const album = capText(item.album);
    const error = capText(item.error, 500);
    if (title) compact.title = title;
    if (artist) compact.artist = artist;
    if (album) compact.album = album;
    if (error) compact.error = error;
    if (typeof item.filePath === 'string' && item.filePath) compact.filePath = item.filePath;
    const addedAt = toIso(item.addedAt);
    const startedAt = toIso(item.startedAt);
    const completedAt = toIso(item.completedAt);
    if (addedAt) compact.addedAt = addedAt;
    if (startedAt) compact.startedAt = startedAt;
    if (completedAt) compact.completedAt = completedAt;
    if (position !== undefined && position > 0) compact.position = position;
    if (item.awaitingRetry) compact.awaitingRetry = true;
    const details = summarizeMetadata(item.metadata);
    if (details) compact.details = details;
    return compact;
}

const STATUS_GROUP: Record<QueueItemStatus, number> = {
    downloading: 0,
    processing: 0,
    uploading: 0,
    pending: 1,
    failed: 2,
    cancelled: 3,
    partial: 4,
    completed: 5
};

const time = (value: unknown): number => {
    const iso = toIso(value);
    return iso ? Date.parse(iso) : 0;
};

/* ------------------------------------------------------------------ */
/* Service                                                              */
/* ------------------------------------------------------------------ */

export class DownloadActionsService {
    /** Normalizes and validates a Qobuz id for `type`; returns it as a string. */
    normalizeId(type: DownloadType, id: unknown): string {
        if (type === 'album') {
            const value = typeof id === 'string' ? id.trim() : typeof id === 'number' ? String(id) : '';
            if (!ALBUM_ID_PATTERN.test(value)) {
                throw new QueueRequestError(
                    'Invalid album id (expected 1-40 letters or digits)',
                    400,
                    'VALIDATION_ERROR'
                );
            }
            return value;
        }

        const value =
            typeof id === 'number' && Number.isSafeInteger(id)
                ? String(id)
                : typeof id === 'string'
                  ? id.trim()
                  : '';
        if (!NUMERIC_ID_PATTERN.test(value) || /^0+$/.test(value)) {
            throw new QueueRequestError(
                `Invalid ${type} id (expected a positive integer)`,
                400,
                'VALIDATION_ERROR'
            );
        }
        return value.replace(/^0+/, '');
    }

    /**
     * Resolves a requested quality: 5, 6, 7 or 27 (number or numeric string),
     * 'max' (27) or 'min' (5); missing, empty or 'ask' means the configured
     * default. Anything else is rejected instead of silently replaced.
     */
    resolveQuality(quality: unknown): number {
        return resolveQualityStrict(quality, CONFIG.quality.default);
    }

    private resolvePriority(priority: unknown): QueuePriority {
        if (priority === undefined || priority === null) return 'normal';
        const parsed = queuePrioritySchema.safeParse(priority);
        if (!parsed.success) {
            throw new QueueRequestError(
                'Invalid priority (expected low, normal or high)',
                400,
                'VALIDATION_ERROR'
            );
        }
        return parsed.data;
    }

    private resolveType(type: unknown): DownloadType {
        const parsed = downloadTypeSchema.safeParse(type);
        if (!parsed.success) {
            throw new QueueRequestError(
                `Invalid type (expected ${DOWNLOAD_TYPES.join(', ')})`,
                400,
                'VALIDATION_ERROR'
            );
        }
        return parsed.data;
    }

    private resolveSource(source: unknown): string {
        return typeof source === 'string' && SOURCE_PATTERN.test(source) ? source : 'api';
    }

    /** Throws when Qobuz credentials are missing; otherwise makes sure the processor runs. */
    ensureReady(): void {
        const { valid, missing } = validateEnvironment(false);
        if (!valid) {
            throw new QueueRequestError(
                `Missing required credentials: ${(missing ?? []).join(', ')}. Please complete setup in Settings first.`,
                400,
                'CREDENTIALS_MISSING'
            );
        }
        queueProcessor.start();
    }

    /** Starts the processor when credentials exist; never throws. */
    private wakeProcessor(): void {
        try {
            if (validateEnvironment(false).valid) queueProcessor.start();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`Could not wake queue processor: ${message}`, 'QUEUE');
        }
    }

    /**
     * Enqueues a track, album, playlist, artist or label. Artists and labels
     * become one album item per release when the processor reaches them, so
     * this returns immediately. With `trackIds` (albums only) just those
     * tracks are queued, one track item each, after checking they belong to
     * the album.
     */
    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
        const type = this.resolveType(request?.type);
        const id = this.normalizeId(type, request.id);
        const quality = this.resolveQuality(request.quality);
        const priority = this.resolvePriority(request.priority);
        const source = this.resolveSource(request.source);
        const skipExisting = request.skipExisting !== false;

        if (request.trackIds !== undefined && type !== 'album') {
            throw new QueueRequestError('trackIds can only be used with albums', 400, 'VALIDATION_ERROR');
        }
        const trackIds = request.trackIds === undefined ? undefined : this.normalizeTrackIds(request.trackIds);

        this.ensureReady();

        const baseMetadata: QueueItemMetadata = {
            source,
            ...(skipExisting ? {} : { forceRedownload: true })
        };

        if (trackIds) {
            return this.enqueueAlbumTracks(id, trackIds, quality, priority, baseMetadata);
        }

        const { item, deduped } = downloadQueue.addWithResult(type, id, quality, {
            title: capText(request.title),
            priority,
            metadata: baseMetadata
        });
        return this.summarize([{ item, deduped, id }]);
    }

    private normalizeTrackIds(trackIds: ReadonlyArray<string | number>): string[] {
        if (!Array.isArray(trackIds) || trackIds.length === 0) {
            throw new QueueRequestError('trackIds must be a non-empty array', 400, 'VALIDATION_ERROR');
        }
        if (trackIds.length > MAX_ENQUEUE_TRACK_IDS) {
            throw new QueueRequestError(
                `Too many trackIds (max ${MAX_ENQUEUE_TRACK_IDS})`,
                400,
                'VALIDATION_ERROR'
            );
        }
        const unique = new Set<string>();
        for (const trackId of trackIds) unique.add(this.normalizeId('track', trackId));
        return Array.from(unique);
    }

    private async enqueueAlbumTracks(
        albumId: string,
        trackIds: string[],
        quality: number,
        priority: QueuePriority,
        baseMetadata: QueueItemMetadata
    ): Promise<EnqueueResult> {
        const res = await qobuzApi.getAlbum(albumId);
        if (!res.success || !res.data) {
            throw new QueueRequestError('Album not found', 404, 'NOT_FOUND');
        }

        const albumTracks = res.data.tracks?.items ?? [];
        const byId = new Map(albumTracks.map((track) => [String(track.id), track]));
        const reportedTotal = res.data.tracks?.total;
        // Only reject unknown ids when Qobuz returned the whole track list.
        const listComplete =
            typeof reportedTotal !== 'number' || albumTracks.length >= reportedTotal;
        const unknown = listComplete ? trackIds.filter((trackId) => !byId.has(trackId)) : [];
        if (unknown.length > 0) {
            throw new QueueRequestError(
                `Track id(s) not on album ${albumId}: ${unknown.slice(0, 10).join(', ')}`,
                400,
                'VALIDATION_ERROR'
            );
        }

        const added = trackIds.map((trackId) => {
            const { item, deduped } = downloadQueue.addWithResult('track', trackId, quality, {
                title: capText(byId.get(trackId)?.title),
                priority,
                // Only the album id: copying the album JSON into every track
                // item bloated the persisted queue.
                metadata: { ...baseMetadata, albumId }
            });
            return { item, deduped, id: trackId };
        });
        return this.summarize(added);
    }

    private summarize(entries: Array<{ item: QueueItem; deduped: boolean; id: string }>): EnqueueResult {
        const items: EnqueuedItem[] = entries.map(({ item, deduped, id }) => {
            const summary: EnqueuedItem = {
                queueId: item.id,
                type: item.type,
                id,
                deduped,
                status: item.status
            };
            const title = capText(item.title);
            if (title) summary.title = title;
            return summary;
        });
        const deduped = items.filter((item) => item.deduped).length;
        return { items, queued: items.length - deduped, deduped };
    }

    /**
     * Enqueues Qobuz links (track, album, playlist, artist or label pages).
     * Each URL gets its own result; one bad URL does not stop the others.
     */
    async enqueueUrls(
        urls: ReadonlyArray<unknown>,
        quality?: number | string | null,
        options: EnqueueUrlsOptions = {}
    ): Promise<EnqueueUrlsResult> {
        if (!Array.isArray(urls) || urls.length === 0) {
            throw new QueueRequestError('urls must be a non-empty array', 400, 'VALIDATION_ERROR');
        }
        if (urls.length > MAX_ENQUEUE_URLS) {
            throw new QueueRequestError(`Too many URLs (max ${MAX_ENQUEUE_URLS})`, 400, 'VALIDATION_ERROR');
        }
        const resolvedQuality = this.resolveQuality(quality);
        const priority = this.resolvePriority(options.priority);
        this.ensureReady();

        const results: UrlEnqueueResult[] = [];
        for (const raw of urls) {
            const url = typeof raw === 'string' ? raw.trim().slice(0, 2048) : '';
            const parsed = url ? parseQobuzUrl(url) : null;
            if (!parsed) {
                results.push({
                    url,
                    ok: false,
                    error: /spotify\./i.test(url)
                        ? 'Spotify links are not supported here; use the Spotify import'
                        : 'Not a recognised Qobuz track, album, playlist, artist or label link'
                });
                continue;
            }

            try {
                const result = await this.enqueue({
                    type: parsed.type,
                    id: parsed.id,
                    quality: resolvedQuality,
                    priority,
                    skipExisting: options.skipExisting,
                    source: options.source ?? 'url'
                });
                const entry = result.items[0];
                results.push({
                    url,
                    ok: true,
                    type: parsed.type,
                    id: entry?.id ?? parsed.id,
                    queueId: entry?.queueId,
                    title: entry?.title,
                    deduped: entry?.deduped ?? false
                });
            } catch (error: unknown) {
                results.push({
                    url,
                    ok: false,
                    type: parsed.type,
                    id: parsed.id,
                    error:
                        error instanceof QueueRequestError
                            ? error.message
                            : 'Could not add this link to the queue'
                });
                if (!(error instanceof QueueRequestError)) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn(`Failed to enqueue ${parsed.type} ${parsed.id}: ${message}`, 'QUEUE');
                }
            }
        }

        const ok = results.filter((r) => r.ok);
        const deduped = ok.filter((r) => r.deduped).length;
        return {
            results,
            queued: ok.length - deduped,
            deduped,
            failed: results.length - ok.length
        };
    }

    /* -------------------------- queue reads -------------------------- */

    getQueue(options: QueueListOptions = {}): QueueListResult {
        const limit = clampInt(options.limit, QUEUE_LIST_DEFAULT_LIMIT, 1, QUEUE_LIST_MAX_LIMIT);
        const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const status = options.status;
        if (status !== undefined && !queueStatusFilterSchema.safeParse(status).success) {
            throw new QueueRequestError('Invalid status filter', 400, 'VALIDATION_ERROR');
        }

        const pendingOrder = this.pendingPositions();
        const all = downloadQueue.getAll().filter((item) => {
            if (status === undefined) return true;
            if (status === 'active') return ACTIVE_QUEUE_STATUSES.includes(item.status);
            return item.status === status;
        });

        all.sort((a, b) => {
            const group = (STATUS_GROUP[a.status] ?? 9) - (STATUS_GROUP[b.status] ?? 9);
            if (group !== 0) return group;
            if (a.status === 'pending' && b.status === 'pending') {
                return (pendingOrder.get(a.id) ?? 0) - (pendingOrder.get(b.id) ?? 0);
            }
            if (ACTIVE_QUEUE_STATUSES.includes(a.status)) {
                return time(a.startedAt) - time(b.startedAt);
            }
            return time(b.completedAt ?? b.addedAt) - time(a.completedAt ?? a.addedAt);
        });

        const page = all.slice(offset, offset + limit);
        return {
            items: page.map((item) => toCompactQueueItem(item, pendingOrder.get(item.id))),
            total: all.length,
            offset,
            limit,
            has_more: offset + page.length < all.length,
            stats: downloadQueue.getStats(),
            paused: downloadQueue.isPaused()
        };
    }

    getQueueItem(id: string): CompactQueueItem | undefined {
        const item = typeof id === 'string' ? downloadQueue.get(id) : undefined;
        if (!item) return undefined;
        const position = item.status === 'pending' ? downloadQueue.getPosition(item.id) : undefined;
        return toCompactQueueItem(item, position);
    }

    private pendingPositions(): Map<string, number> {
        const positions = new Map<string, number>();
        for (const item of downloadQueue.getPendingItems()) {
            positions.set(item.id, downloadQueue.getPosition(item.id));
        }
        return positions;
    }

    /* ------------------------- queue control ------------------------- */

    pause(): { paused: boolean } {
        downloadQueue.pause();
        return { paused: true };
    }

    resume(): { paused: boolean } {
        downloadQueue.resume();
        // The processor only reacts to queue events; nothing would pick up the
        // pending items after a resume otherwise.
        this.wakeProcessor();
        return { paused: false };
    }

    /** Removes completed, partial, failed and cancelled items. */
    clearCompleted(): number {
        return downloadQueue.clearCompleted();
    }

    /** Removes items that have not started yet. */
    clearPending(): number {
        return downloadQueue.clearPending();
    }

    /** Sends every failed item back to the queue; returns how many. */
    retryFailed(): number {
        const count = downloadQueue.retryAllFailed();
        if (count > 0) this.wakeProcessor();
        return count;
    }

    cancel(id: string): CompactQueueItem {
        return this.unwrap(downloadQueue.cancelWithResult(this.requireQueueId(id)));
    }

    retry(id: string): CompactQueueItem {
        const item = this.unwrap(downloadQueue.retry(this.requireQueueId(id)));
        this.wakeProcessor();
        return item;
    }

    setPriority(id: string, priority: QueuePriority): CompactQueueItem {
        const resolved = this.resolvePriority(priority);
        return this.unwrap(downloadQueue.setPriority(this.requireQueueId(id), resolved));
    }

    /**
     * Removes an item that is not running. A running item is cancelled
     * instead (it stays listed as cancelled). Returns what happened.
     */
    remove(id: string): 'removed' | 'cancelled' {
        const queueId = this.requireQueueId(id);
        if (downloadQueue.remove(queueId)) return 'removed';
        this.unwrap(downloadQueue.cancelWithResult(queueId));
        return 'cancelled';
    }

    private requireQueueId(id: unknown): string {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
            throw new QueueRequestError('Invalid queue item id', 400, 'VALIDATION_ERROR');
        }
        return id;
    }

    private unwrap(result: QueueMutationResult): CompactQueueItem {
        if (result.ok) {
            const position =
                result.item.status === 'pending' ? downloadQueue.getPosition(result.item.id) : undefined;
            return toCompactQueueItem(result.item, position);
        }
        if (result.reason === 'not_found') {
            throw new QueueRequestError(result.message, 404, 'NOT_FOUND');
        }
        throw new QueueRequestError(
            result.message,
            409,
            result.reason === 'duplicate' ? 'DUPLICATE' : 'INVALID_STATE'
        );
    }
}

export const downloadActionsService = new DownloadActionsService();

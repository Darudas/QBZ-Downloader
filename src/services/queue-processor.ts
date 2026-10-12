import fs from 'fs';
import { downloadQueue } from './queue/queue.js';
import { checkUpgradeSource, isSameFile } from './queue/upgrade-guard.js';
import { QueueRequestError } from './queue/utils.js';
import DownloadService from './download.js';
import qobuzApi from '../api/qobuz.js';
import LyricsProvider from '../api/lyrics.js';
import MetadataService from './metadata.js';
import { databaseService } from './database/index.js';
import { logger } from '../utils/logger.js';
import { QueueItem, QueueItemMetadata } from './queue/types.js';
import { CONFIG } from '../config.js';
import { notifyDownloadComplete, notifyDownloadError } from './notifications.js';
import { eventBus, EVENTS } from '../utils/events.js';
import { globalApiLimit } from '../utils/limit.js';
import { sleep } from '../utils/async.js';
import { NotFoundError } from '../utils/errors.js';
import { Album } from '../types/qobuz.js';

/** Hydration passes to spend on one queue item before treating it as unresolvable. */
const MAX_HYDRATION_ATTEMPTS = 3;

/** Albums requested per page when expanding an artist or label. */
export const FANOUT_PAGE_SIZE = 100;

/**
 * Upper bound on album items one artist or label item may enqueue. Large
 * labels list tens of thousands of releases; the item records `truncated`
 * when the cap is hit.
 */
export const MAX_FANOUT_ALBUMS = 2000;

enum ErrorCategory {
    NETWORK = 'network',
    AUTH = 'auth',
    NOT_FOUND = 'not_found',
    RATE_LIMIT = 'rate_limit',
    SERVER = 'server',
    INVALID = 'invalid',
    UNKNOWN = 'unknown'
}

interface NetworkError {
    message?: string;
    code?: string;
    statusCode?: number;
    response?: { status?: number };
}

function categorizeError(error: unknown): ErrorCategory {
    if (error instanceof QueueRequestError) {
        return ErrorCategory.INVALID;
    }

    const err = error as NetworkError;
    const message = (err?.message || '').toLowerCase();
    const statusCode = err?.statusCode || err?.response?.status || 0;

    if (err?.code === 'QOBUZ_STREAM_UNAVAILABLE') {
        return ErrorCategory.NOT_FOUND;
    }
    if (
        message.includes('qobuz closed the stream after only') ||
        message.includes('selected hi-res candidate is likely unavailable')
    ) {
        return ErrorCategory.NOT_FOUND;
    }
    if (statusCode === 401 || statusCode === 403 || message.includes('auth')) {
        return ErrorCategory.AUTH;
    }
    if (statusCode === 404 || message.includes('not found')) {
        return ErrorCategory.NOT_FOUND;
    }
    if (statusCode === 429 || message.includes('rate limit') || message.includes('too many')) {
        return ErrorCategory.RATE_LIMIT;
    }
    if (statusCode >= 500 || message.includes('server')) {
        return ErrorCategory.SERVER;
    }
    if (
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('econnrefused') ||
        message.includes('econnreset') ||
        message.includes('aborted') ||
        message.includes('premature close') ||
        message.includes('socket hang up')
    ) {
        return ErrorCategory.NETWORK;
    }
    return ErrorCategory.UNKNOWN;
}

function isRetryableError(category: ErrorCategory): boolean {
    return [
        ErrorCategory.NETWORK,
        ErrorCategory.RATE_LIMIT,
        ErrorCategory.SERVER,
        ErrorCategory.UNKNOWN
    ].includes(category);
}

function calculateRetryDelay(retryCount: number, category: ErrorCategory): number {
    const baseDelay = CONFIG.download.retryDelay || 1000;

    if (category === ErrorCategory.RATE_LIMIT) {
        return baseDelay * Math.pow(3, retryCount);
    }

    const delay = baseDelay * Math.pow(2, retryCount);
    const jitter = Math.random() * 500;
    return Math.min(delay + jitter, 30000);
}

interface AlbumPage {
    name?: string;
    albums?: { items?: Album[]; total?: number };
}

export class QueueProcessor {
    private api = qobuzApi;
    private downloadService: DownloadService;
    private lastErrorTime: number = 0;
    private consecutiveErrors: number = 0;
    private isHydrationRunning: boolean = false;
    private isStarted: boolean = false;
    /** Hydration attempts per content id, so an unresolvable item is dropped. */
    private hydrationAttempts: Map<string | number, number> = new Map();
    /** Pending automatic retries, so a cancel, removal or manual retry can drop them. */
    private retryTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor() {
        const lyricsProvider = new LyricsProvider();
        const metadataService = new MetadataService();
        this.downloadService = new DownloadService(this.api, lyricsProvider, metadataService);
    }

    start(): void {
        if (this.isStarted) {
            void this.processNext();
            return;
        }

        this.isStarted = true;

        // MAX_CONCURRENCY is editable in the UI but the queue was constructed
        // with a hardcoded 2 and the API limiter was frozen at import time, so
        // the setting had no effect at all. Applied here — after settings and
        // the database are initialised — and re-applied whenever it changes.
        const applyConcurrency = () => {
            const concurrent = CONFIG.download.concurrent || 2;
            downloadQueue.setMaxConcurrent(concurrent);
            globalApiLimit.concurrency = concurrent;
        };
        applyConcurrency();
        eventBus.on(EVENTS.SETTINGS.UPDATED, applyConcurrency);

        this.setupEvents();
        void this.startMetadataHydration();
        void this.processNext();
        logger.info('Queue Processor active: Error Recovery & Smart Retry enabled', 'QUEUE');
    }

    private async startMetadataHydration(): Promise<void> {
        if (this.isHydrationRunning) return;

        logger.info('Starting background metadata hydration service...', 'QUEUE');
        this.isHydrationRunning = true;
        while (this.isHydrationRunning) {
            try {
                const pendingItems = downloadQueue.getPendingItems();
                const itemsToHydrate = pendingItems.filter(
                    (item) =>
                        (!item.title || item.title === `${item.type}: ${item.contentId}`) &&
                        (this.hydrationAttempts.get(item.contentId) ?? 0) < MAX_HYDRATION_ATTEMPTS
                );

                for (const item of itemsToHydrate) {
                    try {
                        let title = item.title;
                        let artist = '';
                        let album = '';

                        if (item.type === 'track') {
                            const trackRes = await this.api.getTrack(item.contentId);
                            if (trackRes.success && trackRes.data) {
                                title = trackRes.data.title;
                                artist =
                                    trackRes.data.performer?.name ||
                                    trackRes.data.artist?.name ||
                                    '';
                                album = trackRes.data.album?.title || '';
                            }
                        } else if (item.type === 'album') {
                            const albumRes = await this.api.getAlbum(item.contentId);
                            if (albumRes.success && albumRes.data) {
                                title = albumRes.data.title;
                                artist = albumRes.data.artist?.name || '';
                            }
                        } else if (item.type === 'playlist') {
                            const plRes = await this.api.getPlaylist(item.contentId);
                            if (plRes.success && plRes.data) {
                                title = plRes.data.name;
                                artist = 'Various Artists';
                            }
                        } else if (item.type === 'artist') {
                            const artistRes = await this.api.getArtist(item.contentId);
                            if (artistRes.success && artistRes.data) {
                                title = artistRes.data.name;
                            }
                        } else if (item.type === 'label') {
                            const labelRes = await this.api.getLabel(item.contentId, 1, 0);
                            if (labelRes.success && labelRes.data) {
                                title = labelRes.data.name;
                            }
                        }

                        if (title !== item.title) {
                            downloadQueue.updateItemDetails(item.id, { title, artist, album });
                            logger.debug(
                                `Hydrated metadata for ${item.type} ${item.contentId}: ${title}`,
                                'META'
                            );
                        }

                        this.hydrationAttempts.delete(item.contentId);
                        await sleep(200);
                    } catch (e: unknown) {
                        const err = e as Error;
                        // Count the failure and stop after a few tries. Content that
                        // has been pulled from Qobuz can never resolve, and because
                        // the item keeps its empty title it matched the filter again
                        // on every 5s pass — retrying the same dead id forever.
                        const attempts = (this.hydrationAttempts.get(item.contentId) ?? 0) + 1;
                        this.hydrationAttempts.set(item.contentId, attempts);

                        if (attempts >= MAX_HYDRATION_ATTEMPTS) {
                            logger.warn(
                                `Giving up on metadata for ${item.type} ${item.contentId} after ${attempts} attempts: ${err.message}`,
                                'QUEUE'
                            );
                        } else {
                            logger.debug(
                                `Failed to hydrate metadata for ${item.contentId}: ${err.message}`
                            );
                        }
                    }
                }
            } catch (error) {
                logger.error(`Metadata hydration error: ${error}`, 'ERROR');
            }
            await sleep(5000);
        }
    }

    private setupEvents(): void {
        downloadQueue.on('item:added', () => this.processNext());
        downloadQueue.on('item:completed', () => {
            this.consecutiveErrors = 0;
            this.processNext();
        });
        downloadQueue.on('item:failed', () => this.processNext());
        // A cancelled item frees its slot immediately.
        downloadQueue.on('item:cancelled', (item) => {
            this.clearRetryTimer((item as QueueItem).id);
            this.processNext();
        });
        downloadQueue.on('item:removed', (item) => this.clearRetryTimer((item as QueueItem).id));
        downloadQueue.on('item:retried', (item) => this.clearRetryTimer((item as QueueItem).id));
    }

    private async processNext(): Promise<void> {
        if (downloadQueue.isPaused()) return;

        if (this.consecutiveErrors >= 5) {
            const timeSinceLastError = Date.now() - this.lastErrorTime;
            if (timeSinceLastError < 60000) {
                logger.warn(
                    `Circuit breaker active: ${this.consecutiveErrors} consecutive errors. Pausing execution...`,
                    'SYSTEM'
                );
                await sleep(30000);
                this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 2);
            } else {
                this.consecutiveErrors = 0;
            }
        }

        let item: QueueItem | null;
        while ((item = downloadQueue.dequeue())) {
            const taskItem = item;
            logger.info(
                `Processing item: ${taskItem.title || taskItem.contentId} (${taskItem.type})`,
                'QUEUE'
            );
            this.runTask(taskItem).catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                logger.error(`Fatal task error for ${taskItem.id}: ${message}`, 'QUEUE');
            });
        }
    }

    /** The user cancelled (or removed) this item: its task must stop quietly. */
    private isCancelled(id: string): boolean {
        const current = downloadQueue.get(id);
        return !current || current.status === 'cancelled';
    }

    private async runTask(item: QueueItem): Promise<void> {
        try {
            switch (item.type) {
                case 'track':
                    await this.processTrack(item);
                    break;
                case 'album':
                case 'playlist':
                    await this.processBatch(item);
                    break;
                case 'artist':
                    await this.processArtist(item);
                    break;
                case 'label':
                    await this.processLabel(item);
                    break;
                default:
                    throw new QueueRequestError(
                        `Unsupported queue item type: ${String((item as { type: unknown }).type)}`,
                        400,
                        'INVALID_TYPE'
                    );
            }
            if (!this.isCancelled(item.id)) this.consecutiveErrors = 0;
        } catch (error: unknown) {
            await this.handleError(item, error);
        }
    }

    private async handleError(item: QueueItem, error: unknown): Promise<void> {
        // A cancellation surfaces as an error from the download engine. It is
        // the user's decision, not a failure: no retry, no error notification,
        // no circuit-breaker count.
        if (this.isCancelled(item.id)) {
            logger.debug(`Task for ${item.id} stopped after cancellation`, 'QUEUE');
            return;
        }

        const err = error instanceof Error ? error : new Error(String(error));
        const category = categorizeError(err);
        const isRetryable = isRetryableError(category);

        this.lastErrorTime = Date.now();
        this.consecutiveErrors++;

        logger.error(`Processor Error [${category.toUpperCase()}]: ${err.message}`, 'ERROR');

        const current = downloadQueue.get(item.id) ?? item;
        const attempt = (current.retryCount ?? 0) + 1;
        const maxRetries = current.maxRetries ?? 3;
        const willRetry = isRetryable && attempt <= maxRetries;

        // fail() increments retryCount and tells listeners whether it is terminal.
        downloadQueue.fail(item.id, err.message, { willRetry });

        if (!isRetryable) {
            notifyDownloadError(item.title || 'Item', `${err.message} (non-retryable)`);
            return;
        }

        if (willRetry) {
            const delay = calculateRetryDelay(attempt - 1, category);
            const nextTime = Math.round(delay / 1000);

            logger.warn(
                `Retry scheduled in ${nextTime}s (Attempt ${attempt}/${maxRetries})`,
                'RETRY'
            );
            this.scheduleRetry(item.id, delay);
        } else {
            logger.error(`Max retries reached for item: ${item.title}`, 'QUEUE');
            notifyDownloadError(item.title || 'Item', err.message);
        }
    }

    private scheduleRetry(id: string, delay: number): void {
        this.clearRetryTimer(id);
        const timer = setTimeout(() => {
            this.retryTimers.delete(id);
            const stillExists = downloadQueue.get(id);
            if (stillExists && stillExists.status === 'failed' && !downloadQueue.requeue(id)) {
                logger.debug(`Automatic retry of ${id} skipped: content is queued elsewhere`, 'RETRY');
            }
        }, delay);
        this.retryTimers.set(id, timer);
    }

    private clearRetryTimer(id: string): void {
        const timer = this.retryTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.retryTimers.delete(id);
        }
    }

    /**
     * Upgrade metadata is validated when the item is enqueued or loaded
     * (queue.ts), so `isUpgrade` here was set by server-side code. The old
     * file is checked again before it is deleted.
     */
    private getUpgradeSource(item: QueueItem): string | undefined {
        const meta = item.metadata;
        if (meta?.isUpgrade !== true || typeof meta.oldFilePath !== 'string') return undefined;
        const trimmed = meta.oldFilePath.trim();
        return trimmed || undefined;
    }

    private async processTrack(item: QueueItem): Promise<void> {
        const upgradeSource = this.getUpgradeSource(item);
        const forceRedownload = item.metadata?.forceRedownload === true;

        const result = await this.downloadService.downloadTrack(item.contentId, item.quality, {
            onProgress: (progress) => {
                const pct =
                    progress.phase === 'download' && progress.total
                        ? Math.floor((progress.loaded / progress.total) * 100)
                        : progress.phase === 'tagging'
                          ? 99
                          : 0;

                downloadQueue.updateProgress(
                    item.id,
                    pct,
                    progress.phase === 'tagging' ? 'processing' : 'downloading'
                );
            },
            isCancelled: () => this.isCancelled(item.id),
            onMetadata: (meta) => {
                downloadQueue.updateItemDetails(item.id, {
                    title: meta.title,
                    artist: meta.artist,
                    album: meta.album
                });
                logger.info(`Resolved Metadata: ${meta.artist} - ${meta.title}`, 'META');
            },
            onQuality: (quality) => {
                downloadQueue.updateQuality(item.id, quality);
            },
            skipExisting: !(upgradeSource || forceRedownload),
            upgradeSourcePath: upgradeSource
        });

        if (this.isCancelled(item.id)) {
            logger.debug(`Track ${item.id} finished after it was cancelled`, 'QUEUE');
            return;
        }

        if (result.skipped) {
            downloadQueue.complete(item.id, result.filePath);
            logger.info(`Skipped (File Exists): ${item.title}`, 'SKIP');
        } else if (result.success && result.filePath) {
            if (result.quality) {
                downloadQueue.updateQuality(item.id, result.quality);
            }

            if (upgradeSource) {
                this.removeUpgradedSource(item, upgradeSource, result.filePath);
            }

            downloadQueue.complete(item.id, result.filePath);
            notifyDownloadComplete(item.title || 'Track', result.filePath);
        } else {
            throw new Error(result.error || 'Unknown download error');
        }
    }

    /**
     * Deletes the file an upgrade replaced. Only a scanned library file inside
     * the managed folders that still exists and is not the new file is
     * removed; anything else is kept and logged.
     */
    private removeUpgradedSource(item: QueueItem, oldPath: string, newPath: string): void {
        if (isSameFile(oldPath, newPath)) return;

        const check = checkUpgradeSource(oldPath, { requireExists: true });
        if (!check.ok) {
            logger.warn(
                `Upgrade of "${item.title || item.contentId}" kept the old file: ${check.reason}`,
                'UPGRADE'
            );
            return;
        }

        try {
            fs.unlinkSync(oldPath);
            logger.info(`Deleted old file for upgrade: ${oldPath}`, 'UPGRADE');
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn(`Failed to delete old file during upgrade: ${message}`, 'UPGRADE');
            return;
        }

        try {
            // deleteTrackByPath falls back to a fuzzy suffix match when there
            // is no exact row, which could hit the freshly downloaded track.
            const exactRow = databaseService
                .getDb()
                .prepare('SELECT 1 FROM tracks WHERE file_path = ?')
                .get(oldPath);
            if (exactRow) databaseService.deleteTrackByPath(oldPath);
            databaseService.deleteLibraryFileByPath(oldPath);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn(`Old file deleted but database cleanup failed: ${message}`, 'UPGRADE');
        }
    }

    private async processBatch(item: QueueItem): Promise<void> {
        const id = item.contentId;
        const type = item.type;

        logger.info(`Starting batch download: ${type} ${id}`, 'BATCH');

        const opts = {
            onProgress: (
                _trackId: string,
                p: { phase?: string; loaded?: number; total?: number }
            ) => {
                if (!p) return;
                const pct =
                    p.phase === 'download' && p.total && p.loaded !== undefined
                        ? Math.floor((p.loaded / p.total) * 100)
                        : p.phase === 'tagging'
                          ? 99
                          : 0;
                downloadQueue.updateProgress(
                    item.id,
                    pct,
                    p.phase === 'tagging' ? 'processing' : 'downloading'
                );
            },
            skipExisting: item.metadata?.forceRedownload !== true,
            onMetadata: (meta: { title?: string; artist?: string; album?: string }) => {
                downloadQueue.updateItemDetails(item.id, {
                    title: meta.title,
                    artist: meta.artist,
                    album: meta.album
                });
                logger.info(`Resolved Batch Metadata: ${meta.title}`, 'META');
            },
            onQuality: (quality: number) => {
                downloadQueue.updateQuality(item.id, quality);
            },
            isCancelled: () => this.isCancelled(item.id)
        };

        const result =
            type === 'playlist'
                ? await this.downloadService.downloadPlaylist(id, item.quality, opts)
                : await this.downloadService.downloadAlbum(id, item.quality, opts);

        if (this.isCancelled(item.id)) {
            logger.debug(`Batch ${item.id} stopped after it was cancelled`, 'BATCH');
            return;
        }

        if (result.success) {
            const files: string[] = [];
            if (result.tracks) {
                result.tracks.forEach((t) => {
                    if (t.filePath) files.push(t.filePath);
                });
            }

            downloadQueue.updateMetadata(item.id, {
                batchFiles: files
            });

            if (result.failedTracks && result.failedTracks > 0) {
                downloadQueue.completePartial(item.id);
                logger.warn(
                    `Batch Download completed with ${result.failedTracks}/${result.totalTracks} tracks missing: ${item.title}`,
                    'BATCH'
                );
                notifyDownloadComplete(item.title || 'Batch');
            } else {
                downloadQueue.complete(item.id);
                logger.success(`Batch Download Completed: ${item.title}`, 'BATCH');
                notifyDownloadComplete(item.title || 'Batch', undefined);
            }
        } else {
            throw new Error(result.error || 'Batch download failed');
        }
    }

    /**
     * An artist item downloads nothing itself: it enqueues one album item per
     * release (all pages) and completes. Running the albums inline used to
     * hold a limiter slot while the album waited for more slots (a deadlock at
     * MAX_CONCURRENCY=1) and hid the albums from the queue.
     */
    private async processArtist(item: QueueItem): Promise<void> {
        const artistId = String(item.contentId);
        await this.fanOutAlbums(item, 'artist', async (limit, offset) => {
            const res = await this.api.getArtistAlbums(artistId, limit, offset);
            if (!res.success || !res.data) {
                throw new Error(res.error || 'Failed to fetch artist albums');
            }
            return { name: res.data.name, albums: res.data.albums };
        });
    }

    /** Same as {@link processArtist} for a record label. */
    private async processLabel(item: QueueItem): Promise<void> {
        const labelId = String(item.contentId);
        await this.fanOutAlbums(item, 'label', async (limit, offset) => {
            const res = await this.api.getLabel(labelId, limit, offset);
            if (!res.success || !res.data) {
                throw new Error(res.error || 'Failed to fetch label albums');
            }
            return { name: res.data.name, albums: res.data.albums };
        });
    }

    private async fanOutAlbums(
        item: QueueItem,
        kind: 'artist' | 'label',
        fetchPage: (limit: number, offset: number) => Promise<AlbumPage>
    ): Promise<void> {
        const parentId = String(item.contentId);
        const seen = new Set<string>();
        let name: string | undefined;
        let offset = 0;
        let total = Number.POSITIVE_INFINITY;
        let queued = 0;
        let deduped = 0;
        let skipped = 0;
        let truncated = false;

        const childMetadata: QueueItemMetadata = {
            source: kind,
            parentQueueId: item.id,
            ...(kind === 'artist' ? { artistId: parentId } : { labelId: parentId }),
            ...(item.metadata?.forceRedownload === true ? { forceRedownload: true } : {})
        };

        while (offset < total) {
            if (this.isCancelled(item.id)) return;

            const page = await fetchPage(FANOUT_PAGE_SIZE, offset);
            if (this.isCancelled(item.id)) return;
            name ??= typeof page.name === 'string' && page.name ? page.name : undefined;
            const albums = Array.isArray(page.albums?.items) ? page.albums.items : [];
            const reportedTotal = page.albums?.total;
            total =
                typeof reportedTotal === 'number' && Number.isFinite(reportedTotal)
                    ? reportedTotal
                    : offset + albums.length;
            if (albums.length === 0) break;

            for (const album of albums) {
                const albumId =
                    album?.id !== undefined && album?.id !== null ? String(album.id) : '';
                if (!albumId || seen.has(albumId)) continue;
                if (seen.size >= MAX_FANOUT_ALBUMS) {
                    truncated = true;
                    break;
                }
                seen.add(albumId);

                try {
                    const result = downloadQueue.addWithResult('album', albumId, item.quality, {
                        title: typeof album.title === 'string' ? album.title : undefined,
                        priority: item.priority,
                        metadata: { ...childMetadata }
                    });
                    if (result.deduped) deduped++;
                    else queued++;
                } catch (e: unknown) {
                    skipped++;
                    const message = e instanceof Error ? e.message : String(e);
                    logger.warn(`Skipping album ${albumId} of ${kind} ${parentId}: ${message}`, 'BATCH');
                }
            }

            if (truncated) break;
            offset += albums.length;
        }

        if (this.isCancelled(item.id)) return;

        if (seen.size === 0) {
            // 404: non-retryable, an empty discography will not fill up on retry.
            throw new NotFoundError(`No albums found for this ${kind}`);
        }

        if (name) downloadQueue.updateItemDetails(item.id, { title: name });
        downloadQueue.updateMetadata(item.id, {
            albumsQueued: queued,
            albumsDeduped: deduped,
            albumsSkipped: skipped,
            albumsTotal: Number.isFinite(total) ? total : seen.size,
            truncated
        });
        downloadQueue.complete(item.id);

        logger.success(
            `${kind === 'artist' ? 'Artist' : 'Label'} "${name || parentId}": queued ${queued} album(s)` +
                (deduped ? `, ${deduped} already queued` : '') +
                (truncated ? ` (stopped at ${MAX_FANOUT_ALBUMS})` : ''),
            'BATCH'
        );
    }
}

export const queueProcessor = new QueueProcessor();
export const downloadService = queueProcessor['downloadService'];

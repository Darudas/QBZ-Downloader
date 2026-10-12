import { qobuzApi, QobuzAPI } from '../api/qobuz.js';
import { databaseService } from './database/index.js';
import { downloadQueue } from './queue/queue.js';
import { QueueRequestError, resolveQualityStrict } from './queue/utils.js';
import { QueueItem } from './queue/types.js';
import { logger } from '../utils/logger.js';
import { historyService } from './history.js';
import { notificationService } from './notifications.js';
import { CONFIG, normalizeDownloadQuality } from '../config.js';

/** Bounds for a watched playlist's sync interval, in hours. */
export const MIN_WATCH_INTERVAL_HOURS = 1;
export const MAX_WATCH_INTERVAL_HOURS = 168;
export const DEFAULT_WATCH_INTERVAL_HOURS = 24;

const WATCHER_SOURCE = 'playlist-watcher';

interface WatchedPlaylistRow {
    id: number | string;
    playlist_id: string;
    title: string | null;
    interval_hours: number | string | null;
    quality: number | string | null;
    last_synced_at: string | null;
    created_at?: string | null;
}

export interface WatchedPlaylist {
    /** Watch id (the Qobuz playlist id for watches created by this app). */
    id: string;
    playlistId: string;
    title: string;
    quality: number;
    intervalHours: number;
    lastSyncedAt: string | null;
    createdAt: string | null;
    /** When the scheduled check will next sync it (ISO), null if never synced. */
    nextSyncAt: string | null;
}

export interface WatchPlaylistInput {
    playlistId: string | number;
    intervalHours?: number;
    quality?: number | string | null;
}

export interface WatchPlaylistUpdate {
    intervalHours?: number;
    quality?: number | string | null;
}

export interface PlaylistSyncResult {
    /** Watched playlists that were fetched from Qobuz. */
    checked: number;
    /** Tracks newly added to the download queue. */
    queued: number;
}

/**
 * A stored interval that is missing, non-numeric or out of range would make
 * the next-sync time NaN, and `NaN > now` is false, so the playlist synced on
 * every pass. Fall back to the default and clamp to the allowed range.
 */
export function normalizeWatchInterval(value: unknown): number {
    const hours = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_WATCH_INTERVAL_HOURS;
    return Math.min(MAX_WATCH_INTERVAL_HOURS, Math.max(MIN_WATCH_INTERVAL_HOURS, Math.round(hours)));
}

function validateIntervalInput(value: unknown): number {
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < MIN_WATCH_INTERVAL_HOURS ||
        value > MAX_WATCH_INTERVAL_HOURS
    ) {
        throw new QueueRequestError(
            `intervalHours must be an integer from ${MIN_WATCH_INTERVAL_HOURS} to ${MAX_WATCH_INTERVAL_HOURS}`,
            400,
            'VALIDATION_ERROR'
        );
    }
    return value;
}

function normalizePlaylistId(value: unknown): string {
    const raw =
        typeof value === 'number' && Number.isSafeInteger(value)
            ? String(value)
            : typeof value === 'string'
              ? value.trim()
              : '';
    if (!/^\d{1,20}$/.test(raw) || /^0+$/.test(raw)) {
        throw new QueueRequestError(
            'Invalid playlist id (expected a positive integer)',
            400,
            'VALIDATION_ERROR'
        );
    }
    return raw.replace(/^0+/, '');
}

function toWatchedPlaylist(row: WatchedPlaylistRow): WatchedPlaylist {
    const intervalHours = normalizeWatchInterval(row.interval_hours);
    const lastSync = row.last_synced_at ? new Date(row.last_synced_at) : null;
    const lastSyncValid = lastSync && !Number.isNaN(lastSync.getTime()) ? lastSync : null;
    return {
        id: String(row.id),
        playlistId: String(row.playlist_id),
        title: row.title || String(row.playlist_id),
        quality: normalizeDownloadQuality(row.quality, 27),
        intervalHours,
        lastSyncedAt: lastSyncValid ? lastSyncValid.toISOString() : null,
        createdAt: row.created_at ?? null,
        nextSyncAt: lastSyncValid
            ? new Date(lastSyncValid.getTime() + intervalHours * 3_600_000).toISOString()
            : null
    };
}

export class PlaylistWatcherService {
    private api: QobuzAPI;
    private timer: NodeJS.Timeout | null = null;
    private isScanning = false;
    private currentScan: Promise<PlaylistSyncResult> | null = null;
    /**
     * Track ids whose watcher download failed for good (or was cancelled),
     * per watched playlist. Those are not queued again on later syncs; a user
     * can still retry them from the queue.
     */
    private failedTracks: Map<string, Set<string>> = new Map();
    private listening = false;

    constructor(api: QobuzAPI = qobuzApi) {
        this.api = api;
    }

    start(checkIntervalMinutes = 60) {
        if (this.timer) return;
        this.listenForFailures();

        this.timer = setInterval(() => {
            void this.scanAllPlaylists();
        }, checkIntervalMinutes * 60 * 1000);

        void this.scanAllPlaylists();
        logger.info(`PlaylistWatcher: Started (checking every ${checkIntervalMinutes} mins)`, 'WATCHER');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Every watched playlist. */
    list(): WatchedPlaylist[] {
        return this.getWatched().map(toWatchedPlaylist);
    }

    /** One watched playlist by watch id or Qobuz playlist id. */
    get(id: string | number): WatchedPlaylist | undefined {
        const row = this.findWatched(String(id));
        return row ? toWatchedPlaylist(row) : undefined;
    }

    /**
     * Starts watching a Qobuz playlist (or updates interval and quality when it
     * is already watched). The playlist must exist on Qobuz. `intervalHours`
     * is 1-168 (default 24); `quality` defaults to the configured default.
     */
    async watch(input: WatchPlaylistInput): Promise<WatchedPlaylist> {
        const playlistId = normalizePlaylistId(input?.playlistId);
        const intervalHours =
            input.intervalHours === undefined
                ? DEFAULT_WATCH_INTERVAL_HOURS
                : validateIntervalInput(input.intervalHours);
        const quality = resolveQualityStrict(input.quality, CONFIG.quality.default);

        const res = await this.api.getPlaylist(playlistId);
        if (!res.success || !res.data) {
            throw new QueueRequestError('Playlist not found on Qobuz', 404, 'NOT_FOUND');
        }
        const playlist = res.data as { name?: unknown; title?: unknown };
        const title = String(playlist.name || playlist.title || '').slice(0, 300);

        databaseService.addWatchedPlaylist({
            id: playlistId,
            playlistId,
            title,
            quality,
            intervalHours
        });
        logger.info(`PlaylistWatcher: Watching "${title || playlistId}"`, 'WATCHER');
        return this.get(playlistId) ?? {
            id: playlistId,
            playlistId,
            title: title || playlistId,
            quality,
            intervalHours,
            lastSyncedAt: null,
            createdAt: null,
            nextSyncAt: null
        };
    }

    /** Changes interval and/or quality. Throws 404 when the playlist is not watched. */
    update(id: string | number, changes: WatchPlaylistUpdate): WatchedPlaylist {
        const row = this.findWatched(String(id));
        if (!row) throw new QueueRequestError('Playlist is not being watched', 404, 'NOT_FOUND');
        if (changes.intervalHours === undefined && changes.quality === undefined) {
            throw new QueueRequestError('Nothing to update', 400, 'VALIDATION_ERROR');
        }

        const current = toWatchedPlaylist(row);
        const intervalHours =
            changes.intervalHours === undefined
                ? current.intervalHours
                : validateIntervalInput(changes.intervalHours);
        const quality =
            changes.quality === undefined
                ? current.quality
                : resolveQualityStrict(changes.quality, CONFIG.quality.default);

        databaseService.upsertWatchedPlaylist({
            id: current.id,
            playlistId: current.playlistId,
            title: row.title ?? undefined,
            quality,
            intervalHours,
            lastSyncedAt: row.last_synced_at,
            ...(row.created_at ? { createdAt: row.created_at } : {})
        });
        return toWatchedPlaylist({ ...row, quality, interval_hours: intervalHours });
    }

    /** Stops watching. Returns false when the playlist was not watched. */
    unwatch(id: string | number): boolean {
        const row = this.findWatched(String(id));
        if (!row) return false;
        databaseService.removeWatchedPlaylist(String(row.id));
        this.failedTracks.delete(String(row.playlist_id));
        return true;
    }

    private listenForFailures(): void {
        if (this.listening) return;
        this.listening = true;

        const remember = (value: unknown) => {
            const item = value as QueueItem | undefined;
            if (!item || item.type !== 'track' || item.awaitingRetry) return;
            if (item.metadata?.source !== WATCHER_SOURCE) return;
            const playlistId = item.metadata?.playlistId;
            if (typeof playlistId !== 'string' || !playlistId) return;

            const failed = this.failedTracks.get(playlistId) ?? new Set<string>();
            failed.add(String(item.contentId));
            this.failedTracks.set(playlistId, failed);
        };

        downloadQueue.on('item:failed', remember);
        downloadQueue.on('item:cancelled', remember);
    }

    /** Scheduled pass: syncs every watched playlist whose interval has elapsed. */
    async scanAllPlaylists(): Promise<PlaylistSyncResult> {
        if (this.isScanning) return { checked: 0, queued: 0 };
        return this.runExclusive(() => this.scan({ force: false }));
    }

    /**
     * Syncs now, ignoring the interval: one watched playlist (matched by its
     * watch id or Qobuz playlist id) or all of them. Waits for a scan already
     * in progress. Throws a 404 QueueRequestError when `playlistId` is not
     * watched.
     */
    async syncNow(playlistId?: string | number): Promise<PlaylistSyncResult> {
        const wanted = playlistId === undefined ? undefined : String(playlistId);
        if (wanted !== undefined && !this.findWatched(wanted)) {
            throw new QueueRequestError('Playlist is not being watched', 404, 'NOT_FOUND');
        }

        while (this.currentScan) {
            await this.currentScan.catch(() => undefined);
        }
        return this.runExclusive(() => this.scan({ force: true, playlistId: wanted }));
    }

    private async runExclusive(task: () => Promise<PlaylistSyncResult>): Promise<PlaylistSyncResult> {
        this.isScanning = true;
        const scan = task();
        this.currentScan = scan;
        try {
            return await scan;
        } finally {
            this.isScanning = false;
            this.currentScan = null;
        }
    }

    private findWatched(id: string): WatchedPlaylistRow | undefined {
        return this.getWatched().find(
            (row) => String(row.id) === id || String(row.playlist_id) === id
        );
    }

    private getWatched(): WatchedPlaylistRow[] {
        return databaseService.getWatchedPlaylists() as unknown as WatchedPlaylistRow[];
    }

    private async scan(options: { force: boolean; playlistId?: string }): Promise<PlaylistSyncResult> {
        const result: PlaylistSyncResult = { checked: 0, queued: 0 };
        try {
            let watched = this.getWatched();
            if (options.playlistId !== undefined) {
                const wanted = options.playlistId;
                watched = watched.filter(
                    (row) => String(row.id) === wanted || String(row.playlist_id) === wanted
                );
            }
            logger.debug(`PlaylistWatcher: Scanning ${watched.length} playlists`, 'WATCHER');

            for (const playlist of watched) {
                const queued = await this.scanPlaylist(playlist, options.force);
                if (queued !== null) {
                    result.checked++;
                    result.queued += queued;
                }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`PlaylistWatcher Scan Error: ${message}`, 'WATCHER');
        }
        return result;
    }

    /** True when a queue item for this track already failed for good or was cancelled. */
    private hasTerminalFailure(trackId: string): boolean {
        return downloadQueue
            .getAll()
            .some(
                (item) =>
                    item.type === 'track' &&
                    String(item.contentId) === trackId &&
                    ((item.status === 'failed' && !item.awaitingRetry) || item.status === 'cancelled')
            );
    }

    /** Returns the number of tracks queued, or null when the playlist was not checked. */
    private async scanPlaylist(p: WatchedPlaylistRow, force: boolean): Promise<number | null> {
        const intervalHours = normalizeWatchInterval(p.interval_hours);
        const lastSync = p.last_synced_at ? new Date(p.last_synced_at) : new Date(0);
        const lastSyncTime = Number.isNaN(lastSync.getTime()) ? 0 : lastSync.getTime();
        const nextSync = lastSyncTime + intervalHours * 60 * 60 * 1000;

        if (!force && nextSync > Date.now()) {
            return null;
        }

        const title = p.title || String(p.playlist_id);
        logger.info(`PlaylistWatcher: Checking "${title}" for new tracks...`, 'WATCHER');

        try {
            const res = await this.api.getPlaylist(p.playlist_id);
            if (!res.success || !res.data) {
                logger.warn(`PlaylistWatcher: Could not fetch playlist ${p.playlist_id}`, 'WATCHER');
                return null;
            }

            const playlistKey = String(p.playlist_id);
            const failed = this.failedTracks.get(playlistKey);
            const quality = normalizeDownloadQuality(p.quality, 27);
            const tracks = res.data.tracks?.items ?? [];
            let newTracksCount = 0;

            for (const track of tracks) {
                if (!track || track.id === undefined || track.id === null) continue;
                const trackId = track.id.toString();
                if (track.streamable === false) continue;
                if (failed?.has(trackId)) continue;
                if (historyService.has(trackId) || databaseService.hasTrack(trackId)) continue;
                if (this.hasTerminalFailure(trackId)) continue;

                try {
                    const { deduped } = downloadQueue.addWithResult('track', trackId, quality, {
                        title: track.title,
                        metadata: {
                            source: WATCHER_SOURCE,
                            playlistId: playlistKey,
                            playlistTitle: title
                        }
                    });
                    if (!deduped) newTracksCount++;
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn(`PlaylistWatcher: Skipping track ${trackId}: ${message}`, 'WATCHER');
                }
            }

            if (newTracksCount > 0) {
                logger.success(`PlaylistWatcher: Added ${newTracksCount} new tracks from "${title}"`, 'WATCHER');
                notificationService.info(
                    'Playlist Watcher',
                    `Added ${newTracksCount} new tracks from "${title}" to queue.`
                );
            }

            databaseService.updatePlaylistSyncTime(p.id.toString());
            return newTracksCount;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`PlaylistWatcher: Error scanning "${title}": ${message}`, 'WATCHER');
            return null;
        }
    }
}

export const playlistWatcherService = new PlaylistWatcherService(qobuzApi);

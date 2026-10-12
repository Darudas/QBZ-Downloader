import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const settings = vi.hoisted(() => new Map<string, string>());

vi.mock('./settings.js', () => ({ settingsService: { get: (key: string) => settings.get(key) } }));
vi.mock('../utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }
}));
vi.mock('./qobuz-library/index.js', () => ({ qobuzLibraryService: {} }));
vi.mock('./download-actions.js', () => ({ downloadActionsService: {} }));
vi.mock('./notifications.js', () => ({ notificationService: { info: vi.fn() } }));
vi.mock('./database/index.js', () => ({ databaseService: {} }));
const lookup = vi.hoisted(() => ({ checkAlbums: vi.fn() }));
vi.mock('./library-lookup.js', () => lookup);

import {
    FAVORITES_SYNC_MIN_STALE_MS,
    FAVORITES_SYNC_SOURCE,
    FAVORITES_SYNC_STARTUP_DELAY_MS,
    FavoritesSyncService,
    readFavoritesSyncSettings,
    SqliteFavoritesSyncStore,
    withAlbumTracksCounts,
    type FavoritesSyncDeps,
    type FavoritesSyncSettings
} from './favorites-sync.js';
import { eventBus, EVENTS } from '../utils/events.js';

const HOUR = 60 * 60 * 1000;

describe('readFavoritesSyncSettings', () => {
    // Settings changes always emit SETTINGS.UPDATED, which clears CONFIG's cache.
    const changed = () => eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['FAVORITES_AUTO_DOWNLOAD'] });
    beforeEach(() => {
        settings.clear();
        changed();
    });

    it('defaults to off, both types and 6 hours', () => {
        expect(readFavoritesSyncSettings()).toEqual({ autoDownload: false, types: ['albums', 'tracks'], intervalHours: 6 });
    });

    it('parses the stored values like CONFIG.favorites and clamps the interval', async () => {
        const { CONFIG } = await import('../config.js');
        settings.set('FAVORITES_AUTO_DOWNLOAD', 'true');
        settings.set('FAVORITES_AUTO_DOWNLOAD_TYPES', ' tracks ,videos');
        settings.set('FAVORITES_SYNC_INTERVAL_HOURS', '12');
        changed();
        expect(readFavoritesSyncSettings()).toEqual({ autoDownload: true, types: ['tracks'], intervalHours: 12 });

        settings.set('FAVORITES_AUTO_DOWNLOAD', '1');
        settings.set('FAVORITES_SYNC_INTERVAL_HOURS', '500');
        settings.set('FAVORITES_AUTO_DOWNLOAD_TYPES', '');
        changed();
        expect(readFavoritesSyncSettings()).toEqual({ autoDownload: false, types: [], intervalHours: 168 });
        expect(readFavoritesSyncSettings()).toEqual({ ...CONFIG.favorites });

        settings.set('FAVORITES_SYNC_INTERVAL_HOURS', '0');
        changed();
        expect(readFavoritesSyncSettings().intervalHours).toBe(1);
    });

    it('lets the scheduler see a settings change in the same event', () => {
        const service = new FavoritesSyncService({
            store: { getLastSyncAt: () => null } as never,
            hasCredentials: () => true,
            userId: () => 'u'
        });
        service.start();
        expect(service.getStatus().nextSyncAt).toBeNull();
        settings.set('FAVORITES_AUTO_DOWNLOAD', 'true');
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['FAVORITES_AUTO_DOWNLOAD'] });
        expect(service.getStatus()).toMatchObject({ autoDownload: true });
        expect(service.getStatus().nextSyncAt).not.toBeNull();
        service.stop();
    });
});

describe('withAlbumTracksCounts', () => {
    it('adds the Qobuz track counts so complete albums can be skipped', async () => {
        lookup.checkAlbums.mockResolvedValueOnce({
            a1: { status: 'partial', downloaded: 3, total: 10 },
            a2: { status: 'missing', downloaded: 0, total: null }
        });
        expect(await withAlbumTracksCounts(['a1', 'a2'])).toEqual([
            { id: 'a1', tracksCount: 10 },
            { id: 'a2', tracksCount: null }
        ]);
        expect(lookup.checkAlbums).toHaveBeenCalledWith(['a1', 'a2']);
    });

    it('falls back to plain ids when the lookup fails', async () => {
        lookup.checkAlbums.mockRejectedValueOnce(new Error('db closed'));
        expect(await withAlbumTracksCounts(['a1'])).toEqual([{ id: 'a1' }]);
    });
});

describe('SqliteFavoritesSyncStore', () => {
    it('records a baseline, adds known ids and forgets an account', () => {
        const db = new Database(':memory:');
        const store = new SqliteFavoritesSyncStore(() => db);
        expect(store.hasBaseline('u1', 'albums')).toBe(false);
        expect(store.getLastSyncAt('u1', ['albums', 'tracks'])).toBeNull();

        store.recordBaseline('u1', 'albums', ['a', 'b'], '2026-01-01T00:00:00.000Z');
        store.addKnown('u1', 'albums', ['c', 'a'], '2026-01-02T00:00:00.000Z');
        store.markSynced('u1', 'albums', '2026-01-02T00:00:00.000Z');
        expect(store.hasBaseline('u1', 'albums')).toBe(true);
        expect(store.hasBaseline('u2', 'albums')).toBe(false);
        expect([...store.getKnown('u1', 'albums')].sort()).toEqual(['a', 'b', 'c']);
        expect(store.getKnown('u1', 'tracks').size).toBe(0);
        expect(store.getLastSyncAt('u1', ['albums', 'tracks'])).toBe('2026-01-02T00:00:00.000Z');

        store.clearBaseline('u1');
        expect(store.hasBaseline('u1', 'albums')).toBe(false);
        expect(store.getKnown('u1', 'albums').size).toBe(0);
        db.close();
    });
});

describe('FavoritesSyncService', () => {
    let db: Database.Database;
    let favorites: { albums: string[]; tracks: string[] };
    let current: FavoritesSyncSettings;
    let credentials: boolean;
    let user: string;
    let deps: FavoritesSyncDeps;
    let service: FavoritesSyncService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-01T12:00:00Z'));
        db = new Database(':memory:');
        favorites = { albums: ['a1', 'a2'], tracks: ['t1'] };
        current = { autoDownload: true, types: ['albums', 'tracks'], intervalHours: 6 };
        credentials = true;
        user = 'user-1';
        deps = {
            store: new SqliteFavoritesSyncStore(() => db),
            readSettings: () => current,
            hasCredentials: () => credentials,
            userId: () => user,
            getFavoriteIds: vi.fn(async () => ({ albums: [...favorites.albums], tracks: [...favorites.tracks] })),
            ensureReady: vi.fn(),
            queue: vi.fn(async (_kind, ids: string[]) => ({
                queued: ids.length,
                deduped: 0,
                skipped: 0,
                failed: 0,
                failedIds: [] as string[]
            })),
            notify: vi.fn(),
            now: () => Date.now()
        };
        service = new FavoritesSyncService(deps);
    });

    afterEach(() => {
        service.stop();
        vi.useRealTimers();
        db.close();
    });

    it('records a baseline on the first check and downloads nothing', async () => {
        const result = await service.syncNow();
        expect(result.baselineRecorded).toEqual(['albums', 'tracks']);
        expect(result.queued).toBe(0);
        expect(deps.queue).not.toHaveBeenCalled();
        expect(deps.notify).not.toHaveBeenCalled();
    });

    it('queues only favorites added since the last check', async () => {
        await service.syncNow();
        favorites.albums.push('a3');
        favorites.tracks.push('t2', 't3');

        const result = await service.syncNow();
        expect(result.baselineRecorded).toEqual([]);
        expect(result.newFavorites).toEqual({ albums: 1, tracks: 2 });
        expect(result.queued).toBe(3);
        expect(deps.queue).toHaveBeenCalledWith('albums', ['a3'], FAVORITES_SYNC_SOURCE);
        expect(deps.queue).toHaveBeenCalledWith('tracks', ['t2', 't3'], FAVORITES_SYNC_SOURCE);
        expect(deps.notify).toHaveBeenCalledWith(3);

        vi.mocked(deps.queue).mockClear();
        const again = await service.syncNow();
        expect(again.queued).toBe(0);
        expect(deps.queue).not.toHaveBeenCalled();
    });

    it('retries ids that failed to queue on the next check', async () => {
        await service.syncNow();
        favorites.albums.push('a3', 'a4');
        vi.mocked(deps.queue).mockResolvedValueOnce({ queued: 1, deduped: 0, skipped: 0, failed: 1, failedIds: ['a4'] });

        const first = await service.syncNow();
        expect(first.failed).toBe(1);
        const second = await service.syncNow();
        expect(second.newFavorites.albums).toBe(1);
        expect(deps.queue).toHaveBeenLastCalledWith('albums', ['a4'], FAVORITES_SYNC_SOURCE);
    });

    it('checks only the configured types; a newly enabled type starts with a baseline', async () => {
        current = { ...current, types: ['albums'] };
        await service.syncNow();
        expect(deps.store.hasBaseline('user-1', 'tracks')).toBe(false);

        favorites.tracks.push('t2');
        current = { ...current, types: ['albums', 'tracks'] };
        const result = await service.syncNow();
        expect(result.baselineRecorded).toEqual(['tracks']);
        expect(deps.queue).not.toHaveBeenCalled();
    });

    it('re-records the baseline of a type that was left out of the previous check', async () => {
        await service.syncNow();
        current = { ...current, types: ['albums'] };
        vi.setSystemTime(Date.now() + HOUR);
        await service.syncNow();

        favorites.tracks.push('t-added-while-excluded');
        favorites.albums.push('a-new');
        current = { ...current, types: ['albums', 'tracks'] };
        vi.setSystemTime(Date.now() + HOUR);
        const result = await service.syncNow();
        expect(result.baselineRecorded).toEqual(['tracks']);
        expect(deps.queue).toHaveBeenCalledTimes(1);
        expect(deps.queue).toHaveBeenCalledWith('albums', ['a-new'], FAVORITES_SYNC_SOURCE);
        expect(deps.store.getKnown('user-1', 'tracks').has('t-added-while-excluded')).toBe(true);
    });

    it('does not download from a stale baseline, manual or scheduled', async () => {
        await service.syncNow();
        favorites.albums.push('old-1', 'old-2');
        vi.setSystemTime(Date.now() + FAVORITES_SYNC_MIN_STALE_MS + HOUR);

        // Manual check with auto-download off, long after the last one.
        current = { ...current, autoDownload: false };
        const manual = await service.syncNow();
        expect(manual.baselineRecorded).toEqual(['albums', 'tracks']);
        expect(deps.queue).not.toHaveBeenCalled();

        // Scheduled check at startup (e.g. enabled through the environment) after a long pause.
        favorites.albums.push('old-3');
        vi.setSystemTime(Date.now() + FAVORITES_SYNC_MIN_STALE_MS + HOUR);
        current = { ...current, autoDownload: true };
        service.start();
        await vi.advanceTimersByTimeAsync(FAVORITES_SYNC_STARTUP_DELAY_MS);
        expect(deps.getFavoriteIds).toHaveBeenCalledTimes(3);
        expect(deps.queue).not.toHaveBeenCalled();
        expect(deps.store.getKnown('user-1', 'albums').has('old-3')).toBe(true);
    });

    it('still downloads favorites added while the app was closed for a few days', async () => {
        await service.syncNow();
        favorites.albums.push('while-closed');
        vi.setSystemTime(Date.now() + 3 * 24 * HOUR);
        const result = await service.syncNow();
        expect(result.baselineRecorded).toEqual([]);
        expect(deps.queue).toHaveBeenCalledWith('albums', ['while-closed'], FAVORITES_SYNC_SOURCE);
    });

    it('aborts a check when the Qobuz account changes while favorites are loaded', async () => {
        await service.syncNow();
        favorites.albums.push('a3');
        vi.mocked(deps.getFavoriteIds).mockImplementationOnce(async () => {
            const ids = { albums: [...favorites.albums], tracks: [...favorites.tracks] };
            user = 'user-2';
            return ids;
        });
        const result = await service.syncNow();
        expect(result.queued).toBe(0);
        expect(result.baselineRecorded).toEqual([]);
        expect(deps.queue).not.toHaveBeenCalled();
        expect(deps.store.hasBaseline('user-2', 'albums')).toBe(false);
        expect(deps.store.getKnown('user-1', 'albums').has('a3')).toBe(false);
    });

    it('keeps a separate baseline per Qobuz account', async () => {
        await service.syncNow();
        user = 'user-2';
        const result = await service.syncNow();
        expect(result.baselineRecorded).toEqual(['albums', 'tracks']);
        expect(deps.queue).not.toHaveBeenCalled();
    });

    it('fails syncNow when downloads cannot be queued', async () => {
        vi.mocked(deps.ensureReady).mockImplementation(() => {
            throw new Error('Missing required credentials');
        });
        await expect(service.syncNow()).rejects.toThrow('Missing required credentials');
        expect(deps.getFavoriteIds).not.toHaveBeenCalled();
    });

    it('shares one check between concurrent callers', async () => {
        const [a, b] = await Promise.all([service.syncNow(), service.syncNow()]);
        expect(a).toBe(b);
        expect(deps.getFavoriteIds).toHaveBeenCalledTimes(1);
    });

    it('runs on a timer while enabled and stops with stop()', async () => {
        service.start();
        expect(service.getStatus().nextSyncAt).toBe(
            new Date(Date.now() + FAVORITES_SYNC_STARTUP_DELAY_MS).toISOString()
        );
        await vi.advanceTimersByTimeAsync(FAVORITES_SYNC_STARTUP_DELAY_MS);
        expect(deps.getFavoriteIds).toHaveBeenCalledTimes(1);

        favorites.albums.push('a9');
        await vi.advanceTimersByTimeAsync(6 * HOUR);
        expect(deps.getFavoriteIds).toHaveBeenCalledTimes(2);
        expect(deps.queue).toHaveBeenCalledWith('albums', ['a9'], FAVORITES_SYNC_SOURCE);

        service.stop();
        expect(service.getStatus().nextSyncAt).toBeNull();
        await vi.advanceTimersByTimeAsync(24 * HOUR);
        expect(deps.getFavoriteIds).toHaveBeenCalledTimes(2);
    });

    it('honours the interval across restarts', async () => {
        await service.syncNow();
        vi.setSystemTime(Date.now() + 2 * HOUR);
        service.start();
        expect(service.getStatus().nextSyncAt).toBe(new Date(Date.now() + 4 * HOUR).toISOString());
    });

    it('stays idle while disabled or without credentials', async () => {
        current = { ...current, autoDownload: false };
        service.start();
        expect(service.getStatus().nextSyncAt).toBeNull();

        current = { ...current, autoDownload: true };
        credentials = false;
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['FAVORITES_AUTO_DOWNLOAD'] });
        expect(service.getStatus().nextSyncAt).toBeNull();
        await vi.advanceTimersByTimeAsync(24 * HOUR);
        expect(deps.getFavoriteIds).not.toHaveBeenCalled();

        credentials = true;
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['QOBUZ_USER_AUTH_TOKEN'] });
        expect(service.getStatus().nextSyncAt).not.toBeNull();
    });

    it('re-records the baseline when auto-download is switched on', async () => {
        current = { ...current, autoDownload: false };
        service.start();
        await service.syncNow();
        favorites.albums.push('added-while-off');

        current = { ...current, autoDownload: true };
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['FAVORITES_AUTO_DOWNLOAD'] });
        await vi.advanceTimersByTimeAsync(FAVORITES_SYNC_STARTUP_DELAY_MS);

        expect(deps.getFavoriteIds).toHaveBeenCalledTimes(2);
        expect(deps.queue).not.toHaveBeenCalled();
        expect(deps.store.getKnown('user-1', 'albums').has('added-while-off')).toBe(true);
    });

    it('ignores unrelated settings changes', () => {
        current = { ...current, autoDownload: false };
        service.start();
        current = { ...current, autoDownload: true };
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['UI_THEME'] });
        expect(service.getStatus().nextSyncAt).toBeNull();
    });

    it('logs a failed scheduled check and tries again after the interval', async () => {
        vi.mocked(deps.getFavoriteIds).mockRejectedValueOnce(new Error('Qobuz down'));
        service.start();
        await vi.advanceTimersByTimeAsync(FAVORITES_SYNC_STARTUP_DELAY_MS);
        expect(deps.getFavoriteIds).toHaveBeenCalledTimes(1);
        expect(service.getStatus().nextSyncAt).toBe(new Date(Date.now() + 6 * HOUR).toISOString());
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Route-level tests for the A2 endpoints of download.routes.ts and the
 * watched-playlist endpoints of catalog.routes.ts: validation, wiring to the
 * services and JSON error mapping. The services themselves are covered by
 * their own tests.
 */

const svc = vi.hoisted(() => ({
    retry: vi.fn(),
    cancel: vi.fn(),
    setPriority: vi.fn(),
    remove: vi.fn(),
    retryFailed: vi.fn(),
    clearPending: vi.fn(),
    enqueue: vi.fn(),
    enqueueUrls: vi.fn(),
    getQueue: vi.fn(),
    getQueueItem: vi.fn()
}));
const watcher = vi.hoisted(() => ({
    watch: vi.fn(),
    update: vi.fn(),
    syncNow: vi.fn(),
    unwatch: vi.fn()
}));
const history = vi.hoisted(() => ({
    remove: vi.fn(),
    query: vi.fn(),
    getAll: vi.fn(() => ({})),
    get: vi.fn(),
    clearAll: vi.fn()
}));
const migration = vi.hoisted(() => ({ migrateFromSpotify: vi.fn(), startMigrationDownload: vi.fn() }));

vi.mock('../download-actions.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../download-actions.js')>()),
    downloadActionsService: svc
}));
vi.mock('../PlaylistWatcherService.js', () => ({ playlistWatcherService: watcher }));
vi.mock('../history.js', () => ({ historyService: history }));
vi.mock('../migration.js', () => ({ migrationService: migration }));
vi.mock('../library-lookup.js', () => ({ isTrackInLibrary: vi.fn(() => false), albumStatus: vi.fn() }));
vi.mock('../database/index.js', () => ({ databaseService: { getWatchedPlaylists: vi.fn(() => []) } }));
vi.mock('../queue/queue.js', () => ({ downloadQueue: { getAll: vi.fn(() => []), clear: vi.fn() } }));
vi.mock('../queue-processor.js', () => ({ queueProcessor: {}, downloadService: {} }));
vi.mock('../../utils/env.js', () => ({ validateEnvironment: vi.fn(() => ({ valid: true })) }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../api/qobuz.js', () => {
    const api = { getAlbum: vi.fn(), getTrack: vi.fn(), getPlaylist: vi.fn() };
    return { default: api, qobuzApi: api };
});
vi.mock('../../config.js', () => ({
    CONFIG: { quality: { default: 27 }, download: { outputDir: '/music' } },
    normalizeDownloadQuality: (v: unknown, d: number) => ([5, 6, 7, 27].includes(Number(v)) ? Number(v) : d)
}));

import downloadRouter from './routers/download.routes.js';
import catalogRouter from './routers/catalog.routes.js';
import { QueueRequestError } from '../queue/utils.js';
import qobuzApi from '../../api/qobuz.js';
import { isTrackInLibrary } from '../library-lookup.js';

const app = express();
app.use(express.json());
app.use('/api', catalogRouter);
app.use('/api', downloadRouter);

const item = { id: 'q_1', status: 'pending', priority: 'high' };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('queue item routes', () => {
    it('POST /queue/item/:id/retry returns the retried item', async () => {
        svc.retry.mockReturnValue(item);
        const res = await request(app).post('/api/queue/item/q_1/retry');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, item });
        expect(svc.retry).toHaveBeenCalledWith('q_1');
    });

    it('maps service errors to their status and rejects malformed ids', async () => {
        svc.retry.mockImplementation(() => {
            throw new QueueRequestError('Queue item not found', 404, 'NOT_FOUND');
        });
        const missing = await request(app).post('/api/queue/item/nope/retry');
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ error: 'Queue item not found', code: 'NOT_FOUND' });

        const bad = await request(app).post(`/api/queue/item/${'x'.repeat(65)}/retry`);
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('VALIDATION_ERROR');
    });

    it('POST /queue/item/:id/priority validates the priority', async () => {
        svc.setPriority.mockReturnValue(item);
        const ok = await request(app).post('/api/queue/item/q_1/priority').send({ priority: 'high' });
        expect(ok.status).toBe(200);
        expect(svc.setPriority).toHaveBeenCalledWith('q_1', 'high');

        for (const body of [{}, { priority: 'urgent' }, { priority: 1 }]) {
            expect((await request(app).post('/api/queue/item/q_1/priority').send(body)).status).toBe(400);
        }
        expect(svc.setPriority).toHaveBeenCalledTimes(1);
    });

    it('POST /queue/retry-failed and clear-pending report counts', async () => {
        svc.retryFailed.mockReturnValue(3);
        svc.clearPending.mockReturnValue(2);
        expect((await request(app).post('/api/queue/retry-failed')).body).toEqual({ success: true, count: 3 });
        expect((await request(app).post('/api/queue/action').send({ action: 'clear-pending' })).body).toEqual({
            success: true,
            count: 2
        });
    });

    it('GET /queue/item/:id answers 404 for unknown items', async () => {
        svc.getQueueItem.mockReturnValue(undefined);
        expect((await request(app).get('/api/queue/item/q_9')).status).toBe(404);
    });
});

describe('POST /download/urls', () => {
    it('forwards urls and options and reports partial failure', async () => {
        svc.enqueueUrls.mockResolvedValue({ results: [{ ok: true }, { ok: false }], queued: 1, failed: 1 });
        const res = await request(app)
            .post('/api/download/urls')
            .send({ urls: ['https://open.qobuz.com/album/abc', 'bad'], quality: 6, priority: 'low', skipExisting: false });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.failed).toBe(1);
        expect(svc.enqueueUrls).toHaveBeenCalledWith(['https://open.qobuz.com/album/abc', 'bad'], 6, {
            priority: 'low',
            skipExisting: false,
            source: 'dashboard'
        });
    });

    it('validates the body', async () => {
        const tooMany = Array.from({ length: 501 }, (_, i) => `https://open.qobuz.com/track/${i}`);
        for (const body of [{}, { urls: [] }, { urls: 'x' }, { urls: ['x'], quality: 9 }, { urls: tooMany }]) {
            expect((await request(app).post('/api/download/urls').send(body)).status).toBe(400);
        }
        expect(svc.enqueueUrls).not.toHaveBeenCalled();
    });
});

describe('history routes', () => {
    it('DELETE /history/:id removes an entry or answers 404', async () => {
        history.remove.mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect((await request(app).delete('/api/history/123')).body).toEqual({ success: true });
        const missing = await request(app).delete('/api/history/456');
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('NOT_FOUND');
        expect((await request(app).delete('/api/history/a%20b')).status).toBe(400);
    });

    it('GET /history pages and searches only when asked to', async () => {
        history.query.mockReturnValue({ items: [], total: 0 });
        await request(app).get('/api/history').query({ q: 'blue', limit: '10', offset: '5' });
        expect(history.query).toHaveBeenCalledWith({ q: 'blue', limit: 10, offset: 5 });
        expect((await request(app).get('/api/history?limit=501')).status).toBe(400);
        expect(Array.isArray((await request(app).get('/api/history')).body)).toBe(true);
    });
});

describe('watched playlist routes', () => {
    it('PATCH /playlists/watch/:id updates interval and quality', async () => {
        watcher.update.mockReturnValue({ id: 'w1', intervalHours: 12, quality: 6 });
        const res = await request(app).patch('/api/playlists/watch/w1').send({ intervalHours: 12, quality: 6 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, playlist: { id: 'w1', intervalHours: 12, quality: 6 } });
        expect(watcher.update).toHaveBeenCalledWith('w1', { intervalHours: 12, quality: 6 });
    });

    it('PATCH validates the body and maps not-watched to 404', async () => {
        for (const body of [{}, { intervalHours: 0 }, { intervalHours: 169 }, { quality: 8 }]) {
            expect((await request(app).patch('/api/playlists/watch/w1').send(body)).status).toBe(400);
        }
        watcher.update.mockImplementation(() => {
            throw new QueueRequestError('Playlist is not being watched', 404, 'NOT_FOUND');
        });
        expect((await request(app).patch('/api/playlists/watch/w2').send({ intervalHours: 2 })).status).toBe(404);
    });

    it('POST /playlists/watch/:id/sync and /playlists/watched/sync', async () => {
        watcher.syncNow.mockResolvedValue({ checked: 1, queued: 4 });
        expect((await request(app).post('/api/playlists/watch/w1/sync')).body).toEqual({ success: true, checked: 1, queued: 4 });
        expect(watcher.syncNow).toHaveBeenLastCalledWith('w1');
        await request(app).post('/api/playlists/watched/sync');
        expect(watcher.syncNow).toHaveBeenLastCalledWith();
        expect((await request(app).post('/api/playlists/watch/bad!id/sync')).status).toBe(400);
    });

    it('DELETE /playlists/watch/:id answers 404 when not watched', async () => {
        watcher.unwatch.mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect((await request(app).delete('/api/playlists/watch/w1')).status).toBe(200);
        expect((await request(app).delete('/api/playlists/watch/w1')).status).toBe(404);
    });
});

describe('catalog flags', () => {
    it('flags playlist tracks and single tracks', async () => {
        vi.mocked(isTrackInLibrary).mockImplementation((id: string | number) => String(id) === '1');
        vi.mocked(qobuzApi.getPlaylist).mockResolvedValue({
            success: true,
            data: { id: 5, tracks: { items: [{ id: 1 }, { id: 2 }] } }
        } as never);
        const playlist = await request(app).get('/api/playlist/5');
        expect(playlist.body.tracks.items.map((t: { already_downloaded: boolean }) => t.already_downloaded)).toEqual([
            true,
            false
        ]);

        vi.mocked(qobuzApi.getTrack).mockResolvedValue({ success: true, data: { id: 1, title: 'T' } } as never);
        expect((await request(app).get('/api/track/1')).body.already_downloaded).toBe(true);
    });
});

describe('POST /migrate/spotify', () => {
    it('rejects a missing url with 400 before calling Spotify', async () => {
        const res = await request(app).post('/api/migrate/spotify').send({});
        expect(res.status).toBe(400);
        expect(migration.migrateFromSpotify).not.toHaveBeenCalled();
    });

    it('queues found tracks when download is set', async () => {
        migration.migrateFromSpotify.mockResolvedValue({ total: 1, found: 1, results: [{ found: true }] });
        migration.startMigrationDownload.mockResolvedValue(1);
        const res = await request(app)
            .post('/api/migrate/spotify')
            .send({ url: 'https://open.spotify.com/playlist/x', quality: 6, download: true });
        expect(res.body.enqueued).toBe(1);
        expect(migration.migrateFromSpotify).toHaveBeenCalledWith('https://open.spotify.com/playlist/x', 6);
    });
});

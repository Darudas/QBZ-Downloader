import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const lookup = vi.hoisted(() => ({
    checkTracks: vi.fn(),
    checkAlbums: vi.fn(),
    searchLocalLibrary: vi.fn()
}));

vi.mock('../library-lookup.js', () => ({
    ...lookup,
    MAX_LOOKUP_TRACK_IDS: 500,
    MAX_LOOKUP_ALBUM_IDS: 50
}));
const actions = vi.hoisted(() => ({
    resolveDuplicate: vi.fn(),
    editTrackMetadata: vi.fn(),
    deleteLibraryFile: vi.fn(),
    queueUpgrade: vi.fn()
}));
vi.mock('../library-actions.js', () => actions);
vi.mock('../database/index.js', () => ({ databaseService: {} }));
vi.mock('../queue/queue.js', () => ({ downloadQueue: {} }));
vi.mock('../library-scanner/index.js', () => ({ libraryScannerService: {} }));
vi.mock('../LibraryStatisticsService.js', () => ({ libraryStatisticsService: {} }));
vi.mock('../FormatConverterService.js', () => ({ formatConverterService: {} }));
vi.mock('../../utils/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../config.js', () => ({
    CONFIG: { download: { outputDir: '/music' }, quality: { default: 27 } },
    normalizeDownloadQuality: (v: unknown, d: number) => ([5, 6, 7, 27].includes(Number(v)) ? Number(v) : d)
}));

import libraryRouter from './routers/library.routes.js';

const app = express();
app.use(express.json());
app.use('/api/library', libraryRouter);

describe('GET /api/library/search', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        lookup.searchLocalLibrary.mockReturnValue({ items: [], total: 0, offset: 0, limit: 25, has_more: false });
    });

    it('passes validated paging and source to the lookup service', async () => {
        const res = await request(app).get('/api/library/search').query({ q: ' band ', source: 'files', limit: '10', offset: '20' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ items: [], total: 0, offset: 0, limit: 25, has_more: false });
        expect(lookup.searchLocalLibrary).toHaveBeenCalledWith('band', { source: 'files', limit: 10, offset: 20 });
    });

    it('defaults to downloaded tracks', async () => {
        await request(app).get('/api/library/search?q=x');
        expect(lookup.searchLocalLibrary).toHaveBeenCalledWith('x', { source: 'tracks', limit: 25, offset: 0 });
    });

    it('rejects a missing query, bad source and out-of-range paging with JSON 400', async () => {
        for (const query of ['', '?q=', '?q=x&source=all', '?q=x&limit=0', '?q=x&limit=101', '?q=x&offset=-1']) {
            const res = await request(app).get(`/api/library/search${query}`);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('VALIDATION_ERROR');
        }
        expect(lookup.searchLocalLibrary).not.toHaveBeenCalled();
    });
});

describe('GET /api/library/lookup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        lookup.checkTracks.mockReturnValue({ '1': { in_library: true, quality: 27 } });
        lookup.checkAlbums.mockResolvedValue({ abc: { status: 'partial', downloaded: 1, total: 3 } });
    });

    it('accepts comma-separated and repeated ids', async () => {
        const res = await request(app).get('/api/library/lookup?trackIds=1,2&trackIds=3&albumIds=abc');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            tracks: { '1': { in_library: true, quality: 27 } },
            albums: { abc: { status: 'partial', downloaded: 1, total: 3 } }
        });
        expect(lookup.checkTracks).toHaveBeenCalledWith(['1', '2', '3']);
        expect(lookup.checkAlbums).toHaveBeenCalledWith(['abc']);
    });

    it('requires at least one id and validates their format and count', async () => {
        const bad = [
            '',
            '?trackIds=',
            '?trackIds=abc',
            '?albumIds=a-b',
            `?albumIds=${Array.from({ length: 51 }, (_, i) => `a${i}`).join(',')}`
        ];
        for (const query of bad) {
            const res = await request(app).get(`/api/library/lookup${query}`);
            expect(res.status).toBe(400);
        }
        expect(lookup.checkTracks).not.toHaveBeenCalled();
    });
});

describe('library actions routes', () => {
    beforeEach(() => vi.clearAllMocks());

    it('POST /duplicates/:id/resolve forwards keep/dryRun and maps errors to JSON', async () => {
        actions.resolveDuplicate.mockResolvedValueOnce({ id: 4, resolved: true, deleted: true, deletedFile: '/music/b.flac' });
        const ok = await request(app).post('/api/library/duplicates/4/resolve');
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ success: true, deleted: true, deletedFile: '/music/b.flac' });
        expect(actions.resolveDuplicate).toHaveBeenCalledWith(4, { keep: 'auto', dryRun: false });

        actions.resolveDuplicate.mockResolvedValueOnce({ id: 4, resolved: false, deleted: false, dryRun: true });
        await request(app).post('/api/library/duplicates/4/resolve').send({ keep: 'first', dryRun: true });
        expect(actions.resolveDuplicate).toHaveBeenLastCalledWith(4, { keep: 'first', dryRun: true });

        const { NotFoundError, ForbiddenError } = await import('../../utils/errors.js');
        actions.resolveDuplicate.mockRejectedValueOnce(new NotFoundError('Duplicate record not found'));
        const missing = await request(app).post('/api/library/duplicates/5/resolve');
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('Duplicate record not found');
        actions.resolveDuplicate.mockRejectedValueOnce(new ForbiddenError('outside'));
        expect((await request(app).post('/api/library/duplicates/5/resolve')).status).toBe(403);

        expect((await request(app).post('/api/library/duplicates/abc/resolve')).status).toBe(400);
        expect((await request(app).post('/api/library/duplicates/1/resolve').send({ keep: 'both' })).status).toBe(400);
    });

    it('POST /metadata/edit accepts fields (or the legacy metadata key)', async () => {
        actions.editTrackMetadata.mockResolvedValue({ filePath: '/music/a.flac', updated: ['title'] });
        const res = await request(app)
            .post('/api/library/metadata/edit')
            .send({ filePath: '/music/a.flac', fields: { title: 'New' } });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, filePath: '/music/a.flac', updated: ['title'] });
        expect(actions.editTrackMetadata).toHaveBeenCalledWith('/music/a.flac', { title: 'New' });

        await request(app).post('/api/library/metadata/edit').send({ filePath: '/music/a.flac', metadata: { genre: 'Jazz' } });
        expect(actions.editTrackMetadata).toHaveBeenLastCalledWith('/music/a.flac', { genre: 'Jazz' });

        expect((await request(app).post('/api/library/metadata/edit').send({ filePath: '/music/a.flac' })).status).toBe(400);
        expect((await request(app).post('/api/library/metadata/edit').send({ fields: { title: 'x' } })).status).toBe(400);
    });

    it('DELETE /file takes a path or a library file id', async () => {
        actions.deleteLibraryFile.mockReturnValue({ filePath: '/music/a.flac', deleted: true, removedRows: { libraryFiles: 1, tracks: 0 } });
        const res = await request(app).delete('/api/library/file').send({ filePath: '/music/a.flac' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, deleted: true });
        await request(app).delete('/api/library/file').send({ libraryFileId: 7 });
        expect(actions.deleteLibraryFile).toHaveBeenLastCalledWith({ libraryFileId: 7 });
        expect((await request(app).delete('/api/library/file').send({})).status).toBe(400);
    });

    it('POST /upgrade keeps its contract', async () => {
        actions.queueUpgrade.mockReturnValue({ id: 'q_1' });
        const res = await request(app).post('/api/library/upgrade').send({ filePath: '/music/a.flac', trackId: '123' });
        expect(res.body).toEqual({ success: true, item: { id: 'q_1' } });
        expect((await request(app).post('/api/library/upgrade').send({ filePath: '/music/a.flac' })).status).toBe(400);
    });
});

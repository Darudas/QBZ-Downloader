import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
    getLibraryFileByPath: vi.fn(),
    add: vi.fn(),
    isPathWithinManagedRoots: vi.fn()
}));

vi.mock('../database/index.js', () => ({
    databaseService: { getLibraryFileByPath: mocks.getLibraryFileByPath }
}));
vi.mock('../queue/queue.js', () => ({ downloadQueue: { add: mocks.add } }));
vi.mock('../../utils/paths.js', () => ({ isPathWithinManagedRoots: mocks.isPathWithinManagedRoots }));
vi.mock('../library-lookup.js', () => ({ MAX_LOOKUP_TRACK_IDS: 500, MAX_LOOKUP_ALBUM_IDS: 50 }));
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

describe('POST /api/library/upgrade', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isPathWithinManagedRoots.mockReturnValue(true);
        mocks.getLibraryFileByPath.mockReturnValue({
            id: 7,
            upgrade_candidates: JSON.stringify([{ trackId: '123', quality: 27, title: 'T', album: 'A' }])
        });
        mocks.add.mockReturnValue({ id: 'q_1' });
    });

    it('queues a candidate with server-built upgrade metadata', async () => {
        const res = await request(app)
            .post('/api/library/upgrade')
            .send({ filePath: '/music/a.flac', trackId: '123' });
        expect(res.status).toBe(200);
        expect(mocks.add).toHaveBeenCalledWith('track', '123', 27, {
            metadata: expect.objectContaining({ isUpgrade: true, oldFilePath: '/music/a.flac', libraryFileId: 7 })
        });
    });

    it('rejects a track that is not a recorded candidate', async () => {
        const res = await request(app)
            .post('/api/library/upgrade')
            .send({ filePath: '/music/a.flac', trackId: '999' });
        expect(res.status).toBe(400);
        expect(mocks.add).not.toHaveBeenCalled();
    });

    it('rejects files outside the managed roots or not indexed', async () => {
        mocks.isPathWithinManagedRoots.mockReturnValueOnce(false);
        expect((await request(app).post('/api/library/upgrade').send({ filePath: '/etc/passwd', trackId: '123' })).status).toBe(403);
        mocks.getLibraryFileByPath.mockReturnValue(undefined);
        expect((await request(app).post('/api/library/upgrade').send({ filePath: '/music/x.flac', trackId: '123' })).status).toBe(404);
        expect(mocks.add).not.toHaveBeenCalled();
    });
});

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { QueueProcessor, MAX_FANOUT_ALBUMS } from './queue-processor.js';
import { downloadQueue } from './queue/queue.js';
import { databaseService } from './database/index.js';
import { notifyDownloadComplete, notifyDownloadError } from './notifications.js';

const shared = vi.hoisted(() => ({
    managedRoot: '',
    exactTrackRow: undefined as unknown
}));

vi.mock('./queue/queue.js', () => ({
    downloadQueue: {
        getPendingItems: vi.fn(),
        updateMetadata: vi.fn(),
        updateItemDetails: vi.fn(),
        on: vi.fn(),
        isPaused: vi.fn().mockReturnValue(false),
        dequeue: vi.fn(),
        fail: vi.fn(),
        complete: vi.fn(),
        completePartial: vi.fn(),
        get: vi.fn(),
        updateProgress: vi.fn(),
        updateQuality: vi.fn(),
        requeue: vi.fn().mockReturnValue(true),
        setMaxConcurrent: vi.fn(),
        addWithResult: vi.fn()
    }
}));

vi.mock('./download.js', () => {
    return {
        default: vi.fn().mockImplementation(function () {
            return {
                downloadTrack: vi.fn(),
                downloadAlbum: vi.fn(),
                downloadPlaylist: vi.fn()
            };
        })
    };
});

vi.mock('../api/qobuz.js', () => {
    const mockApi = {
        getTrack: vi.fn(),
        getAlbum: vi.fn(),
        getPlaylist: vi.fn(),
        getArtist: vi.fn(),
        getArtistAlbums: vi.fn(),
        getLabel: vi.fn(),
        getFileUrl: vi.fn()
    };
    return {
        qobuzApi: mockApi,
        default: mockApi
    };
});

vi.mock('./metadata.js', () => ({
    default: vi.fn().mockImplementation(function () {
        return {
            extractMetadata: vi.fn(),
            writeMetadata: vi.fn(),
            getCoverUrlCandidates: vi.fn()
        };
    })
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

vi.mock('./notifications.js', () => ({
    notifyDownloadComplete: vi.fn(),
    notifyDownloadError: vi.fn()
}));

vi.mock('../config.js', () => ({
    CONFIG: {
        download: { retryDelay: 100, outputDir: './downloads' },
        quality: { default: 27 }
    }
}));

vi.mock('../utils/paths.js', () => ({
    isPathWithinManagedRoots: vi.fn(
        (filePath: unknown) =>
            typeof filePath === 'string' &&
            shared.managedRoot !== '' &&
            path.resolve(filePath).startsWith(shared.managedRoot + path.sep)
    )
}));

vi.mock('./database/index.js', () => ({
    databaseService: {
        getLibraryFileByPath: vi.fn(),
        deleteTrackByPath: vi.fn(),
        deleteLibraryFileByPath: vi.fn(),
        getDb: vi.fn(() => ({
            prepare: () => ({ get: () => shared.exactTrackRow })
        }))
    }
}));

type Internals = {
    api: Record<string, ReturnType<typeof vi.fn>>;
    downloadService: Record<string, ReturnType<typeof vi.fn>>;
    consecutiveErrors: number;
    lastErrorTime: number;
    isHydrationRunning: boolean;
    startMetadataHydration: () => Promise<void>;
    processNext: () => Promise<void>;
    handleError: (item: unknown, err: unknown) => Promise<void>;
    processTrack: (item: unknown) => Promise<void>;
    processBatch: (item: unknown) => Promise<void>;
    runTask: (item: unknown) => Promise<void>;
};

type QueueGet = ReturnType<typeof downloadQueue.get>;

const internals = (processor: QueueProcessor) => processor as unknown as Internals;

const mockGet = (item: unknown) =>
    vi.mocked(downloadQueue.get).mockReturnValue(item as QueueGet);

/** Handlers registered on the (mocked) queue by setupEvents. */
const queueHandler = (event: string): ((...args: unknown[]) => void) => {
    const call = vi.mocked(downloadQueue.on).mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`no handler for ${event}`);
    return call[1] as (...args: unknown[]) => void;
};

describe('QueueProcessor', () => {
    let processor: QueueProcessor;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.mocked(downloadQueue.requeue).mockReturnValue(true);
        vi.mocked(downloadQueue.isPaused).mockReturnValue(false);
        shared.exactTrackRow = undefined;
        processor = new QueueProcessor();
    });

    afterEach(() => {
        internals(processor).isHydrationRunning = false;
        vi.useRealTimers();
    });

    it('should hydrate metadata for pending items', async () => {
        const mockItem = {
            id: '1',
            type: 'track',
            contentId: 'track1',
            title: 'track: track1'
        };

        vi.mocked(downloadQueue.getPendingItems).mockReturnValue([
            mockItem as unknown as ReturnType<typeof downloadQueue.getPendingItems>[number]
        ]);
        internals(processor).api.getTrack!.mockResolvedValue({
            success: true,
            data: {
                title: 'Real Title',
                performer: { name: 'Real Artist' },
                album: { title: 'Real Album' }
            }
        });

        void internals(processor).startMetadataHydration();
        await vi.advanceTimersByTimeAsync(500);

        expect(downloadQueue.updateItemDetails).toHaveBeenCalledWith('1', {
            title: 'Real Title',
            artist: 'Real Artist',
            album: 'Real Album'
        });
    });

    it('should hydrate label titles through getLabel', async () => {
        vi.mocked(downloadQueue.getPendingItems).mockReturnValue([
            { id: 'l1', type: 'label', contentId: '77' } as unknown as ReturnType<
                typeof downloadQueue.getPendingItems
            >[number]
        ]);
        internals(processor).api.getLabel!.mockResolvedValue({
            success: true,
            data: { id: 77, name: 'ECM Records' }
        });

        void internals(processor).startMetadataHydration();
        await vi.advanceTimersByTimeAsync(500);

        expect(internals(processor).api.getLabel).toHaveBeenCalledWith('77', 1, 0);
        expect(downloadQueue.updateItemDetails).toHaveBeenCalledWith(
            'l1',
            expect.objectContaining({ title: 'ECM Records' })
        );
    });

    it('should start idempotently and process pending items when woken again', () => {
        vi.mocked(downloadQueue.getPendingItems).mockReturnValue([]);
        vi.mocked(downloadQueue.dequeue).mockReturnValue(null);

        processor.start();
        processor.start();

        const events = vi.mocked(downloadQueue.on).mock.calls.map(([name]) => name);
        expect(events).toEqual([
            'item:added',
            'item:completed',
            'item:failed',
            'item:cancelled',
            'item:removed',
            'item:retried'
        ]);
        expect(downloadQueue.dequeue).toHaveBeenCalledTimes(2);
    });

    it('should activate circuit breaker after consecutive errors', async () => {
        const mockItem = { id: '1', type: 'track', contentId: 't1', title: 'T1' };
        vi.mocked(downloadQueue.dequeue)
            .mockReturnValueOnce(mockItem as unknown as ReturnType<typeof downloadQueue.dequeue>)
            .mockReturnValue(null);
        mockGet(mockItem);

        internals(processor).downloadService.downloadTrack!.mockRejectedValue(
            new Error('Network Error')
        );

        internals(processor).consecutiveErrors = 5;
        internals(processor).lastErrorTime = Date.now();

        const processPromise = internals(processor).processNext();

        await vi.advanceTimersByTimeAsync(30000);
        await processPromise;

        expect(internals(processor).consecutiveErrors).toBeLessThan(5);
    });

    describe('error handling', () => {
        it('should retry item on retryable error', async () => {
            const mockItem = {
                id: '1',
                type: 'track',
                contentId: 't1',
                title: 'T1',
                retryCount: 1,
                maxRetries: 3,
                status: 'failed'
            };
            mockGet(mockItem);

            const error = new Error('Network timeout');
            Object.assign(error, { statusCode: 503 });

            const handlePromise = internals(processor).handleError(mockItem, error);
            await vi.advanceTimersByTimeAsync(5000);
            await handlePromise;

            expect(downloadQueue.fail).toHaveBeenCalledWith('1', 'Network timeout', {
                willRetry: true
            });
            expect(downloadQueue.requeue).toHaveBeenCalledWith('1');
            expect(notifyDownloadError).not.toHaveBeenCalled();
        });

        it('should fail item immediately on non-retryable error', async () => {
            const mockItem = {
                id: '1',
                type: 'track',
                contentId: 't1',
                title: 'T1',
                retryCount: 0,
                maxRetries: 3,
                status: 'downloading'
            };
            mockGet(mockItem);

            const error = new Error('Not found');
            Object.assign(error, { statusCode: 404 });

            await internals(processor).handleError(mockItem, error);

            expect(downloadQueue.fail).toHaveBeenCalledWith('1', 'Not found', { willRetry: false });
            expect(notifyDownloadError).toHaveBeenCalledWith('T1', 'Not found (non-retryable)');
        });

        it('should not retry unavailable Hi-Res stream candidates', async () => {
            const mockItem = {
                id: '1',
                type: 'track',
                contentId: 't1',
                title: 'Team',
                retryCount: 0,
                maxRetries: 3,
                status: 'downloading'
            };
            mockGet(mockItem);

            const error = new Error(
                'Qobuz closed the stream after only 1 byte(s). The selected Hi-Res candidate is likely unavailable or blocked; rescan the library and choose another candidate.'
            );

            await internals(processor).handleError(mockItem, error);
            await vi.advanceTimersByTimeAsync(60000);

            expect(downloadQueue.fail).toHaveBeenCalledWith('1', error.message, { willRetry: false });
            expect(downloadQueue.requeue).not.toHaveBeenCalled();
        });

        it('should stop retrying and notify once the retry budget is used up', async () => {
            const mockItem = {
                id: '1',
                type: 'track',
                contentId: 't1',
                title: 'T1',
                retryCount: 3,
                maxRetries: 3,
                status: 'downloading'
            };
            mockGet(mockItem);

            await internals(processor).handleError(mockItem, new Error('socket hang up'));
            await vi.advanceTimersByTimeAsync(60000);

            expect(downloadQueue.fail).toHaveBeenCalledWith('1', 'socket hang up', {
                willRetry: false
            });
            expect(downloadQueue.requeue).not.toHaveBeenCalled();
            expect(notifyDownloadError).toHaveBeenCalledWith('T1', 'socket hang up');
        });

        it('should treat a cancelled item as terminal and silent', async () => {
            const mockItem = {
                id: '1',
                type: 'track',
                contentId: 't1',
                title: 'T1',
                retryCount: 0,
                maxRetries: 3,
                status: 'cancelled'
            };
            mockGet(mockItem);
            internals(processor).consecutiveErrors = 2;

            await internals(processor).handleError(mockItem, new Error('Cancelled by user'));
            await vi.advanceTimersByTimeAsync(60000);

            expect(downloadQueue.fail).not.toHaveBeenCalled();
            expect(downloadQueue.requeue).not.toHaveBeenCalled();
            expect(notifyDownloadError).not.toHaveBeenCalled();
            expect(internals(processor).consecutiveErrors).toBe(2);
        });

        it('should drop a scheduled retry when the item is cancelled meanwhile', async () => {
            vi.mocked(downloadQueue.getPendingItems).mockReturnValue([]);
            vi.mocked(downloadQueue.dequeue).mockReturnValue(null);
            processor.start();

            const mockItem = {
                id: 'r1',
                type: 'track',
                contentId: 't1',
                title: 'T1',
                retryCount: 0,
                maxRetries: 3,
                status: 'failed'
            };
            mockGet(mockItem);

            await internals(processor).handleError(mockItem, new Error('Network timeout'));
            queueHandler('item:cancelled')({ ...mockItem, status: 'cancelled' });
            await vi.advanceTimersByTimeAsync(60000);

            expect(downloadQueue.requeue).not.toHaveBeenCalled();
        });

        it('should fail an unsupported item type without retrying', async () => {
            const mockItem = {
                id: 'x1',
                type: 'spotify_track',
                contentId: 'abc',
                title: 'Bogus',
                retryCount: 0,
                maxRetries: 3,
                status: 'downloading'
            };
            mockGet(mockItem);

            await internals(processor).runTask(mockItem);
            await vi.advanceTimersByTimeAsync(60000);

            expect(downloadQueue.fail).toHaveBeenCalledWith(
                'x1',
                expect.stringContaining('Unsupported queue item type'),
                { willRetry: false }
            );
            expect(downloadQueue.requeue).not.toHaveBeenCalled();
        });
    });

    describe('tracks', () => {
        it('should pass upgrade source path so same-path upgrades are written safely', async () => {
            const mockItem = {
                id: 'upgrade-1',
                type: 'track',
                contentId: 'track-1',
                quality: 27,
                title: 'Team',
                status: 'downloading',
                metadata: {
                    isUpgrade: true,
                    oldFilePath: 'C:\\Music\\Lorde\\Pure Heroine\\06. Team.flac'
                }
            };
            mockGet(mockItem);

            const downloadTrack = internals(processor).downloadService.downloadTrack!;
            downloadTrack.mockResolvedValue({
                success: true,
                filePath: mockItem.metadata.oldFilePath,
                quality: 27
            });

            await internals(processor).processTrack(mockItem);

            expect(downloadTrack).toHaveBeenCalledWith(
                'track-1',
                27,
                expect.objectContaining({
                    skipExisting: false,
                    upgradeSourcePath: mockItem.metadata.oldFilePath
                })
            );
            expect(downloadQueue.complete).toHaveBeenCalledWith(
                mockItem.id,
                mockItem.metadata.oldFilePath
            );
            expect(databaseService.deleteLibraryFileByPath).not.toHaveBeenCalled();
        });

        it('should re-download over existing files when forceRedownload is set', async () => {
            const mockItem = {
                id: 'f1',
                type: 'track',
                contentId: '42',
                quality: 6,
                title: 'Song',
                status: 'downloading',
                metadata: { forceRedownload: true }
            };
            mockGet(mockItem);
            const downloadTrack = internals(processor).downloadService.downloadTrack!;
            downloadTrack.mockResolvedValue({ success: true, filePath: '/x/song.flac', quality: 6 });

            await internals(processor).processTrack(mockItem);

            expect(downloadTrack).toHaveBeenCalledWith(
                '42',
                6,
                expect.objectContaining({ skipExisting: false, upgradeSourcePath: undefined })
            );
        });

        it('should not complete or notify a track that was cancelled while downloading', async () => {
            const mockItem = {
                id: 'c1',
                type: 'track',
                contentId: '42',
                quality: 27,
                title: 'Song',
                status: 'downloading'
            };
            mockGet(mockItem);
            const downloadTrack = internals(processor).downloadService.downloadTrack!;
            downloadTrack.mockImplementation(async () => {
                mockGet({ ...mockItem, status: 'cancelled' });
                return { success: true, filePath: '/x/song.flac', quality: 27 };
            });

            await internals(processor).processTrack(mockItem);

            expect(downloadQueue.complete).not.toHaveBeenCalled();
            expect(notifyDownloadComplete).not.toHaveBeenCalled();
        });

        it('should report cancellation to the download service', async () => {
            const mockItem = { id: 'c2', type: 'track', contentId: '42', quality: 27, status: 'downloading' };
            mockGet(mockItem);
            const downloadTrack = internals(processor).downloadService.downloadTrack!;
            downloadTrack.mockResolvedValue({ success: false, error: 'x' });

            await expect(internals(processor).processTrack(mockItem)).rejects.toThrow('x');
            const options = downloadTrack.mock.calls[0]![2] as { isCancelled: () => boolean };
            expect(options.isCancelled()).toBe(false);
            mockGet({ ...mockItem, status: 'cancelled' });
            expect(options.isCancelled()).toBe(true);
        });
    });

    describe('upgrade old-file deletion guard', () => {
        let root: string;
        let outside: string;

        beforeAll(() => {
            root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-upgrade-root-')));
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-upgrade-out-')));
        });

        afterAll(() => {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        });

        beforeEach(() => {
            shared.managedRoot = root;
        });

        const runUpgrade = async (oldPath: string, newPath: string) => {
            const item = {
                id: 'up',
                type: 'track',
                contentId: '99',
                quality: 27,
                title: 'Upgrade',
                status: 'downloading',
                metadata: { isUpgrade: true, oldFilePath: oldPath }
            };
            mockGet(item);
            internals(processor).downloadService.downloadTrack!.mockResolvedValue({
                success: true,
                filePath: newPath,
                quality: 27
            });
            await internals(processor).processTrack(item);
        };

        it('deletes the old file when it is a scanned library file inside the managed roots', async () => {
            const oldPath = path.join(root, 'old.mp3');
            const newPath = path.join(root, 'new.flac');
            fs.writeFileSync(oldPath, 'old');
            fs.writeFileSync(newPath, 'new');
            vi.mocked(databaseService.getLibraryFileByPath).mockReturnValue({ id: 1, file_path: oldPath });
            shared.exactTrackRow = { 1: 1 };

            await runUpgrade(oldPath, newPath);

            expect(fs.existsSync(oldPath)).toBe(false);
            expect(fs.existsSync(newPath)).toBe(true);
            expect(databaseService.deleteTrackByPath).toHaveBeenCalledWith(oldPath);
            expect(databaseService.deleteLibraryFileByPath).toHaveBeenCalledWith(oldPath);
            expect(downloadQueue.complete).toHaveBeenCalledWith('up', newPath);
        });

        it('skips the fuzzy track-row delete when the old file has no exact tracks row', async () => {
            const oldPath = path.join(root, 'scanned-only.mp3');
            const newPath = path.join(root, 'scanned-only.flac');
            fs.writeFileSync(oldPath, 'old');
            fs.writeFileSync(newPath, 'new');
            vi.mocked(databaseService.getLibraryFileByPath).mockReturnValue({ id: 2 });
            shared.exactTrackRow = undefined;

            await runUpgrade(oldPath, newPath);

            expect(fs.existsSync(oldPath)).toBe(false);
            expect(databaseService.deleteTrackByPath).not.toHaveBeenCalled();
            expect(databaseService.deleteLibraryFileByPath).toHaveBeenCalledWith(oldPath);
        });

        it('keeps a file outside the managed roots', async () => {
            const oldPath = path.join(outside, 'precious.txt');
            const newPath = path.join(root, 'new2.flac');
            fs.writeFileSync(oldPath, 'keep me');
            fs.writeFileSync(newPath, 'new');
            vi.mocked(databaseService.getLibraryFileByPath).mockReturnValue({ id: 3 });

            await runUpgrade(oldPath, newPath);

            expect(fs.existsSync(oldPath)).toBe(true);
            expect(databaseService.deleteLibraryFileByPath).not.toHaveBeenCalled();
            expect(downloadQueue.complete).toHaveBeenCalledWith('up', newPath);
        });

        it('keeps a file inside the roots that is not in library_files', async () => {
            const oldPath = path.join(root, 'not-indexed.flac');
            const newPath = path.join(root, 'new3.flac');
            fs.writeFileSync(oldPath, 'keep me');
            fs.writeFileSync(newPath, 'new');
            vi.mocked(databaseService.getLibraryFileByPath).mockReturnValue(undefined);

            await runUpgrade(oldPath, newPath);

            expect(fs.existsSync(oldPath)).toBe(true);
            expect(databaseService.deleteLibraryFileByPath).not.toHaveBeenCalled();
        });

        it('never deletes the new file even when the old path is another name for it', async () => {
            const newPath = path.join(root, 'same.flac');
            fs.writeFileSync(newPath, 'new');
            // A hard link: a different path string for the very same file.
            const oldPath = path.join(root, 'same-link.flac');
            fs.linkSync(newPath, oldPath);
            vi.mocked(databaseService.getLibraryFileByPath).mockReturnValue({ id: 4 });

            await runUpgrade(oldPath, newPath);

            expect(fs.existsSync(newPath)).toBe(true);
            expect(fs.existsSync(oldPath)).toBe(true);
            expect(databaseService.deleteLibraryFileByPath).not.toHaveBeenCalled();
        });

        it('never deletes a directory', async () => {
            const oldPath = path.join(root, 'a-directory');
            fs.mkdirSync(oldPath, { recursive: true });
            const newPath = path.join(root, 'new4.flac');
            fs.writeFileSync(newPath, 'new');
            vi.mocked(databaseService.getLibraryFileByPath).mockReturnValue({ id: 5 });

            await runUpgrade(oldPath, newPath);

            expect(fs.existsSync(oldPath)).toBe(true);
        });
    });

    describe('albums and playlists', () => {
        it('should complete a batch and record its files', async () => {
            const item = { id: 'b1', type: 'album', contentId: 'alb1', quality: 27, title: 'Album', status: 'downloading' };
            mockGet(item);
            internals(processor).downloadService.downloadAlbum!.mockResolvedValue({
                success: true,
                tracks: [{ filePath: '/a/1.flac' }, { filePath: '/a/2.flac' }],
                failedTracks: 0,
                totalTracks: 2
            });

            await internals(processor).processBatch(item);

            expect(downloadQueue.updateMetadata).toHaveBeenCalledWith('b1', {
                batchFiles: ['/a/1.flac', '/a/2.flac']
            });
            expect(downloadQueue.complete).toHaveBeenCalledWith('b1');
        });

        it('should not complete a batch that was cancelled', async () => {
            const item = { id: 'b2', type: 'playlist', contentId: '5', quality: 27, status: 'downloading' };
            mockGet(item);
            internals(processor).downloadService.downloadPlaylist!.mockImplementation(async () => {
                mockGet({ ...item, status: 'cancelled' });
                return { success: true, tracks: [], failedTracks: 0 };
            });

            await internals(processor).processBatch(item);

            expect(downloadQueue.complete).not.toHaveBeenCalled();
            expect(notifyDownloadComplete).not.toHaveBeenCalled();
        });
    });

    describe('artist and label fan-out', () => {
        const albumsPage = (start: number, count: number) =>
            Array.from({ length: count }, (_, i) => ({ id: `alb${start + i}`, title: `Album ${start + i}` }));

        beforeEach(() => {
            vi.mocked(downloadQueue.addWithResult).mockImplementation(
                (type, contentId) =>
                    ({
                        item: { id: `q-${contentId}`, type, contentId },
                        deduped: contentId === 'alb0'
                    }) as unknown as ReturnType<typeof downloadQueue.addWithResult>
            );
        });

        it('enqueues every album of an artist across pages', async () => {
            const item = {
                id: 'art1',
                type: 'artist',
                contentId: '123',
                quality: 7,
                priority: 'high',
                status: 'downloading'
            };
            mockGet(item);
            const getArtistAlbums = internals(processor).api.getArtistAlbums!;
            getArtistAlbums.mockImplementation(async (_id: string, limit: number, offset: number) => ({
                success: true,
                data: {
                    id: 123,
                    name: 'Artist',
                    albums: { items: albumsPage(offset, Math.min(limit, 150 - offset)), total: 150, offset, limit }
                }
            }));

            await internals(processor).runTask(item);

            expect(getArtistAlbums).toHaveBeenNthCalledWith(1, '123', 100, 0);
            expect(getArtistAlbums).toHaveBeenNthCalledWith(2, '123', 100, 100);
            expect(downloadQueue.addWithResult).toHaveBeenCalledTimes(150);
            expect(downloadQueue.addWithResult).toHaveBeenCalledWith('album', 'alb149', 7, {
                title: 'Album 149',
                priority: 'high',
                metadata: { source: 'artist', parentQueueId: 'art1', artistId: '123' }
            });
            expect(downloadQueue.updateItemDetails).toHaveBeenCalledWith('art1', { title: 'Artist' });
            expect(downloadQueue.updateMetadata).toHaveBeenCalledWith('art1', {
                albumsQueued: 149,
                albumsDeduped: 1,
                albumsSkipped: 0,
                albumsTotal: 150,
                truncated: false
            });
            expect(downloadQueue.complete).toHaveBeenCalledWith('art1');
            expect(downloadQueue.fail).not.toHaveBeenCalled();
            // Nothing is downloaded inline any more.
            expect(internals(processor).downloadService.downloadAlbum).not.toHaveBeenCalled();
        });

        it('enqueues a label catalogue through getLabel and skips repeated album ids', async () => {
            const item = {
                id: 'lab1',
                type: 'label',
                contentId: '55',
                quality: 27,
                priority: 'normal',
                status: 'downloading',
                metadata: { forceRedownload: true }
            };
            mockGet(item);
            const getLabel = internals(processor).api.getLabel!;
            getLabel
                .mockResolvedValueOnce({
                    success: true,
                    data: { id: 55, name: 'Label', albums: { items: albumsPage(1, 100), total: 120 } }
                })
                .mockResolvedValueOnce({
                    success: true,
                    // One duplicate from the first page plus 19 new albums.
                    data: { id: 55, name: 'Label', albums: { items: albumsPage(100, 20), total: 120 } }
                });

            await internals(processor).runTask(item);

            expect(getLabel).toHaveBeenNthCalledWith(1, '55', 100, 0);
            expect(getLabel).toHaveBeenNthCalledWith(2, '55', 100, 100);
            expect(downloadQueue.addWithResult).toHaveBeenCalledTimes(119);
            expect(downloadQueue.addWithResult).toHaveBeenCalledWith('album', 'alb1', 27, {
                title: 'Album 1',
                priority: 'normal',
                metadata: { source: 'label', parentQueueId: 'lab1', labelId: '55', forceRedownload: true }
            });
            expect(downloadQueue.complete).toHaveBeenCalledWith('lab1');
        });

        it('stops at MAX_FANOUT_ALBUMS and records the truncation', async () => {
            const item = { id: 'big', type: 'label', contentId: '9', quality: 27, priority: 'low', status: 'downloading' };
            mockGet(item);
            const total = MAX_FANOUT_ALBUMS + 250;
            internals(processor).api.getLabel!.mockImplementation(
                async (_id: string, limit: number, offset: number) => ({
                    success: true,
                    data: {
                        id: 9,
                        name: 'Huge',
                        albums: { items: albumsPage(offset + 1, Math.min(limit, total - offset)), total }
                    }
                })
            );

            await internals(processor).runTask(item);

            expect(downloadQueue.addWithResult).toHaveBeenCalledTimes(MAX_FANOUT_ALBUMS);
            expect(downloadQueue.updateMetadata).toHaveBeenCalledWith(
                'big',
                expect.objectContaining({ truncated: true, albumsTotal: total })
            );
            expect(downloadQueue.complete).toHaveBeenCalledWith('big');
        });

        it('fails without retry when an artist has no albums', async () => {
            const item = {
                id: 'art2',
                type: 'artist',
                contentId: '321',
                quality: 27,
                title: 'Nobody',
                retryCount: 0,
                maxRetries: 3,
                status: 'downloading'
            };
            mockGet(item);
            internals(processor).api.getArtistAlbums!.mockResolvedValue({
                success: true,
                data: { id: 321, name: 'Nobody', albums: { items: [], total: 0 } }
            });

            await internals(processor).runTask(item);

            expect(downloadQueue.addWithResult).not.toHaveBeenCalled();
            expect(downloadQueue.fail).toHaveBeenCalledWith('art2', 'No albums found for this artist', {
                willRetry: false
            });
            expect(downloadQueue.complete).not.toHaveBeenCalled();
        });

        it('stops expanding when the artist item is cancelled', async () => {
            const item = { id: 'art3', type: 'artist', contentId: '5', quality: 27, status: 'downloading' };
            mockGet(item);
            internals(processor).api.getArtistAlbums!.mockImplementation(async () => {
                mockGet({ ...item, status: 'cancelled' });
                return {
                    success: true,
                    data: { id: 5, name: 'A', albums: { items: albumsPage(1, 100), total: 300 } }
                };
            });

            await internals(processor).runTask(item);

            expect(internals(processor).api.getArtistAlbums).toHaveBeenCalledTimes(1);
            expect(downloadQueue.addWithResult).not.toHaveBeenCalled();
            expect(downloadQueue.complete).not.toHaveBeenCalled();
            expect(downloadQueue.fail).not.toHaveBeenCalled();
        });
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    hasTrack: vi.fn((id: string) => id === 't-have'),
    enqueue: vi.fn(),
    ensureReady: vi.fn(),
    getPurchaseIds: vi.fn(),
    listFavorites: vi.fn()
}));

vi.mock('./database/index.js', () => ({ databaseService: { hasTrack: mocks.hasTrack } }));
vi.mock('./download-actions.js', () => ({
    downloadActionsService: { enqueue: mocks.enqueue, ensureReady: mocks.ensureReady }
}));
vi.mock('./qobuz-library/service.js', () => ({
    qobuzLibraryService: { getPurchaseIds: mocks.getPurchaseIds, listFavorites: mocks.listFavorites }
}));

import { downloadFavorites, downloadPurchases, queueLibraryIds } from './favorites-download.js';

describe('favorites and purchases download', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.enqueue.mockImplementation(async ({ id }: { id: string }) => {
            if (id === 'bad') throw new Error('nope');
            return { items: [], queued: id === 'dup' ? 0 : 1, deduped: id === 'dup' ? 1 : 0 };
        });
    });

    it('queues ids, skips tracks already in the library and reports failures', async () => {
        const result = await queueLibraryIds('tracks', ['t1', 't-have', 'bad', 'dup'], 27, 'mcp');
        expect(result).toEqual({ queued: 1, deduped: 1, skipped: 1, failed: 1, failedIds: ['bad'] });
        expect(mocks.enqueue).toHaveBeenCalledWith({ type: 'track', id: 't1', quality: 27, source: 'mcp' });
    });

    it('downloads purchased albums and tracks', async () => {
        mocks.getPurchaseIds.mockResolvedValue({ albums: ['alb1'], tracks: ['t1', 't-have'] });
        const result = await downloadPurchases('all', undefined, 'dashboard');
        expect(mocks.ensureReady).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ queued: 2, deduped: 0, skipped: 1, failed: 0 });
        expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'album', id: 'alb1' }));
    });

    it('downloads only the requested purchase type', async () => {
        mocks.getPurchaseIds.mockResolvedValue({ albums: ['alb1'], tracks: ['t1'] });
        await downloadPurchases('albums', 6, 'mcp');
        expect(mocks.enqueue).toHaveBeenCalledTimes(1);
        expect(mocks.enqueue).toHaveBeenCalledWith({ type: 'album', id: 'alb1', quality: 6, source: 'mcp' });
    });

    it('does not touch Qobuz when downloads cannot be queued', async () => {
        mocks.ensureReady.mockImplementationOnce(() => {
            throw new Error('Missing required credentials');
        });
        await expect(downloadPurchases('all', undefined, 'mcp')).rejects.toThrow('Missing required credentials');
        expect(mocks.getPurchaseIds).not.toHaveBeenCalled();
    });

    it('pages through favorites', async () => {
        mocks.listFavorites
            .mockResolvedValueOnce({ items: [{ id: 'a1' }], has_more: true })
            .mockResolvedValueOnce({ items: [{ id: 'a2' }], has_more: false });
        const result = await downloadFavorites('albums', undefined, 'mcp');
        expect(result.queued).toBe(2);
        expect(mocks.listFavorites).toHaveBeenNthCalledWith(2, 'albums', { limit: 100, offset: 100 });
    });
});

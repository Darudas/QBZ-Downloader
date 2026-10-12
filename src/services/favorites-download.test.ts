import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
    isTrackInLibrary: vi.fn(),
    albumStatus: vi.fn(),
    enqueue: vi.fn(),
    listFavorites: vi.fn()
}));

vi.mock('./library-lookup.js', () => ({ isTrackInLibrary: m.isTrackInLibrary, albumStatus: m.albumStatus }));
vi.mock('./download-actions.js', () => ({
    downloadActionsService: { ensureReady: vi.fn(), enqueue: m.enqueue }
}));
vi.mock('./qobuz-library/service.js', () => ({ qobuzLibraryService: { listFavorites: m.listFavorites } }));

import { downloadFavorites } from './favorites-download.js';

describe('downloadFavorites', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m.enqueue.mockResolvedValue({ queued: 1, deduped: 0 });
    });

    it('skips tracks on disk and complete albums, queues the rest', async () => {
        m.listFavorites.mockImplementation(async (kind: string) =>
            kind === 'tracks'
                ? { items: [{ id: 1 }, { id: 2 }], has_more: false }
                : { items: [{ id: 'full', tracks_count: 2 }, { id: 'half', tracks_count: 4 }], has_more: false }
        );
        m.isTrackInLibrary.mockImplementation((id: string) => id === '1');
        m.albumStatus.mockImplementation((id: string) => ({ status: id === 'full' ? 'complete' : 'partial' }));

        const result = await downloadFavorites('all', 27, 'test');

        expect(result).toEqual({ queued: 2, deduped: 0, skipped: 2, failed: 0 });
        expect(m.albumStatus).toHaveBeenCalledWith('full', 2);
        expect(m.enqueue.mock.calls.map(([arg]) => [arg.type, arg.id])).toEqual([
            ['album', 'half'],
            ['track', '2']
        ]);
    });
});

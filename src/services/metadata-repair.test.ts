import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getTrack: vi.fn(), writeMetadata: vi.fn() }));
vi.mock('../api/qobuz.js', () => ({ qobuzApi: { getTrack: mocks.getTrack, getAlbum: vi.fn() } }));
vi.mock('./metadata.js', () => ({
    default: class {
        extractMetadata = vi.fn().mockResolvedValue({ title: 'T', artist: 'A', album: 'B' });
        getCoverUrlCandidates = () => [];
        writeMetadata = mocks.writeMetadata;
    }
}));
vi.mock('../config.js', () => ({ CONFIG: { metadata: { embedCover: true, coverSize: 'max' } } }));
vi.mock('../utils/paths.js', () => ({ isPathWithinManagedRoots: (p: string) => p.startsWith('/music/') }));
vi.mock('../utils/logger.js', () => ({ logger: { debug: vi.fn() } }));

import { retagFileFromQobuz } from './metadata-repair.js';

describe('retagFileFromQobuz', () => {
    it('refuses paths outside the library and bad ids before touching Qobuz', async () => {
        await expect(retagFileFromQobuz('/etc/passwd', 1)).rejects.toThrow(/outside/);
        await expect(retagFileFromQobuz('/music/a.flac', 'x')).rejects.toThrow(/numeric/);
        expect(mocks.getTrack).not.toHaveBeenCalled();
    });

    it('writes tags built from the Qobuz track', async () => {
        mocks.getTrack.mockResolvedValue({ success: true, data: { id: 1 } });
        const result = await retagFileFromQobuz('/music/a.flac', 1);
        expect(mocks.writeMetadata).toHaveBeenCalledWith('/music/a.flac', expect.objectContaining({ title: 'T' }), 0, null, null);
        expect(result).toMatchObject({ title: 'T', cover_embedded: false });
    });
});

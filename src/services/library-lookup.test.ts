import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const getAlbum = vi.hoisted(() => vi.fn());

vi.mock('./database/index.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('./database/index.js')>();
    return { ...mod, databaseService: new mod.DatabaseService(':memory:') };
});
vi.mock('../api/qobuz.js', () => ({ qobuzApi: { getAlbum }, default: { getAlbum } }));
vi.mock('../utils/logger.js', () => ({
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() }
}));

import { databaseService } from './database/index.js';
import { albumStatus, checkAlbums, checkTracks, isTrackInLibrary, searchLocalLibrary } from './library-lookup.js';

describe('library-lookup', () => {
    let dir: string;
    const file = (name: string): string => path.join(dir, name);

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-lookup-'));
        for (const name of ['a1.flac', 'a2.flac', 'b1.flac', 'lib.flac']) fs.writeFileSync(file(name), 'x');
        databaseService.initialize();
        // Album A: 3 tracks on Qobuz, 2 on disk, one row whose file was deleted.
        databaseService.addTrack({ id: '11', title: 'A One', artist: 'Band', album: 'Album A', album_id: 'albA', file_path: file('a1.flac'), quality: 27 });
        databaseService.addTrack({ id: '12', title: 'A Two', artist: 'Band', album: 'Album A', album_id: 'albA', file_path: file('a2.flac'), quality: 6 });
        databaseService.addTrack({ id: '13', title: 'A Three', artist: 'Band', album: 'Album A', album_id: 'albA', file_path: file('gone.flac') });
        // Album B: 1 track, on disk.
        databaseService.addTrack({ id: '21', title: 'B One', artist: 'Solo', album: 'Album B', album_id: 'albB', file_path: file('b1.flac') });
        databaseService.addLibraryFile({ file_path: file('lib.flac'), title: 'Loose File', artist: 'Band', album: 'Bootleg', quality: 6, format: 'flac' });
    });

    afterAll(() => {
        databaseService.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        getAlbum.mockReset();
    });

    it('checkTracks needs both the row and the file on disk', () => {
        const result = checkTracks(['11', 13, '99', '11']);
        expect(Object.keys(result).sort()).toEqual(['11', '13', '99']);
        expect(result['11']).toEqual({ in_library: true, quality: 27, file_path: file('a1.flac') });
        expect(result['13']).toEqual({ in_library: false });
        expect(result['99']).toEqual({ in_library: false });
        expect(isTrackInLibrary(12)).toBe(true);
        expect(isTrackInLibrary('13')).toBe(false);
    });

    it('albumStatus compares tracks on disk with the Qobuz count', () => {
        expect(albumStatus('albA', 3)).toEqual({ status: 'partial', downloaded: 2, total: 3 });
        expect(albumStatus('albA', 2)).toEqual({ status: 'complete', downloaded: 2, total: 2 });
        expect(albumStatus('albB', 1).status).toBe('complete');
        expect(albumStatus('albA').status).toBe('partial');
        expect(albumStatus('nope', 10)).toEqual({ status: 'missing', downloaded: 0, total: 10 });
    });

    it('checkAlbums fetches the track count only for albums with local tracks', async () => {
        getAlbum.mockResolvedValue({ success: true, data: { tracks_count: 1 } });
        const result = await checkAlbums(['albB', 'nope']);
        expect(result.albB).toEqual({ status: 'complete', downloaded: 1, total: 1 });
        expect(result.nope).toEqual({ status: 'missing', downloaded: 0, total: null });
        expect(getAlbum).toHaveBeenCalledTimes(1);
        expect(getAlbum).toHaveBeenCalledWith('albB');
    });

    it('checkAlbums uses caller totals and survives Qobuz errors', async () => {
        getAlbum.mockRejectedValue(new Error('offline'));
        const result = await checkAlbums(['albA', 'albB'], { totals: { albA: 3 } });
        expect(result.albA?.status).toBe('partial');
        expect(result.albB).toEqual({ status: 'partial', downloaded: 1, total: null });
        expect(getAlbum).toHaveBeenCalledTimes(1);
    });

    it('searchLocalLibrary pages over downloaded tracks', () => {
        const page = searchLocalLibrary('band', { limit: 2 });
        expect(page.total).toBe(3);
        expect(page.items).toHaveLength(2);
        expect(page.has_more).toBe(true);
        expect(page.items[0]).toMatchObject({ source: 'tracks', album_id: 'albA', library_file_id: null });
        const last = searchLocalLibrary('band', { limit: 2, offset: 2 });
        expect(last.items).toHaveLength(1);
        expect(last.has_more).toBe(false);
        const gone = searchLocalLibrary('A Three');
        expect(gone.items[0]).toMatchObject({ track_id: '13', on_disk: false });
    });

    it('searchLocalLibrary can search scanned files and clamps paging', () => {
        const page = searchLocalLibrary('bootleg', { source: 'files', limit: 1000, offset: -3 });
        expect(page.limit).toBe(100);
        expect(page.offset).toBe(0);
        expect(page.items).toEqual([
            expect.objectContaining({ source: 'files', title: 'Loose File', track_id: null, on_disk: true, format: 'flac' })
        ]);
        expect(typeof page.items[0]?.library_file_id).toBe('number');
    });
});

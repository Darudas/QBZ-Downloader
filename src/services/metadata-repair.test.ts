import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/qbz-retag-${process.pid}`.replace(/\/+/g, '/'));
const mocks = vi.hoisted(() => ({
    getTrack: vi.fn(),
    getAlbum: vi.fn(),
    writeFlacTags: vi.fn(),
    writeId3Tags: vi.fn(),
    parseFile: vi.fn(),
    axiosGet: vi.fn(),
    coverUrls: [] as string[],
    indexed: new Set<string>(),
    updateLibraryFileTags: vi.fn(),
    updateTrackTagsByPath: vi.fn()
}));
vi.mock('../api/qobuz.js', () => ({ qobuzApi: { getTrack: mocks.getTrack, getAlbum: mocks.getAlbum } }));
vi.mock('./metadata.js', () => ({
    default: class {
        static runExclusive = <T>(op: () => Promise<T> | T) => Promise.resolve().then(op);
        extractMetadata = vi.fn().mockResolvedValue({
            title: 'T',
            artist: 'A',
            album: 'B',
            albumArtist: 'AA',
            genre: 'Jazz',
            year: '1959-08-17',
            isrc: 'US123',
            label: ''
        });
        getCoverUrlCandidates = () => mocks.coverUrls;
        buildFlacTags = () => [['TITLE', 'T']];
        buildId3Tags = (_m: unknown, cover: Buffer | null) =>
            cover ? { title: 'T', image: { mime: 'image/jpeg', imageBuffer: cover } } : { title: 'T' };
        writeFlacTags = mocks.writeFlacTags;
        writeId3Tags = mocks.writeId3Tags;
    }
}));
vi.mock('music-metadata', () => ({ parseFile: mocks.parseFile }));
vi.mock('axios', () => ({ default: { get: mocks.axiosGet } }));
vi.mock('./database/index.js', () => ({
    databaseService: {
        getLibraryFileByPath: (p: string) => (mocks.indexed.has(p) ? { id: 1, file_path: p } : undefined),
        getTrackByPath: () => undefined,
        updateLibraryFileTags: mocks.updateLibraryFileTags,
        updateTrackTagsByPath: mocks.updateTrackTagsByPath
    }
}));
vi.mock('../config.js', () => ({ CONFIG: { metadata: { embedCover: true, coverSize: 'max' } } }));
vi.mock('../utils/paths.js', () => ({ isPathWithinManagedRoots: (p: string) => p.startsWith(root) }));
vi.mock('../utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn() } }));

import { retagFileFromQobuz } from './metadata-repair.js';

const file = (name: string, index = true): string => {
    const p = path.join(root, name);
    fs.writeFileSync(p, 'audio');
    if (index) mocks.indexed.add(p);
    return p;
};

describe('retagFileFromQobuz', () => {
    beforeEach(() => {
        fs.mkdirSync(root, { recursive: true });
        vi.clearAllMocks();
        mocks.indexed.clear();
        mocks.coverUrls = [];
        mocks.getTrack.mockResolvedValue({ success: true, data: { id: 1, album: { id: 'alb' } } });
        mocks.getAlbum.mockResolvedValue({ success: true, data: { id: 'alb', image: {} } });
        mocks.parseFile.mockResolvedValue({ common: {} });
    });

    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it('refuses paths outside the library and bad ids before touching Qobuz', async () => {
        await expect(retagFileFromQobuz('/etc/passwd', 1)).rejects.toThrow(/outside/);
        await expect(retagFileFromQobuz(path.join(root, 'a.flac'), 'x')).rejects.toThrow(/numeric/);
        expect(mocks.getTrack).not.toHaveBeenCalled();
    });

    it('refuses unsupported formats, missing files, directories and files that are not indexed', async () => {
        await expect(retagFileFromQobuz(file('a.m4a'), 1)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(retagFileFromQobuz(path.join(root, 'gone.flac'), 1)).rejects.toThrow(/not found/i);
        fs.mkdirSync(path.join(root, 'dir.flac'), { recursive: true });
        mocks.indexed.add(path.join(root, 'dir.flac'));
        await expect(retagFileFromQobuz(path.join(root, 'dir.flac'), 1)).rejects.toThrow(/not found/i);
        await expect(retagFileFromQobuz(file('stray.flac', false), 1)).rejects.toThrow(/index/);
        expect(mocks.getTrack).not.toHaveBeenCalled();
        expect(mocks.writeFlacTags).not.toHaveBeenCalled();
    });

    it('writes an upper-case .FLAC and updates the index rows', async () => {
        const target = file('Song.FLAC');
        const result = await retagFileFromQobuz(target, 1);
        expect(mocks.writeFlacTags).toHaveBeenCalledWith(target, [['TITLE', 'T']], null);
        expect(result).toMatchObject({ title: 'T', cover_embedded: false, cover_kept: false });
        expect(mocks.updateLibraryFileTags).toHaveBeenCalledWith(target, {
            title: 'T',
            artist: 'A',
            album_artist: 'AA',
            album: 'B'
        });
        expect(mocks.updateTrackTagsByPath).toHaveBeenCalledWith(target, {
            title: 'T',
            artist: 'A',
            album_artist: 'AA',
            album: 'B',
            genre: 'Jazz',
            year: 1959,
            isrc: 'US123',
            label: undefined
        });
    });

    it('keeps the existing embedded cover when no cover could be fetched', async () => {
        const png = Buffer.from('png-cover');
        mocks.parseFile.mockResolvedValue({ common: { picture: [{ format: 'image/png', data: new Uint8Array(png) }] } });
        const flac = file('keep.flac');
        const flacResult = await retagFileFromQobuz(flac, 1);
        expect(mocks.writeFlacTags).toHaveBeenCalledWith(flac, expect.anything(), png);
        expect(flacResult).toMatchObject({ cover_embedded: false, cover_kept: true });

        const mp3 = file('keep.MP3');
        await retagFileFromQobuz(mp3, 1);
        expect(mocks.writeId3Tags).toHaveBeenCalledWith(mp3, {
            title: 'T',
            image: { mime: 'image/png', imageBuffer: png }
        });
    });

    it('embeds a fetched cover instead of the existing one', async () => {
        mocks.coverUrls = ['https://static.qobuz.com/images/covers/x.jpg'];
        mocks.axiosGet.mockResolvedValue({ data: Buffer.from('new-cover') });
        const target = file('new.flac');
        const result = await retagFileFromQobuz(target, 1);
        expect(mocks.parseFile).not.toHaveBeenCalled();
        expect(mocks.writeFlacTags).toHaveBeenCalledWith(target, expect.anything(), Buffer.from('new-cover'));
        expect(result).toMatchObject({ cover_embedded: true, cover_kept: false });
    });
});

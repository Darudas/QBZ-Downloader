import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ root: '', add: vi.fn(), cleanup: vi.fn() }));

vi.mock('./database/index.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('./database/index.js')>();
    return { ...mod, databaseService: new mod.DatabaseService(':memory:') };
});
vi.mock('./queue/queue.js', () => ({ downloadQueue: { add: h.add } }));
vi.mock('./history.js', () => ({ historyService: { cleanup: h.cleanup } }));
vi.mock('../utils/paths.js', () => ({
    isPathWithinManagedRoots: (p: unknown) => typeof p === 'string' && p.startsWith(h.root + path.sep)
}));
vi.mock('../config.js', () => ({
    normalizeDownloadQuality: (v: unknown, d: number) => ([5, 6, 7, 27].includes(Number(v)) ? Number(v) : d)
}));
vi.mock('../utils/logger.js', () => ({
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() }
}));

import { databaseService } from './database/index.js';
import { deleteLibraryFile, editTrackMetadata, queueUpgrade, resolveDuplicate } from './library-actions.js';
import { readFlacComments } from './tag-editor.js';

const minimalFlac = (comments: string[]): Buffer => {
    const u32 = (n: number) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n);
        return b;
    };
    const vendor = Buffer.from('v');
    const body = Buffer.concat([
        u32(vendor.length),
        vendor,
        u32(comments.length),
        ...comments.flatMap((c) => [u32(Buffer.byteLength(c)), Buffer.from(c)])
    ]);
    const header = (type: number, size: number, last: boolean) => {
        const b = Buffer.alloc(4);
        b[0] = (last ? 0x80 : 0) | type;
        b.writeUIntBE(size, 1, 3);
        return b;
    };
    return Buffer.concat([
        Buffer.from('fLaC'),
        header(0, 34, false),
        Buffer.alloc(34),
        header(4, body.length, true),
        body,
        Buffer.from([0xff, 0xf8, 1, 2, 3])
    ]);
};

describe('library-actions', () => {
    const file = (name: string) => path.join(h.root, name);
    const db = () => databaseService.getDb();
    const addDuplicate = (a: string, b: string): number => {
        databaseService.addDuplicate(a, b, 'exact', 1);
        return (db().prepare('SELECT MAX(id) AS id FROM duplicates').get() as { id: number }).id;
    };

    beforeAll(() => {
        h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-actions-'));
        databaseService.initialize();
    });
    afterAll(() => {
        databaseService.close();
        fs.rmSync(h.root, { recursive: true, force: true });
    });
    beforeEach(() => {
        vi.clearAllMocks();
        for (const table of ['library_files', 'tracks', 'duplicates']) db().prepare(`DELETE FROM ${table}`).run();
    });

    describe('resolveDuplicate', () => {
        const pair = (q1: number, q2: number, s1 = 10, s2 = 10) => {
            fs.writeFileSync(file('one.flac'), Buffer.alloc(s1));
            fs.writeFileSync(file('two.flac'), Buffer.alloc(s2));
            databaseService.addLibraryFile({ file_path: file('one.flac'), quality: q1, file_size: s1 });
            databaseService.addLibraryFile({ file_path: file('two.flac'), quality: q2, file_size: s2 });
            databaseService.addTrack({ id: '2', title: 'Two', file_path: file('two.flac') });
            return addDuplicate(file('one.flac'), file('two.flac'));
        };

        it('auto keeps the higher quality, deletes the other and its index rows', async () => {
            const id = pair(27, 6);
            const result = await resolveDuplicate(id);
            expect(result).toMatchObject({ resolved: true, deleted: true, deletedFile: file('two.flac'), keptFile: file('one.flac') });
            expect(fs.existsSync(file('two.flac'))).toBe(false);
            expect(fs.existsSync(file('one.flac'))).toBe(true);
            expect(databaseService.getLibraryFileByPath(file('two.flac'))).toBeUndefined();
            expect(databaseService.getTrack('2')).toBeUndefined();
            expect(databaseService.getDuplicates()).toEqual([]);
            expect(h.cleanup).toHaveBeenCalled();
        });

        it('auto falls back to the larger file, keep=second overrides it', async () => {
            let id = pair(6, 6, 20, 10);
            expect((await resolveDuplicate(id, { dryRun: true })).deletedFile).toBe(file('two.flac'));
            id = pair(6, 6, 20, 10);
            const result = await resolveDuplicate(id, { keep: 'second' });
            expect(result.deletedFile).toBe(file('one.flac'));
            expect(fs.existsSync(file('one.flac'))).toBe(false);
        });

        it('dryRun changes nothing', async () => {
            const id = pair(27, 6);
            const result = await resolveDuplicate(id, { dryRun: true });
            expect(result).toMatchObject({ dryRun: true, resolved: false, deleted: false, deletedFile: file('two.flac') });
            expect(fs.existsSync(file('two.flac'))).toBe(true);
            expect(databaseService.getDuplicates()).toHaveLength(1);
        });

        it('refuses pairs outside the library and unknown ids', async () => {
            const id = addDuplicate('/etc/passwd', file('two.flac'));
            await expect(resolveDuplicate(id)).rejects.toMatchObject({ statusCode: 403 });
            await expect(resolveDuplicate(99999)).rejects.toMatchObject({ statusCode: 404 });
        });

        it('marks a pair stale when both files are gone', async () => {
            const id = addDuplicate(file('gone1.flac'), file('gone2.flac'));
            databaseService.addLibraryFile({ file_path: file('gone1.flac') });
            const result = await resolveDuplicate(id);
            expect(result).toMatchObject({ resolved: true, deleted: false });
            expect(databaseService.getLibraryFileByPath(file('gone1.flac'))).toBeUndefined();
        });

        it('never deletes when both entries are the same file', async () => {
            fs.writeFileSync(file('same.flac'), 'x');
            fs.rmSync(file('link.flac'), { force: true });
            fs.linkSync(file('same.flac'), file('link.flac'));
            const id = addDuplicate(file('same.flac'), file('link.flac'));
            await expect(resolveDuplicate(id)).rejects.toMatchObject({ statusCode: 400 });
            expect(fs.existsSync(file('same.flac'))).toBe(true);
        });
    });

    describe('deleteLibraryFile', () => {
        it('deletes an indexed file and its rows, by path or by id', async () => {
            fs.writeFileSync(file('del.flac'), 'x');
            databaseService.addLibraryFile({ file_path: file('del.flac') });
            databaseService.addTrack({ id: '5', title: 'Del', file_path: file('del.flac') });
            const result = deleteLibraryFile({ filePath: file('del.flac') });
            expect(result).toEqual({ filePath: file('del.flac'), deleted: true, removedRows: { libraryFiles: 1, tracks: 1 } });
            expect(fs.existsSync(file('del.flac'))).toBe(false);
            expect(databaseService.getTrack('5')).toBeUndefined();

            fs.writeFileSync(file('byid.flac'), 'x');
            databaseService.addLibraryFile({ file_path: file('byid.flac') });
            const row = databaseService.getLibraryFileByPath(file('byid.flac')) as { id: number };
            expect(deleteLibraryFile({ libraryFileId: row.id }).deleted).toBe(true);
        });

        it('finds rows stored with a relative path (scanner) and an absolute one (download)', () => {
            fs.writeFileSync(file('mixed.flac'), 'x');
            const relative = path.relative(process.cwd(), file('mixed.flac'));
            databaseService.addLibraryFile({ file_path: relative });
            databaseService.addTrack({ id: '77', title: 'Mixed', file_path: file('mixed.flac') });

            const result = deleteLibraryFile({ filePath: file('mixed.flac') });

            expect(result.removedRows).toEqual({ libraryFiles: 1, tracks: 1 });
            expect(databaseService.getLibraryFileByPath(relative)).toBeUndefined();
            expect(databaseService.getTrack('77')).toBeUndefined();
        });

        it('refuses files outside the library or not in the index', () => {
            expect(() => deleteLibraryFile({ filePath: '/etc/hosts' })).toThrow(/outside/);
            fs.writeFileSync(file('cover.jpg'), 'x');
            expect(() => deleteLibraryFile({ filePath: file('cover.jpg') })).toThrow(/not in the library index/);
            expect(fs.existsSync(file('cover.jpg'))).toBe(true);
            expect(() => deleteLibraryFile({ libraryFileId: 424242 })).toThrow(/not found/);
        });
    });

    describe('editTrackMetadata', () => {
        it('patches the file and the index rows', async () => {
            const target = file('edit.flac');
            fs.writeFileSync(target, minimalFlac(['TITLE=Old', 'ARTIST=Band', 'REPLAYGAIN_TRACK_GAIN=-3 dB']));
            databaseService.addLibraryFile({ file_path: target, title: 'Old', artist: 'Band', file_size: 1 });
            databaseService.addTrack({ id: '9', title: 'Old', artist: 'Band', file_path: target });

            const result = await editTrackMetadata(target, { title: ' New ', year: 1999, genre: 'Jazz' });

            expect(result).toEqual({ filePath: target, updated: ['title', 'genre', 'year'] });
            const comments = readFlacComments(target);
            expect(comments.TITLE).toEqual(['New']);
            expect(comments.ARTIST).toEqual(['Band']);
            expect(comments.REPLAYGAIN_TRACK_GAIN).toEqual(['-3 dB']);
            const lib = databaseService.getLibraryFileByPath(target) as { title: string; file_size: number };
            expect(lib.title).toBe('New');
            expect(lib.file_size).toBe(fs.statSync(target).size);
            expect(databaseService.getTrack('9')).toMatchObject({ title: 'New', genre: 'Jazz', year: 1999 });
        });

        it('validates path, format and fields', async () => {
            await expect(editTrackMetadata('/etc/x.flac', { title: 'x' })).rejects.toMatchObject({ statusCode: 403 });
            fs.writeFileSync(file('x.m4a'), 'x');
            await expect(editTrackMetadata(file('x.m4a'), { title: 'x' })).rejects.toMatchObject({ statusCode: 400 });
            await expect(editTrackMetadata(file('nope.flac'), { title: 'x' })).rejects.toMatchObject({ statusCode: 404 });
            await expect(editTrackMetadata(file('edit.flac'), {})).rejects.toMatchObject({ statusCode: 400 });
            await expect(editTrackMetadata(file('edit.flac'), { isrc: 'bad' })).rejects.toMatchObject({ statusCode: 400 });
            await expect(editTrackMetadata(file('edit.flac'), { year: '99' })).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    describe('queueUpgrade', () => {
        it('accepts a library_files id and builds the metadata server-side', () => {
            h.add.mockReturnValue({ id: 'q1' });
            databaseService.addLibraryFile({
                file_path: file('up.flac'),
                upgrade_candidates: [{ trackId: '77', quality: 27, title: 'T', album: 'A' }]
            });
            const row = databaseService.getLibraryFileByPath(file('up.flac')) as { id: number };
            queueUpgrade({ libraryFileId: row.id });
            expect(h.add).toHaveBeenCalledWith('track', '77', 27, {
                metadata: expect.objectContaining({ isUpgrade: true, oldFilePath: file('up.flac'), libraryFileId: row.id })
            });
            expect(() => queueUpgrade({ libraryFileId: 999999 })).toThrow(/not in the scanned library/);
            expect(() => queueUpgrade({ libraryFileId: 'x' })).toThrow(/positive integer/);
        });
    });
});

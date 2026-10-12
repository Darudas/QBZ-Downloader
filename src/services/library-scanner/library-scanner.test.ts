import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LibraryScannerService, isTemporaryDownloadFile, isPathInsideDirectory } from './index.js';
import { databaseService } from '../database/index.js';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock dependencies
vi.mock('../database/index.js', () => ({
    databaseService: {
        clearLibraryScan: vi.fn(),
        clearDuplicateScan: vi.fn(),
        getLibraryFiles: vi.fn().mockReturnValue([]),
        getLibraryFileByPath: vi.fn(),
        deleteLibraryFileByPath: vi.fn(),
        addLibraryFile: vi.fn(),
        addDuplicate: vi.fn(),
        deleteTrackByPath: vi.fn(),
        resolveDuplicate: vi.fn(),
        getUpgradeableFiles: vi.fn().mockReturnValue([]),
        getDuplicates: vi.fn().mockReturnValue([]),
        getMissingMetadataFiles: vi.fn().mockReturnValue([]),
        getDb: vi.fn().mockReturnValue({
            prepare: vi.fn().mockReturnValue({
                get: vi.fn().mockReturnValue({ count: 0, size: 0 }),
                all: vi.fn().mockReturnValue([]),
                run: vi.fn()
            })
        })
    }
}));

vi.mock('../../utils/binaries.js', () => ({
    checkBinaryAvailability: vi.fn().mockResolvedValue({ available: false })
}));

vi.mock('../history.js', () => ({
    historyService: {
        cleanup: vi.fn()
    }
}));

vi.mock('../../utils/logger.js', () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        success: vi.fn()
    }
}));

vi.mock('../../utils/http.js', () => ({
    downloadFile: vi.fn().mockImplementation(() => {
        const stream = new EventEmitter();
        (stream as unknown as { destroy: () => void; destroyed: boolean }).destroy = vi.fn(
            () => {
                (stream as unknown as { destroyed: boolean }).destroyed = true;
            }
        );
        (stream as unknown as { destroyed: boolean }).destroyed = false;
        setTimeout(() => stream.emit('data', Buffer.alloc(2048)), 0);
        return Promise.resolve({ data: stream });
    })
}));

vi.mock('../../api/qobuz.js', () => {
    const mock = vi.fn().mockImplementation(() => {
        return {
            search: vi.fn().mockResolvedValue({ success: true, data: { tracks: { items: [] } } }),
            getFileUrl: vi.fn().mockResolvedValue({ success: true, data: { format_id: 6 } })
        };
    });
    return {
        default: mock,
        QobuzAPI: mock,
        isSampleStream: vi.fn().mockReturnValue(false)
    };
});



describe('LibraryScannerService', () => {
    let scanner: LibraryScannerService;

    beforeEach(() => {
        vi.clearAllMocks();
        scanner = new LibraryScannerService();
    });

    describe('String Utilities', () => {
        it('should normalize strings correctly', () => {
            const input = '  Testing...  123!!!  ';
            const expected = 'testing 123';
            expect(scanner.normalizeString(input)).toBe(expected);
        });

        it('should calculate similarity correctly', () => {
            expect(scanner.similarity('hello', 'hello')).toBe(1);
            expect(scanner.similarity('hello', 'hallo')).toBeGreaterThan(0.7);
            expect(scanner.similarity('hello', 'world')).toBeLessThan(0.3);
        });

        it('should identify substrings as highly similar', () => {
            expect(scanner.similarity('stereo love', 'stereo love (original mix)')).toBe(0.9);
        });
    });

    describe('Duplicate Detection Logic', () => {
        it('should detect duplicates based on fingerprints', async () => {
            vi.mocked(databaseService.getLibraryFiles).mockReturnValue([
                { file_path: 'path1', audio_fingerprint: 'fp1', title: 'Song 1' },
                { file_path: 'path2', audio_fingerprint: 'fp1', title: 'Song 1 (Alt)' }
            ]);

            const count = await scanner.detectDuplicates();
            expect(count).toBe(1);
            expect(databaseService.addDuplicate).toHaveBeenCalledWith('path1', 'path2', 'exact', 1.0);
        });

        it('should detect duplicates based on metadata similarity', async () => {
            vi.mocked(databaseService.getLibraryFiles).mockReturnValue([
                { file_path: 'path1', audio_fingerprint: null, title: 'Stereo Love', artist: 'Edward Maya' },
                { file_path: 'path2', audio_fingerprint: null, title: 'stereo love', artist: 'Edward Maya & Vika Jigulina' }
            ]);

            const count = await scanner.detectDuplicates();
            expect(count).toBe(1);
            expect(databaseService.addDuplicate).toHaveBeenCalledWith(
                expect.any(String), 
                expect.any(String), 
                'similar', 
                expect.any(Number)
            );
        });

        it('should not flag remix releases as duplicates based on title only', async () => {
            vi.mocked(databaseService.getLibraryFiles).mockReturnValue([
                {
                    file_path: 'Music/The Weeknd/After Hours (Explicit)/11. Save Your Tears.flac',
                    audio_fingerprint: null,
                    title: 'Save Your Tears',
                    artist: 'The Weeknd',
                    album: 'After Hours (Explicit)'
                },
                {
                    file_path: 'Music/The Weeknd/Save Your Tears (Remix with Ariana Grande)/01. Save Your Tears.flac',
                    audio_fingerprint: null,
                    title: 'Save Your Tears',
                    artist: 'The Weeknd',
                    album: 'Save Your Tears (Remix with Ariana Grande)'
                }
            ]);

            const count = await scanner.detectDuplicates();

            expect(count).toBe(0);
            expect(databaseService.addDuplicate).not.toHaveBeenCalled();
        });
    });

    describe('Temporary download files', () => {
        it('recognises every staging name the downloader writes', () => {
            expect(isTemporaryDownloadFile('/m/A/01. Song.qbz-part.flac')).toBe(true);
            expect(isTemporaryDownloadFile('/m/A/01. Song.qbz-part')).toBe(true);
            expect(isTemporaryDownloadFile('/m/A/01. Song.qbz-replace-1700000000000.flac')).toBe(true);
            expect(isTemporaryDownloadFile('/m/A/01. Song.qbz-replace-1700000000000-2.flac')).toBe(true);
            expect(isTemporaryDownloadFile('/m/A/01. Song.qbz-backup-1700000000000.mp3')).toBe(true);
            expect(isTemporaryDownloadFile('C:\\m\\01. Song.QBZ-PART.FLAC')).toBe(true);
        });

        it('leaves real tracks alone, even with qbz in the name', () => {
            expect(isTemporaryDownloadFile('/m/A/01. Song.flac')).toBe(false);
            expect(isTemporaryDownloadFile('/m/qbz-part/01. Song.flac')).toBe(false);
            expect(isTemporaryDownloadFile('/m/A/01. qbz-part of me.flac')).toBe(false);
            expect(isTemporaryDownloadFile('/m/A/01. Song.qbz-replace-final.flac')).toBe(false);
        });

        it('does not collect temp files when walking the library', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-scan-'));
            try {
                fs.writeFileSync(path.join(dir, 'a.flac'), 'x');
                fs.writeFileSync(path.join(dir, 'a.qbz-part.flac'), 'x');
                fs.writeFileSync(path.join(dir, 'b.qbz-replace-1700000000000.flac'), 'x');
                fs.writeFileSync(path.join(dir, 'c.qbz-backup-1700000000000.mp3'), 'x');
                const internals = scanner as unknown as {
                    collectAudioFiles(dir: string): Promise<{ filePath: string }[]>;
                };
                const files = await internals.collectAudioFiles(dir);
                expect(files.map((f) => path.basename(f.filePath))).toEqual(['a.flac']);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('never pairs a previously indexed temp file as a duplicate', async () => {
            vi.mocked(databaseService.getLibraryFiles).mockReturnValue([
                { file_path: '/m/A/01. Song.flac', audio_fingerprint: 'fp', title: 'Song', artist: 'A' },
                { file_path: '/m/A/01. Song.qbz-backup-1700000000000.flac', audio_fingerprint: 'fp', title: 'Song', artist: 'A' }
            ] as never);
            const internals = scanner as unknown as { detectDuplicates(): Promise<number> };
            expect(await internals.detectDuplicates()).toBe(0);
            expect(databaseService.addDuplicate).not.toHaveBeenCalled();
        });
    });

    describe('Subfolder scans', () => {
        it('isPathInsideDirectory matches only real descendants', () => {
            expect(isPathInsideDirectory('/music/A/x.flac', '/music/A')).toBe(true);
            expect(isPathInsideDirectory('/music/A', '/music/A')).toBe(true);
            expect(isPathInsideDirectory('/music/AB/x.flac', '/music/A')).toBe(false);
            expect(isPathInsideDirectory('/music/B/x.flac', '/music/A')).toBe(false);
        });

        it('keeps index rows outside the scanned folder and drops stale rows inside it', async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-subscan-'));
            const sub = path.join(root, 'Artist A');
            fs.mkdirSync(sub);
            const kept = path.join(sub, '01. Kept.flac');
            fs.writeFileSync(kept, 'abc');
            const stat = fs.statSync(kept);
            try {
                vi.mocked(databaseService.getLibraryFiles).mockReturnValue([
                    { file_path: kept, file_size: stat.size, file_mtime_ms: stat.mtimeMs, quality: 6, format: 'flac' },
                    { file_path: path.join(sub, '02. Gone.flac'), file_size: 1, file_mtime_ms: 1 },
                    { file_path: path.join(sub, '01. Kept.qbz-part.flac'), file_size: 1, file_mtime_ms: 1 },
                    { file_path: path.join(root, 'Artist B', '01. Other.flac'), file_size: 1, file_mtime_ms: 1 },
                    { file_path: path.join(root, 'Artist AB', '01. Sibling.flac'), file_size: 1, file_mtime_ms: 1 }
                ] as never);

                const result = await scanner.scanLibrary(sub, { detectDuplicates: false, checkUpgrades: false });

                expect(result.totalFiles).toBe(1);
                expect(result.cachedFiles).toBe(1);
                const deleted = vi.mocked(databaseService.deleteLibraryFileByPath).mock.calls.map((c) => c[0]);
                expect(deleted.sort()).toEqual(
                    [path.join(sub, '01. Kept.qbz-part.flac'), path.join(sub, '02. Gone.flac')].sort()
                );
                expect(databaseService.addLibraryFile).not.toHaveBeenCalled();
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    });

    describe('Upgrade Detection Logic', () => {
        it('should detect a Hi-Res upgrade from a different release with the same title and artist', async () => {
            const run = vi.fn();
            vi.mocked(databaseService.getDb).mockReturnValue({
                prepare: vi.fn().mockReturnValue({ run, get: vi.fn().mockReturnValue({ count: 1 }) })
            } as any);
            vi.mocked(databaseService.getLibraryFiles).mockReturnValue([
                {
                    file_path: 'Music/Artist/CD Release/01. Same Song.flac',
                    track_id: null,
                    available_quality: null,
                    quality: 6,
                    title: 'Same Song',
                    artist: 'Artist',
                    album: 'CD Release'
                }
            ]);

            (scanner as any).api = {
                search: vi.fn().mockResolvedValue({
                    success: true,
                    data: {
                        tracks: {
                            items: [
                                {
                                    id: 123,
                                    title: 'Same Song',
                                    performer: { name: 'Artist' },
                                    album: { title: 'Hi-Res Edition', artist: { name: 'Artist' } }
                                },
                                {
                                    id: 456,
                                    title: 'Same Song Remix',
                                    performer: { name: 'Artist' },
                                    album: { title: 'Remix Single', artist: { name: 'Artist' } }
                                }
                            ]
                        }
                    }
                }),
                getFileUrl: vi.fn().mockResolvedValue({
                    success: true,
                    data: { url: 'https://stream.example/track.flac', format_id: 27, quality_verified: true }
                })
            };

            const count = await (scanner as any).checkQobuzUpgrades();

            expect(count).toBe(1);
            expect(run).toHaveBeenCalledWith(
                '123',
                27,
                expect.stringContaining('"trackId":"123"'),
                'Music/Artist/CD Release/01. Same Song.flac'
            );
            expect(run.mock.calls[0][2]).toContain('"trackId":"456"');
            expect(run.mock.calls[0][2]).toContain('"variantWarning":true');
        });
    });

    describe('Quality Labels', () => {
        it('should return correct labels for qualities', () => {
            expect(scanner.getQualityLabel(5)).toBe('MP3 320');
            expect(scanner.getQualityLabel(6)).toBe('FLAC 16/44');
            expect(scanner.getQualityLabel(27)).toBe('FLAC 24/192');
            expect(scanner.getQualityLabel(123)).toBe('Q123');
        });
    });

    describe('Scanning State', () => {
        it('should report scanning status correctly', () => {
            expect(scanner.isScanInProgress()).toBe(false);
        });
    });
});

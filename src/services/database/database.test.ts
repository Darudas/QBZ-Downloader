import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseService } from './index.js';

// Mock logger to avoid console spam
vi.mock('../../utils/logger.js', () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        success: vi.fn()
    }
}));

describe('DatabaseService', () => {
    let dbService: DatabaseService;

    beforeEach(() => {
        dbService = new DatabaseService(':memory:');
        dbService.initialize();
    });

    afterEach(() => {
        dbService.close();
    });

    describe('Schema and Initialization', () => {
        it('should initialize and create tables', () => {
            const db = dbService.getDb();
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
            const tableNames = tables.map((t: unknown) => (t as { name: string }).name);
            
            expect(tableNames).toContain('tracks');
            expect(tableNames).toContain('albums');
            expect(tableNames).toContain('artists');
            expect(tableNames).toContain('queue_items');
            expect(tableNames).toContain('library_files');
        });

        it('should store and retrieve database version', () => {
            const db = dbService.getDb();
            const version = db.prepare("SELECT value FROM meta WHERE key = 'db_version'").get();
            expect(version.value).toBe('13');
        });

        it('should create a same-directory backup before migrating a file database', () => {
            dbService.close();

            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-db-migration-'));
            const dbPath = path.join(tempDir, 'qbz.db');
            const oldDb = new Database(dbPath);
            oldDb.exec(`
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                INSERT INTO meta (key, value) VALUES ('db_version', '10');
                CREATE TABLE library_files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT UNIQUE NOT NULL,
                    track_id TEXT,
                    title TEXT,
                    artist TEXT,
                    album_artist TEXT,
                    album TEXT,
                    duration INTEGER,
                    quality INTEGER,
                    available_quality INTEGER,
                    file_size INTEGER,
                    format TEXT,
                    bit_depth INTEGER,
                    sample_rate INTEGER,
                    scanned_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    needs_upgrade INTEGER DEFAULT 0,
                    upgrade_candidates TEXT,
                    audio_fingerprint TEXT,
                    missing_metadata INTEGER DEFAULT 0,
                    missing_tags TEXT,
                    checksum TEXT,
                    verification_status TEXT DEFAULT 'pending'
                );
            `);
            oldDb.close();

            const fileDbService = new DatabaseService(dbPath);
            fileDbService.initialize();
            fileDbService.close();

            const backupPath = path.join(tempDir, 'qbz.backup-v11.db');
            expect(fs.existsSync(backupPath)).toBe(true);

            const backupDb = new Database(backupPath, { readonly: true });
            const backupVersion = backupDb
                .prepare("SELECT value FROM meta WHERE key = 'db_version'")
                .get() as { value: string };
            const backupColumns = backupDb.prepare('PRAGMA table_info(library_files)').all() as {
                name: string;
            }[];
            backupDb.close();

            expect(backupVersion.value).toBe('10');
            expect(backupColumns.some((column) => column.name === 'file_mtime_ms')).toBe(false);

            fs.rmSync(tempDir, { recursive: true, force: true });
        }, 30000);

        it('should migrate tracks quality scan cache columns with a v12 backup', () => {
            dbService.close();

            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-db-v12-'));
            const dbPath = path.join(tempDir, 'qbz.db');
            const oldDb = new Database(dbPath);
            oldDb.exec(`
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                INSERT INTO meta (key, value) VALUES ('db_version', '11');
                CREATE TABLE tracks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    artist TEXT,
                    album_artist TEXT,
                    album TEXT,
                    album_id TEXT,
                    duration INTEGER DEFAULT 0,
                    quality INTEGER DEFAULT 27,
                    file_path TEXT,
                    file_size INTEGER DEFAULT 0,
                    cover_url TEXT,
                    downloaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    genre TEXT,
                    year INTEGER,
                    isrc TEXT,
                    label TEXT,
                    play_count INTEGER DEFAULT 0,
                    last_played TEXT,
                    checksum TEXT
                );
            `);
            oldDb.close();

            const fileDbService = new DatabaseService(dbPath);
            fileDbService.initialize();
            fileDbService.close();

            const backupPath = path.join(tempDir, 'qbz.backup-v12.db');
            expect(fs.existsSync(backupPath)).toBe(true);

            const migratedDb = new Database(dbPath, { readonly: true });
            const columns = migratedDb.prepare('PRAGMA table_info(tracks)').all() as {
                name: string;
            }[];
            const version = migratedDb
                .prepare("SELECT value FROM meta WHERE key = 'db_version'")
                .get() as { value: string };
            migratedDb.close();

            expect(version.value).toBe('13');
            expect(columns.some((column) => column.name === 'quality_scan_result')).toBe(true);
            expect(columns.some((column) => column.name === 'quality_scanned_at')).toBe(true);

            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    });

    describe('Track Management', () => {
        const testTrack = {
            id: 'track1',
            title: 'Test Track',
            artist: 'Test Artist',
            album: 'Test Album',
            duration: 180,
            quality: 27,
            file_path: '/path/to/track.flac',
            file_size: 1024
        };

        it('should add and retrieve a track', () => {
            dbService.addTrack(testTrack);
            const retrieved = dbService.getTrack('track1');
            expect(retrieved).toBeDefined();
            expect(retrieved!.title).toBe('Test Track');
            expect(retrieved!.artist).toBe('Test Artist');
        });

        it('should correctly handle track existence check', () => {
            expect(dbService.hasTrack('track1')).toBe(false);
            dbService.addTrack(testTrack);
            expect(dbService.hasTrack('track1')).toBe(true);
        });

        it('should search tracks by title or artist', () => {
            dbService.addTrack(testTrack);
            dbService.addTrack({ ...testTrack, id: 'track2', title: 'Other Song', artist: 'Someone Else' });
            
            const results = dbService.searchTracks('Track');
            expect(results.length).toBe(1);
            expect(results[0].title).toBe('Test Track');
        });

        it('should store and retrieve cached quality scan results by checksum', () => {
            const scanResult = {
                isTrueLossless: true,
                confidence: 100,
                details: 'OK'
            };
            dbService.addTrack({
                ...testTrack,
                checksum: 'abc123',
                quality_scan_result: JSON.stringify(scanResult),
                quality_scanned_at: '2026-05-25T00:00:00.000Z'
            });

            const cached = dbService.getQualityScanResult('track1', 'abc123');
            expect(cached?.result).toEqual(scanResult);
            expect(cached?.scannedAt).toBe('2026-05-25T00:00:00.000Z');
            expect(dbService.getQualityScanResult('track1', 'different')).toBeUndefined();
        });

    });

    describe('Statistics', () => {
        it('should update and retrieve daily stats', () => {
            dbService.addTrack({ id: 't1', title: 'T1' });
            const stats = dbService.getDailyStats(1);
            expect(stats.length).toBe(1);
            expect(stats[0].tracks).toBe(1);
        });

        it('should update genre stats', () => {
            dbService.addTrack({ id: 't1', title: 'T1', genre: 'Rock', file_size: 100 });
            const stats = dbService.getGenreStats(1);
            expect(stats.length).toBe(1);
            expect(stats[0].genre).toBe('Rock');
            expect(stats[0].count).toBe(1);
        });
    });

    describe('Library Management', () => {
        it('should add and retrieve library files', () => {
            dbService.addLibraryFile({
                file_path: '/lib/track.flac',
                title: 'Lib Track',
                quality: 27,
                file_mtime_ms: 12345
            });
            const files = dbService.getLibraryFiles();
            expect(files.length).toBe(1);
            expect(files[0].title).toBe('Lib Track');
            expect(files[0].file_mtime_ms).toBe(12345);
        });

        it('should calculate library health score', () => {
            dbService.addLibraryFile({ file_path: 'f1', missing_metadata: true });
            dbService.addLibraryFile({ file_path: 'f2', missing_metadata: false });
            
            const health = dbService.getLibraryHealth();
            expect(health.totalTracks).toBe(2);
            expect(health.healthScore).toBeLessThan(100);
        });
    });

    describe('Queue Management', () => {
        const testItem = {
            id: 'q1',
            type: 'track',
            contentId: 'c1',
            quality: 27,
            status: 'pending',
            priority: 'normal',
            progress: 0,
            title: 'Queue Item',
            addedAt: new Date()
        };

        it('should add and retrieve queue items', () => {
            dbService.addQueueItem(testItem);
            const items = dbService.getQueueItems();
            expect(items.length).toBe(1);
            expect(items[0].id).toBe('q1');
            expect(items[0].title).toBe('Queue Item');
        });

        it('should update queue item status', () => {
            dbService.addQueueItem(testItem);
            dbService.updateQueueItemStatus('q1', 'downloading', 50);
            const items = dbService.getQueueItems();
            expect(items[0].status).toBe('downloading');
            expect(items[0].progress).toBe(50);
        });
    });
    describe('Lookup indexes (v13)', () => {
        it('creates the lookup indexes', () => {
            const names = (
                dbService.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
            ).map((row) => row.name);
            expect(names).toEqual(
                expect.arrayContaining([
                    'idx_tracks_isrc',
                    'idx_tracks_album_id',
                    'idx_tracks_file_path',
                    'idx_library_track_id',
                    'idx_queue_items_status'
                ])
            );
        });

        it('upgrades a v12 database to v13 and adds the indexes', () => {
            dbService.close();
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-db-v13-'));
            const dbPath = path.join(tempDir, 'qbz.db');
            const first = new DatabaseService(dbPath);
            first.initialize();
            const raw = first.getDb();
            raw.exec('DROP INDEX idx_tracks_isrc; DROP INDEX idx_queue_items_status');
            raw.prepare("UPDATE meta SET value = '12' WHERE key = 'db_version'").run();
            first.close();

            const migrated = new DatabaseService(dbPath);
            try {
                migrated.initialize();
                const db = migrated.getDb();
                const version = db.prepare("SELECT value FROM meta WHERE key = 'db_version'").get() as { value: string };
                expect(version.value).toBe('13');
                const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
                    (row) => row.name
                );
                expect(names).toEqual(expect.arrayContaining(['idx_tracks_isrc', 'idx_queue_items_status']));
            } finally {
                migrated.close();
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            dbService = new DatabaseService(':memory:');
            dbService.initialize();
        });
    });

    describe('Paged lookups', () => {
        beforeEach(() => {
            dbService.addTrack({ id: '1', title: 'Alpha 100%', artist: 'Band', album: 'First', album_id: 'alb1', file_path: '/m/a.flac', downloaded_at: '2024-01-01T00:00:00.000Z' });
            dbService.addTrack({ id: '2', title: 'Beta', artist: 'Band', album: 'First', album_id: 'alb1', file_path: '/m/b.flac', downloaded_at: '2024-01-02T00:00:00.000Z' });
            dbService.addTrack({ id: '3', title: 'Gamma', artist: 'Other', album: 'Second', album_id: 'alb2', file_path: '/m/c.flac', downloaded_at: '2024-01-03T00:00:00.000Z' });
        });

        it('searchTracksPaged returns a page plus the total', () => {
            const page = dbService.searchTracksPaged('band', { limit: 1, offset: 0 });
            expect(page.total).toBe(2);
            expect(page.items.map((t) => t.id)).toEqual(['2']);
            expect(dbService.searchTracksPaged('band', { limit: 1, offset: 1 }).items.map((t) => t.id)).toEqual(['1']);
        });

        it('searchTracksPaged treats LIKE wildcards literally and clamps paging', () => {
            expect(dbService.searchTracksPaged('100%').items.map((t) => t.id)).toEqual(['1']);
            expect(dbService.searchTracksPaged('%').total).toBe(1);
            const page = dbService.searchTracksPaged('', { limit: -1, offset: -5 });
            expect(page.limit).toBe(25);
            expect(page.offset).toBe(0);
            expect(dbService.searchTracksPaged('', { limit: 100000 }).limit).toBe(500);
        });

        it('getTracksByAlbumId, getTracksByIds and getTrackByPath', () => {
            expect(dbService.getTracksByAlbumId('alb1').map((t) => t.id).sort()).toEqual(['1', '2']);
            expect(dbService.getTracksByIds(['3', '1', 'x']).map((t) => t.id).sort()).toEqual(['1', '3']);
            expect(dbService.getTracksByIds([])).toEqual([]);
            expect(dbService.getTrackByPath('/m/c.flac')?.id).toBe('3');
        });

        it('searchLibraryFiles and getLibraryFileById', () => {
            dbService.addLibraryFile({ file_path: '/m/x/one.flac', title: 'One', artist: 'Band', album: 'First' });
            dbService.addLibraryFile({ file_path: '/m/y/two.flac', title: 'Two', artist: 'Solo', album: 'Else' });
            const page = dbService.searchLibraryFiles('band');
            expect(page.total).toBe(1);
            const row = page.items[0] as { id: number; file_path: string };
            expect(row.file_path).toBe('/m/x/one.flac');
            expect(dbService.getLibraryFileById(row.id)?.title).toBe('One');
            expect(dbService.searchLibraryFiles('/m/y/').total).toBe(1);
            expect(dbService.getLibraryFileById(99999)).toBeUndefined();
        });

        it('updates tag columns for a file path only', () => {
            dbService.addLibraryFile({ file_path: '/m/a.flac', title: 'Alpha', artist: 'Band' });
            expect(dbService.updateTrackTagsByPath('/m/a.flac', { title: 'New', genre: 'Jazz' })).toBe(1);
            expect(dbService.getTrack('1')?.title).toBe('New');
            expect(dbService.getTrack('1')?.genre).toBe('Jazz');
            expect(dbService.getTrack('2')?.title).toBe('Beta');
            expect(dbService.updateLibraryFileTags('/m/a.flac', { album: 'Renamed', file_size: 42 })).toBe(1);
            const lib = dbService.getLibraryFileByPath('/m/a.flac') as { album: string; file_size: number; title: string };
            expect(lib.album).toBe('Renamed');
            expect(lib.file_size).toBe(42);
            expect(lib.title).toBe('Alpha');
            expect(dbService.updateTrackTagsByPath('/m/a.flac', {})).toBe(0);
        });
    });

    describe('History', () => {
        it('getHistorySorted binds its limit', () => {
            dbService.addHistoryEntry('1', { title: 'A', filename: 'a', downloadedAt: '2024-01-01T00:00:00Z' });
            dbService.addHistoryEntry('2', { title: 'B', filename: 'b', downloadedAt: '2024-01-02T00:00:00Z' });
            expect(dbService.getHistorySorted(1).map((r) => r.id)).toEqual(['2']);
            expect(dbService.getHistorySorted().length).toBe(2);
            expect(dbService.getHistorySorted(1.5 as number).length).toBe(2);
            expect(dbService.getHistorySorted('1; DROP TABLE history' as unknown as number).length).toBe(2);
        });
    });
});

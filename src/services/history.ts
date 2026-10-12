import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getDataDir } from '../utils/data-dir.js';
import { databaseService } from './database/index.js';

export interface HistoryEntry {
    downloadedAt: string;
    filename: string;
    quality: number;
    title: string;
    artist?: string;
    albumArtist?: string;
    artistImageUrl?: string;
    album?: string;
    type?: 'track' | 'album' | 'playlist' | 'artist' | 'label';
    qualityScan?: {
        isTrueLossless: boolean;
        confidence: number;
        details: string;
    };
}


export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 500;
const MAX_QUERY_LENGTH = 200;

export interface HistoryQuery {
    /** Case-insensitive substring matched against title, artist, album artist and album. */
    q?: string;
    limit?: number;
    offset?: number;
}

export type HistoryListEntry = { id: string } & HistoryEntry;

export interface HistoryPage {
    items: HistoryListEntry[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
}

interface HistoryRow {
    id: string;
    downloaded_at: string | null;
    filename: string | null;
    quality: number | null;
    title: string | null;
    artist: string | null;
    album_artist: string | null;
    artist_image_url: string | null;
    album: string | null;
    type: string | null;
    quality_scan: string | null;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

function parseQualityScan(raw: string | null): HistoryEntry['qualityScan'] {
    if (!raw) return undefined;
    try {
        return JSON.parse(raw) as HistoryEntry['qualityScan'];
    } catch {
        return undefined;
    }
}

function toListEntry(row: HistoryRow): HistoryListEntry {
    const entry: HistoryListEntry = {
        id: row.id,
        downloadedAt: row.downloaded_at ?? '',
        filename: row.filename ?? '',
        quality: row.quality ?? 0,
        title: row.title ?? ''
    };
    if (row.artist) entry.artist = row.artist;
    if (row.album_artist) entry.albumArtist = row.album_artist;
    if (row.artist_image_url) entry.artistImageUrl = row.artist_image_url;
    if (row.album) entry.album = row.album;
    if (row.type) entry.type = row.type as HistoryEntry['type'];
    const qualityScan = parseQualityScan(row.quality_scan);
    if (qualityScan) entry.qualityScan = qualityScan;
    return entry;
}

export class HistoryService {
    private jsonPath: string;

    constructor(historyPath?: string) {
        this.jsonPath = historyPath || path.join(getDataDir(), 'history.json');
        this.migrateFromJson();
    }

    private migrateFromJson(): void {
        try {
            if (fs.existsSync(this.jsonPath)) {
                const content = fs.readFileSync(this.jsonPath, 'utf8');
                const data = JSON.parse(content);

                if (data.entries && Object.keys(data.entries).length > 0) {
                    logger.info(`History: Migrating ${Object.keys(data.entries).length} entries to SQLite...`, 'HISTORY');
                    for (const [id, entry] of Object.entries(data.entries)) {
                        databaseService.addHistoryEntry(id, entry as Parameters<typeof databaseService.addHistoryEntry>[1]);
                    }
                    
                    // Backup and remove JSON
                    const backupPath = this.jsonPath + '.bak';
                    fs.renameSync(this.jsonPath, backupPath);
                    logger.success(`History: Migration complete. JSON backed up to ${backupPath}`, 'HISTORY');
                }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`History: Migration failed (${message})`);
        }
    }

    has(trackId: string | number): boolean {
        return !!databaseService.getHistory(trackId.toString());
    }

    get(trackId: string | number): HistoryEntry | undefined {
        return databaseService.getHistory(trackId.toString()) as unknown as HistoryEntry | undefined;
    }

    getAll(): Record<string, HistoryEntry> {
        return databaseService.getHistoryAll() as unknown as Record<string, HistoryEntry>;
    }

    getSorted(limit?: number): Array<{ id: string } & HistoryEntry> {
        // Anything but a positive integer means "all entries".
        const safeLimit =
            typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : undefined;
        return databaseService.getHistorySorted(safeLimit) as unknown as Array<{ id: string } & HistoryEntry>;
    }

    /**
     * Newest-first page of history entries, optionally filtered by `q`.
     * `limit` is clamped to 1..{@link HISTORY_MAX_LIMIT} (default
     * {@link HISTORY_DEFAULT_LIMIT}) and `offset` to >= 0.
     */
    query(query: HistoryQuery = {}): HistoryPage {
        const limit = clampInt(query.limit, HISTORY_DEFAULT_LIMIT, 1, HISTORY_MAX_LIMIT);
        const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const q = typeof query.q === 'string' ? query.q.trim().slice(0, MAX_QUERY_LENGTH) : '';

        const where = q
            ? "WHERE title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album_artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\'"
            : '';
        const params = q ? Array(4).fill(`%${escapeLike(q)}%`) : [];

        const db = databaseService.getDb();
        const totalRow = db
            .prepare(`SELECT COUNT(*) AS count FROM history ${where}`)
            .get(...params) as { count: number } | undefined;
        const rows = db
            .prepare(
                `SELECT * FROM history ${where} ORDER BY downloaded_at DESC, id ASC LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset) as HistoryRow[];

        const total = totalRow?.count ?? 0;
        return {
            items: rows.map(toListEntry),
            total,
            offset,
            limit,
            has_more: offset + rows.length < total
        };
    }

    add(trackId: string | number, entry: Omit<HistoryEntry, 'downloadedAt'>): void {
        databaseService.addHistoryEntry(trackId.toString(), {
            downloadedAt: new Date().toISOString(),
            ...entry
        });
    }

    remove(trackId: string | number): boolean {
        return databaseService.removeHistoryEntry(trackId.toString());
    }

    clearAll(): void {
        databaseService.clearHistory();
    }

    count(): number {
        const all = this.getAll();
        return Object.keys(all).length;
    }

    search(query: string): Array<{ id: string } & HistoryEntry> {
        return databaseService.searchHistory(query) as unknown as Array<{ id: string } & HistoryEntry>;
    }

    cleanup(): number {
        let cleaned = 0;
        const all = this.getAll();
        for (const [id, entry] of Object.entries(all)) {
            if (entry.filename && !fs.existsSync(entry.filename)) {
                databaseService.removeHistoryEntry(id);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            logger.info(`History: Cleaned ${cleaned} entries with missing files`);
        }
        return cleaned;
    }

    flush(): void {
        // No-op for SQLite
    }
}

export const historyService = new HistoryService();

import fs from 'fs';
import { qobuzApi } from '../api/qobuz.js';
import { databaseService, type DbTrack } from './database/index.js';
import { logger } from '../utils/logger.js';

/**
 * "Is this already in my library?" answers for the catalog views, the
 * favorites download, the REST lookup route and the MCP tools.
 *
 * A Qobuz track counts as downloaded only while the app has a `tracks` row
 * for it AND its file is still on disk; the row alone survives a manual
 * delete. Albums are judged by their tracks: the `albums` table is never
 * written, so it cannot tell anything.
 */

export type AlbumLibraryStatus = 'complete' | 'partial' | 'missing';

export interface TrackLibraryStatus {
    in_library: boolean;
    quality?: number | null;
    file_path?: string;
}

export interface AlbumLibraryInfo {
    status: AlbumLibraryStatus;
    /** Tracks of this album that are on disk. */
    downloaded: number;
    /** Qobuz track count, or null when unknown. */
    total: number | null;
}

export interface LocalLibraryItem {
    source: 'tracks' | 'files';
    track_id: string | null;
    library_file_id: number | null;
    title: string | null;
    artist: string | null;
    album_artist: string | null;
    album: string | null;
    album_id: string | null;
    quality: number | null;
    format: string | null;
    file_path: string;
    on_disk: boolean;
}

export interface LocalLibraryPage {
    items: LocalLibraryItem[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
}

export const MAX_LOOKUP_TRACK_IDS = 500;
export const MAX_LOOKUP_ALBUM_IDS = 50;

export function fileIsOnDisk(filePath: unknown): boolean {
    if (typeof filePath !== 'string' || !filePath) return false;
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

const str = (value: unknown): string | null =>
    value === null || value === undefined || value === '' ? null : String(value);
const num = (value: unknown): number | null => {
    const parsed = Number(value);
    return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed;
};

export function isTrackInLibrary(trackId: string | number): boolean {
    const row = databaseService.getTrack(String(trackId));
    return Boolean(row) && fileIsOnDisk(row?.file_path);
}

/** Status of each track id: a row in `tracks` plus its file on disk. */
export function checkTracks(ids: ReadonlyArray<string | number>): Record<string, TrackLibraryStatus> {
    const wanted = [...new Set(ids.map(String))];
    const rows = new Map<string, DbTrack>();
    for (const row of databaseService.getTracksByIds(wanted)) rows.set(String(row.id), row);

    const result: Record<string, TrackLibraryStatus> = {};
    for (const id of wanted) {
        const row = rows.get(id);
        result[id] =
            row && fileIsOnDisk(row.file_path)
                ? { in_library: true, quality: row.quality ?? null, file_path: row.file_path }
                : { in_library: false };
    }
    return result;
}

/**
 * Album status from the tracks on disk. `total` is the Qobuz track count;
 * when it is unknown an album with some tracks is reported as partial, never
 * complete.
 */
export function albumStatus(albumId: string, total?: number | null): AlbumLibraryInfo {
    const ids = new Set<string>();
    for (const row of databaseService.getTracksByAlbumId(String(albumId))) {
        if (fileIsOnDisk(row.file_path)) ids.add(String(row.id));
    }
    const downloaded = ids.size;
    const knownTotal = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null;
    const status: AlbumLibraryStatus =
        downloaded === 0 ? 'missing' : knownTotal !== null && downloaded >= knownTotal ? 'complete' : 'partial';
    return { status, downloaded, total: knownTotal };
}

/**
 * Status per album id. Track counts come from `totals` when the caller has
 * them (catalog results carry `tracks_count`); otherwise, with
 * `fetchTotals`, from Qobuz for albums that have at least one track locally.
 */
export async function checkAlbums(
    ids: ReadonlyArray<string>,
    options: { totals?: Record<string, number | null | undefined>; fetchTotals?: boolean } = {}
): Promise<Record<string, AlbumLibraryInfo>> {
    const result: Record<string, AlbumLibraryInfo> = {};
    for (const id of [...new Set(ids.map(String))]) {
        let info = albumStatus(id, options.totals?.[id]);
        if (info.total === null && info.downloaded > 0 && options.fetchTotals !== false) {
            try {
                const album = await qobuzApi.getAlbum(id);
                const total = album.success ? album.data?.tracks_count : undefined;
                if (typeof total === 'number') info = albumStatus(id, total);
            } catch (error: unknown) {
                logger.debug(`Album track count lookup failed for ${id}: ${(error as Error).message}`, 'LIBRARY');
            }
        }
        result[id] = info;
    }
    return result;
}

const clampPage = (page: { limit?: number; offset?: number }): { limit: number; offset: number } => ({
    limit: Math.min(Math.max(Math.trunc(Number(page.limit) || 25), 1), 100),
    offset: Math.max(Math.trunc(Number(page.offset) || 0), 0)
});

/**
 * Searches the local library. `tracks` (default) covers what this app
 * downloaded and carries Qobuz ids; `files` covers everything the library
 * scanner indexed, including files from elsewhere.
 */
export function searchLocalLibrary(
    query: string,
    page: { limit?: number; offset?: number; source?: 'tracks' | 'files' } = {}
): LocalLibraryPage {
    const { limit, offset } = clampPage(page);
    const text = query.trim();

    if (page.source === 'files') {
        const rows = databaseService.searchLibraryFiles(text, { limit, offset });
        const items = rows.items.map(
            (row): LocalLibraryItem => ({
                source: 'files',
                track_id: null,
                library_file_id: num(row.id),
                title: str(row.title),
                artist: str(row.artist),
                album_artist: str(row.album_artist),
                album: str(row.album),
                album_id: null,
                quality: num(row.quality),
                format: str(row.format),
                file_path: String(row.file_path),
                on_disk: fileIsOnDisk(row.file_path)
            })
        );
        return { items, total: rows.total, offset, limit, has_more: offset + items.length < rows.total };
    }

    const rows = databaseService.searchTracksPaged(text, { limit, offset });
    const items = rows.items.map(
        (row): LocalLibraryItem => ({
            source: 'tracks',
            track_id: str(row.id),
            library_file_id: null,
            title: str(row.title),
            artist: str(row.artist),
            album_artist: str(row.album_artist),
            album: str(row.album),
            album_id: str(row.album_id),
            quality: num(row.quality),
            format: null,
            file_path: String(row.file_path ?? ''),
            on_disk: fileIsOnDisk(row.file_path)
        })
    );
    return { items, total: rows.total, offset, limit, has_more: offset + items.length < rows.total };
}

export const libraryLookupService = {
    checkTracks,
    checkAlbums,
    albumStatus,
    isTrackInLibrary,
    searchLocalLibrary
};

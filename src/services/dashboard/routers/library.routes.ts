import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { databaseService } from '../../database/index.js';
import { libraryScannerService } from '../../library-scanner/index.js';
import { libraryStatisticsService } from '../../LibraryStatisticsService.js';
import { formatConverterService } from '../../FormatConverterService.js';
import { logger } from '../../../utils/logger.js';
import { isPathWithinManagedRoots } from '../../../utils/paths.js';
import { deleteLibraryFile, editTrackMetadata, queueUpgrade, resolveDuplicate } from '../../library-actions.js';
import {
    listSmartPlaylists,
    createSmartPlaylist,
    deleteSmartPlaylist,
    getSmartPlaylist,
    parseSmartPlaylistFilter,
    sanitizeSmartPlaylistFilter,
    countTracksForFilter,
    tracksForFilter
} from '../../smart-playlists.js';
import {
    checkAlbums,
    checkTracks,
    MAX_LOOKUP_ALBUM_IDS,
    MAX_LOOKUP_TRACK_IDS,
    searchLocalLibrary
} from '../../library-lookup.js';
import { parseBody, parseParams, parseQuery, routeErrorHandler } from './route-utils.js';

const router = Router();

const getParam = (p: unknown): string => (Array.isArray(p) ? String(p[0]) : String(p ?? ''));

/**
 * Pagination values reach SQLite's LIMIT/OFFSET directly, and SQLite reads a
 * negative LIMIT as "no limit" — so `?limit=-1` dumped whole tables.
 */
const getPageParam = (raw: unknown, fallback: number, max: number): number => {
    const parsed = parseInt(getParam(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, max);
};

const MAX_PAGE_SIZE = 1000;

/** Query values may come as `?trackIds=1,2` or repeated `?trackIds=1&trackIds=2`. */
const idList = (pattern: RegExp, max: number, what: string) =>
    z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((value) =>
            value === undefined
                ? []
                : (Array.isArray(value) ? value : [value])
                      .flatMap((part) => part.split(','))
                      .map((part) => part.trim())
                      .filter(Boolean)
        )
        .pipe(z.array(z.string().regex(pattern, `Invalid ${what}`)).max(max, `At most ${max} ${what}s`));

const lookupQuery = z
    .object({
        trackIds: idList(/^\d{1,20}$/, MAX_LOOKUP_TRACK_IDS, 'track id'),
        albumIds: idList(/^[A-Za-z0-9]{1,40}$/, MAX_LOOKUP_ALBUM_IDS, 'album id')
    })
    .refine((value) => value.trackIds.length + value.albumIds.length > 0, {
        message: 'trackIds or albumIds is required'
    });

const duplicateParams = z.object({ id: z.coerce.number().int().positive('Valid duplicate id is required') });

const resolveDuplicateBody = z.object({
    keep: z.enum(['auto', 'first', 'second']).default('auto'),
    dryRun: z.boolean().default(false)
});

const filePathSchema = z.string().trim().min(1).max(4096);

const metadataEditBody = z
    .object({
        filePath: filePathSchema,
        // `metadata` is the name the old route used; `fields` is preferred.
        fields: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional()
    })
    .refine((body) => body.fields !== undefined || body.metadata !== undefined, {
        message: 'fields is required'
    });

const deleteFileBody = z
    .object({
        filePath: filePathSchema.optional(),
        libraryFileId: z.number().int().positive().optional()
    })
    .refine((body) => body.filePath !== undefined || body.libraryFileId !== undefined, {
        message: 'filePath or libraryFileId is required'
    });

const searchQuery = z.object({
    q: z.string().trim().min(1, 'Query parameter "q" is required').max(200),
    source: z.enum(['tracks', 'files']).default('tracks'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0)
});

router.get('/scan/status', async (req: Request, res: Response) => {
    const stats = libraryScannerService.getScanStats();
    res.json({
        ...stats,
        stats,
        scanning: libraryScannerService.isScanInProgress(),
        FFMPEG_AVAILABLE: await formatConverterService.isAvailable()
    });
});

/** Queues a Hi-Res upgrade; validation lives in libraryActions.queueUpgrade. */
router.post('/upgrade', (req: Request, res: Response) => {
    const trackId = String(req.body?.trackId ?? '').trim();
    if (!/^\d{1,20}$/.test(trackId)) {
        res.status(400).json({ error: 'filePath and a numeric trackId are required' });
        return;
    }
    const item = queueUpgrade({ filePath: req.body?.filePath, trackId, quality: req.body?.quality });
    res.json({ success: true, item });
});

/**
 * Searches the local library. `source=tracks` (default): downloads made by
 * this app, with Qobuz ids. `source=files`: everything the scanner indexed.
 */
router.get('/search', (req: Request, res: Response) => {
    const { q, source, limit, offset } = parseQuery(searchQuery, req.query);
    res.json(searchLocalLibrary(q, { source, limit, offset }));
});

/** "Already in the library?" for Qobuz track and album ids (file on disk, albums complete/partial/missing). */
router.get('/lookup', async (req: Request, res: Response) => {
    const { trackIds, albumIds } = parseQuery(lookupQuery, req.query);
    res.json({ tracks: checkTracks(trackIds), albums: await checkAlbums(albumIds) });
});

router.post('/scan', (req: Request, res: Response) => {
    const { path } = req.body;

    // Without this the caller picks any directory and the scanner walks it into
    // the database, which the /api/library/files route then reads back.
    if (path !== undefined && !isPathWithinManagedRoots(path)) {
        logger.warn(`Refused library scan outside the library: ${path}`, 'LIBRARY');
        res.status(403).json({ error: 'Path is outside the library directory' });
        return;
    }

    // scanLibrary rejects with 'Scan already in progress'; unhandled, that
    // rejection terminates the process on Node 20+.
    libraryScannerService
        .scanLibrary(path)
        .catch((error: unknown) =>
            logger.error(`Library scan failed: ${(error as Error).message}`, 'LIBRARY')
        );

    res.json({ success: true });
});

router.post('/scan/abort', (req: Request, res: Response) => {
    libraryScannerService.abortScan();
    res.json({ success: true });
});

router.get('/statistics', async (req: Request, res: Response) => {
    try {
        const stats = await libraryStatisticsService.getLibraryStats();
        res.json(stats);
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/files', (req: Request, res: Response) => {
    try {
        const limit = getPageParam(req.query.limit, 100, MAX_PAGE_SIZE);
        const offset = getPageParam(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
        const files = databaseService.getLibraryFiles(limit, offset);
        res.json(files);
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/upgradeable', (req: Request, res: Response) => {
    try {
        res.json(libraryScannerService.getUpgradeableFiles());
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/missing-metadata', (req: Request, res: Response) => {
    try {
        res.json(libraryScannerService.getMissingMetadataFiles());
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/duplicates', (req: Request, res: Response) => {
    try {
        const duplicates = databaseService.getDuplicates();
        res.json(duplicates);
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

/**
 * Deletes one file of a duplicate pair. Body (optional): `keep`
 * auto|first|second, `dryRun` to only report the choice.
 */
router.post('/duplicates/:id/resolve', async (req: Request, res: Response) => {
    const { id } = parseParams(duplicateParams, req.params);
    const options = parseBody(resolveDuplicateBody, req.body);
    const result = await resolveDuplicate(id, options);
    res.json({ success: true, ...result });
});

router.get('/integrity', (req: Request, res: Response) => {
    try {
        const issues = databaseService.getDuplicates();
        res.json(issues);
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

/**
 * Changes single tags of a FLAC/MP3 library file, keeping all other tags and
 * the embedded cover. Body: `{ filePath, fields: { title?, artist?, ... } }`.
 */
router.post('/metadata/edit', async (req: Request, res: Response) => {
    const body = parseBody(metadataEditBody, req.body);
    const result = await editTrackMetadata(body.filePath, body.fields ?? body.metadata);
    res.json({ success: true, ...result });
});

/** Deletes an indexed library file from disk and from the index. Body: `{ filePath }` or `{ libraryFileId }`. */
router.delete('/file', (req: Request, res: Response) => {
    const body = parseBody(deleteFileBody, req.body);
    const result = deleteLibraryFile(body);
    res.json({ success: true, ...result });
});

router.get('/database/stats', async (req: Request, res: Response) => {
    try {
        res.json(databaseService.getOverallStats());
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/database/tracks', async (req: Request, res: Response) => {
    try {
        const limit = getPageParam(req.query.limit, 100, MAX_PAGE_SIZE);
        const offset = getPageParam(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
        res.json(databaseService.getAllTracks(limit, offset));
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/database/albums', async (req: Request, res: Response) => {
    try {
        const limit = getPageParam(req.query.limit, 50, MAX_PAGE_SIZE);
        const offset = getPageParam(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
        res.json(databaseService.getAllAlbums(limit, offset));
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/database/search', async (req: Request, res: Response) => {
    try {
        const query = req.query.q as string;

        if (!query) {
            res.status(400).json({ error: 'Query parameter "q" is required' });
            return;
        }

        res.json(databaseService.searchTracks(query));
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/smart-playlists', (_req: Request, res: Response) => {
    res.json(listSmartPlaylists());
});

router.post('/smart-playlists', (req: Request, res: Response) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) {
        res.status(400).json({ error: 'name is required (max 100 chars)' });
        return;
    }
    const filter = sanitizeSmartPlaylistFilter(req.body?.filter);
    if (!filter) {
        res.status(400).json({ error: 'at least one filter condition is required' });
        return;
    }
    const created = createSmartPlaylist(name, filter);
    res.status(201).json({ ...created, track_count: countTracksForFilter(filter) });
});

router.delete('/smart-playlists/:id', (req: Request, res: Response) => {
    const removed = deleteSmartPlaylist(getParam(req.params.id));
    if (!removed) {
        res.status(404).json({ error: 'Playlist not found' });
        return;
    }
    res.json({ success: true });
});

router.get('/smart-playlists/:id/tracks', (req: Request, res: Response) => {
    const playlist = getSmartPlaylist(getParam(req.params.id));
    const filter = parseSmartPlaylistFilter(playlist);
    if (!playlist || !filter) {
        res.status(404).json({ error: 'Playlist not found' });
        return;
    }
    res.json(tracksForFilter(filter));
});

router.use(routeErrorHandler('library'));

export default router;

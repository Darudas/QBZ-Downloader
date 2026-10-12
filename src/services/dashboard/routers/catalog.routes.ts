import { Router, Request, Response } from 'express';
import { z } from 'zod';
import qobuzApi from '../../../api/qobuz.js';
import { databaseService } from '../../database/index.js';
import { historyService } from '../../history.js';
import { playlistWatcherService } from '../../PlaylistWatcherService.js';
import { downloadQualitySchema } from '../../download-actions.js';
import { albumStatus, isTrackInLibrary } from '../../library-lookup.js';
import { parseBody, parseParams, parseQuery, routeErrorHandler } from './route-utils.js';

const router = Router();
const api = qobuzApi;

/**
 * Artists without a picture get one from their latest album, which costs one
 * extra getArtist call each. Capped so a single search cannot fan out into
 * dozens of Qobuz requests.
 */
export const MAX_ARTIST_IMAGE_LOOKUPS = 5;

/* ------------------------------------------------------------------ */
/* Schemas                                                              */
/* ------------------------------------------------------------------ */

const limitSchema = z.coerce.number().int().min(1).max(100);
const offsetSchema = z.coerce.number().int().min(0).max(100000);

const searchQuery = z
    .object({
        query: z.string().trim().max(200).optional(),
        q: z.string().trim().max(200).optional(),
        type: z.enum(['albums', 'tracks', 'artists', 'playlists']).default('albums'),
        limit: limitSchema.default(20),
        offset: offsetSchema.default(0)
    })
    .refine((value) => Boolean(value.query || value.q), { message: 'Query is required' });

const albumParams = z.object({
    id: z.string().regex(/^[A-Za-z0-9]{1,40}$/, 'Invalid album id')
});

const numericParams = z.object({
    id: z.string().regex(/^\d{1,20}$/, 'Invalid id')
});

const artistQuery = z.object({
    type: z.enum(['albums', 'tracks']).optional(),
    limit: limitSchema.default(20),
    offset: offsetSchema.default(0)
});

const intervalSchema = z.number().int().min(1).max(168);
const playlistIdSchema = z.union([
    z.string().trim().regex(/^\d{1,20}$/, 'playlistId must be a positive integer'),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
]);

const watchBody = z.object({
    playlistId: playlistIdSchema,
    intervalHours: intervalSchema.optional(),
    quality: downloadQualitySchema.nullish()
});

const watchUpdateBody = z
    .object({
        intervalHours: intervalSchema.optional(),
        quality: downloadQualitySchema.nullish()
    })
    .refine((value) => value.intervalHours !== undefined || value.quality !== undefined, {
        message: 'intervalHours or quality is required'
    });

const watchParams = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid watched playlist id')
});

/* ------------------------------------------------------------------ */
/* "Already downloaded" flags                                           */
/* ------------------------------------------------------------------ */

type Item = Record<string, unknown>;

const itemsOf = (value: unknown): Item[] | undefined => {
    const items = (value as { items?: unknown } | undefined)?.items;
    return Array.isArray(items) ? (items as Item[]) : undefined;
};

/** A track counts as downloaded only while its file is still on disk. */
function flagTracks(items: Item[] | undefined): void {
    items?.forEach((item) => {
        item.already_downloaded = isTrackInLibrary(String(item.id));
    });
}

/**
 * An album counts as downloaded when every one of its Qobuz tracks is on
 * disk; `library_status` also tells partial albums apart. (The `albums` table
 * is never written, so it cannot be used for this.)
 */
function flagAlbum(item: Item): void {
    const total = typeof item.tracks_count === 'number' ? item.tracks_count : itemsOf(item.tracks)?.length;
    const info = albumStatus(String(item.id), total);
    item.already_downloaded = info.status === 'complete';
    item.library_status = info.status;
    item.downloaded_tracks = info.downloaded;
}

function flagAlbums(items: Item[] | undefined): void {
    items?.forEach(flagAlbum);
}

/* ------------------------------------------------------------------ */
/* Catalog                                                              */
/* ------------------------------------------------------------------ */

router.get('/search', async (req: Request, res: Response) => {
    const { query, q, type, limit, offset } = parseQuery(searchQuery, req.query);
    const text = (query || q)!;

    const result = await api.search(text, type, limit, offset);
    if (!result.success) {
        res.status(502).json({ error: result.error || 'Search failed', code: 'API_ERROR' });
        return;
    }

    const data = (result.data ?? {}) as Item;

    if (type === 'artists') {
        const missingImage = (itemsOf(data.artists) ?? [])
            .filter((item) => !item.image && !item.picture)
            .slice(0, MAX_ARTIST_IMAGE_LOOKUPS);
        await Promise.allSettled(
            missingImage.map(async (item) => {
                const detail = await api.getArtist(String(item.id), 0, 1);
                const latestAlbum = itemsOf((detail.data as Item | undefined)?.albums)?.[0];
                if (detail.success && latestAlbum?.image) {
                    item.image = latestAlbum.image;
                    item.picture = latestAlbum.image;
                }
            })
        );
    }

    flagTracks(itemsOf(data.tracks));
    flagAlbums(itemsOf(data.albums));
    res.json(data);
});

router.get('/album/:id', async (req: Request, res: Response) => {
    const { id } = parseParams(albumParams, req.params);
    const result = await api.getAlbum(id);

    if (!result.success || !result.data) {
        res.status(404).json({ error: result.error || 'Album not found', code: 'NOT_FOUND' });
        return;
    }

    const data = result.data as unknown as Item;
    flagAlbum(data);
    flagTracks(itemsOf(data.tracks));
    res.json(data);
});

router.get('/artist/:id', async (req: Request, res: Response) => {
    const { id } = parseParams(numericParams, req.params);
    const { type, limit, offset } = parseQuery(artistQuery, req.query);

    // getArtistAlbums returns the artist with an `albums` page ({items,total}),
    // the same shape as getArtist; the list views read data[type].items.
    const result =
        type === 'albums'
            ? await api.getArtistAlbums(id, limit, offset)
            : type === 'tracks'
              ? await api.getArtist(id, 0, 1, offset, limit)
              : await api.getArtist(id, offset, limit);

    if (!result.success || !result.data) {
        res.status(404).json({ error: result.error || 'Artist not found', code: 'NOT_FOUND' });
        return;
    }

    const data = result.data as unknown as Item;
    flagTracks(itemsOf(data.tracks));
    flagAlbums(itemsOf(data.albums));
    res.json(data);
});

router.get('/playlist/:id', async (req: Request, res: Response) => {
    const { id } = parseParams(numericParams, req.params);
    const result = await api.getPlaylist(id);

    if (!result.success || !result.data) {
        res.status(404).json({ error: result.error || 'Playlist not found', code: 'NOT_FOUND' });
        return;
    }
    const data = result.data as unknown as Item;
    flagTracks(itemsOf(data.tracks));
    res.json(data);
});

router.get('/track/:id', async (req: Request, res: Response) => {
    const { id } = parseParams(numericParams, req.params);
    const result = await api.getTrack(id);

    if (!result.success || !result.data) {
        res.status(404).json({ error: result.error || 'Track not found', code: 'NOT_FOUND' });
        return;
    }
    const data = result.data as unknown as Item;
    data.already_downloaded = isTrackInLibrary(id);
    res.json(data);
});

router.get('/genres', async (_req: Request, res: Response) => {
    const result = await api.getGenres();
    if (!result.success) {
        res.status(502).json({ error: result.error || 'Failed to load genres', code: 'API_ERROR' });
        return;
    }
    res.json(result.data);
});

router.get('/search/suggestions', async (req: Request, res: Response) => {
    const { query } = req.query;
    if (!query || typeof query !== 'string' || query.length > 200) {
        res.json({ artists: [], albums: [], tracks: [] });
        return;
    }

    try {
        const [artists, albums, tracks] = await Promise.all([
            api.search(query, 'artists', 3),
            api.search(query, 'albums', 3),
            api.search(query, 'tracks', 3)
        ]);

        const firstItems = (result: { success: boolean; data?: unknown }, key: string) =>
            result.success ? (itemsOf((result.data as Item | undefined)?.[key]) ?? []).slice(0, 3) : [];

        res.json({
            artists: firstItems(artists, 'artists'),
            albums: firstItems(albums, 'albums'),
            tracks: firstItems(tracks, 'tracks')
        });
    } catch {
        res.json({ artists: [], albums: [], tracks: [] });
    }
});

router.get('/preview/:id', async (req: Request, res: Response) => {
    const { id } = parseParams(numericParams, req.params);
    const { audioPreviewService } = await import('../../audio-preview/index.js');
    const info = await audioPreviewService.getPreviewInfo(id);

    if (info) {
        res.json(info);
    } else {
        res.status(404).json({ error: 'Preview info not found', code: 'NOT_FOUND' });
    }
});

router.get('/stream/:id', async (req: Request, res: Response) => {
    const { id } = parseParams(numericParams, req.params);
    const { audioPreviewService } = await import('../../audio-preview/index.js');
    const url = await audioPreviewService.getStreamUrl(id);

    if (url) {
        // No Access-Control-Allow-Origin here: the dashboard plays this
        // from its own origin, and `*` let any site read a signed Qobuz
        // stream URL minted with the user's credentials.
        res.redirect(url);
    } else {
        res.status(404).json({ error: 'Stream URL not found', code: 'NOT_FOUND' });
    }
});

/* ------------------------------------------------------------------ */
/* Watched playlists                                                    */
/* ------------------------------------------------------------------ */

// Raw rows, as the dashboard playlists view expects them.
router.get('/playlists/watched', (_req: Request, res: Response) => {
    res.json(databaseService.getWatchedPlaylists());
});

router.post('/playlists/watch', async (req: Request, res: Response) => {
    const body = parseBody(watchBody, req.body);
    const playlist = await playlistWatcherService.watch(body);
    res.json({ success: true, message: 'Playlist added to watch list', playlist });
});

router.patch('/playlists/watch/:id', (req: Request, res: Response) => {
    const { id } = parseParams(watchParams, req.params);
    const body = parseBody(watchUpdateBody, req.body);
    const playlist = playlistWatcherService.update(id, body);
    res.json({ success: true, playlist });
});

router.post('/playlists/watch/:id/sync', async (req: Request, res: Response) => {
    const { id } = parseParams(watchParams, req.params);
    const result = await playlistWatcherService.syncNow(id);
    res.json({ success: true, ...result });
});

router.post('/playlists/watched/sync', async (_req: Request, res: Response) => {
    const result = await playlistWatcherService.syncNow();
    res.json({ success: true, ...result });
});

router.delete('/playlists/watch/:id', (req: Request, res: Response) => {
    const { id } = parseParams(watchParams, req.params);
    if (!playlistWatcherService.unwatch(id)) {
        res.status(404).json({ error: 'Playlist is not being watched', code: 'NOT_FOUND' });
        return;
    }
    res.json({ success: true });
});

router.get('/quality-stats', (_req: Request, res: Response) => {
    const history = historyService.getAll();
    const stats = {
        totalScanned: 0,
        trueLossless: 0,
        fakeLossless: 0,
        issues: [] as Record<string, unknown>[]
    };

    Object.values(history).forEach((entry) => {
        if (entry.qualityScan) {
            stats.totalScanned++;
            if (entry.qualityScan.isTrueLossless) {
                stats.trueLossless++;
            } else {
                stats.fakeLossless++;
                stats.issues.push({
                    title: entry.title,
                    artist: entry.artist,
                    details: entry.qualityScan.details,
                    confidence: entry.qualityScan.confidence
                });
            }
        }
    });

    res.json(stats);
});

router.use(routeErrorHandler('catalog'));

export default router;

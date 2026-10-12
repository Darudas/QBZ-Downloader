import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { qobuzLibraryService } from '../../qobuz-library/index.js';
import { downloadQualitySchema } from '../../download-actions.js';
import { downloadFavorites, downloadPurchases } from '../../favorites-download.js';
import { favoritesSyncService } from '../../favorites-sync.js';
import { parseBody, parseQuery, routeErrorHandler } from './route-utils.js';

/**
 * REST routes for the logged-in user's Qobuz library: favorites, own
 * playlists, purchases, discovery, labels, related artists and account info.
 * All validation, ownership checks and events live in QobuzLibraryService
 * (shared with the MCP tools); these handlers only map HTTP onto it.
 */
const router = Router();
const library = qobuzLibraryService;

/* ------------------------------------------------------------------ */
/* Schemas (shape only; the service validates values)                   */
/* ------------------------------------------------------------------ */

const pageQuery = z.object({
    limit: z.string().optional(),
    offset: z.string().optional()
});

const favoritesQuery = pageQuery.extend({
    type: z.string().default('albums')
});

/** Query values may come as `?trackIds=1,2` or repeated `?trackIds=1&trackIds=2`. */
const idList = z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) =>
        value === undefined
            ? undefined
            : (Array.isArray(value) ? value : [value])
                  .flatMap((part) => part.split(','))
                  .map((part) => part.trim())
                  .filter(Boolean)
    );

const favoriteIdsCheckQuery = z.object({
    albumIds: idList,
    trackIds: idList,
    artistIds: idList
});

const playlistsQuery = pageQuery.extend({
    filter: z.string().optional()
});

const purchasesQuery = pageQuery.extend({
    type: z.string().default('albums')
});

const discoverQuery = pageQuery.extend({
    type: z.string().optional(),
    genre_id: z.string().optional(),
    genreId: z.string().optional()
});

const releasesQuery = pageQuery.extend({
    release_type: idList,
    releaseType: idList,
    sort: z.string().optional(),
    order: z.string().optional()
});

const resolveQuery = z.object({
    url: z.string(),
    details: z.enum(['true', 'false', '1', '0']).optional()
});

/** Body of the favorites and purchases bulk downloads. */
const libraryDownloadBody = z.object({
    type: z.enum(['albums', 'tracks', 'all']).default('all'),
    quality: downloadQualitySchema.nullish()
});

/** Body fields are passed to the service, which validates them strictly. */
const looseBody = z.record(z.string(), z.unknown());

const pageOf = (query: { limit?: string | undefined; offset?: string | undefined }) => ({
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {})
});

/* ------------------------------------------------------------------ */
/* Favorites                                                            */
/* ------------------------------------------------------------------ */

router.get('/favorites', async (req: Request, res: Response) => {
    const query = parseQuery(favoritesQuery, req.query);
    res.json(await library.listFavorites(query.type as 'albums', pageOf(query)));
});

/**
 * Without parameters: every favorite id (for heart buttons). With
 * `albumIds`/`trackIds`/`artistIds`: a per-id true/false lookup.
 */
router.get('/favorites/ids', async (req: Request, res: Response) => {
    const query = parseQuery(favoriteIdsCheckQuery, req.query);
    const hasIds = [query.albumIds, query.trackIds, query.artistIds].some((ids) => (ids?.length ?? 0) > 0);
    if (!hasIds) {
        res.json(await library.getFavoriteIds());
        return;
    }
    res.json(
        await library.checkFavorites({
            ...(query.albumIds ? { albumIds: query.albumIds } : {}),
            ...(query.trackIds ? { trackIds: query.trackIds } : {}),
            ...(query.artistIds ? { artistIds: query.artistIds } : {})
        })
    );
});

router.post('/favorites', async (req: Request, res: Response) => {
    res.json(await library.addFavorites(parseBody(looseBody, req.body)));
});

router.delete('/favorites', async (req: Request, res: Response) => {
    res.json(await library.removeFavorites(parseBody(looseBody, req.body)));
});

/** Queues every favorite album and/or track; tracks already in the library are skipped. */
router.post('/favorites/download', async (req: Request, res: Response) => {
    const body = parseBody(libraryDownloadBody, req.body);
    res.json(await downloadFavorites(body.type, body.quality, 'dashboard'));
});

/** Favorites auto-download state: settings, last and next check. */
router.get('/favorites/sync', (_req: Request, res: Response) => {
    res.json(favoritesSyncService.getStatus());
});

/**
 * Checks for favorites added since the last check and queues them. The first
 * check only records a baseline and downloads nothing.
 */
router.post('/favorites/sync', async (_req: Request, res: Response) => {
    res.json(await favoritesSyncService.syncNow());
});

/* ------------------------------------------------------------------ */
/* Own playlists                                                        */
/* ------------------------------------------------------------------ */

router.get('/me/playlists', async (req: Request, res: Response) => {
    const query = parseQuery(playlistsQuery, req.query);
    res.json(
        await library.listUserPlaylists({
            ...pageOf(query),
            ...(query.filter !== undefined ? { filter: query.filter as 'owner' } : {})
        })
    );
});

router.post('/me/playlists', async (req: Request, res: Response) => {
    const body = parseBody(looseBody, req.body);
    res.status(201).json(await library.createPlaylist(body as never));
});

router.get('/me/playlists/:id', async (req: Request, res: Response) => {
    const query = parseQuery(pageQuery, req.query);
    res.json(await library.getPlaylist(String(req.params.id), pageOf(query)));
});

router.patch('/me/playlists/:id', async (req: Request, res: Response) => {
    const body = parseBody(looseBody, req.body);
    res.json(await library.updatePlaylist(String(req.params.id), body));
});

router.delete('/me/playlists/:id', async (req: Request, res: Response) => {
    res.json(await library.deletePlaylist(String(req.params.id)));
});

router.post('/me/playlists/:id/tracks', async (req: Request, res: Response) => {
    res.json(await library.addTracks(String(req.params.id), parseBody(looseBody, req.body)));
});

router.delete('/me/playlists/:id/tracks', async (req: Request, res: Response) => {
    res.json(await library.removeTracks(String(req.params.id), parseBody(looseBody, req.body)));
});

router.post('/me/playlists/:id/follow', async (req: Request, res: Response) => {
    res.json(await library.followPlaylist(String(req.params.id)));
});

router.delete('/me/playlists/:id/follow', async (req: Request, res: Response) => {
    res.json(await library.unfollowPlaylist(String(req.params.id)));
});

/* ------------------------------------------------------------------ */
/* Purchases                                                            */
/* ------------------------------------------------------------------ */

router.get('/purchases', async (req: Request, res: Response) => {
    const query = parseQuery(purchasesQuery, req.query);
    res.json(await library.listPurchases(query.type as 'albums', pageOf(query)));
});

router.get('/purchases/ids', async (_req: Request, res: Response) => {
    res.json(await library.getPurchaseIds());
});

/** Queues every purchased album and/or track; tracks already in the library are skipped. */
router.post('/purchases/download', async (req: Request, res: Response) => {
    const body = parseBody(libraryDownloadBody, req.body);
    res.json(await downloadPurchases(body.type, body.quality, 'dashboard'));
});

/* ------------------------------------------------------------------ */
/* Discovery                                                            */
/* ------------------------------------------------------------------ */

router.get('/discover/albums', async (req: Request, res: Response) => {
    const query = parseQuery(discoverQuery, req.query);
    const genreId = query.genre_id ?? query.genreId;
    res.json(
        await library.getFeaturedAlbums((query.type ?? 'new-releases') as 'new-releases', {
            ...pageOf(query),
            ...(genreId !== undefined ? { genreId } : {})
        })
    );
});

router.get('/discover/playlists', async (req: Request, res: Response) => {
    const query = parseQuery(discoverQuery, req.query);
    const genreId = query.genre_id ?? query.genreId;
    res.json(
        await library.getFeaturedPlaylists((query.type ?? 'editor-picks') as 'editor-picks', {
            ...pageOf(query),
            ...(genreId !== undefined ? { genreId } : {})
        })
    );
});

/* ------------------------------------------------------------------ */
/* Labels, related artists, account, URLs                               */
/* ------------------------------------------------------------------ */

router.get('/label/:id', async (req: Request, res: Response) => {
    const query = parseQuery(pageQuery, req.query);
    res.json(await library.getLabel(String(req.params.id), pageOf(query)));
});

router.get('/artist/:id/similar', async (req: Request, res: Response) => {
    const query = parseQuery(pageQuery, req.query);
    res.json(await library.getSimilarArtists(String(req.params.id), pageOf(query)));
});

router.get('/artist/:id/releases', async (req: Request, res: Response) => {
    const query = parseQuery(releasesQuery, req.query);
    const releaseType = query.release_type ?? query.releaseType;
    res.json(
        await library.getArtistReleases(String(req.params.id), {
            ...pageOf(query),
            ...(releaseType !== undefined ? { releaseType: releaseType as never } : {}),
            ...(query.sort !== undefined ? { sort: query.sort as never } : {}),
            ...(query.order !== undefined ? { order: query.order as never } : {})
        })
    );
});

router.get('/account', async (_req: Request, res: Response) => {
    res.json(await library.getAccountInfo());
});

router.get('/resolve', async (req: Request, res: Response) => {
    const query = parseQuery(resolveQuery, req.query);
    const details = query.details === 'true' || query.details === '1';
    res.json(await library.resolveUrl(query.url, { details }));
});

router.use(routeErrorHandler('qobuz-library'));

export default router;

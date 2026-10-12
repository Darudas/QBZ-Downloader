import { Router, Request, Response } from 'express';
import path from 'path';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { z } from 'zod';
import { downloadQueue } from '../../queue/queue.js';
import { historyService } from '../../history.js';
import { databaseService } from '../../database/index.js';
import { migrationService } from '../../migration.js';
import qobuzApi from '../../../api/qobuz.js';
import { logger } from '../../../utils/logger.js';
import { CONFIG, normalizeDownloadQuality } from '../../../config.js';
import {
    contentIdSchema,
    downloadActionsService,
    downloadQualitySchema,
    downloadTypeSchema,
    MAX_ENQUEUE_TRACK_IDS,
    MAX_ENQUEUE_URLS,
    QUEUE_LIST_MAX_LIMIT,
    queuePrioritySchema,
    QueueRequestError,
    queueStatusFilterSchema
} from '../../download-actions.js';
import { downloadTrackLyrics, getTrackLyrics, managedLrcPath } from '../../lyrics-actions.js';
import { parseBody, parseParams, parseQuery, routeErrorHandler } from './route-utils.js';

const router = Router();
const api = qobuzApi;

/* ------------------------------------------------------------------ */
/* Schemas                                                              */
/* ------------------------------------------------------------------ */

const optionalQuality = downloadQualitySchema.nullish();

const queueItemParams = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid queue item id')
});

const queueListQuery = z.object({
    status: queueStatusFilterSchema.optional(),
    limit: z.coerce.number().int().min(1).max(QUEUE_LIST_MAX_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).optional()
});

// Unknown keys (notably `metadata`) are dropped: queue metadata is built on
// the server only. Upgrade metadata deletes a file after the download.
const queueAddBody = z
    .object({
        type: downloadTypeSchema.optional(),
        id: contentIdSchema.optional(),
        url: z.string().trim().min(1).max(2048).optional(),
        quality: optionalQuality,
        priority: queuePrioritySchema.optional(),
        title: z.string().max(300).optional()
    })
    .refine((body) => body.url !== undefined || (body.type !== undefined && body.id !== undefined), {
        message: 'type and id (or url) are required'
    });

const queueActionBody = z.object({
    action: z.enum(['pause', 'resume', 'clear', 'clear-completed', 'clear-pending', 'retry-failed'])
});

const priorityBody = z.object({ priority: queuePrioritySchema });

const legacyItemParams = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid queue item id'),
    action: z.enum(['cancel', 'remove', 'retry'])
});

const trackIdsSchema = z.array(contentIdSchema).min(1).max(MAX_ENQUEUE_TRACK_IDS);

const downloadBody = z.object({
    type: downloadTypeSchema,
    id: contentIdSchema,
    quality: optionalQuality,
    priority: queuePrioritySchema.optional(),
    trackIds: trackIdsSchema.optional(),
    skipExisting: z.boolean().optional()
});

const simpleDownloadBody = z.object({
    id: contentIdSchema,
    quality: optionalQuality,
    priority: queuePrioritySchema.optional(),
    skipExisting: z.boolean().optional()
});

const albumDownloadBody = simpleDownloadBody.extend({
    /** Zero-based positions in the album's track list. */
    indices: z.array(z.number().int().min(0).max(9999)).min(1).max(MAX_ENQUEUE_TRACK_IDS).optional(),
    trackIds: trackIdsSchema.optional()
});

const urlsDownloadBody = z.object({
    urls: z.array(z.string().max(2048)).min(1).max(MAX_ENQUEUE_URLS),
    quality: optionalQuality,
    priority: queuePrioritySchema.optional(),
    skipExisting: z.boolean().optional()
});

const historyQuery = z.object({
    q: z.string().max(200).optional(),
    // Same bound as HISTORY_MAX_LIMIT in history.ts.
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional()
});

const historyIdParams = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid history id')
});

const trackIdParams = z.object({
    id: z.string().regex(/^\d{1,20}$/, 'Invalid track id')
});

const lyricsSaveBody = z.object({
    content: z.string().min(1).max(512 * 1024)
});

const lyricsDownloadBody = z.object({
    trackId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()])
});

const spotifyMigrationBody = z.object({
    url: z.string().trim().min(1, 'url is required').max(2048),
    quality: optionalQuality,
    download: z.boolean().optional()
});

const albumZipBody = z.object({
    albumId: z.union([z.string().regex(/^[A-Za-z0-9]{1,40}$/), z.number().int().positive()])
});

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const hasAnyQuery = (req: Request, keys: string[]): boolean =>
    keys.some((key) => req.query[key] !== undefined);

export { lrcPathFor } from '../../lyrics-actions.js';

/**
 * A CSV cell that starts with =, +, -, @, tab or CR is run as a formula by
 * spreadsheet apps; titles come from Qobuz, so neutralize them.
 */
export function csvCell(value: unknown): string {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

const safeArchiveName = (value: string): string =>
    // eslint-disable-next-line no-control-regex
    value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 180) || 'lyrics';

/* ------------------------------------------------------------------ */
/* Queue                                                                */
/* ------------------------------------------------------------------ */

router.get('/queue', (req: Request, res: Response) => {
    // Without parameters keep the array the dashboard queue view expects.
    if (!hasAnyQuery(req, ['status', 'limit', 'offset'])) {
        res.json(downloadQueue.getAll());
        return;
    }
    const query = parseQuery(queueListQuery, req.query);
    res.json(downloadActionsService.getQueue(query));
});

router.get('/queue/item/:id', (req: Request, res: Response) => {
    const { id } = parseParams(queueItemParams, req.params);
    const item = downloadActionsService.getQueueItem(id);
    if (!item) {
        res.status(404).json({ error: 'Queue item not found', code: 'NOT_FOUND' });
        return;
    }
    res.json(item);
});

router.post('/queue/add', async (req: Request, res: Response) => {
    const body = parseBody(queueAddBody, req.body);

    if (body.url !== undefined) {
        const result = await downloadActionsService.enqueueUrls([body.url], body.quality, {
            priority: body.priority,
            source: 'dashboard'
        });
        const entry = result.results[0];
        if (!entry?.ok || !entry.queueId) {
            throw new QueueRequestError(entry?.error || 'Could not add this link', 400, 'VALIDATION_ERROR');
        }
        res.json({
            id: entry.queueId,
            queueId: entry.queueId,
            type: entry.type,
            contentId: entry.id,
            title: entry.title,
            deduped: entry.deduped === true
        });
        return;
    }

    const result = await downloadActionsService.enqueue({
        type: body.type!,
        id: body.id!,
        quality: body.quality,
        priority: body.priority,
        title: body.title,
        source: 'dashboard'
    });
    const entry = result.items[0]!;
    res.json({
        id: entry.queueId,
        queueId: entry.queueId,
        type: entry.type,
        contentId: entry.id,
        title: entry.title,
        status: entry.status,
        deduped: entry.deduped
    });
});

router.post('/queue/action', (req: Request, res: Response) => {
    const { action } = parseBody(queueActionBody, req.body);
    switch (action) {
        case 'pause':
            downloadActionsService.pause();
            res.json({ success: true });
            return;
        case 'resume':
            downloadActionsService.resume();
            res.json({ success: true });
            return;
        case 'clear':
            res.json({ success: true, count: downloadQueue.clear() });
            return;
        case 'clear-completed':
            res.json({ success: true, count: downloadActionsService.clearCompleted() });
            return;
        case 'clear-pending':
            res.json({ success: true, count: downloadActionsService.clearPending() });
            return;
        case 'retry-failed':
            res.json({ success: true, count: downloadActionsService.retryFailed() });
            return;
    }
});

router.post('/queue/retry-failed', (_req: Request, res: Response) => {
    res.json({ success: true, count: downloadActionsService.retryFailed() });
});

router.post('/queue/item/:id/retry', (req: Request, res: Response) => {
    const { id } = parseParams(queueItemParams, req.params);
    res.json({ success: true, item: downloadActionsService.retry(id) });
});

router.post('/queue/item/:id/cancel', (req: Request, res: Response) => {
    const { id } = parseParams(queueItemParams, req.params);
    res.json({ success: true, item: downloadActionsService.cancel(id) });
});

router.post('/queue/item/:id/priority', (req: Request, res: Response) => {
    const { id } = parseParams(queueItemParams, req.params);
    const { priority } = parseBody(priorityBody, req.body);
    res.json({ success: true, item: downloadActionsService.setPriority(id, priority) });
});

router.delete('/queue/item/:id', (req: Request, res: Response) => {
    const { id } = parseParams(queueItemParams, req.params);
    res.json({ success: true, result: downloadActionsService.remove(id) });
});

// Legacy per-item endpoint used by the dashboard queue view. It answers 200
// with `success: false` when the action does not apply, as it always has.
router.post('/item/:id/:action', (req: Request, res: Response) => {
    const { id, action } = parseParams(legacyItemParams, req.params);
    try {
        if (action === 'retry') downloadActionsService.retry(id);
        else if (action === 'remove') downloadActionsService.remove(id);
        else downloadActionsService.cancel(id);
        res.json({ success: true });
    } catch (error: unknown) {
        if (error instanceof QueueRequestError && error.statusCode !== 400) {
            res.json({ success: false, error: error.message });
            return;
        }
        throw error;
    }
});

/* ------------------------------------------------------------------ */
/* Downloads (all enqueue and return immediately)                       */
/* ------------------------------------------------------------------ */

router.post('/download', async (req: Request, res: Response) => {
    const body = parseBody(downloadBody, req.body);
    const result = await downloadActionsService.enqueue({ ...body, source: 'dashboard' });
    res.json({ success: true, count: result.items.length, ...result });
});

router.post('/download/track', async (req: Request, res: Response) => {
    const body = parseBody(simpleDownloadBody, req.body);
    const result = await downloadActionsService.enqueue({ type: 'track', ...body, source: 'dashboard' });
    res.json({ success: true, count: result.items.length, ...result });
});

router.post('/download/album', async (req: Request, res: Response) => {
    const { indices, trackIds, ...body } = parseBody(albumDownloadBody, req.body);
    let selected = trackIds;

    if (indices) {
        const albumId = downloadActionsService.normalizeId('album', body.id);
        const albumRes = await api.getAlbum(albumId);
        if (!albumRes.success || !albumRes.data) {
            throw new QueueRequestError('Album not found', 404, 'NOT_FOUND');
        }
        const tracks = albumRes.data.tracks?.items ?? [];
        const outOfRange = indices.filter((index) => index >= tracks.length);
        if (outOfRange.length > 0) {
            throw new QueueRequestError(
                `Track index out of range: ${outOfRange.slice(0, 10).join(', ')}`,
                400,
                'VALIDATION_ERROR'
            );
        }
        const fromIndices = indices.map((index) => String(tracks[index]!.id));
        selected = [...(trackIds ?? []).map(String), ...fromIndices];
    }

    const result = await downloadActionsService.enqueue({
        type: 'album',
        ...body,
        trackIds: selected,
        source: 'dashboard'
    });
    res.json({ success: true, count: result.items.length, ...result });
});

for (const type of ['playlist', 'artist', 'label'] as const) {
    router.post(`/download/${type}`, async (req: Request, res: Response) => {
        const body = parseBody(simpleDownloadBody, req.body);
        const result = await downloadActionsService.enqueue({ type, ...body, source: 'dashboard' });
        res.json({ success: true, count: result.items.length, ...result });
    });
}

router.post('/download/urls', async (req: Request, res: Response) => {
    const body = parseBody(urlsDownloadBody, req.body);
    const result = await downloadActionsService.enqueueUrls(body.urls, body.quality, {
        priority: body.priority,
        skipExisting: body.skipExisting,
        source: 'dashboard'
    });
    res.json({ success: result.failed === 0, ...result });
});

/* ------------------------------------------------------------------ */
/* History                                                              */
/* ------------------------------------------------------------------ */

router.get('/history', (req: Request, res: Response) => {
    // Without parameters keep the array the dashboard history view expects.
    if (!hasAnyQuery(req, ['q', 'limit', 'offset'])) {
        res.json(Object.entries(historyService.getAll()).map(([id, data]) => ({ id, ...data })));
        return;
    }
    const query = parseQuery(historyQuery, req.query);
    res.json(historyService.query(query));
});

router.delete('/history/:id', (req: Request, res: Response) => {
    const { id } = parseParams(historyIdParams, req.params);
    if (!historyService.remove(id)) {
        res.status(404).json({ error: 'History entry not found', code: 'NOT_FOUND' });
        return;
    }
    res.json({ success: true });
});

router.post('/history/clear', (_req: Request, res: Response) => {
    historyService.clearAll();
    res.json({ success: true });
});

router.get('/history/export', (req: Request, res: Response) => {
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const history = historyService.getSorted();

    if (format === 'csv') {
        const headers = ['ID', 'Downloaded At', 'Title', 'Artist', 'Album', 'Quality', 'Filename'];
        const rows = history.map((item) => [
            item.id,
            item.downloadedAt,
            item.title,
            item.artist || '',
            item.album || '',
            item.quality,
            item.filename
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map((row) => row.map(csvCell).join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=qbz_history.csv');
        res.send(csvContent);
        return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=qbz_history.json');
    res.json(history);
});

router.delete('/history', (_req: Request, res: Response) => {
    historyService.clearAll();
    res.json({ success: true });
});

/* ------------------------------------------------------------------ */
/* Lyrics                                                               */
/* ------------------------------------------------------------------ */

router.get('/lyrics/:id', async (req: Request, res: Response) => {
    const { id } = parseParams(trackIdParams, req.params);
    res.json(await getTrackLyrics(id));
});

router.post('/lyrics/:id/save', (req: Request, res: Response) => {
    const { id } = parseParams(trackIdParams, req.params);
    const { content } = parseBody(lyricsSaveBody, req.body);

    const historyItem = historyService.get(id);
    if (!historyItem) {
        res.status(404).json({ error: 'Track not found in history', code: 'NOT_FOUND' });
        return;
    }

    const lrcPath = managedLrcPath(historyItem.filename);
    if (!lrcPath) {
        res.status(403).json({
            error: 'The track is outside the managed library folders',
            code: 'FORBIDDEN'
        });
        return;
    }
    if (!existsSync(path.dirname(lrcPath))) {
        res.status(404).json({ error: 'The track folder no longer exists', code: 'NOT_FOUND' });
        return;
    }

    writeFileSync(lrcPath, content, 'utf8');
    logger.info(`Lyrics manually updated for track ${id}`, 'LYRICS');
    res.json({ success: true });
});

router.post('/lyrics/download', async (req: Request, res: Response) => {
    const { trackId } = parseBody(lyricsDownloadBody, req.body);
    const { lyrics } = await downloadTrackLyrics(String(trackId));
    res.json(lyrics);
});

router.post('/lyrics/download-album-zip', async (req: Request, res: Response) => {
    const { albumId: rawAlbumId } = parseBody(albumZipBody, req.body);
    const albumId = String(rawAlbumId);

    const albumRes = await api.getAlbum(albumId);
    if (!albumRes.success || !albumRes.data) {
        res.status(404).json({ error: 'Album not found', code: 'NOT_FOUND' });
        return;
    }

    const album = albumRes.data;
    const tracks = album.tracks?.items || [];
    if (tracks.length === 0) {
        res.status(404).json({ error: 'No tracks found for this album', code: 'NOT_FOUND' });
        return;
    }

    const { downloadService } = await import('../../queue-processor.js');
    const { default: archiver } = await import('archiver');

    const albumArtist = album.artist?.name || 'Unknown Artist';
    const zipDir = path.join(path.resolve(CONFIG.download.outputDir || './downloads'), '_lyrics');
    if (!existsSync(zipDir)) mkdirSync(zipDir, { recursive: true });

    const zipName = `${safeArchiveName(`${albumArtist} - ${album.title || albumId} - Lyrics`)}.zip`;
    const zipPath = path.join(zipDir, zipName);

    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const closed = new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
    });
    archive.pipe(output);

    let added = 0;
    for (const [index, track] of tracks.entries()) {
        try {
            const lyrics = await downloadService.lyricsProvider.getLyrics(
                track.title,
                track.performer?.name || track.artist?.name || albumArtist,
                album.title,
                track.duration
            );

            const text = lyrics.success ? lyrics.syncedLyrics || lyrics.plainLyrics : undefined;
            if (typeof text === 'string' && text) {
                const number = Number.isInteger(track.track_number) ? track.track_number : index + 1;
                const filename = `${safeArchiveName(`${String(number).padStart(2, '0')}. ${track.title || 'Track'}`)}.lrc`;
                archive.append(text, { name: filename });
                added++;
            }
        } catch {
            logger.warn(`Failed to fetch lyrics for ZIP: ${track.title}`, 'LYRICS');
        }
    }

    await archive.finalize();
    await closed;
    logger.info(`Lyrics ZIP created: ${zipName} (${added} file(s))`, 'LYRICS');

    // Relative to the downloads folder: the absolute server path is not the
    // client's business.
    res.json({
        success: true,
        fileName: zipName,
        filePath: path.posix.join('_lyrics', zipName),
        lyricsCount: added
    });
});

/* ------------------------------------------------------------------ */
/* Misc                                                                 */
/* ------------------------------------------------------------------ */

router.post('/migrate/spotify', async (req: Request, res: Response) => {
    // Outside the try: a malformed body is a 400, not a migration failure.
    const { url, quality, download } = parseBody(spotifyMigrationBody, req.body);
    try {
        const q = normalizeDownloadQuality(quality, CONFIG.quality.default);
        const results = await migrationService.migrateFromSpotify(url, q);

        if (download && results.results.length > 0) {
            const count = await migrationService.startMigrationDownload(results.results, q);
            return res.json({ ...results, enqueued: count });
        }

        res.json(results);
    } catch (error: unknown) {
        res.status(500).json({ error: (error as Error).message });
    }
});

router.get('/analytics/overview', (_req: Request, res: Response) => {
    res.json(databaseService.getOverallStats() || {});
});

router.use(routeErrorHandler('download'));

export default router;

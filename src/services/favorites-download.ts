import { databaseService } from './database/index.js';
import { downloadActionsService } from './download-actions.js';
import { qobuzLibraryService } from './qobuz-library/service.js';

export type FavoritesDownloadType = 'albums' | 'tracks' | 'all';
export type LibraryDownloadKind = 'albums' | 'tracks';

export interface FavoritesDownloadResult {
    queued: number;
    deduped: number;
    /** Tracks skipped because they are already in the library. */
    skipped: number;
    failed: number;
}

/** Same counters as {@link FavoritesDownloadResult}, plus the ids that could not be queued. */
export interface LibraryIdsQueueResult extends FavoritesDownloadResult {
    failedIds: string[];
}

/** Upper bound per type, so one call cannot page through an unbounded list. */
export const MAX_FAVORITES_PER_DOWNLOAD = 2000;
/** Upper bound per type for purchases (their id list is not paginated). */
export const MAX_PURCHASES_PER_DOWNLOAD = 2000;
const PAGE = 100;

const kindsOf = (type: FavoritesDownloadType): readonly LibraryDownloadKind[] =>
    type === 'all' ? ['albums', 'tracks'] : [type];

/**
 * Queues album or track ids, one queue item each. Tracks already in the
 * library are skipped; albums are queued and the processor skips files that
 * already exist. Does not check credentials: callers run
 * `downloadActionsService.ensureReady()` once first.
 */
export async function queueLibraryIds(
    kind: LibraryDownloadKind,
    ids: Iterable<string>,
    quality: unknown,
    source: string
): Promise<LibraryIdsQueueResult> {
    const result: LibraryIdsQueueResult = { queued: 0, deduped: 0, skipped: 0, failed: 0, failedIds: [] };
    for (const rawId of ids) {
        const id = String(rawId);
        if (kind === 'tracks' && databaseService.hasTrack(id)) {
            result.skipped++;
            continue;
        }
        try {
            const queued = await downloadActionsService.enqueue({
                type: kind === 'albums' ? 'album' : 'track',
                id,
                quality: quality as string | number | null | undefined,
                source
            });
            result.queued += queued.queued;
            result.deduped += queued.deduped;
        } catch {
            result.failed++;
            result.failedIds.push(id);
        }
    }
    return result;
}

const addCounts = (target: FavoritesDownloadResult, part: FavoritesDownloadResult): void => {
    target.queued += part.queued;
    target.deduped += part.deduped;
    target.skipped += part.skipped;
    target.failed += part.failed;
};

/**
 * Queues the user's favorite albums and/or tracks (up to
 * {@link MAX_FAVORITES_PER_DOWNLOAD} each). Used by the REST route and the
 * MCP tool.
 */
export async function downloadFavorites(
    type: FavoritesDownloadType,
    quality: unknown,
    source: string
): Promise<FavoritesDownloadResult> {
    // Fail once with a clear error instead of once per item.
    downloadActionsService.ensureReady();

    const result: FavoritesDownloadResult = { queued: 0, deduped: 0, skipped: 0, failed: 0 };
    for (const kind of kindsOf(type)) {
        for (let offset = 0; offset < MAX_FAVORITES_PER_DOWNLOAD; offset += PAGE) {
            const page = await qobuzLibraryService.listFavorites(kind, { limit: PAGE, offset });
            const ids = (page.items as Array<{ id: string | number }>).map((item) => String(item.id));
            addCounts(result, await queueLibraryIds(kind, ids, quality, source));
            if (!page.has_more) break;
        }
    }
    return result;
}

/**
 * Queues the user's purchased albums and/or tracks (up to
 * {@link MAX_PURCHASES_PER_DOWNLOAD} each). Tracks already in the library are
 * skipped. Used by the REST route and the MCP tool.
 */
export async function downloadPurchases(
    type: FavoritesDownloadType,
    quality: unknown,
    source: string
): Promise<FavoritesDownloadResult> {
    downloadActionsService.ensureReady();

    const purchases = await qobuzLibraryService.getPurchaseIds();
    const result: FavoritesDownloadResult = { queued: 0, deduped: 0, skipped: 0, failed: 0 };
    for (const kind of kindsOf(type)) {
        const ids = purchases[kind].slice(0, MAX_PURCHASES_PER_DOWNLOAD);
        addCounts(result, await queueLibraryIds(kind, ids, quality, source));
    }
    return result;
}

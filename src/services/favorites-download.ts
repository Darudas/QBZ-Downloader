import { databaseService } from './database/index.js';
import { downloadActionsService } from './download-actions.js';
import { qobuzLibraryService } from './qobuz-library/service.js';

export type FavoritesDownloadType = 'albums' | 'tracks' | 'all';

export interface FavoritesDownloadResult {
    queued: number;
    deduped: number;
    /** Tracks skipped because they are already in the library. */
    skipped: number;
    failed: number;
}

/** Upper bound per type, so one call cannot page through an unbounded list. */
export const MAX_FAVORITES_PER_DOWNLOAD = 2000;
const PAGE = 100;

/**
 * Queues the user's favorite albums and/or tracks. Tracks already in the
 * library are skipped; albums are queued and the processor skips files that
 * already exist. Used by the REST route and the MCP tool.
 */
export async function downloadFavorites(
    type: FavoritesDownloadType,
    quality: unknown,
    source: string
): Promise<FavoritesDownloadResult> {
    // Fail once with a clear error instead of once per item.
    downloadActionsService.ensureReady();

    const result: FavoritesDownloadResult = { queued: 0, deduped: 0, skipped: 0, failed: 0 };
    const kinds = type === 'all' ? (['albums', 'tracks'] as const) : ([type] as const);
    for (const kind of kinds) {
        for (let offset = 0; offset < MAX_FAVORITES_PER_DOWNLOAD; offset += PAGE) {
            const page = await qobuzLibraryService.listFavorites(kind, { limit: PAGE, offset });
            for (const item of page.items as Array<{ id: string | number }>) {
                const id = String(item.id);
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
                }
            }
            if (!page.has_more) break;
        }
    }
    return result;
}

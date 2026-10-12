import { databaseService } from './database/index.js';
import { downloadQueue } from './queue/queue.js';
import { QueueRequestError } from './queue/utils.js';
import type { QueueItem } from './queue/types.js';
import { isPathWithinManagedRoots } from '../utils/paths.js';
import { normalizeDownloadQuality } from '../config.js';

/**
 * Queues a Hi-Res upgrade for a scanned library file. The old file is deleted
 * after the better copy is downloaded, so callers (REST and MCP) may only name
 * a file the scanner indexed and one of the upgrade candidates the scanner
 * recorded for it; the upgrade metadata is built here, never taken from input.
 * Throws QueueRequestError (400/403/404) for invalid requests.
 */
export function queueLibraryUpgrade(input: {
    filePath: unknown;
    trackId?: unknown;
    quality?: unknown;
}): QueueItem {
    const filePath = typeof input.filePath === 'string' ? input.filePath : '';
    if (!filePath) throw new QueueRequestError('filePath is required', 400, 'VALIDATION_ERROR');
    if (!isPathWithinManagedRoots(filePath)) {
        throw new QueueRequestError('File is outside the managed library folders', 403, 'FORBIDDEN');
    }

    const libraryFile = databaseService.getLibraryFileByPath(filePath);
    if (!libraryFile) throw new QueueRequestError('File is not in the scanned library', 404, 'NOT_FOUND');

    let candidates: Array<{ trackId?: unknown; quality?: unknown; title?: unknown; album?: unknown }> = [];
    try {
        const parsed = JSON.parse(String(libraryFile.upgrade_candidates ?? '[]'));
        if (Array.isArray(parsed)) candidates = parsed;
    } catch {
        candidates = [];
    }
    if (candidates.length === 0) {
        throw new QueueRequestError('No upgrade candidates recorded for this file', 400, 'NO_CANDIDATES');
    }

    // Without an explicit track the scanner's first (best) candidate is used.
    const wanted = input.trackId === undefined || input.trackId === null ? undefined : String(input.trackId).trim();
    if (wanted !== undefined && !/^\d{1,20}$/.test(wanted)) {
        throw new QueueRequestError('trackId must be numeric', 400, 'VALIDATION_ERROR');
    }
    const candidate = wanted === undefined ? candidates[0] : candidates.find((c) => String(c?.trackId) === wanted);
    if (!candidate) {
        throw new QueueRequestError('trackId is not an upgrade candidate for this file', 400, 'VALIDATION_ERROR');
    }

    const quality = normalizeDownloadQuality(
        (input.quality ?? candidate.quality) as number | string | undefined,
        27
    );
    return downloadQueue.add('track', String(candidate.trackId), quality, {
        metadata: {
            isUpgrade: true,
            oldFilePath: filePath,
            libraryFileId: libraryFile.id as number | undefined,
            selectedUpgradeTitle: typeof candidate.title === 'string' ? candidate.title : undefined,
            selectedUpgradeAlbum: typeof candidate.album === 'string' ? candidate.album : undefined
        }
    });
}

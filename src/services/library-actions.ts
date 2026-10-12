import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { databaseService } from './database/index.js';
import { downloadQueue } from './queue/queue.js';
import { QueueRequestError } from './queue/utils.js';
import { isSameFile } from './queue/upgrade-guard.js';
import type { QueueItem } from './queue/types.js';
import { historyService } from './history.js';
import MetadataService from './metadata.js';
import { patchTags, EDITABLE_TAG_FORMATS, type TagChanges } from './tag-editor.js';
import { isPathWithinManagedRoots } from '../utils/paths.js';
import { normalizeDownloadQuality } from '../config.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Write actions on the local library, shared by the REST routes and the MCP
 * tools. Every action that names a file checks that it lies inside the
 * managed library folders and is a file the app knows about; none of them
 * accepts upgrade metadata or other server-side state from the caller.
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function assertManagedPath(filePath: unknown, what = 'File'): string {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
        throw new ValidationError('filePath is required');
    }
    if (!isPathWithinManagedRoots(filePath)) {
        throw new ForbiddenError(`${what} is outside the managed library folders`);
    }
    return filePath;
}

const isRegularFile = (filePath: string): boolean => {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
};

/**
 * The ways one file can be stored in the index: downloads record absolute
 * paths, while the scanner keeps the configured form, which is relative with
 * the default `./downloads`. Lookups and updates must try each of them.
 */
export function pathVariants(filePath: string): string[] {
    const absolute = path.resolve(filePath);
    const relative = path.relative(process.cwd(), absolute);
    return [...new Set([filePath, absolute, relative, `.${path.sep}${relative}`])];
}

const findLibraryFile = (filePath: string) =>
    pathVariants(filePath)
        .map((variant) => databaseService.getLibraryFileByPath(variant))
        .find(Boolean);

const findTrack = (filePath: string) =>
    pathVariants(filePath)
        .map((variant) => databaseService.getTrackByPath(variant))
        .find(Boolean);

/** Drops the index rows of a file that is gone (library_files, tracks, open duplicates, history). */
function forgetFile(filePath: string): { libraryFiles: number; tracks: number } {
    let libraryFiles = 0;
    let tracks = 0;
    const resolveDuplicates = databaseService
        .getDb()
        .prepare('UPDATE duplicates SET resolved = 1 WHERE file_path_1 = ? OR file_path_2 = ?');
    for (const variant of pathVariants(filePath)) {
        if (databaseService.getLibraryFileByPath(variant)) {
            libraryFiles++;
            databaseService.deleteLibraryFileByPath(variant);
        }
        // Exact match only: deleteTrackByPath falls back to a fuzzy suffix
        // match, which must not remove some other copy's row.
        if (databaseService.getTrackByPath(variant)) {
            tracks++;
            databaseService.deleteTrackByPath(variant);
        }
        resolveDuplicates.run(variant, variant);
    }
    historyService.cleanup();
    return { libraryFiles, tracks };
}

/* ------------------------------------------------------------------ */
/* Upgrade                                                              */
/* ------------------------------------------------------------------ */

/**
 * Queues a Hi-Res upgrade for a scanned library file. The old file is deleted
 * after the better copy is downloaded, so callers (REST and MCP) may only name
 * a file the scanner indexed (by path or library_files id) and one of the
 * upgrade candidates the scanner recorded for it; the upgrade metadata is
 * built here, never taken from input.
 * Throws QueueRequestError (400/403/404) for invalid requests.
 */
export function queueUpgrade(input: {
    filePath?: unknown;
    libraryFileId?: unknown;
    trackId?: unknown;
    quality?: unknown;
}): QueueItem {
    let filePath = typeof input.filePath === 'string' ? input.filePath : '';
    if (!filePath && input.libraryFileId !== undefined && input.libraryFileId !== null) {
        const id = Number(input.libraryFileId);
        if (!Number.isInteger(id) || id <= 0) {
            throw new QueueRequestError('libraryFileId must be a positive integer', 400, 'VALIDATION_ERROR');
        }
        const row = databaseService.getLibraryFileById(id);
        if (!row) throw new QueueRequestError('File is not in the scanned library', 404, 'NOT_FOUND');
        filePath = String(row.file_path);
    }
    if (!filePath) throw new QueueRequestError('filePath is required', 400, 'VALIDATION_ERROR');
    if (!isPathWithinManagedRoots(filePath)) {
        throw new QueueRequestError('File is outside the managed library folders', 403, 'FORBIDDEN');
    }

    const libraryFile = findLibraryFile(filePath);
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

/* ------------------------------------------------------------------ */
/* Duplicates                                                           */
/* ------------------------------------------------------------------ */

export type DuplicateKeep = 'auto' | 'first' | 'second';

export interface ResolveDuplicateResult {
    id: number;
    resolved: boolean;
    deleted: boolean;
    dryRun?: boolean;
    deletedFile?: string;
    keptFile?: string;
    matchType?: string;
    reason?: string;
}

interface DuplicateSide {
    file_path: string;
    quality: number;
    file_size: number;
    exists: boolean;
}

function duplicateSide(filePath: string): DuplicateSide {
    const row = findLibraryFile(filePath) as { quality?: number; file_size?: number } | undefined;
    const exists = isRegularFile(filePath);
    let size = Number(row?.file_size ?? 0);
    if (!size && exists) size = fs.statSync(filePath).size;
    return { file_path: filePath, quality: Number(row?.quality ?? 0), file_size: size, exists };
}

/**
 * Resolves a duplicate pair by deleting one file. `keep` picks the file to
 * keep: `auto` keeps an existing file over a missing one, then the higher
 * quality, then the larger file; `first`/`second` name it explicitly.
 * `dryRun` only reports what would happen. Both files must lie inside the
 * managed library folders.
 */
export async function resolveDuplicate(
    id: number,
    options: { keep?: DuplicateKeep; dryRun?: boolean } = {}
): Promise<ResolveDuplicateResult> {
    const keep = options.keep ?? 'auto';
    const dryRun = options.dryRun === true;
    const db = databaseService.getDb();
    const duplicate = db.prepare('SELECT * FROM duplicates WHERE id = ?').get(id) as
        | { file_path_1: string; file_path_2: string; match_type?: string }
        | undefined;
    if (!duplicate) throw new NotFoundError('Duplicate record not found');

    if (!isPathWithinManagedRoots(duplicate.file_path_1) || !isPathWithinManagedRoots(duplicate.file_path_2)) {
        throw new ForbiddenError('Duplicate files are outside the managed library folders');
    }

    const first = duplicateSide(duplicate.file_path_1);
    const second = duplicateSide(duplicate.file_path_2);
    const base = { id, matchType: duplicate.match_type, ...(dryRun ? { dryRun: true } : {}) };

    if (!first.exists && !second.exists) {
        if (!dryRun) {
            forgetFile(first.file_path);
            forgetFile(second.file_path);
            databaseService.resolveDuplicate(id);
            logger.warn(`Duplicate #${id} resolved as stale; neither file exists on disk`, 'LIBRARY');
        }
        return { ...base, resolved: !dryRun, deleted: false, reason: 'Both duplicate files were already missing' };
    }

    let kept: DuplicateSide;
    let removed: DuplicateSide;
    if (keep === 'first' || keep === 'second') {
        [kept, removed] = keep === 'first' ? [first, second] : [second, first];
        if (!kept.exists) {
            throw new ValidationError(`The ${keep} file no longer exists; keep the other one`);
        }
    } else if (!first.exists || !second.exists) {
        [kept, removed] = first.exists ? [first, second] : [second, first];
    } else if (first.quality !== second.quality) {
        [kept, removed] = first.quality > second.quality ? [first, second] : [second, first];
    } else {
        [kept, removed] = first.file_size >= second.file_size ? [first, second] : [second, first];
    }

    if (removed.exists && isSameFile(kept.file_path, removed.file_path)) {
        throw new ValidationError('Both entries point to the same file; nothing is deleted');
    }

    const result: ResolveDuplicateResult = {
        ...base,
        resolved: !dryRun,
        deleted: false,
        deletedFile: removed.file_path,
        keptFile: kept.file_path
    };
    if (dryRun) {
        return { ...result, deleted: false, reason: removed.exists ? 'Would delete this file' : 'File already missing' };
    }

    if (removed.exists) {
        try {
            fs.unlinkSync(removed.file_path);
            result.deleted = true;
            logger.info(
                `Resolved duplicate by deleting: ${path.basename(removed.file_path)} (kept ${path.basename(kept.file_path)})`,
                'LIBRARY'
            );
        } catch (error: unknown) {
            logger.error(`Failed to delete duplicate file ${removed.file_path}: ${(error as Error).message}`, 'LIBRARY');
            throw error;
        }
    }

    forgetFile(removed.file_path);
    databaseService.resolveDuplicate(id);
    return result;
}

/* ------------------------------------------------------------------ */
/* Delete                                                               */
/* ------------------------------------------------------------------ */

export interface DeleteLibraryFileResult {
    filePath: string;
    deleted: boolean;
    removedRows: { libraryFiles: number; tracks: number };
}

/**
 * Deletes a library file from disk and removes its index rows. The file must
 * be inside the managed folders and known to the app (scanned, or downloaded
 * by it); other files in those folders, such as covers, are refused.
 */
export function deleteLibraryFile(input: { filePath?: unknown; libraryFileId?: unknown }): DeleteLibraryFileResult {
    let filePath: unknown = input.filePath;
    if ((filePath === undefined || filePath === '') && input.libraryFileId !== undefined) {
        const id = Number(input.libraryFileId);
        if (!Number.isInteger(id) || id <= 0) throw new ValidationError('libraryFileId must be a positive integer');
        const row = databaseService.getLibraryFileById(id);
        if (!row) throw new NotFoundError('Library file not found');
        filePath = row.file_path;
    }
    const target = assertManagedPath(filePath);

    const known = Boolean(findLibraryFile(target)) || Boolean(findTrack(target));
    if (!known) throw new NotFoundError('File is not in the library index');

    let deleted = false;
    if (fs.existsSync(target)) {
        if (!isRegularFile(target)) throw new ValidationError('Path is not a regular file');
        fs.unlinkSync(target);
        deleted = true;
        logger.info(`Deleted library file: ${path.basename(target)}`, 'LIBRARY');
    }
    return { filePath: target, deleted, removedRows: forgetFile(target) };
}

/* ------------------------------------------------------------------ */
/* Metadata edit                                                        */
/* ------------------------------------------------------------------ */

const textField = (max: number) => z.string().max(max).transform((value) => value.trim());
const numberField = z
    .union([z.number().int().min(0).max(9999), z.string().trim().regex(/^\d{0,4}$/, 'Must be a number')])
    .transform((value) => String(value));

/** Fields an edit may change. Empty strings remove the tag. Unknown keys are ignored. */
export const editableMetadataSchema = z
    .object({
        title: textField(500),
        artist: textField(500),
        album: textField(500),
        albumArtist: textField(500),
        genre: textField(200),
        year: z
            .union([z.number().int().min(0).max(9999), z.string().trim().regex(/^(\d{4}(-\d{2}(-\d{2})?)?)?$/, 'Use YYYY or YYYY-MM-DD')])
            .transform((value) => String(value)),
        trackNumber: numberField,
        totalTracks: numberField,
        discNumber: numberField,
        totalDiscs: numberField,
        composer: textField(500),
        label: textField(500),
        isrc: z.string().trim().regex(/^([A-Za-z]{2}[A-Za-z0-9]{3}\d{7})?$/, 'Invalid ISRC'),
        copyright: textField(1000),
        comment: textField(4000)
    })
    .partial()
    .refine((fields) => Object.values(fields).some((value) => value !== undefined), {
        message: 'At least one metadata field is required'
    });

export type EditableMetadata = z.input<typeof editableMetadataSchema>;

export interface EditTrackMetadataResult {
    filePath: string;
    updated: string[];
}

/**
 * Changes single tags of a FLAC or MP3 library file. Unlike writeMetadata it
 * keeps every other tag and the embedded cover, and it also updates the
 * matching `library_files`/`tracks` rows so the next scan and the views agree.
 */
export async function editTrackMetadata(filePath: unknown, fields: unknown): Promise<EditTrackMetadataResult> {
    const target = assertManagedPath(filePath);
    const parsed = editableMetadataSchema.safeParse(fields ?? {});
    if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'Invalid metadata');

    const ext = path.extname(target).toLowerCase();
    if (!(EDITABLE_TAG_FORMATS as readonly string[]).includes(ext)) {
        throw new ValidationError(`Editing tags is only supported for ${EDITABLE_TAG_FORMATS.join(', ')} files`);
    }
    if (!isRegularFile(target)) throw new NotFoundError('File not found');

    const changes = Object.fromEntries(
        Object.entries(parsed.data).filter(([, value]) => value !== undefined)
    ) as TagChanges;

    await MetadataService.runExclusive(() => patchTags(target, changes));

    const stat = fs.statSync(target);
    const year = changes.year ? Number.parseInt(changes.year.slice(0, 4), 10) : undefined;
    for (const variant of pathVariants(target)) {
        databaseService.updateLibraryFileTags(variant, {
            title: changes.title,
            artist: changes.artist,
            album_artist: changes.albumArtist,
            album: changes.album,
            file_size: stat.size,
            file_mtime_ms: stat.mtimeMs
        });
        databaseService.updateTrackTagsByPath(variant, {
            title: changes.title,
            artist: changes.artist,
            album_artist: changes.albumArtist,
            album: changes.album,
            genre: changes.genre,
            year: Number.isFinite(year) ? year : undefined,
            isrc: changes.isrc,
            label: changes.label
        });
    }

    logger.info(`Edited ${Object.keys(changes).length} tag(s) of ${path.basename(target)}`, 'LIBRARY');
    return { filePath: target, updated: Object.keys(changes) };
}

export const libraryActionsService = {
    queueUpgrade,
    resolveDuplicate,
    deleteLibraryFile,
    editTrackMetadata
};

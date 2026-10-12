import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { parseFile } from 'music-metadata';
import { qobuzApi } from '../api/qobuz.js';
import { databaseService } from './database/index.js';
import MetadataService from './metadata.js';
import { EDITABLE_TAG_FORMATS } from './tag-editor.js';
import { CONFIG } from '../config.js';
import { isPathWithinManagedRoots } from '../utils/paths.js';
import { isPublicHttpUrl, MAX_IMAGE_BYTES, MAX_IMAGE_REDIRECTS } from '../utils/net.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface EmbeddedCover {
    data: Buffer;
    mime: string;
}

/** The first embedded picture of a file, or null (unreadable files have none). */
async function readEmbeddedCover(filePath: string): Promise<EmbeddedCover | null> {
    try {
        const metadata = await parseFile(filePath, { duration: false, skipCovers: false });
        const picture = metadata.common.picture?.[0];
        if (!picture || picture.data.length === 0) return null;
        return { data: Buffer.from(picture.data), mime: picture.format || 'image/jpeg' };
    } catch (e: unknown) {
        logger.debug(`Could not read the embedded cover of ${path.basename(filePath)}: ${(e as Error).message}`, 'METADATA');
        return null;
    }
}

const textOrUndefined = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;

const isRegularFile = (filePath: string): boolean => {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
};

/**
 * Rewrites a local file's tags (and embedded cover) from a Qobuz track. The
 * tag writers replace every tag and drop the embedded cover unless one is
 * supplied, so this fetches the album cover and, when none can be fetched
 * (or cover embedding is off), writes the file's existing cover back. It never
 * patches fields from free-form input: the only inputs are a library path and
 * a track id. Like editTrackMetadata, only indexed FLAC/MP3 files inside the
 * managed folders are accepted, and the index rows are updated afterwards.
 */
export async function retagFileFromQobuz(filePath: string, trackId: string | number): Promise<{
    file_path: string;
    title: string;
    artist: string;
    album: string;
    /** True when a new cover from Qobuz was embedded. */
    cover_embedded: boolean;
    /** True when no cover was fetched and the file's existing cover was written back. */
    cover_kept: boolean;
}> {
    if (!filePath || filePath.includes('\0')) throw new ValidationError('file_path is required');
    if (!/^\d{1,20}$/.test(String(trackId))) throw new ValidationError('track_id must be numeric');
    if (!isPathWithinManagedRoots(filePath)) {
        throw new ForbiddenError('File is outside the managed library folders');
    }
    // Case-insensitive: the tag writers are picked here, not by writeMetadata,
    // which would silently skip an upper-case ".FLAC".
    const ext = path.extname(filePath).toLowerCase();
    if (!(EDITABLE_TAG_FORMATS as readonly string[]).includes(ext)) {
        throw new ValidationError(`Rewriting tags is only supported for ${EDITABLE_TAG_FORMATS.join(', ')} files`);
    }
    if (!isRegularFile(filePath)) throw new NotFoundError('File not found');
    const indexed =
        Boolean(databaseService.getLibraryFileByPath(filePath)) || Boolean(databaseService.getTrackByPath(filePath));
    if (!indexed) throw new NotFoundError('File is not in the library index');

    const track = await qobuzApi.getTrack(trackId);
    if (!track.success || !track.data) throw new NotFoundError('Track not found on Qobuz');
    const albumId = (track.data.album as { id?: string } | undefined)?.id;
    const album = albumId ? await qobuzApi.getAlbum(albumId) : undefined;

    const metadataService = new MetadataService();
    const metadata = await metadataService.extractMetadata(track.data, album?.data ?? ({} as never), {});

    let cover: Buffer | null = null;
    if (CONFIG.metadata.embedCover) {
        const image = (album?.data?.image ?? {}) as Record<string, unknown>;
        for (const url of metadataService.getCoverUrlCandidates(image as never, CONFIG.metadata.coverSize)) {
            if (!isPublicHttpUrl(url)) continue;
            try {
                const res = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    maxContentLength: MAX_IMAGE_BYTES,
                    maxRedirects: MAX_IMAGE_REDIRECTS,
                    beforeRedirect: (options) => {
                        if (!isPublicHttpUrl(options.href)) throw new Error('redirect to a non-public host');
                    }
                });
                cover = Buffer.from(res.data);
                break;
            } catch (e: unknown) {
                logger.debug(`Cover candidate failed (${url}): ${(e as Error).message}`, 'METADATA');
            }
        }
    }

    let keptCover = false;
    await MetadataService.runExclusive(async () => {
        const existing = cover ? null : await readEmbeddedCover(filePath);
        keptCover = existing !== null;
        const picture = cover ?? existing?.data ?? null;
        if (ext === '.flac') {
            await metadataService.writeFlacTags(filePath, metadataService.buildFlacTags(metadata, null), picture);
        } else {
            const tags = metadataService.buildId3Tags(metadata, picture, null);
            if (existing && tags.image && typeof tags.image === 'object') tags.image.mime = existing.mime;
            await metadataService.writeId3Tags(filePath, tags);
        }
    });

    // file_size/file_mtime_ms are left as they were, so the next scan re-reads
    // the file and recomputes its missing-tag flags.
    databaseService.updateLibraryFileTags(filePath, {
        title: textOrUndefined(metadata.title),
        artist: textOrUndefined(metadata.artist),
        album_artist: textOrUndefined(metadata.albumArtist),
        album: textOrUndefined(metadata.album)
    });
    const year = Number.parseInt(String(metadata.year ?? '').slice(0, 4), 10);
    databaseService.updateTrackTagsByPath(filePath, {
        title: textOrUndefined(metadata.title),
        artist: textOrUndefined(metadata.artist),
        album_artist: textOrUndefined(metadata.albumArtist),
        album: textOrUndefined(metadata.album),
        genre: textOrUndefined(metadata.genre),
        year: Number.isFinite(year) && year > 0 ? year : undefined,
        isrc: textOrUndefined(metadata.isrc),
        label: textOrUndefined(metadata.label)
    });
    logger.info(`Rewrote the tags of ${path.basename(filePath)} from Qobuz track ${trackId}`, 'METADATA');

    return {
        file_path: filePath,
        title: String(metadata.title ?? ''),
        artist: String(metadata.artist ?? ''),
        album: String(metadata.album ?? ''),
        cover_embedded: cover !== null,
        cover_kept: keptCover
    };
}

import axios from 'axios';
import { qobuzApi } from '../api/qobuz.js';
import MetadataService from './metadata.js';
import { CONFIG } from '../config.js';
import { isPathWithinManagedRoots } from '../utils/paths.js';
import { isPublicHttpUrl, MAX_IMAGE_BYTES, MAX_IMAGE_REDIRECTS } from '../utils/net.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Rewrites a local file's tags (and embedded cover) from a Qobuz track.
 * writeMetadata replaces every tag and drops the embedded cover unless one is
 * supplied, so this always fetches the album cover and never patches fields
 * from free-form input: the only inputs are a library path and a track id.
 */
export async function retagFileFromQobuz(filePath: string, trackId: string | number): Promise<{
    file_path: string;
    title: string;
    artist: string;
    album: string;
    cover_embedded: boolean;
}> {
    if (!filePath || filePath.includes('\0')) throw new ValidationError('file_path is required');
    if (!/^\d{1,20}$/.test(String(trackId))) throw new ValidationError('track_id must be numeric');
    if (!isPathWithinManagedRoots(filePath)) {
        throw new ForbiddenError('File is outside the managed library folders');
    }

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

    await metadataService.writeMetadata(filePath, metadata, 0, null, cover);
    return {
        file_path: filePath,
        title: String(metadata.title ?? ''),
        artist: String(metadata.artist ?? ''),
        album: String(metadata.album ?? ''),
        cover_embedded: cover !== null
    };
}

import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { qobuzApi } from '../api/qobuz.js';
import type LyricsProvider from '../api/lyrics.js';
import { NotFoundError } from '../utils/errors.js';
import { isPathWithinManagedRoots } from '../utils/paths.js';
import { historyService } from './history.js';

/**
 * Lyrics lookups shared by the REST routes and the MCP tools: read a track's
 * `.lrc` sidecar or fetch lyrics from the providers, and save them next to a
 * downloaded track (only inside the managed library folders).
 */

export type TrackLyrics = Awaited<ReturnType<LyricsProvider['getLyrics']>>;

/** `<dir>/<name>.lrc` next to an audio file, for any extension (or none). */
export function lrcPathFor(audioPath: string): string {
    const { dir, name } = path.parse(audioPath);
    return path.join(dir, `${name}.lrc`);
}

/** The `.lrc` sidecar for a downloaded file, or null when it would land outside the library. */
export function managedLrcPath(audioPath: unknown): string | null {
    if (typeof audioPath !== 'string' || !audioPath.trim()) return null;
    const lrcPath = lrcPathFor(audioPath);
    return isPathWithinManagedRoots(lrcPath) ? lrcPath : null;
}

/** The sidecar of a track in the download history, when it is in the library. */
const historyLrcPath = (trackId: string): string | null => {
    const item = historyService.get(trackId);
    return item ? managedLrcPath(item.filename) : null;
};

// Loaded lazily: the queue processor pulls in the whole download pipeline.
async function lyricsProvider(): Promise<LyricsProvider> {
    const { downloadService } = await import('./queue-processor.js');
    return downloadService.lyricsProvider;
}

async function fetchFromProviders(trackId: string): Promise<TrackLyrics> {
    const trackRes = await qobuzApi.getTrack(trackId);
    if (!trackRes.success || !trackRes.data) throw new NotFoundError('Track not found');
    const track = trackRes.data;
    const provider = await lyricsProvider();
    return provider.getLyrics(
        track.title,
        track.performer?.name || track.artist?.name || 'Unknown',
        track.album?.title,
        track.duration
    );
}

/**
 * Lyrics of a track: the saved `.lrc` next to the downloaded file when there
 * is one, otherwise a provider lookup. Throws NotFoundError for an unknown track.
 */
export async function getTrackLyrics(trackId: string): Promise<TrackLyrics> {
    const lrcPath = historyLrcPath(trackId);
    if (lrcPath && existsSync(lrcPath)) {
        const content = readFileSync(lrcPath, 'utf8');
        const provider = await lyricsProvider();
        return {
            success: true,
            source: 'Local File',
            syncedLyrics: content,
            parsedLyrics: provider.parseLrc(content)
        };
    }
    return fetchFromProviders(trackId);
}

/**
 * Fetches lyrics from the providers and, when the track was downloaded into
 * the library, writes them to its `.lrc` sidecar. Throws NotFoundError when
 * the track or its lyrics are not found.
 */
export async function downloadTrackLyrics(trackId: string): Promise<{ lyrics: TrackLyrics; saved: boolean }> {
    const lyrics = await fetchFromProviders(trackId);
    if (!lyrics.success) throw new NotFoundError('Lyrics not found');

    const text = lyrics.syncedLyrics || lyrics.plainLyrics;
    const lrcPath = historyLrcPath(trackId);
    if (lrcPath && typeof text === 'string' && text && existsSync(path.dirname(lrcPath))) {
        writeFileSync(lrcPath, text, 'utf8');
        return { lyrics, saved: true };
    }
    return { lyrics, saved: false };
}

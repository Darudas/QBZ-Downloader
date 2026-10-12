import { databaseService } from './database/index.js';
import { logger } from '../utils/logger.js';

export interface LibraryStats {
    totalTracks: number;
    totalAlbums: number;
    totalArtists: number;
    totalSize: number;
    qualityDistribution: Record<string, number>;
    genreDistribution: Record<string, number>;
    activity: {
        date: string;
        count: number;
    }[];
}

export class LibraryStatisticsService {
    async getLibraryStats(): Promise<LibraryStats> {
        try {
            // Default page size is 100; whole-library statistics need the whole library.
        const tracks = databaseService.getAllTracks(1_000_000, 0);
            
            const stats: LibraryStats = {
                totalTracks: tracks.length,
                totalAlbums: new Set(tracks.map(t => t.album)).size,
                totalArtists: new Set(tracks.map(t => t.artist)).size,
                totalSize: tracks.reduce((acc, t) => acc + (t.file_size || 0), 0),
                qualityDistribution: {},
                genreDistribution: {},
                activity: []
            };

            for (const track of tracks) {
                const qName = this.getQualityLabel(track.quality);
                stats.qualityDistribution[qName] = (stats.qualityDistribution[qName] || 0) + 1;

                if (track.genre) {
                    stats.genreDistribution[track.genre] = (stats.genreDistribution[track.genre] || 0) + 1;
                }
            }

            stats.activity = this.calculateActivity(tracks);

            return stats;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Statistics: Failed to calculate stats: ${message}`, 'STATS');
            throw error;
        }
    }

    private getQualityLabel(quality: number): string {
        if (quality >= 7) return 'Hi-Res';
        if (quality === 6) return 'FLAC';
        if (quality === 5) return 'MP3';
        return 'Other';
    }

    private calculateActivity(tracks: { downloaded_at?: string }[]): { date: string; count: number }[] {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const activityMap = new Map<string, number>();
        const now = Date.now();

        // UTC calendar days, the same clock downloaded_at is written in.
        for (let i = 29; i >= 0; i--) {
            activityMap.set(new Date(now - i * DAY_MS).toISOString().slice(0, 10), 0);
        }

        for (const track of tracks) {
            const date = this.dayOf(track.downloaded_at);
            if (date && activityMap.has(date)) {
                activityMap.set(date, (activityMap.get(date) || 0) + 1);
            }
        }

        return Array.from(activityMap.entries()).map(([date, count]) => ({ date, count }));
    }

    /**
     * `YYYY-MM-DD` of a stored timestamp. addTrack writes ISO strings
     * (`2024-05-01T12:00:00.000Z`) and SQLite's CURRENT_TIMESTAMP default is
     * `2024-05-01 12:00:00`; splitting on a space only matched the latter, so
     * the activity chart stayed at zero.
     */
    private dayOf(value: string | undefined): string | null {
        if (typeof value !== 'string') return null;
        const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
        return match ? match[1]! : null;
    }
}

export const libraryStatisticsService = new LibraryStatisticsService();

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { APP_VERSION } from '../constants.js';
import { downloadActionsService } from '../services/download-actions.js';
import { favoritesSyncService } from '../services/favorites-sync.js';
import { libraryScannerService } from '../services/library-scanner/index.js';
import { downloadQueue } from '../services/queue/queue.js';
import { validateEnvironment } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import type { McpPermissionGroup } from './token.js';

/* ------------------------------------------------------------------ */
/* Resources                                                            */
/* ------------------------------------------------------------------ */

/** Favorites auto-download state, in the tools' snake_case shape. */
export function favoritesAutoDownloadStatus(): Record<string, unknown> {
    try {
        const status = favoritesSyncService.getStatus();
        return {
            enabled: status.autoDownload,
            types: status.types,
            interval_hours: status.intervalHours,
            last_sync_at: status.lastSyncAt,
            next_sync_at: status.nextSyncAt
        };
    } catch {
        return { enabled: false };
    }
}

/** App status shared by the get_status tool and the qbz://status resource. */
export function getAppStatus(): Record<string, unknown> {
    return {
        version: APP_VERSION,
        credentials_configured: validateEnvironment(false).valid,
        queue: downloadQueue.getStats(),
        queue_paused: downloadQueue.isPaused(),
        scan_in_progress: libraryScannerService.isScanInProgress(),
        favorites_auto_download: favoritesAutoDownloadStatus()
    };
}

/** Queue snapshot for qbz://queue: running and pending items first, at most 100. */
export function getQueueSnapshot(): Record<string, unknown> {
    return { ...downloadActionsService.getQueue({ status: 'active', limit: 100 }) };
}

const json = (uri: URL, data: unknown) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }]
});

/** Read-only resources; available with the always-on `read` group. */
export function registerResources(server: McpServer): void {
    const read = (name: string, build: () => unknown) => (uri: URL) => {
        try {
            return json(uri, build());
        } catch (error: unknown) {
            logger.warn(`MCP resource ${name} error: ${(error as Error).message}`, 'MCP');
            throw new Error(`Could not read ${name}`);
        }
    };

    server.registerResource(
        'status',
        'qbz://status',
        {
            title: 'App status',
            description: 'Version, credentials state, queue statistics, library scan and favorites auto-download.',
            mimeType: 'application/json'
        },
        read('status', getAppStatus)
    );

    server.registerResource(
        'queue',
        'qbz://queue',
        {
            title: 'Download queue',
            description: 'Running and pending downloads (up to 100) with queue statistics.',
            mimeType: 'application/json'
        },
        read('queue', getQueueSnapshot)
    );
}

/* ------------------------------------------------------------------ */
/* Prompts                                                              */
/* ------------------------------------------------------------------ */

const userMessage = (text: string) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }]
});

const shortArg = (what: string) => z.string().trim().min(1).max(200).describe(what);

/**
 * Workflow prompts. Each is registered only when the tools it relies on are
 * enabled, so a prompt never asks the model to call a tool it cannot see.
 */
export function registerPrompts(server: McpServer, allowed: ReadonlySet<McpPermissionGroup>): void {
    if (allowed.has('download')) {
        server.registerPrompt(
            'download_discography',
            {
                title: 'Download a discography',
                description: 'Find an artist and queue the albums that are not in the local library yet.',
                argsSchema: z.object({ artist: shortArg('Artist name') })
            },
            ({ artist }) =>
                userMessage(
                    `Download the discography of the artist "${artist}" in the best available quality.\n` +
                        '1. Use search_catalog with type=artists to find the artist; if several match, ask me which one.\n' +
                        '2. List the releases with get_artist_releases (release_type=album first), paging until has_more is false.\n' +
                        '3. Use check_in_library with the album ids to find albums that are missing or only partly downloaded.\n' +
                        '4. Show me the missing albums and, after I confirm, queue them with download (type=album, quality=27).\n' +
                        '5. Finish with a short summary and tell me to follow progress with get_queue.'
                )
        );

        server.registerPrompt(
            'sync_favorites',
            {
                title: 'Download missing favorites',
                description: 'Compare the Qobuz favorites with the local library and queue what is missing.'
            },
            () =>
                userMessage(
                    'Make sure my Qobuz favorites are downloaded.\n' +
                        '1. Read my favorite albums and tracks with list_favorites (page until has_more is false).\n' +
                        '2. Use check_in_library to see which are missing or incomplete, and tell me how many.\n' +
                        '3. After I confirm, queue them with download_favorites (it skips tracks that are already downloaded).' +
                        (allowed.has('manage')
                            ? '\n4. Mention that sync_favorites_now and the favorites auto-download setting can pick up new favorites automatically.'
                            : '')
                )
        );
    }

    if (allowed.has('manage')) {
        server.registerPrompt(
            'find_hires_upgrades',
            {
                title: 'Find Hi-Res upgrades',
                description: 'List local files that Qobuz offers in better quality and offer to upgrade them.'
            },
            () =>
                userMessage(
                    'Find tracks in my local library that I could upgrade to Hi-Res.\n' +
                        '1. Check get_scan_status; if the library was never scanned, start one with start_library_scan and wait for it.\n' +
                        '2. Read list_upgrade_candidates (page until has_more is false) and group the results by album.\n' +
                        '3. Show me the albums with the current and the available quality.\n' +
                        '4. Only for the ones I pick, call queue_upgrade; the old file is replaced after the new one is downloaded.'
                )
        );
    }

    server.registerPrompt(
        'clean_duplicates',
        {
            title: 'Clean up duplicates',
            description: 'Review duplicate files found by the library scan and resolve them one by one.'
        },
        () =>
            userMessage(
                'Help me clean up duplicate files in my local library.\n' +
                    '1. Read list_duplicates (run start_library_scan first if nothing was scanned yet).\n' +
                    '2. For each pair, show both files, the match type and confidence, and which one would be kept.\n' +
                    (allowed.has('destructive')
                        ? '3. Only for pairs I explicitly approve, call resolve_duplicate with confirm=true. It deletes a file; never do it without my approval.'
                        : '3. Deleting files needs the "destructive" permission, which is off. Only report the duplicates and tell me how to enable it in Settings → AI control (MCP).')
            )
    );

    if (allowed.has('library')) {
        server.registerPrompt(
            'build_playlist',
            {
                title: 'Build a playlist',
                description: 'Create a private Qobuz playlist around a theme.',
                argsSchema: z.object({ theme: shortArg('Theme, mood or occasion of the playlist') })
            },
            ({ theme }) =>
                userMessage(
                    `Build a Qobuz playlist with the theme "${theme}".\n` +
                        '1. Use search_catalog (tracks and albums), get_featured_albums and get_similar_artists to find 15-25 fitting tracks.\n' +
                        '2. Prefer variety of artists, and Hi-Res tracks when there is a choice.\n' +
                        '3. Show me the proposed track list with a name and a short description for the playlist.\n' +
                        '4. After I confirm, create it with create_playlist (private unless I ask otherwise) and the track ids.' +
                        (allowed.has('download') ? '\n5. Ask whether I also want to download it.' : '')
                )
        );
    }
}

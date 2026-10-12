import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const state = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock('../services/settings.js', () => ({
    settingsService: {
        get: (k: string) => state.settings.get(k),
        setMany: (v: Record<string, string>) => {
            for (const [k, val] of Object.entries(v)) state.settings.set(k, val);
        }
    }
}));
vi.mock('../utils/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
vi.mock('../api/qobuz.js', () => ({
    qobuzApi: {
        getAlbum: vi.fn().mockResolvedValue({ success: true, data: { tracks_count: 2 } }),
        search: vi.fn().mockResolvedValue({
            success: true,
            data: { albums: { items: [{ id: 'abc1', title: 'Kind of Blue', artist: { id: 1, name: 'Miles' } }], total: 1 } }
        })
    }
}));
vi.mock('../services/qobuz-library/service.js', () => ({
    qobuzLibraryService: {
        addFavorites: vi.fn().mockResolvedValue({ added: 1 }),
        deletePlaylist: vi.fn().mockResolvedValue({ deleted: true })
    }
}));
vi.mock('../services/download-actions.js', () => ({
    downloadActionsService: {
        enqueue: vi.fn().mockResolvedValue({ items: [], queued: 1, deduped: 0 })
    }
}));
vi.mock('../services/queue/queue.js', () => ({ downloadQueue: { getStats: () => ({}), isPaused: () => false } }));
const db = vi.hoisted(() => ({
    rows: { dup: { file_path_1: '/music/a.flac', file_path_2: '/music/b.flac' } as Record<string, string> | undefined }
}));
vi.mock('../services/database/index.js', () => ({
    databaseService: {
        hasTrack: () => false,
        getTrack: (id: string) => (id === '1' ? { file_path: __filename, quality: 27 } : undefined),
        getTracksByIds: (ids: string[]) => (ids.includes('1') ? [{ id: '1', file_path: __filename, quality: 27 }] : []),
        getTracksByAlbumId: () => [{ id: '7', file_path: __filename }],
        getDuplicates: () => [{ id: 3, file_path_1: '/music/a.flac', file_path_2: '/music/b.flac', match_type: 'exact' }],
        getDb: () => ({
            prepare: (sql: string) => ({
                all: () => (sql.includes('album_id') ? [{ file_path: __filename }] : []),
                get: () => db.rows.dup
            })
        })
    }
}));
vi.mock('../utils/paths.js', () => ({ isPathWithinManagedRoots: (p: string) => p.startsWith('/music/') }));
vi.mock('../services/history.js', () => ({
    historyService: {
        count: () => 7,
        clearAll: vi.fn(),
        remove: vi.fn((id: string | number) => String(id) === '11')
    }
}));
vi.mock('../services/library-scanner/index.js', () => ({
    libraryScannerService: {
        isScanInProgress: () => false
    }
}));
const actions = vi.hoisted(() => ({
    resolveDuplicate: vi.fn(),
    queueUpgrade: vi.fn()
}));
// Containment and deletion are covered by library-actions.test.ts; here only
// the tool wiring is checked.
vi.mock('../services/library-actions.js', () => actions);
vi.mock('../services/PlaylistWatcherService.js', () => ({
    playlistWatcherService: {
        list: () => [
            { playlistId: '42', title: 'Jazz', quality: 27, intervalHours: 24, lastSyncedAt: null, nextSyncAt: null }
        ],
        unwatch: vi.fn((id: string | number) => String(id) === '42')
    }
}));
vi.mock('../utils/env.js', () => ({ validateEnvironment: () => ({ valid: true }) }));
vi.mock('../services/favorites-download.js', () => ({
    downloadFavorites: vi.fn(),
    downloadPurchases: vi.fn().mockResolvedValue({ queued: 2, deduped: 0, skipped: 1, failed: 0 })
}));
vi.mock('../services/favorites-sync.js', () => ({
    favoritesSyncService: {
        syncNow: vi.fn().mockResolvedValue({ baselineRecorded: ['albums'], queued: 0 }),
        getStatus: () => ({ autoDownload: true, types: ['albums'], intervalHours: 6, lastSyncAt: null, nextSyncAt: null })
    }
}));
vi.mock('../services/lyrics-actions.js', () => ({
    getTrackLyrics: vi.fn().mockResolvedValue({ success: true, source: 'LRCLIB', plainLyrics: 'x'.repeat(25_000) }),
    downloadTrackLyrics: vi.fn().mockResolvedValue({ lyrics: { success: true, source: 'LRCLIB', syncedLyrics: '[00:01]a' }, saved: true })
}));
vi.mock('../services/notifications.js', () => {
    const items = [
        { id: 'n1', type: 'info', title: 'Done', message: 'm'.repeat(5000), timestamp: new Date(0), read: false },
        { id: 'n2', type: 'error', title: 'Failed', message: 'x', timestamp: new Date(0), read: true }
    ];
    return {
        notificationService: {
            getAll: () => items,
            getUnread: () => items.filter((n) => !n.read),
            getUnreadCount: () => items.filter((n) => !n.read).length,
            markAsRead: (id: string) => id === 'n1',
            markAllAsRead: () => 1
        }
    };
});
vi.mock('../services/smart-playlists.js', () => {
    const row = { id: 'sp1', name: 'Hi-Res jazz', filter: '{"genre":"Jazz","minQuality":27}', created_at: '2026-01-01', track_count: 3 };
    return {
        listSmartPlaylists: () => [row],
        getSmartPlaylist: (id: string) => (id === 'sp1' ? row : undefined),
        parseSmartPlaylistFilter: (r?: { filter: string }) => (r ? JSON.parse(r.filter) : undefined),
        sanitizeSmartPlaylistFilter: (f: Record<string, unknown>) => {
            const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
            return Object.keys(clean).length > 0 ? clean : null;
        },
        createSmartPlaylist: vi.fn((name: string, filter: unknown) => ({ id: 'sp2', name, filter: JSON.stringify(filter), created_at: '' })),
        deleteSmartPlaylist: (id: string) => id === 'sp1',
        countTracksForFilter: () => 3,
        tracksForFilter: vi.fn(() => [{ id: '9', title: 'So What', artist: 'Miles', album: 'KoB', album_id: 'abc1', quality: 27, file_path: '/music/9.flac' }])
    };
});

import { createMcpEndpoint, createMcpAdminRouter, isAllowedLoopbackHost } from './http.js';
import { downloadActionsService } from '../services/download-actions.js';
import { downloadPurchases } from '../services/favorites-download.js';
import { favoritesSyncService } from '../services/favorites-sync.js';
import { historyService } from '../services/history.js';
import { createSmartPlaylist, tracksForFilter } from '../services/smart-playlists.js';
import { eventBus, EVENTS } from '../utils/events.js';

const app = express();
app.use('/mcp', createMcpEndpoint());
app.use(express.json());
app.use('/api/mcp', createMcpAdminRouter());
const server = app.listen(0, '127.0.0.1');
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

async function newToken(): Promise<string> {
    const res = await fetch(`${base()}/api/mcp/token`, { method: 'POST' });
    return ((await res.json()) as { token: string }).token;
}

async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } }
        })
    );
    return client;
}

const post = (headers: Record<string, string>) =>
    fetch(`${base()}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });

describe('MCP endpoint', () => {
    beforeEach(() => {
        state.settings.clear();
        state.settings.set('MCP_ENABLED', 'true');
    });

    it('is 404 while disabled', async () => {
        state.settings.set('MCP_ENABLED', 'false');
        expect((await post({})).status).toBe(404);
    });

    it('requires a valid bearer token and stores only its hash', async () => {
        expect((await post({})).status).toBe(401);
        const token = await newToken();
        expect(state.settings.get('MCP_TOKEN_HASH')).toMatch(/^[0-9a-f]{64}$/);
        expect(state.settings.get('MCP_TOKEN_HASH')).not.toContain(token);
        expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401);
        expect((await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status).toBe(403);
    });

    it('lists tools by permission group and runs them', async () => {
        const token = await newToken();
        const client = await connect(token);
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['search_catalog', 'add_favorites', 'download']));
        expect(names).not.toContain('delete_playlist');

        const search = await client.callTool({ name: 'search_catalog', arguments: { query: 'blue' } });
        expect((search.structuredContent as { items: Array<{ id: string }> }).items[0]?.id).toBe('abc1');

        await client.callTool({ name: 'download', arguments: { type: 'album', id: 'abc1', quality: 27 } });
        expect(downloadActionsService.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'album', id: 'abc1', quality: 27, source: 'mcp' })
        );
        await client.close();
    });

    it('exposes destructive tools only when enabled, and they need confirm=true', async () => {
        state.settings.set('MCP_PERMISSIONS', 'library,destructive');
        const client = await connect(await newToken());
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain('delete_playlist');
        expect(names).not.toContain('download');

        const refused = await client.callTool({ name: 'delete_playlist', arguments: { playlist_id: 5 } });
        expect(refused.isError).toBe(true);
        const done = await client.callTool({ name: 'delete_playlist', arguments: { playlist_id: 5, confirm: true } });
        expect(done.isError).toBeFalsy();
        await client.close();
    });

    it('checks library ownership and guards duplicate deletion', async () => {
        state.settings.set('MCP_PERMISSIONS', 'destructive');
        const client = await connect(await newToken());
        const check = await client.callTool({
            name: 'check_in_library',
            arguments: { track_ids: [1, 2], album_ids: ['abc1'] }
        });
        expect(check.structuredContent).toMatchObject({
            tracks: { '1': { in_library: true }, '2': { in_library: false } },
            albums: { abc1: { status: 'partial', downloaded: 1, total: 2 } }
        });

        actions.resolveDuplicate.mockResolvedValueOnce({ id: 3, resolved: true, deleted: true });
        const ok = await client.callTool({ name: 'resolve_duplicate', arguments: { duplicate_id: 3, confirm: true } });
        expect(ok.isError).toBeFalsy();
        expect(actions.resolveDuplicate).toHaveBeenLastCalledWith(3, { keep: 'auto', dryRun: false });

        await client.callTool({
            name: 'resolve_duplicate',
            arguments: { duplicate_id: 3, keep: 'second', dry_run: true, confirm: true }
        });
        expect(actions.resolveDuplicate).toHaveBeenLastCalledWith(3, { keep: 'second', dryRun: true });

        const { ForbiddenError } = await import('../utils/errors.js');
        actions.resolveDuplicate.mockRejectedValueOnce(new ForbiddenError('Duplicate files are outside the managed library folders'));
        const refused = await client.callTool({ name: 'resolve_duplicate', arguments: { duplicate_id: 3, confirm: true } });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain('outside the managed library folders');
        await client.close();
    });

    it('rejects non-loopback Host headers on a loopback bind', async () => {
        const token = await newToken();
        const port = (server.address() as AddressInfo).port;
        const status = (host: string) =>
            new Promise<number>((resolve, reject) => {
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        path: '/mcp',
                        method: 'POST',
                        headers: {
                            host,
                            authorization: `Bearer ${token}`,
                            'content-type': 'application/json',
                            accept: 'application/json, text/event-stream'
                        }
                    },
                    (res) => {
                        res.resume();
                        resolve(res.statusCode ?? 0);
                    }
                );
                req.on('error', reject);
                req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
            });

        expect(await status('evil.example')).toBe(403);
        expect(await status(`evil.example:${port}`)).toBe(403);
        expect(await status(`127.0.0.1:${port + 1}`)).toBe(403);
        expect(await status(`127.0.0.1:${port}`)).toBe(200);
        expect(await status(`localhost:${port}`)).toBe(200);
        expect(await status(`[::1]:${port}`)).toBe(200);
    });

    it('matches loopback Host values exactly', () => {
        expect(isAllowedLoopbackHost('LOCALHOST:3000', 3000)).toBe(true);
        expect(isAllowedLoopbackHost('localhost', 80)).toBe(true);
        expect(isAllowedLoopbackHost('localhost', 3000)).toBe(false);
        expect(isAllowedLoopbackHost('127.0.0.2:3000', 3000)).toBe(false);
        expect(isAllowedLoopbackHost('localhost.evil.example:3000', 3000)).toBe(false);
        expect(isAllowedLoopbackHost(undefined, 3000)).toBe(false);
    });

    it('serves the status and queue resources', async () => {
        const client = await connect(await newToken());
        const uris = (await client.listResources()).resources.map((r) => r.uri);
        expect(uris).toEqual(expect.arrayContaining(['qbz://status', 'qbz://queue']));

        const status = await client.readResource({ uri: 'qbz://status' });
        const content = status.contents[0] as { text: string; mimeType: string };
        expect(content.mimeType).toBe('application/json');
        expect(JSON.parse(content.text)).toMatchObject({
            credentials_configured: true,
            favorites_auto_download: { enabled: true, types: ['albums'], interval_hours: 6 }
        });

        vi.mocked(downloadActionsService).getQueue = vi.fn().mockReturnValue({ items: [], total: 0, stats: {}, paused: false });
        const queue = await client.readResource({ uri: 'qbz://queue' });
        expect(JSON.parse((queue.contents[0] as { text: string }).text)).toMatchObject({ items: [], paused: false });
        expect(downloadActionsService.getQueue).toHaveBeenCalledWith({ status: 'active', limit: 100 });
        await client.close();
    });

    it('offers prompts only for the enabled groups', async () => {
        state.settings.set('MCP_PERMISSIONS', '');
        let client = await connect(await newToken());
        expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['clean_duplicates']);
        const readOnly = await client.getPrompt({ name: 'clean_duplicates' });
        expect(JSON.stringify(readOnly.messages)).toContain('destructive');
        await client.close();

        state.settings.set('MCP_PERMISSIONS', 'library,download,manage,destructive');
        client = await connect(await newToken());
        const names = (await client.listPrompts()).prompts.map((p) => p.name);
        expect(names).toEqual(
            expect.arrayContaining(['download_discography', 'find_hires_upgrades', 'clean_duplicates', 'sync_favorites', 'build_playlist'])
        );
        const prompt = await client.getPrompt({ name: 'download_discography', arguments: { artist: 'Radiohead' } });
        const text = (prompt.messages[0]?.content as { text: string }).text;
        expect(text).toContain('"Radiohead"');
        expect(text).toContain('get_artist_releases');
        await client.close();
    });

    it('runs the smart playlist, notification, lyrics and history tools', async () => {
        state.settings.set('MCP_PERMISSIONS', 'library,download,manage,destructive');
        const client = await connect(await newToken());
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const res = await client.callTool({ name, arguments: args });
            return { error: Boolean(res.isError), data: res.structuredContent as Record<string, unknown> };
        };

        expect((await call('list_smart_playlists')).data).toMatchObject({
            items: [{ id: 'sp1', filter: { genre: 'Jazz', min_quality: 27 }, track_count: 3 }],
            total: 1,
            has_more: false
        });
        expect((await call('get_smart_playlist_tracks', { id: 'sp1', limit: 10, offset: 5 })).data).toMatchObject({
            name: 'Hi-Res jazz',
            items: [{ track_id: '9', title: 'So What' }],
            total: 3,
            offset: 5
        });
        expect(tracksForFilter).toHaveBeenCalledWith({ genre: 'Jazz', minQuality: 27 }, 10, 5);
        expect((await call('get_smart_playlist_tracks', { id: 'nope' })).error).toBe(true);

        expect((await call('create_smart_playlist', { name: 'Miles', filter: {} })).error).toBe(true);
        const created = await call('create_smart_playlist', { name: 'Miles', filter: { artist: 'Miles', min_quality: 7 } });
        expect(created.data).toMatchObject({ id: 'sp2', filter: { artist: 'Miles', min_quality: 7 }, track_count: 3 });
        expect(createSmartPlaylist).toHaveBeenCalledWith('Miles', { artist: 'Miles', minQuality: 7 });
        expect((await call('delete_smart_playlist', { id: 'sp1' })).data).toEqual({ deleted: true, id: 'sp1' });
        expect((await call('delete_smart_playlist', { id: 'zz' })).error).toBe(true);

        const notes = await call('list_notifications', { unread_only: true });
        expect(notes.data).toMatchObject({ total: 1, unread_count: 1, items: [{ id: 'n1', read: false }] });
        expect(((notes.data.items as Array<{ message: string }>)[0]?.message.length ?? 0)).toBeLessThanOrEqual(1001);
        expect((await call('mark_notifications_read', { ids: ['n1', 'n9'] })).data).toEqual({ marked: 1, not_found: ['n9'] });
        expect((await call('mark_notifications_read', { all: true })).data).toEqual({ marked: 1 });
        expect((await call('mark_notifications_read', {})).error).toBe(true);

        const lyrics = await call('get_lyrics', { track_id: 5 });
        expect(lyrics.data).toMatchObject({ found: true, source: 'LRCLIB', synced: false, truncated: true });
        expect((lyrics.data.lyrics as string).length).toBeLessThanOrEqual(20_001);
        expect((await call('download_lyrics', { track_id: 5 })).data).toMatchObject({ saved: true, synced: true });

        expect((await call('list_watched_playlists')).data).toMatchObject({ items: [{ playlist_id: '42', title: 'Jazz' }] });
        expect((await call('unwatch_playlist', { playlist_id: 42 })).data).toEqual({ unwatched: true, playlist_id: '42' });
        expect((await call('unwatch_playlist', { playlist_id: 43 })).error).toBe(true);

        expect((await call('download_purchases', { type: 'albums', quality: 27 })).data).toMatchObject({ queued: 2 });
        expect(downloadPurchases).toHaveBeenCalledWith('albums', 27, 'mcp');
        expect((await call('sync_favorites_now')).data).toMatchObject({ baselineRecorded: ['albums'] });
        expect(favoritesSyncService.syncNow).toHaveBeenCalled();

        expect((await call('clear_download_history')).error).toBe(true);
        expect(historyService.clearAll).not.toHaveBeenCalled();
        expect((await call('clear_download_history', { confirm: true })).data).toEqual({ cleared: 7 });
        expect((await call('remove_history_entry', { track_id: 11, confirm: true })).data).toEqual({ removed: true, track_id: '11' });
        expect((await call('remove_history_entry', { track_id: 12, confirm: true })).error).toBe(true);
        await client.close();
    });

    it('registers the new tools in the documented groups', async () => {
        state.settings.set('MCP_PERMISSIONS', '');
        let client = await connect(await newToken());
        const readOnly = (await client.listTools()).tools.map((t) => t.name);
        expect(readOnly).toEqual(
            expect.arrayContaining(['list_smart_playlists', 'get_smart_playlist_tracks', 'list_notifications', 'get_lyrics', 'list_watched_playlists', 'get_queue_item'])
        );
        for (const name of ['download_purchases', 'download_lyrics', 'sync_favorites_now', 'create_smart_playlist', 'clear_download_history']) {
            expect(readOnly).not.toContain(name);
        }
        await client.close();

        state.settings.set('MCP_PERMISSIONS', 'library,download,manage,destructive');
        client = await connect(await newToken());
        const tools = (await client.listTools()).tools;
        for (const t of tools) {
            const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
            if (['list_smart_playlists', 'get_lyrics', 'download_purchases', 'mark_notifications_read', 'remove_history_entry'].includes(t.name)) {
                for (const [field, schema] of Object.entries(props)) {
                    expect(schema.description, `${t.name}.${field}`).toBeTruthy();
                }
            }
        }
        expect(tools.find((t) => t.name === 'clear_download_history')?.annotations?.destructiveHint).toBe(true);
        await client.close();
    });
    it('reads the safe settings subset and changes only allowlisted settings', async () => {
        state.settings.set('DOWNLOADS_PATH', '/secret/music');
        state.settings.set('QOBUZ_USER_AUTH_TOKEN', 'user-token-secret');
        state.settings.set('FOLDER_TEMPLATE', '{secret}/{album}');
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: [] });
        const client = await connect(await newToken());

        const read = await client.callTool({ name: 'get_settings', arguments: {} });
        expect(read.structuredContent).toMatchObject({ default_quality: 27, max_concurrency: 2 });
        expect(JSON.stringify(read)).not.toMatch(/secret/);

        const changed = await client.callTool({
            name: 'update_settings',
            arguments: { max_concurrency: 4, embed_cover_art: false, favorites_auto_download_types: ['albums'] }
        });
        expect(changed.isError).toBeFalsy();
        expect(changed.structuredContent).toMatchObject({
            updated: ['max_concurrency', 'embed_cover_art', 'favorites_auto_download_types']
        });
        expect(state.settings.get('MAX_CONCURRENCY')).toBe('4');
        expect(state.settings.get('EMBED_COVER_ART')).toBe('false');
        expect(state.settings.get('FAVORITES_AUTO_DOWNLOAD_TYPES')).toBe('albums');

        for (const args of [
            { downloads_path: '/tmp' },
            { folder_template: '../{album}' },
            { max_concurrency: 500 },
            {}
        ]) {
            const refused = await client.callTool({ name: 'update_settings', arguments: args });
            expect(refused.isError).toBe(true);
        }
        expect(state.settings.get('DOWNLOADS_PATH')).toBe('/secret/music');
        expect(state.settings.get('FOLDER_TEMPLATE')).toBe('{secret}/{album}');
        await client.close();
    });

    it('offers update_settings only with the manage group', async () => {
        state.settings.set('MCP_PERMISSIONS', 'library');
        const client = await connect(await newToken());
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain('get_settings');
        expect(names).not.toContain('update_settings');
        await client.close();
    });
});

describe('stdio bridge (end to end)', () => {
    const bridgePath = path.join(__dirname, 'bridge.ts');

    type Bridge = {
        send: (msg: unknown) => void;
        response: (id: number) => Promise<Record<string, unknown>>;
        end: () => void;
        exit: Promise<number | null>;
        stdoutLines: () => string[];
    };

    function startBridge(token: string): Bridge {
        const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', bridgePath], {
            env: { ...process.env, QBZ_MCP_URL: `${base()}/mcp`, QBZ_MCP_TOKEN: token },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let buffer = '';
        const lines: string[] = [];
        const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
        const seen = new Map<number, Record<string, unknown>>();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                lines.push(line);
                try {
                    const msg = JSON.parse(line) as Record<string, unknown>;
                    if (typeof msg.id === 'number') {
                        seen.set(msg.id, msg);
                        waiters.get(msg.id)?.(msg);
                    }
                } catch {
                    /* asserted below: every line must be JSON */
                }
            }
        });
        child.stderr.resume();
        return {
            send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
            response: (id) =>
                new Promise((resolve) => {
                    const known = seen.get(id);
                    if (known) resolve(known);
                    else waiters.set(id, resolve);
                }),
            end: () => child.stdin.end(),
            exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
            stdoutLines: () => (buffer ? [...lines, buffer] : lines)
        };
    }

    const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } }
    };

    beforeEach(() => {
        state.settings.clear();
        state.settings.set('MCP_ENABLED', 'true');
    });

    it('speaks JSON-RPC over stdio and writes nothing else to stdout', async () => {
        const bridge = startBridge(await newToken());
        bridge.send(initialize);
        const init = await bridge.response(1);
        expect(init.result).toMatchObject({ serverInfo: { name: 'qbz-downloader' } });

        bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const list = await bridge.response(2);
        const names = ((list.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['search_catalog', 'download']));

        bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_catalog', arguments: { query: 'blue' } } });
        const call = await bridge.response(3);
        expect(call.result).toMatchObject({ structuredContent: { items: [{ id: 'abc1' }] } });

        bridge.end();
        expect(await bridge.exit).toBe(0);
        const lines = bridge.stdoutLines().filter((l) => l.trim() !== '');
        expect(lines.length).toBeGreaterThanOrEqual(3);
        for (const line of lines) {
            expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
        }
    }, 20_000);

    it('answers requests that are still in flight when stdin closes', async () => {
        const bridge = startBridge(await newToken());
        bridge.send(initialize);
        bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
        bridge.end();
        expect(await bridge.exit).toBe(0);
        const ids = bridge.stdoutLines().map((l) => (JSON.parse(l) as { id?: number }).id);
        expect(ids).toEqual(expect.arrayContaining([1, 2]));
    }, 20_000);

    it('reports a rejected token as a JSON-RPC error', async () => {
        const bridge = startBridge('not-the-token');
        bridge.send(initialize);
        const res = await bridge.response(1);
        expect(res.error).toMatchObject({ code: -32000 });
        bridge.end();
        expect(await bridge.exit).toBe(0);
    }, 20_000);
});

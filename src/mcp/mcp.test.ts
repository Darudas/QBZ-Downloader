import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
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
vi.mock('../services/history.js', () => ({ historyService: {} }));
vi.mock('../services/library-scanner/index.js', () => ({
    libraryScannerService: {
        isScanInProgress: () => false,
        resolveDuplicate: vi.fn().mockResolvedValue({ deleted: '/music/b.flac' })
    }
}));
vi.mock('../services/PlaylistWatcherService.js', () => ({ playlistWatcherService: {} }));
vi.mock('../utils/env.js', () => ({ validateEnvironment: () => ({ valid: true }) }));

import { createMcpEndpoint, createMcpAdminRouter } from './http.js';
import { downloadActionsService } from '../services/download-actions.js';
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

        const ok = await client.callTool({ name: 'resolve_duplicate', arguments: { duplicate_id: 3, confirm: true } });
        expect(ok.isError).toBeFalsy();
        db.rows.dup = { file_path_1: '/etc/passwd', file_path_2: '/music/b.flac' };
        const refused = await client.callTool({ name: 'resolve_duplicate', arguments: { duplicate_id: 3, confirm: true } });
        expect(refused.isError).toBe(true);
        db.rows.dup = { file_path_1: '/music/a.flac', file_path_2: '/music/b.flac' };
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

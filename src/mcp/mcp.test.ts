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
vi.mock('../services/database/index.js', () => ({ databaseService: { hasTrack: () => false } }));
vi.mock('../services/history.js', () => ({ historyService: {} }));
vi.mock('../services/library-scanner/index.js', () => ({ libraryScannerService: { isScanInProgress: () => false } }));
vi.mock('../services/PlaylistWatcherService.js', () => ({ playlistWatcherService: {} }));
vi.mock('../utils/env.js', () => ({ validateEnvironment: () => ({ valid: true }) }));

import { createMcpEndpoint, createMcpAdminRouter } from './http.js';
import { downloadActionsService } from '../services/download-actions.js';

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
});

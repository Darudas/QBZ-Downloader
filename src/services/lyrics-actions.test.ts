import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({ root: '', history: new Map<string, { filename: string }>() }));

vi.mock('../utils/paths.js', () => ({
    isPathWithinManagedRoots: (p: string) => p.startsWith(state.root + '/') || p.startsWith(state.root + '\\')
}));
vi.mock('./history.js', () => ({ historyService: { get: (id: string) => state.history.get(id) } }));
vi.mock('../api/qobuz.js', () => ({
    qobuzApi: {
        getTrack: vi.fn(async (id: string) =>
            id === '404'
                ? { success: false }
                : { success: true, data: { title: 'So What', artist: { name: 'Miles' }, album: { title: 'KoB' }, duration: 545 } }
        )
    }
}));
const provider = vi.hoisted(() => ({ getLyrics: vi.fn(), parseLrc: vi.fn(() => [{ time: 0, timeStr: '00:00', text: 'x' }]) }));
vi.mock('./queue-processor.js', () => ({ downloadService: { lyricsProvider: provider } }));

import { downloadTrackLyrics, getTrackLyrics, lrcPathFor, managedLrcPath } from './lyrics-actions.js';

describe('lyrics actions', () => {
    beforeEach(() => {
        state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbz-lyrics-'));
        state.history.clear();
        provider.getLyrics.mockReset();
    });
    afterEach(() => fs.rmSync(state.root, { recursive: true, force: true }));

    it('builds the sidecar path and refuses paths outside the library', () => {
        expect(lrcPathFor(path.join('a', 'b', 'song.flac'))).toBe(path.join('a', 'b', 'song.lrc'));
        expect(managedLrcPath(path.join(state.root, 'song.flac'))).toBe(path.join(state.root, 'song.lrc'));
        expect(managedLrcPath('/etc/passwd')).toBeNull();
        expect(managedLrcPath('')).toBeNull();
    });

    it('prefers the saved sidecar over a provider lookup', async () => {
        const audio = path.join(state.root, 'song.flac');
        fs.writeFileSync(path.join(state.root, 'song.lrc'), '[00:00.00]x');
        state.history.set('1', { filename: audio });
        const lyrics = await getTrackLyrics('1');
        expect(lyrics).toMatchObject({ success: true, source: 'Local File', syncedLyrics: '[00:00.00]x' });
        expect(provider.getLyrics).not.toHaveBeenCalled();
    });

    it('looks lyrics up by track metadata and 404s for unknown tracks', async () => {
        provider.getLyrics.mockResolvedValue({ success: true, plainLyrics: 'la la' });
        expect(await getTrackLyrics('2')).toMatchObject({ plainLyrics: 'la la' });
        expect(provider.getLyrics).toHaveBeenCalledWith('So What', 'Miles', 'KoB', 545);
        await expect(getTrackLyrics('404')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('saves downloaded lyrics only next to a library file', async () => {
        provider.getLyrics.mockResolvedValue({ success: true, syncedLyrics: '[00:01.00]hi' });
        state.history.set('1', { filename: path.join(state.root, 'song.flac') });
        state.history.set('2', { filename: '/elsewhere/song.flac' });

        expect((await downloadTrackLyrics('1')).saved).toBe(true);
        expect(fs.readFileSync(path.join(state.root, 'song.lrc'), 'utf8')).toBe('[00:01.00]hi');
        expect((await downloadTrackLyrics('2')).saved).toBe(false);
        expect((await downloadTrackLyrics('3')).saved).toBe(false);
    });

    it('reports missing lyrics as not found', async () => {
        provider.getLyrics.mockResolvedValue({ success: false, error: 'none' });
        await expect(downloadTrackLyrics('1')).rejects.toMatchObject({ statusCode: 404, message: 'Lyrics not found' });
    });
});

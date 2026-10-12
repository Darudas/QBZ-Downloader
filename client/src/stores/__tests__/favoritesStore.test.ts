import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFavoritesStore } from '../favoritesStore';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const reset = () =>
    useFavoritesStore.setState({
        albums: new Set(),
        tracks: new Set(),
        artists: new Set(),
        loaded: false,
        loading: false,
        pending: new Set()
    });

describe('favoritesStore', () => {
    beforeEach(reset);
    afterEach(() => vi.unstubAllGlobals());

    it('loads favorite ids once unless forced', async () => {
        const calls = mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: ['a1'], tracks: ['5'], artists: [] })
        });
        await useFavoritesStore.getState().load();
        await useFavoritesStore.getState().load();
        expect(calls).toHaveLength(1);
        expect(useFavoritesStore.getState().isFavorite('album', 'a1')).toBe(true);
        expect(useFavoritesStore.getState().isFavorite('track', 5)).toBe(true);
        await useFavoritesStore.getState().load(true);
        expect(calls).toHaveLength(2);
    });

    it('adds a favorite optimistically with the right body', async () => {
        const calls = mockFetchRoutes({ 'POST /api/favorites': () => ({ action: 'add' }) });
        const promise = useFavoritesStore.getState().toggle('track', 9);
        expect(useFavoritesStore.getState().isFavorite('track', '9')).toBe(true);
        await expect(promise).resolves.toBe(true);
        expect(calls[0]).toMatchObject({ method: 'POST', body: { trackIds: ['9'] } });
    });

    it('removes an existing favorite with DELETE', async () => {
        useFavoritesStore.setState({ albums: new Set(['x']) });
        const calls = mockFetchRoutes({ 'DELETE /api/favorites': () => ({ action: 'remove' }) });
        await expect(useFavoritesStore.getState().toggle('album', 'x')).resolves.toBe(false);
        expect(calls[0]).toMatchObject({ method: 'DELETE', body: { albumIds: ['x'] } });
        expect(useFavoritesStore.getState().isFavorite('album', 'x')).toBe(false);
    });

    it('rolls back and rethrows the server message on failure', async () => {
        mockFetchRoutes({ 'POST /api/favorites': () => ({ status: 502, body: { error: 'Qobuz said no' } }) });
        await expect(useFavoritesStore.getState().toggle('artist', 3)).rejects.toThrow('Qobuz said no');
        expect(useFavoritesStore.getState().isFavorite('artist', 3)).toBe(false);
        expect(useFavoritesStore.getState().pending.size).toBe(0);
    });
});

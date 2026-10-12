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

    it('keeps a toggle made while the ids were loading', async () => {
        let answer!: (value: unknown) => void;
        mockFetchRoutes({
            'GET /api/favorites/ids': () => new Promise((resolve) => (answer = resolve)),
            'POST /api/favorites': () => ({ action: 'add' }),
            'DELETE /api/favorites': () => ({ action: 'remove' })
        });
        const loading = useFavoritesStore.getState().load();
        await useFavoritesStore.getState().toggle('album', 'new');
        await useFavoritesStore.getState().toggle('album', 'gone');
        await useFavoritesStore.getState().toggle('album', 'gone');
        await useFavoritesStore.getState().toggle('track', 'old');
        await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
        // Snapshot taken before the writes: 'old' still favorite, 'new' not yet.
        answer({ albums: ['kept', 'gone'], tracks: ['old'], artists: [] });
        await loading;

        const state = useFavoritesStore.getState();
        expect(state.isFavorite('album', 'kept')).toBe(true);
        expect(state.isFavorite('album', 'new')).toBe(true);
        expect(state.isFavorite('album', 'gone')).toBe(false);
        expect(state.isFavorite('track', 'old')).toBe(true);
        expect(state.loaded).toBe(true);
    });

    it('lets the server decide again for ids toggled before the load started', async () => {
        mockFetchRoutes({
            'POST /api/favorites': () => ({ action: 'add' }),
            'GET /api/favorites/ids': () => ({ albums: [], tracks: [], artists: [] })
        });
        await useFavoritesStore.getState().toggle('album', 'a');
        await useFavoritesStore.getState().load(true);
        // Removed elsewhere since: the later snapshot wins.
        expect(useFavoritesStore.getState().isFavorite('album', 'a')).toBe(false);
    });

    it('runs a forced reload requested while a load is running', async () => {
        const answers: Array<(value: unknown) => void> = [];
        const calls = mockFetchRoutes({
            'GET /api/favorites/ids': () => new Promise((resolve) => answers.push(resolve))
        });
        const first = useFavoritesStore.getState().load();
        const forced = useFavoritesStore.getState().load(true);
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        answers[0]({ albums: ['old-account'], tracks: [], artists: [] });
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1]({ albums: ['new-account'], tracks: [], artists: [] });
        await Promise.all([first, forced]);

        expect(calls.filter((c) => c.url === '/api/favorites/ids')).toHaveLength(2);
        expect(useFavoritesStore.getState().isFavorite('album', 'new-account')).toBe(true);
        expect(useFavoritesStore.getState().isFavorite('album', 'old-account')).toBe(false);
        expect(useFavoritesStore.getState().loading).toBe(false);
    });

    it('shares one request between concurrent unforced loads', async () => {
        const calls = mockFetchRoutes({ 'GET /api/favorites/ids': () => ({ albums: [], tracks: [], artists: [] }) });
        await Promise.all([useFavoritesStore.getState().load(), useFavoritesStore.getState().load()]);
        expect(calls).toHaveLength(1);
    });
});

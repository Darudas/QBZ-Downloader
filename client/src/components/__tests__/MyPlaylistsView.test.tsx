import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MyPlaylistsView } from '../MyPlaylistsView';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { useFavoritesStore } from '../../stores/favoritesStore';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const mocks = vi.hoisted(() => ({
    showToast: vi.fn(),
    addToQueue: vi.fn().mockResolvedValue(true),
    playTrack: vi.fn()
}));

vi.mock('../../contexts/LanguageContext', () => ({
    useLanguage: () => ({ t: (key: string) => key })
}));
vi.mock('../../contexts/ToastContext', () => ({
    useToast: () => ({ showToast: mocks.showToast })
}));
vi.mock('../../contexts/SettingsContext', () => ({
    useSettings: () => ({ settings: {}, updateSetting: vi.fn(), loading: false })
}));
vi.mock('../../hooks/useQueueActions', () => ({
    useQueueActions: () => ({ addToQueue: mocks.addToQueue, addToBatchStaging: vi.fn() })
}));
vi.mock('../Player', () => ({ playTrack: mocks.playTrack }));

const page = <T,>(items: T[], extra: Record<string, unknown> = {}) => ({
    items,
    total: items.length,
    offset: 0,
    limit: 50,
    has_more: false,
    ...extra
});

const playlists = [
    { id: 1, name: 'Mine', tracks_count: 2, is_owner: true },
    { id: 2, name: 'Theirs', tracks_count: 9, is_owner: false, owner: { name: 'Qobuz' } }
];
const details = {
    id: 1,
    name: 'Mine',
    tracks_count: 2,
    is_owner: true,
    can_add_tracks: true,
    tracks: page([
        { id: 100, playlist_track_id: 9001, position: 1, title: 'Alpha', duration: 60, album: { id: 'alb' } },
        { id: 101, playlist_track_id: 9002, position: 2, title: 'Beta', duration: 61 }
    ])
};
const favoriteIds = () => ({ albums: [], tracks: [], artists: [] });

/** Renders the view inside the real router, starting at `path`. */
const renderAt = (path = '/my_playlists') => {
    window.history.replaceState(null, '', path);
    return render(
        <NavigationProvider>
            <MyPlaylistsView />
        </NavigationProvider>
    );
};

beforeEach(() => {
    vi.clearAllMocks();
    useFavoritesStore.setState({
        albums: new Set(),
        tracks: new Set(),
        artists: new Set(),
        loaded: false,
        loading: false,
        pending: new Set()
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('MyPlaylistsView', () => {
    it('separates own and followed playlists', async () => {
        mockFetchRoutes({ 'GET /api/me/playlists': () => page(playlists) });
        renderAt();
        expect(await screen.findByText('Mine')).toBeInTheDocument();
        expect(screen.getByText('title_followed_playlists')).toBeInTheDocument();
        expect(screen.getByText('Theirs')).toBeInTheDocument();
    });

    it('removes a track by its playlist_track_id', async () => {
        const calls = mockFetchRoutes({
            'GET /api/me/playlists': () => page(playlists),
            'GET /api/me/playlists/1': () => details,
            'GET /api/favorites/ids': favoriteIds,
            'DELETE /api/me/playlists/1/tracks': () => ({ removed: 1 })
        });
        renderAt();
        fireEvent.click(await screen.findByText('Mine'));
        const row = (await screen.findByText('Beta')).closest('.track-item') as HTMLElement;
        fireEvent.click(within(row).getByLabelText('action_remove_from_playlist'));
        await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument());
        expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ playlistTrackIds: ['9002'] });
        // The total shrank with the list, so no phantom "Load more" appears.
        expect(screen.queryByText('action_load_more')).not.toBeInTheDocument();
        expect(screen.getByText(/1 label_tracks/)).toBeInTheDocument();
    });

    it('deletes an own playlist after confirmation and goes back', async () => {
        const calls = mockFetchRoutes({
            'GET /api/me/playlists': () => page(playlists),
            'GET /api/me/playlists/1': () => details,
            'GET /api/favorites/ids': favoriteIds,
            'DELETE /api/me/playlists/1': () => ({ deleted: true })
        });
        renderAt();
        fireEvent.click(await screen.findByText('Mine'));
        fireEvent.click(await screen.findByRole('button', { name: /action_delete/ }));
        fireEvent.click(screen.getByText('Confirm'));
        await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/me/playlists/1')).toBe(true));
        expect(await screen.findByText('title_my_playlists')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/my_playlists');
    });

    it('creates a new playlist', async () => {
        const calls = mockFetchRoutes({
            'GET /api/me/playlists': () => page([]),
            'POST /api/me/playlists': () => ({ playlist: { id: 3, name: 'Gym' } })
        });
        renderAt();
        fireEvent.click(screen.getByRole('button', { name: /action_new_playlist/ }));
        fireEvent.change(screen.getByLabelText('placeholder_new_playlist'), { target: { value: 'Gym' } });
        fireEvent.click(screen.getByRole('button', { name: 'action_create' }));
        await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Gym', isPublic: false }));
    });

    it('creates only one playlist when the form is submitted twice', async () => {
        let finish!: (value: unknown) => void;
        const calls = mockFetchRoutes({
            'GET /api/me/playlists': () => page([]),
            'POST /api/me/playlists': () => new Promise((resolve) => (finish = resolve))
        });
        renderAt();
        fireEvent.click(screen.getByRole('button', { name: /action_new_playlist/ }));
        fireEvent.change(screen.getByLabelText('placeholder_new_playlist'), { target: { value: 'Gym' } });
        const form = screen.getByLabelText('placeholder_new_playlist').closest('form') as HTMLFormElement;
        fireEvent.submit(form);
        fireEvent.submit(form);
        await waitFor(() => expect(screen.getByRole('button', { name: 'action_create' })).toBeDisabled());
        await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
        finish({ playlist: { id: 3, name: 'Gym' } });
        await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('msg_playlist_created: Gym', 'success'));
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('limits the description to the server maximum', async () => {
        mockFetchRoutes({
            'GET /api/me/playlists': () => page(playlists),
            'GET /api/me/playlists/1': () => details,
            'GET /api/favorites/ids': favoriteIds
        });
        renderAt();
        fireEvent.click(await screen.findByText('Mine'));
        fireEvent.click(await screen.findByRole('button', { name: /action_edit/ }));
        expect(screen.getByLabelText('label_description')).toHaveAttribute('maxLength', '1000');
        expect(screen.getByLabelText('label_name')).toHaveAttribute('maxLength', '200');
    });
});

describe('MyPlaylistsView history', () => {
    const routes = () =>
        mockFetchRoutes({
            'GET /api/me/playlists': () => page(playlists),
            'GET /api/me/playlists/1': () => details,
            'GET /api/favorites/ids': favoriteIds
        });

    it('puts an opened playlist in the URL and closes it with browser Back', async () => {
        routes();
        renderAt();
        fireEvent.click(await screen.findByText('Mine'));
        expect(await screen.findByText('Alpha')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/my_playlists/1');

        act(() => window.history.back());
        await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
        expect(window.location.pathname).toBe('/my_playlists');
        expect(screen.getByText('Theirs')).toBeInTheDocument();
    });

    it('reopens the playlist from its URL after a reload', async () => {
        routes();
        renderAt('/my_playlists/1');
        expect(await screen.findByText('Alpha')).toBeInTheDocument();
        // Opened directly: the in-app back button falls back to the list.
        fireEvent.click(screen.getByText('action_back'));
        expect(await screen.findByText('Theirs')).toBeInTheDocument();
        expect(window.location.pathname).toBe('/my_playlists');
    });

    it('opens a playlist card and a track album from the keyboard', async () => {
        routes();
        renderAt();
        const card = await screen.findByRole('button', { name: 'Mine' });
        fireEvent.keyDown(card, { key: 'Enter' });
        const title = await screen.findByRole('button', { name: 'Alpha' });
        fireEvent.keyDown(title, { key: ' ' });
        await waitFor(() => expect(window.location.pathname).toBe('/album/alb'));
    });
});

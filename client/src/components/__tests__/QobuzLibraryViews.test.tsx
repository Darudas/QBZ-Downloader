import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FavoritesView } from '../FavoritesView';
import { AddToPlaylistModal } from '../AddToPlaylistModal';
import { useFavoritesStore } from '../../stores/favoritesStore';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const mocks = vi.hoisted(() => ({
    showToast: vi.fn(),
    navigate: vi.fn(),
    addToQueue: vi.fn().mockResolvedValue(true),
    playTrack: vi.fn()
}));

vi.mock('../../contexts/LanguageContext', () => ({
    useLanguage: () => ({ t: (key: string) => key })
}));
vi.mock('../../contexts/ToastContext', () => ({
    useToast: () => ({ showToast: mocks.showToast })
}));
vi.mock('../../contexts/NavigationContext', () => ({
    useNavigation: () => ({ navigate: mocks.navigate, setActiveTab: vi.fn() })
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

const resetFavorites = () =>
    useFavoritesStore.setState({
        albums: new Set(),
        tracks: new Set(),
        artists: new Set(),
        loaded: false,
        loading: false,
        pending: new Set()
    });

beforeEach(() => {
    vi.clearAllMocks();
    resetFavorites();
});
afterEach(() => vi.unstubAllGlobals());

describe('FavoritesView', () => {
    const albums = [
        { id: 'a1', title: 'First Album', artist: { name: 'Band' }, hires: true },
        { id: 'a2', title: 'Second Album', artist: { name: 'Band' } }
    ];

    it('lists favorite albums and opens one', async () => {
        mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: ['a1', 'a2'], tracks: [], artists: [] }),
            'GET /api/favorites': () => page(albums)
        });
        render(<FavoritesView />);
        fireEvent.click(await screen.findByText('First Album'));
        expect(mocks.navigate).toHaveBeenCalledWith('album', { id: 'a1' });
    });

    it('opens a favorite row from the keyboard', async () => {
        mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: ['a1', 'a2'], tracks: [], artists: [] }),
            'GET /api/favorites': () => page(albums)
        });
        render(<FavoritesView />);
        const row = await screen.findByRole('button', { name: 'Second Album' });
        fireEvent.keyDown(within(row).getByLabelText('action_download'), { key: ' ' });
        expect(mocks.navigate).not.toHaveBeenCalled();
        fireEvent.keyDown(row, { key: ' ' });
        expect(mocks.navigate).toHaveBeenCalledWith('album', { id: 'a2' });
    });

    it('drops an item from the list when its heart is clicked', async () => {
        const calls = mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: ['a1', 'a2'], tracks: [], artists: [] }),
            'GET /api/favorites': () => page(albums),
            'DELETE /api/favorites': () => ({ action: 'remove' })
        });
        render(<FavoritesView />);
        const row = (await screen.findByText('Second Album')).closest('.track-item') as HTMLElement;
        const heart = within(row).getByRole('button', { name: 'action_favorite' });
        await waitFor(() => expect(heart).toHaveAttribute('aria-pressed', 'true'));
        fireEvent.click(heart);
        await waitFor(() => expect(screen.queryByText('Second Album')).not.toBeInTheDocument());
        expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ albumIds: ['a2'] });
    });

    it('loads the next page after an un-favorite without skipping an item', async () => {
        const calls = mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: ['a1', 'a2', 'a3'], tracks: [], artists: [] }),
            'GET /api/favorites': ({ url }) =>
                url.includes('offset=0')
                    ? page(albums, { total: 3, has_more: true })
                    : page([{ id: 'a3', title: 'Third Album', artist: { name: 'Band' } }], { total: 2, offset: 1 }),
            'DELETE /api/favorites': () => ({ action: 'remove' })
        });
        render(<FavoritesView />);
        const row = (await screen.findByText('First Album')).closest('.track-item') as HTMLElement;
        const heart = within(row).getByRole('button', { name: 'action_favorite' });
        await waitFor(() => expect(heart).toHaveAttribute('aria-pressed', 'true'));
        fireEvent.click(heart);
        await waitFor(() => expect(screen.queryByText('First Album')).not.toBeInTheDocument());

        fireEvent.click(screen.getByText('action_load_more'));
        expect(await screen.findByText('Third Album')).toBeInTheDocument();
        // The server list shrank by one: one item (Second Album) remains before the next page.
        expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/favorites?')).at(-1)?.url).toContain('offset=1');
    });

    it('switches to tracks and queues all missing favorites after confirming', async () => {
        const calls = mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: [], tracks: ['7'], artists: [] }),
            'GET /api/favorites': ({ url }) =>
                url.includes('type=tracks') ? page([{ id: 7, title: 'Song', performer: { name: 'Singer' }, duration: 125 }]) : page([]),
            'POST /api/favorites/download': () => ({ queued: 1, deduped: 0, skipped: 0, failed: 0 })
        });
        render(<FavoritesView />);
        fireEvent.click(screen.getByRole('tab', { name: 'label_tracks' }));
        expect(await screen.findByText('Song')).toBeInTheDocument();
        expect(screen.getByText('2:05')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /action_download_all_missing/ }));
        fireEvent.click(screen.getByText('Confirm'));
        await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('msg_favorites_queued'), 'success'));
        expect(calls.find((c) => c.url === '/api/favorites/download')?.body).toEqual({ type: 'tracks' });
    });

    it('shows the server error when favorites cannot load', async () => {
        mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ status: 400, body: { error: 'Missing credentials' } }),
            'GET /api/favorites': () => ({ status: 400, body: { error: 'Missing credentials' } })
        });
        render(<FavoritesView />);
        expect(await screen.findByText('Missing credentials')).toBeInTheDocument();
    });
});

describe('FavoritesView request order', () => {
    it('keeps the newest tab when the previous tab answers late', async () => {
        let resolveAlbums!: (value: unknown) => void;
        const slowAlbums = new Promise((resolve) => {
            resolveAlbums = resolve;
        });
        mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: ['a1'], tracks: ['7'], artists: [] }),
            'GET /api/favorites': ({ url }) =>
                url.includes('type=albums') ? slowAlbums : page([{ id: 7, title: 'Fresh Song' }])
        });
        render(<FavoritesView />);
        fireEvent.click(screen.getByRole('tab', { name: 'label_tracks' }));
        expect(await screen.findByText('Fresh Song')).toBeInTheDocument();

        resolveAlbums(page([{ id: 'a1', title: 'Late Album' }]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByText('Late Album')).not.toBeInTheDocument();
        expect(screen.getByText('Fresh Song')).toBeInTheDocument();
    });
});

describe('AddToPlaylistModal', () => {
    it('adds tracks to an existing playlist', async () => {
        const onClose = vi.fn();
        const calls = mockFetchRoutes({
            'GET /api/me/playlists': () => page([{ id: 11, name: 'Road Trip', tracks_count: 3, is_owner: true }]),
            'POST /api/me/playlists/11/tracks': () => ({ added: 1, requested: 1 })
        });
        render(<AddToPlaylistModal isOpen onClose={onClose} trackIds={['5']} label="Song" />);
        fireEvent.click(await screen.findByText('Road Trip'));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ trackIds: ['5'] });
        expect(calls[0].url).toContain('filter=owner');
    });

    it('creates a private playlist with the album', async () => {
        const calls = mockFetchRoutes({
            'GET /api/me/playlists': () => page([]),
            'POST /api/me/playlists': () => ({ playlist: { id: 12, name: 'Fresh' }, added: 10, requested: 10 })
        });
        render(<AddToPlaylistModal isOpen onClose={vi.fn()} albumId="abc" />);
        expect(await screen.findByText('msg_no_own_playlists')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('placeholder_new_playlist'), { target: { value: 'Fresh' } });
        fireEvent.click(screen.getByRole('button', { name: /action_create/ }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Fresh', isPublic: false, albumId: 'abc' });
    });

    it('focuses the name field and closes on Escape', async () => {
        mockFetchRoutes({ 'GET /api/me/playlists': () => page([]) });
        const onClose = vi.fn();
        render(<AddToPlaylistModal isOpen onClose={onClose} trackIds={['5']} />);
        expect(screen.getByLabelText('placeholder_new_playlist')).toHaveFocus();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        await screen.findByText('msg_no_own_playlists');
    });

    it('renders nothing when closed', () => {
        const { container } = render(<AddToPlaylistModal isOpen={false} onClose={vi.fn()} trackIds={['1']} />);
        expect(container).toBeEmptyDOMElement();
    });
});

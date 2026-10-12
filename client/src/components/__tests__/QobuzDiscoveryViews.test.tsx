import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoverView } from '../DiscoverView';
import { PurchasesView } from '../PurchasesView';
import { LabelView } from '../LabelView';
import { ArtistDiscography } from '../ArtistSections';
import { useFavoritesStore } from '../../stores/favoritesStore';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const mocks = vi.hoisted(() => ({
    showToast: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    addToQueue: vi.fn().mockResolvedValue(true),
    navData: null as { id: string } | null
}));

vi.mock('../../contexts/LanguageContext', () => ({
    useLanguage: () => ({ t: (key: string) => key })
}));
vi.mock('../../contexts/ToastContext', () => ({
    useToast: () => ({ showToast: mocks.showToast })
}));
vi.mock('../../contexts/NavigationContext', () => ({
    useNavigation: () => ({ navigate: mocks.navigate, goBack: mocks.goBack, navData: mocks.navData, setActiveTab: vi.fn() })
}));
vi.mock('../../hooks/useQueueActions', () => ({
    useQueueActions: () => ({ addToQueue: mocks.addToQueue, addToBatchStaging: vi.fn() })
}));

const page = <T,>(items: T[], extra: Record<string, unknown> = {}) => ({
    items,
    total: items.length,
    offset: 0,
    limit: 50,
    has_more: false,
    ...extra
});

const favoriteIds = () => ({ albums: [], tracks: [], artists: [] });

/** A response body the test resolves later, to simulate a slow request. */
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.navData = null;
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

describe('DiscoverView', () => {
    const albums = [
        { id: 'n1', title: 'New One', artist: { name: 'Band' }, hires: true, release_date_original: '2026-01-02' },
        { id: 'n2', title: 'New Two', version: 'Deluxe', artist: { name: 'Other' } }
    ];
    const playlists = [{ id: 77, name: 'Jazz Picks', tracks_count: 30, owner: { name: 'Qobuz' } }];

    const routes = (overrides: Record<string, Parameters<typeof mockFetchRoutes>[0][string]> = {}) =>
        mockFetchRoutes({
            'GET /api/genres': () => ({ genres: { items: [{ id: 112, name: 'Pop/Rock' }, { id: 80, name: 'Jazz' }] } }),
            'GET /api/discover/albums': ({ url }) =>
                url.includes('offset=0') ? page(albums, { has_more: true }) : page([{ id: 'n3', title: 'New Three', artist: { name: 'Band' } }]),
            'GET /api/discover/playlists': () => page(playlists),
            'GET /api/favorites/ids': favoriteIds,
            'POST /api/me/playlists/77/follow': () => ({ playlist_id: '77', name: 'Jazz Picks', following: true }),
            ...overrides
        });

    it('lists featured albums, opens one and loads more', async () => {
        const calls = routes();
        render(<DiscoverView />);
        fireEvent.click(await screen.findByText('New One'));
        expect(mocks.navigate).toHaveBeenCalledWith('album', { id: 'n1' });
        expect(screen.getByText('New Two (Deluxe)')).toBeInTheDocument();
        expect(calls.some((c) => c.url.startsWith('/api/discover/albums?type=new-releases'))).toBe(true);

        fireEvent.click(screen.getByText('action_load_more'));
        expect(await screen.findByText('New Three')).toBeInTheDocument();
        expect(screen.getByText('New One')).toBeInTheDocument();
    });

    it('refetches albums when the type or genre changes', async () => {
        const calls = routes();
        render(<DiscoverView />);
        await screen.findByText('New One');
        fireEvent.change(screen.getByLabelText('label_featured_type'), { target: { value: 'press-awards' } });
        await waitFor(() => expect(calls.some((c) => c.url.includes('type=press-awards'))).toBe(true));

        const playlistCalls = calls.filter((c) => c.url.startsWith('/api/discover/playlists')).length;
        fireEvent.change(await screen.findByLabelText('label_genre'), { target: { value: '80' } });
        await waitFor(() =>
            expect(calls.some((c) => c.url.includes('type=press-awards') && c.url.includes('genre_id=80'))).toBe(true)
        );
        // The genre filter belongs to the album section; featured playlists stay unfiltered.
        expect(calls.filter((c) => c.url.startsWith('/api/discover/playlists'))).toHaveLength(playlistCalls);
        expect(calls.some((c) => c.url.startsWith('/api/discover/playlists') && c.url.includes('genre_id'))).toBe(false);
    });

    it('offers every featured type with a translated label', async () => {
        routes();
        render(<DiscoverView />);
        const select = screen.getByLabelText('label_featured_type');
        const options = within(select).getAllByRole('option');
        expect(options).toHaveLength(15);
        expect(options[0]).toHaveTextContent('discover_album_new_releases');
    });

    it('hides the genre filter when genres cannot be loaded', async () => {
        routes({ 'GET /api/genres': () => ({ status: 502, body: { error: 'down' } }) });
        render(<DiscoverView />);
        await screen.findByText('New One');
        expect(screen.queryByLabelText('label_genre')).not.toBeInTheDocument();
    });

    it('downloads and follows a featured playlist', async () => {
        const calls = routes();
        render(<DiscoverView />);
        const card = (await screen.findByText('Jazz Picks')).closest('.grid-item') as HTMLElement;
        fireEvent.click(within(card).getByLabelText('action_download'));
        expect(mocks.addToQueue).toHaveBeenCalledWith('playlist', '77');

        fireEvent.click(within(card).getByLabelText('action_follow'));
        await waitFor(() => expect(within(card).getByLabelText('label_following')).toBeDisabled());
        expect(calls.some((c) => c.method === 'POST' && c.url === '/api/me/playlists/77/follow')).toBe(true);
        expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('msg_playlist_followed'), 'success');
    });

    it('switches to last created playlists', async () => {
        const calls = routes();
        render(<DiscoverView />);
        fireEvent.click(screen.getByRole('tab', { name: 'discover_playlist_last_created' }));
        await waitFor(() => expect(calls.some((c) => c.url.includes('/api/discover/playlists?type=last-created'))).toBe(true));
    });

    it('shows the server error when follow fails', async () => {
        routes({ 'POST /api/me/playlists/77/follow': () => ({ status: 400, body: { error: 'You cannot follow your own playlist' } }) });
        render(<DiscoverView />);
        const card = (await screen.findByText('Jazz Picks')).closest('.grid-item') as HTMLElement;
        fireEvent.click(within(card).getByLabelText('action_follow'));
        await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('You cannot follow your own playlist', 'error'));
    });

    it('shows the server error when featured albums cannot load', async () => {
        routes({ 'GET /api/discover/albums': () => ({ status: 400, body: { error: 'Missing credentials' } }) });
        render(<DiscoverView />);
        expect(await screen.findByText('Missing credentials')).toBeInTheDocument();
    });
});

describe('PurchasesView', () => {
    const albums = [
        { id: 'p1', title: 'Bought One', artist: { name: 'Band' }, hires: true },
        { id: 'p2', title: 'Bought Two', artist: { name: 'Band' } }
    ];

    it('lists purchased albums, opens one and downloads one', async () => {
        mockFetchRoutes({
            'GET /api/purchases': () => page(albums),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<PurchasesView />);
        const row = (await screen.findByText('Bought Two')).closest('.track-item') as HTMLElement;
        fireEvent.click(within(row).getByLabelText('action_download'));
        expect(mocks.addToQueue).toHaveBeenCalledWith('album', 'p2');
        fireEvent.click(screen.getByText('Bought One'));
        expect(mocks.navigate).toHaveBeenCalledWith('album', { id: 'p1' });
    });

    it('shows purchased tracks and opens their album', async () => {
        mockFetchRoutes({
            'GET /api/purchases': ({ url }) =>
                url.includes('type=tracks')
                    ? page([{ id: 9, title: 'Single Song', duration: 61, performer: { name: 'Singer' }, album: { id: 'alb', title: 'Parent' } }])
                    : page([]),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<PurchasesView />);
        fireEvent.click(screen.getByRole('tab', { name: 'label_tracks' }));
        fireEvent.click(await screen.findByText('Single Song'));
        expect(mocks.navigate).toHaveBeenCalledWith('album', { id: 'alb' });
        expect(screen.getByText('1:01')).toBeInTheDocument();
        expect(screen.getByText('Singer • Parent')).toBeInTheDocument();
    });

    it('queues all purchases on the server and reports a summary', async () => {
        const calls = mockFetchRoutes({
            'GET /api/purchases': () => page(albums, { total: 3, has_more: true }),
            'GET /api/favorites/ids': favoriteIds,
            'POST /api/purchases/download': () => ({ queued: 1, deduped: 0, skipped: 1, failed: 1 })
        });
        render(<PurchasesView />);
        await screen.findByText('Bought One');
        fireEvent.click(screen.getByRole('button', { name: /action_download_all/ }));
        fireEvent.click(screen.getByText('Confirm'));
        await waitFor(() =>
            expect(mocks.showToast).toHaveBeenCalledWith('msg_purchases_queued: 1 · label_skipped: 1 · label_failed: 1', 'info')
        );
        expect(calls.find((c) => c.url === '/api/purchases/download')?.body).toEqual({ type: 'albums' });
        expect(calls.some((c) => c.url === '/api/queue/add')).toBe(false);
    });

    it('shows the server error when purchases cannot load', async () => {
        mockFetchRoutes({
            'GET /api/purchases': () => ({ status: 400, body: { error: 'Missing credentials' } }),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<PurchasesView />);
        expect(await screen.findByText('Missing credentials')).toBeInTheDocument();
    });
});

describe('LabelView', () => {
    const labelPage = (offset: number) => ({
        label: { id: 9, name: 'Blue Note', albums_count: 3, description: '<p>Jazz <b>label</b></p>' },
        albums:
            offset === 0
                ? page([{ id: 'l1', title: 'Label Album', artist: { name: 'Band' } }], { total: 2, has_more: true })
                : page([{ id: 'l2', title: 'Second Label Album', artist: { name: 'Band' } }], { total: 2, offset: 1 })
    });

    it('shows label info and albums, loads more and opens an album', async () => {
        mocks.navData = { id: '9' };
        const calls = mockFetchRoutes({
            'GET /api/label/9': ({ url }) => labelPage(url.includes('offset=0') ? 0 : 1),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<LabelView />);
        expect(await screen.findByText('Blue Note')).toBeInTheDocument();
        expect(screen.getByText(/Jazz label/)).toBeInTheDocument();
        fireEvent.click(screen.getByText('action_load_more'));
        expect(await screen.findByText('Second Label Album')).toBeInTheDocument();
        expect(calls.some((c) => c.url.includes('offset=1'))).toBe(true);
        fireEvent.click(screen.getByText('Label Album'));
        expect(mocks.navigate).toHaveBeenCalledWith('album', { id: 'l1' });
    });

    it('goes back and reports a load error', async () => {
        mocks.navData = { id: '9' };
        mockFetchRoutes({ 'GET /api/label/9': () => ({ status: 404, body: { error: 'Label 9 could not be loaded' } }) });
        render(<LabelView />);
        expect(await screen.findByText('Label 9 could not be loaded')).toBeInTheDocument();
        fireEvent.click(screen.getByText('action_back'));
        expect(mocks.goBack).toHaveBeenCalledWith('discover');
    });
});

describe('out-of-order responses', () => {
    it('DiscoverView keeps the albums of the newest type when an older request resolves last', async () => {
        const slow = deferred<unknown>();
        mockFetchRoutes({
            'GET /api/genres': () => ({ genres: { items: [] } }),
            'GET /api/discover/albums': ({ url }) =>
                url.includes('type=new-releases') ? slow.promise : page([{ id: 'pa', title: 'Awarded Album' }]),
            'GET /api/discover/playlists': () => page([]),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<DiscoverView />);
        fireEvent.change(screen.getByLabelText('label_featured_type'), { target: { value: 'press-awards' } });
        expect(await screen.findByText('Awarded Album')).toBeInTheDocument();

        slow.resolve(page([{ id: 'old', title: 'Stale Release' }]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByText('Stale Release')).not.toBeInTheDocument();
        expect(screen.getByText('Awarded Album')).toBeInTheDocument();
    });

    it('PurchasesView keeps the newest tab when the previous tab answers late', async () => {
        const slow = deferred<unknown>();
        mockFetchRoutes({
            'GET /api/purchases': ({ url }) =>
                url.includes('type=albums') ? slow.promise : page([{ id: 3, title: 'Bought Track' }]),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<PurchasesView />);
        fireEvent.click(screen.getByRole('tab', { name: 'label_tracks' }));
        expect(await screen.findByText('Bought Track')).toBeInTheDocument();

        slow.resolve(page([{ id: 'alb', title: 'Late Album' }]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByText('Late Album')).not.toBeInTheDocument();
        expect(screen.getByText('Bought Track')).toBeInTheDocument();
    });

    it('ArtistDiscography keeps the newest release type', async () => {
        const slow = deferred<unknown>();
        mockFetchRoutes({
            'GET /api/artist/5/releases': ({ url }) =>
                url.includes('release_type=all') ? slow.promise : page([{ id: 'live1', title: 'Live Set' }]),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<ArtistDiscography artistId="5" />);
        fireEvent.change(screen.getByLabelText('label_release_type'), { target: { value: 'live' } });
        expect(await screen.findByText('Live Set')).toBeInTheDocument();

        slow.resolve(page([{ id: 'all1', title: 'Everything' }]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByText('Everything')).not.toBeInTheDocument();
        expect(screen.getByText('Live Set')).toBeInTheDocument();
    });

    it('LabelView shows the label opened last', async () => {
        const slow = deferred<unknown>();
        mockFetchRoutes({
            'GET /api/label/1': () => slow.promise,
            'GET /api/label/2': () => ({ label: { id: 2, name: 'Second Label' }, albums: page([]) }),
            'GET /api/favorites/ids': favoriteIds
        });
        mocks.navData = { id: '1' };
        const { rerender } = render(<LabelView />);
        mocks.navData = { id: '2' };
        rerender(<LabelView />);
        expect(await screen.findByText('Second Label')).toBeInTheDocument();

        slow.resolve({ label: { id: 1, name: 'First Label' }, albums: page([]) });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByText('First Label')).not.toBeInTheDocument();
        expect(screen.getByText('Second Label')).toBeInTheDocument();
    });
});

describe('overlapping pages', () => {
    it('does not repeat an album that appears on two pages', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockFetchRoutes({
            'GET /api/genres': () => ({ genres: { items: [] } }),
            'GET /api/discover/albums': ({ url }) =>
                url.includes('offset=0')
                    ? page([{ id: 'x1', title: 'Shared Album' }], { has_more: true })
                    : page([{ id: 'x1', title: 'Shared Album' }, { id: 'x2', title: 'Next Album' }]),
            'GET /api/discover/playlists': () => page([]),
            'GET /api/favorites/ids': favoriteIds
        });
        render(<DiscoverView />);
        await screen.findByText('Shared Album');
        fireEvent.click(screen.getByText('action_load_more'));
        expect(await screen.findByText('Next Album')).toBeInTheDocument();
        expect(screen.getAllByText('Shared Album')).toHaveLength(1);
        expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
        errors.mockRestore();
    });
});

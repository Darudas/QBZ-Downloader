import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Player } from '../Player';
import { useFavoritesStore } from '../../stores/favoritesStore';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast })
}));

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (key: string) => key })
}));

vi.mock('../../contexts/PlayerContext', () => ({
  usePlayer: () => ({
    showLyrics: false,
    setShowLyrics: vi.fn(),
    isLyricsFullscreen: false,
    setIsLyricsFullscreen: vi.fn(),
    showEditor: false,
    setShowEditor: vi.fn(),
    playQueue: [{ id: '1', title: 'Test Track', artist: 'Test Artist', cover: 'test.jpg' }],
    currentTrackIndex: 0,
    setCurrentTrackIndex: vi.fn(),
    addToPlaybackQueue: vi.fn(),
    showQueue: false,
    setShowQueue: vi.fn()
  })
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ activeTab: 'home' })
}));

describe('Player', () => {
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
        mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: [], tracks: [], artists: [] }),
            'POST /api/favorites': () => ({ action: 'add' })
        });
        window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
        window.HTMLMediaElement.prototype.pause = vi.fn();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('renders without crashing', () => {
        render(<Player />);
        expect(screen.getAllByText('Test Track').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Test Artist').length).toBeGreaterThan(0);
    });

    it('toggles play/pause', () => {
        render(<Player />);
        const btns = document.querySelectorAll('.play-pause-btn');
        expect(btns.length).toBe(1);
        fireEvent.click(btns[0]);
        expect(btns[0]).toBeInTheDocument();
    });

    it('renders volume/seek slider', () => {
        render(<Player />);
        const slider = document.querySelector('.seek-slider');
        expect(slider).toBeInTheDocument();
    });

    it('favorites the playing track with the heart', async () => {
        const calls = mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: [], tracks: [], artists: [] }),
            'POST /api/favorites': () => ({ action: 'add' })
        });
        render(<Player />);
        fireEvent.click(screen.getByLabelText('action_favorite'));
        await waitFor(() => expect(screen.getByLabelText('action_favorite')).toHaveAttribute('aria-pressed', 'true'));
        expect(calls.find((c) => c.method === 'POST' && c.url === '/api/favorites')?.body).toEqual({ trackIds: ['1'] });
    });

    it('reports a failed download instead of success', async () => {
        mockFetchRoutes({
            'GET /api/favorites/ids': () => ({ albums: [], tracks: [], artists: [] }),
            'POST /api/queue/add': () => ({ status: 400, body: { error: 'Missing credentials' } })
        });
        render(<Player />);
        fireEvent.click(screen.getByTitle('Download'));
        await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Missing credentials', 'error'));
        expect(mocks.showToast).not.toHaveBeenCalledWith('Added to queue', 'success');
    });
});

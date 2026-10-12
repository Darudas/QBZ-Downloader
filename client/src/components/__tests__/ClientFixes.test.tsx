import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../CommandPalette';
import { LoginModal } from '../Modals';
import { ThemeProvider, useTheme } from '../../contexts/ThemeContext';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    setActiveTab: vi.fn(),
    updateSetting: vi.fn(),
    showToast: vi.fn()
}));

vi.mock('../../contexts/NavigationContext', () => ({
    useNavigation: () => ({ navigate: mocks.navigate, setActiveTab: mocks.setActiveTab })
}));
vi.mock('../../contexts/SettingsContext', () => ({
    useSettings: () => ({ settings: {}, updateSetting: mocks.updateSetting, loading: false, addToStaging: vi.fn() })
}));
vi.mock('../../contexts/ToastContext', () => ({
    useToast: () => ({ showToast: mocks.showToast })
}));

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('CommandPalette', () => {
    it('shows artists, albums and tracks from the suggestions route', async () => {
        mockFetchRoutes({
            'GET /api/search/suggestions': () => ({
                artists: [{ id: 1, name: 'Miles Davis' }],
                albums: [{ id: 'kob', title: 'Kind of Blue', artist: { name: 'Miles Davis' } }],
                tracks: [{ id: 5, title: 'So What', performer: { name: 'Miles Davis' }, album: { id: 'kob', title: 'Kind of Blue' } }]
            })
        });
        render(<CommandPalette />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        fireEvent.change(screen.getByPlaceholderText(/search music/i), { target: { value: 'miles' } });

        expect(await screen.findByText('Kind of Blue')).toBeInTheDocument();
        expect(screen.getByText('So What')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Miles Davis'));
        expect(mocks.navigate).toHaveBeenCalledWith('artist', { id: '1' });
    });

    it('opens the album of a track suggestion', async () => {
        mockFetchRoutes({
            'GET /api/search/suggestions': () => ({
                artists: [],
                albums: [],
                tracks: [{ id: 5, title: 'So What', album: { id: 'kob', title: 'Kind of Blue' } }]
            })
        });
        render(<CommandPalette />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        fireEvent.change(screen.getByPlaceholderText(/search music/i), { target: { value: 'so what' } });
        fireEvent.click(await screen.findByText('So What'));
        expect(mocks.navigate).toHaveBeenCalledWith('album', { id: 'kob' });
    });
});

describe('LoginModal', () => {
    it('shows the running version instead of a hard-coded one', async () => {
        mockFetchRoutes({ 'GET /api/status': () => ({ ok: true, status: 'running', version: '5.6.3' }) });
        render(<LoginModal onSuccess={vi.fn()} />);
        expect(await screen.findByText('v5.6.3')).toBeInTheDocument();
        expect(screen.queryByText('v5.2.0')).not.toBeInTheDocument();
    });

    it('shows no version when the status route is unreachable', async () => {
        const calls = mockFetchRoutes({});
        render(<LoginModal onSuccess={vi.fn()} />);
        await waitFor(() => expect(calls.some((c) => c.url === '/api/status')).toBe(true));
        expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
    });
});

describe('ThemeContext', () => {
    const HASH = 'a'.repeat(64);

    const ThemeProbe = ({ onError }: { onError: (err: unknown) => void }) => {
        const { themes, saveTheme } = useTheme();
        return (
            <div>
                <span data-testid="count">{themes.length}</span>
                <button onClick={() => saveTheme('Mine', true, {}).catch(onError)}>save</button>
            </div>
        );
    };

    it('loads themes with the dashboard password header', async () => {
        sessionStorage.setItem('dashboard_password', HASH);
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);
        render(
            <ThemeProvider>
                <ThemeProbe onError={vi.fn()} />
            </ThemeProvider>
        );
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/api/themes');
        expect((init.headers as Record<string, string>)['x-password']).toBe(HASH);
    });

    it('rejects saveTheme when the server refuses', async () => {
        mockFetchRoutes({
            'GET /api/themes': () => [],
            'POST /api/themes': () => ({ status: 400, body: { error: 'Missing parameters' } })
        });
        const onError = vi.fn();
        render(
            <ThemeProvider>
                <ThemeProbe onError={onError} />
            </ThemeProvider>
        );
        fireEvent.click(screen.getByText('save'));
        await waitFor(() => expect(onError).toHaveBeenCalled());
        expect((onError.mock.calls[0][0] as Error).message).toBe('Missing parameters');
        expect(screen.getByTestId('count').textContent).toBe('0');
    });
});

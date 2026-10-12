import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FavoritesSyncSettingsSection } from '../FavoritesSyncSettingsSection';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const showToast = vi.hoisted(() => vi.fn());

vi.mock('../../contexts/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));

const status = {
    autoDownload: false,
    types: ['albums', 'tracks'],
    intervalHours: 6,
    running: false,
    credentialsConfigured: true,
    lastSyncAt: null,
    nextSyncAt: null
};

describe('FavoritesSyncSettingsSection', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('saves the toggle, types and interval as settings', async () => {
        const calls = mockFetchRoutes({
            'GET /api/favorites/sync': () => status,
            'POST /api/settings/update': () => ({ success: true })
        });
        render(<FavoritesSyncSettingsSection />);
        fireEvent.click(await screen.findByLabelText('label_favorites_sync_enabled'));
        fireEvent.click(screen.getByLabelText('label_tracks'));
        fireEvent.change(screen.getByLabelText('label_favorites_sync_interval'), { target: { value: '12' } });
        fireEvent.click(screen.getByRole('button', { name: 'action_save' }));
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('msg_favorites_sync_saved', 'success'));
        expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
            settings: {
                FAVORITES_AUTO_DOWNLOAD: 'true',
                FAVORITES_AUTO_DOWNLOAD_TYPES: 'albums',
                FAVORITES_SYNC_INTERVAL_HOURS: '12'
            }
        });
    });

    it('blocks saving without a type or with an invalid interval', async () => {
        mockFetchRoutes({ 'GET /api/favorites/sync': () => status });
        render(<FavoritesSyncSettingsSection />);
        fireEvent.click(await screen.findByLabelText('label_albums'));
        fireEvent.click(screen.getByLabelText('label_tracks'));
        expect(screen.getByRole('button', { name: 'action_save' })).toBeDisabled();
        fireEvent.click(screen.getByLabelText('label_tracks'));
        fireEvent.change(screen.getByLabelText('label_favorites_sync_interval'), { target: { value: '500' } });
        expect(screen.getByRole('button', { name: 'action_save' })).toBeDisabled();
    });

    it('reports a baseline-only check', async () => {
        mockFetchRoutes({
            'GET /api/favorites/sync': () => status,
            'POST /api/favorites/sync': () => ({ baselineRecorded: ['albums'], queued: 0, skipped: 0, deduped: 0, failed: 0 })
        });
        render(<FavoritesSyncSettingsSection />);
        fireEvent.click(await screen.findByRole('button', { name: 'action_check_now' }));
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('msg_favorites_sync_baseline', 'info'));
    });

    it('renders nothing when the status cannot load', async () => {
        mockFetchRoutes({});
        const { container } = render(<FavoritesSyncSettingsSection />);
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });
});

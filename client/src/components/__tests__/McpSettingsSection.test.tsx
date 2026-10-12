import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsSection } from '../McpSettingsSection';
import { mockFetchRoutes } from '../../test-utils/fetchRoutes';

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('../../contexts/LanguageContext', () => ({
    useLanguage: () => ({ t: (key: string) => key })
}));
vi.mock('../../contexts/ToastContext', () => ({
    useToast: () => ({ showToast: mocks.showToast })
}));

const status = {
    enabled: true,
    permissions: ['read'],
    available_permissions: ['read', 'library', 'download', 'manage', 'destructive'],
    token: { configured: true, createdAt: null, fromEnv: false },
    endpoint_path: '/mcp'
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('McpSettingsSection', () => {
    it('reports a failed token revoke and keeps the buttons usable', async () => {
        const calls = mockFetchRoutes({
            'GET /api/mcp/status': () => status,
            'DELETE /api/mcp/token': () => ({ status: 500, body: { error: 'disk full' } })
        });
        render(<McpSettingsSection />);
        fireEvent.click(await screen.findByText('mcp_revoke'));
        await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('mcp_revoke_failed', 'error'));
        expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
        expect(screen.getByText('mcp_revoke')).not.toBeDisabled();
    });

    it('reloads the status after a successful revoke', async () => {
        let revoked = false;
        mockFetchRoutes({
            'GET /api/mcp/status': () => ({ ...status, token: { ...status.token, configured: !revoked } }),
            'DELETE /api/mcp/token': () => {
                revoked = true;
                return { success: true };
            }
        });
        render(<McpSettingsSection />);
        fireEvent.click(await screen.findByText('mcp_revoke'));
        expect(await screen.findByText('mcp_token_missing')).toBeInTheDocument();
        expect(mocks.showToast).not.toHaveBeenCalled();
    });

    it('reports a failed token generation', async () => {
        mockFetchRoutes({
            'GET /api/mcp/status': () => status,
            'POST /api/mcp/token': () => ({ status: 500, body: { error: 'nope' } })
        });
        render(<McpSettingsSection />);
        fireEvent.click(await screen.findByText('mcp_rotate'));
        await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('mcp_save_failed', 'error'));
        expect(screen.getByText('mcp_rotate')).not.toBeDisabled();
    });

    it('reports a failed permission change', async () => {
        mockFetchRoutes({
            'GET /api/mcp/status': () => status,
            'POST /api/mcp/config': () => ({ status: 400, body: { error: 'bad' } })
        });
        render(<McpSettingsSection />);
        fireEvent.click(await screen.findByText('mcp_group_library'));
        await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('mcp_save_failed', 'error'));
    });
});

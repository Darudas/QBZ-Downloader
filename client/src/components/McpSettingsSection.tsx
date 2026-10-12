import { useEffect, useState } from 'react';
import { smartFetch } from '../utils/api';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';

interface McpStatus {
    enabled: boolean;
    permissions: string[];
    available_permissions: string[];
    token: { configured: boolean; createdAt: string | null; fromEnv: boolean };
    endpoint_path: string;
}

const isStatus = (value: unknown): value is McpStatus =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as McpStatus).enabled === 'boolean' &&
    Array.isArray((value as McpStatus).permissions) &&
    !!(value as McpStatus).token;

const GROUPS = ['library', 'download', 'manage', 'destructive'] as const;

/** Copies text; navigator.clipboard is unavailable on plain-http LAN origins. */
async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    }
}

export function McpSettingsSection() {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const [status, setStatus] = useState<McpStatus | null>(null);
    // The plaintext token exists only in this component's memory, once.
    const [freshToken, setFreshToken] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        const res = await smartFetch('/api/mcp/status');
        if (res && res.ok) {
            const data: unknown = await res.json();
            if (isStatus(data)) setStatus(data);
        }
    };

    useEffect(() => {
        void load();
        return () => setFreshToken(null);
    }, []);

    const saveConfig = async (patch: { enabled?: boolean; permissions?: string[] }) => {
        setBusy(true);
        const res = await smartFetch('/api/mcp/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        setBusy(false);
        if (res && res.ok) {
            const data: unknown = await res.json();
            if (isStatus(data)) setStatus(data);
        } else {
            showToast(t('mcp_save_failed'), 'error');
        }
    };

    const generate = async () => {
        if (status?.token.configured && !window.confirm(t('mcp_rotate_confirm'))) return;
        setBusy(true);
        const res = await smartFetch('/api/mcp/token', { method: 'POST' });
        setBusy(false);
        if (res && res.ok) {
            const data = (await res.json()) as { token?: unknown };
            if (typeof data.token === 'string') setFreshToken(data.token);
            void load();
        } else {
            showToast(t('mcp_save_failed'), 'error');
        }
    };

    const revoke = async () => {
        if (!window.confirm(t('mcp_revoke_confirm'))) return;
        const res = await smartFetch('/api/mcp/token', { method: 'DELETE' });
        if (res && res.ok) {
            setFreshToken(null);
            void load();
        }
    };

    if (!status) return null;

    const url = `${window.location.origin}${status.endpoint_path}`;
    const token = freshToken ?? '<token>';
    const claudeCode = `claude mcp add --transport http qbz ${url} --header "Authorization: Bearer ${token}"`;
    const desktop = JSON.stringify(
        {
            mcpServers: {
                qbz: {
                    command: 'node',
                    args: ['/path/to/QBZ-Downloader/dist/mcp/bridge.js'],
                    env: { QBZ_MCP_URL: url, QBZ_MCP_TOKEN: token }
                }
            }
        },
        null,
        2
    );

    const togglePermission = (group: string) => {
        const current = status.permissions.filter((p) => p !== 'read');
        const next = current.includes(group) ? current.filter((p) => p !== group) : [...current, group];
        void saveConfig({ permissions: next });
    };

    const copy = async (text: string) => {
        showToast((await copyText(text)) ? t('mcp_copied') : t('mcp_copy_failed'), 'info');
    };

    return (
        <div className="settings-section">
            <h3 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="icon">🤖</span> {t('sec_mcp')}
            </h3>
            <p className="section-desc">{t('desc_mcp')}</p>

            <div className="settings-checkbox-group">
                <div className="settings-checkbox-item" onClick={() => !busy && saveConfig({ enabled: !status.enabled })}>
                    <input type="checkbox" checked={status.enabled} onChange={() => {}} />
                    <label>{t('mcp_enable')}</label>
                </div>
            </div>

            <h4 style={{ marginTop: '20px' }}>{t('mcp_permissions')}</h4>
            <div className="settings-checkbox-group">
                {GROUPS.map((group) => (
                    <div key={group} className="settings-checkbox-item" onClick={() => !busy && togglePermission(group)}>
                        <input type="checkbox" checked={status.permissions.includes(group)} onChange={() => {}} />
                        <label style={group === 'destructive' ? { color: 'var(--danger)' } : undefined}>
                            {t(`mcp_group_${group}`)}
                        </label>
                    </div>
                ))}
            </div>

            <h4 style={{ marginTop: '20px' }}>{t('mcp_token')}</h4>
            <p className="section-desc">
                {status.token.configured
                    ? `${t('mcp_token_configured')}${status.token.createdAt ? ` (${new Date(status.token.createdAt).toLocaleString()})` : ''}`
                    : t('mcp_token_missing')}
            </p>
            {freshToken && (
                <div className="form-group">
                    <label>{t('mcp_token_once')}</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <input type="text" readOnly value={freshToken} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
                        <button className="btn secondary" onClick={() => copy(freshToken)}>{t('mcp_copy')}</button>
                    </div>
                </div>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button className="btn primary" disabled={busy} onClick={generate}>
                    {status.token.configured ? t('mcp_rotate') : t('mcp_generate')}
                </button>
                {status.token.configured && (
                    <button className="btn danger" disabled={busy} onClick={revoke}>{t('mcp_revoke')}</button>
                )}
            </div>

            <h4 style={{ marginTop: '20px' }}>{t('mcp_connect')}</h4>
            <div className="form-group">
                <label>URL</label>
                <input type="text" readOnly value={url} />
            </div>
            <div className="form-group">
                <label>Claude Code</label>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '12px' }}>{claudeCode}</pre>
                <button className="btn secondary small" onClick={() => copy(claudeCode)}>{t('mcp_copy')}</button>
            </div>
            <div className="form-group">
                <label>Claude Desktop (claude_desktop_config.json)</label>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>{desktop}</pre>
                <button className="btn secondary small" onClick={() => copy(desktop)}>{t('mcp_copy')}</button>
            </div>
            <p className="section-desc">{t('mcp_more_clients')}</p>
        </div>
    );
}

export default McpSettingsSection;

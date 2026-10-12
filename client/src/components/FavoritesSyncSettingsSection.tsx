import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';

type Kind = 'albums' | 'tracks';

interface SyncStatus {
    autoDownload: boolean;
    types: Kind[];
    intervalHours: number;
    running: boolean;
    credentialsConfigured: boolean;
    lastSyncAt: string | null;
    nextSyncAt: string | null;
}

interface SyncResult {
    baselineRecorded: Kind[];
    queued: number;
    skipped: number;
    deduped: number;
    failed: number;
}

const KINDS: Kind[] = ['albums', 'tracks'];

const formatTime = (value: string | null, never: string) => (value ? new Date(value).toLocaleString() : never);

/** Settings for downloading newly added Qobuz favorites automatically. */
export function FavoritesSyncSettingsSection() {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [types, setTypes] = useState<Kind[]>(KINDS);
    const [interval, setIntervalHours] = useState('6');
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const data = await apiJson<SyncStatus>('/api/favorites/sync');
            setStatus(data);
            setEnabled(data.autoDownload);
            setTypes(data.types.length > 0 ? data.types : KINDS);
            setIntervalHours(String(data.intervalHours));
        } catch {
            setStatus(null);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const toggleType = (kind: Kind) =>
        setTypes((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));

    const hours = Number(interval);
    const intervalValid = Number.isInteger(hours) && hours >= 1 && hours <= 168;
    const canSave = !busy && types.length > 0 && intervalValid;

    const save = async () => {
        setBusy(true);
        try {
            await apiJson('/api/settings/update', {
                method: 'POST',
                body: {
                    settings: {
                        FAVORITES_AUTO_DOWNLOAD: enabled ? 'true' : 'false',
                        FAVORITES_AUTO_DOWNLOAD_TYPES: types.join(','),
                        FAVORITES_SYNC_INTERVAL_HOURS: String(hours)
                    }
                }
            });
            showToast(t('msg_favorites_sync_saved'), 'success');
            await load();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            setBusy(false);
        }
    };

    const syncNow = async () => {
        setBusy(true);
        try {
            const result = await apiJson<SyncResult>('/api/favorites/sync', { method: 'POST' });
            if (result.baselineRecorded.length > 0 && result.queued === 0) {
                showToast(t('msg_favorites_sync_baseline'), 'info');
            } else {
                showToast(
                    `${t('msg_favorites_queued')}: ${result.queued}` + (result.failed ? ` · ${t('label_failed')}: ${result.failed}` : ''),
                    result.failed ? 'info' : 'success'
                );
            }
            await load();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            setBusy(false);
        }
    };

    if (!status) return null;

    return (
        <div className="settings-section" style={{ marginTop: 32 }}>
            <h3 style={{ marginBottom: 8 }}>{t('title_favorites_sync')}</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0 }}>{t('msg_favorites_sync_hint')}</p>

            <div className="settings-checkbox-group">
                <label className="settings-checkbox-item" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                    <span>{t('label_favorites_sync_enabled')}</span>
                </label>
                {KINDS.map((kind) => (
                    <label key={kind} className="settings-checkbox-item" style={{ cursor: 'pointer' }}>
                        <input type="checkbox" checked={types.includes(kind)} onChange={() => toggleType(kind)} />
                        <span>{kind === 'albums' ? t('label_albums') : t('label_tracks')}</span>
                    </label>
                ))}
            </div>

            <div className="form-group" style={{ maxWidth: 240, marginTop: 12 }}>
                <label htmlFor="favorites-sync-interval">{t('label_favorites_sync_interval')}</label>
                <input
                    id="favorites-sync-interval"
                    type="number"
                    min={1}
                    max={168}
                    value={interval}
                    onChange={(e) => setIntervalHours(e.target.value)}
                />
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 16px' }}>
                {t('label_last_check')}: {formatTime(status.lastSyncAt, t('label_never'))}
                {' · '}
                {t('label_next_check')}: {formatTime(status.nextSyncAt, '–')}
                {!status.credentialsConfigured && <> · {t('msg_favorites_sync_no_login')}</>}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={save} disabled={!canSave}>
                    {t('action_save')}
                </button>
                <button className="btn secondary" onClick={syncNow} disabled={busy || !status.credentialsConfigured}>
                    {t('action_check_now')}
                </button>
            </div>
        </div>
    );
}

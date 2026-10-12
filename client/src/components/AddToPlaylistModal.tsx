import React, { useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';
import { Icons } from './Icons';

export interface OwnPlaylist {
    id: string | number;
    name: string;
    tracks_count?: number;
    is_owner?: boolean;
    is_public?: boolean;
    images300?: string[];
    image_rectangle?: string[];
    description?: string;
    owner?: { name?: string };
}

interface PageResult<T> {
    items: T[];
    total: number;
    has_more: boolean;
}

interface AddToPlaylistModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Tracks to add. Either this or `albumId` must be set. */
    trackIds?: Array<string | number>;
    /** Adds every track of this album. */
    albumId?: string;
    /** Shown in the dialog title, e.g. the track or album name. */
    label?: string;
}

export const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({ isOpen, onClose, trackIds, albumId, label }) => {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const [playlists, setPlaylists] = useState<OwnPlaylist[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [newName, setNewName] = useState('');

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        setLoading(true);
        setError('');
        apiJson<PageResult<OwnPlaylist>>('/api/me/playlists?filter=owner&limit=500')
            .then((page) => {
                if (!cancelled) setPlaylists(page.items ?? []);
            })
            .catch((err: Error) => {
                if (!cancelled) setError(err.message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const payload = {
        ...(trackIds && trackIds.length > 0 ? { trackIds: trackIds.map(String) } : {}),
        ...(albumId ? { albumId } : {})
    };

    const addTo = async (playlist: OwnPlaylist) => {
        const id = String(playlist.id);
        setBusyId(id);
        try {
            const result = await apiJson<{ added: number; requested: number }>(`/api/me/playlists/${id}/tracks`, {
                method: 'POST',
                body: payload
            });
            if (result.added === 0 && result.requested > 0) {
                showToast(t('msg_playlist_already_contains'), 'info');
            } else {
                showToast(`${t('msg_added_to_playlist')}: ${playlist.name}`, 'success');
            }
            onClose();
        } catch (err) {
            showToast(err instanceof Error ? err.message : t('msg_playlist_failed'), 'error');
        } finally {
            setBusyId(null);
        }
    };

    const createWithTracks = async (event: React.FormEvent) => {
        event.preventDefault();
        const name = newName.trim();
        if (!name) return;
        setBusyId('new');
        try {
            const result = await apiJson<{ playlist: OwnPlaylist; error?: { message?: string } }>('/api/me/playlists', {
                method: 'POST',
                body: { name, isPublic: false, ...payload }
            });
            if (result.error) {
                showToast(`${t('msg_playlist_created_tracks_failed')}: ${result.error.message ?? ''}`, 'error');
            } else {
                showToast(`${t('msg_playlist_created')}: ${result.playlist.name}`, 'success');
            }
            setNewName('');
            onClose();
        } catch (err) {
            showToast(err instanceof Error ? err.message : t('msg_playlist_failed'), 'error');
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={t('title_add_to_playlist')}
            onClick={onClose}
            style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
            }}
        >
            <div
                className="modal-content"
                onClick={(e) => e.stopPropagation()}
                style={{
                    background: 'var(--bg-card)', padding: '24px', borderRadius: '12px', width: '100%',
                    maxWidth: '440px', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
                    border: '1px solid var(--border)'
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <h3 style={{ margin: 0 }}>{t('title_add_to_playlist')}</h3>
                    <button type="button" className="btn-track-dl" onClick={onClose} aria-label={t('action_close')}>
                        <Icons.Close width={14} height={14} />
                    </button>
                </div>
                {label && (
                    <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label}
                    </p>
                )}

                <form onSubmit={createWithTracks} style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
                    <input
                        type="text"
                        value={newName}
                        maxLength={200}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder={t('placeholder_new_playlist')}
                        aria-label={t('placeholder_new_playlist')}
                        style={{ flex: 1 }}
                    />
                    <button type="submit" className="btn primary" disabled={!newName.trim() || busyId !== null} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icons.Plus width={14} height={14} /> {t('action_create')}
                    </button>
                </form>

                <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {loading && <div style={{ color: 'var(--text-secondary)' }}>{t('msg_loading')}</div>}
                    {!loading && error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
                    {!loading && !error && playlists.length === 0 && (
                        <div style={{ color: 'var(--text-secondary)' }}>{t('msg_no_own_playlists')}</div>
                    )}
                    {playlists.map((playlist) => (
                        <button
                            key={String(playlist.id)}
                            type="button"
                            className="track-item"
                            disabled={busyId !== null}
                            onClick={() => addTo(playlist)}
                            style={{ textAlign: 'left', cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', width: '100%' }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                                <Icons.Playlist width={18} height={18} />
                                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playlist.name}</span>
                            </div>
                            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                {busyId === String(playlist.id) ? '…' : `${playlist.tracks_count ?? 0} ${t('label_tracks')}`}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};

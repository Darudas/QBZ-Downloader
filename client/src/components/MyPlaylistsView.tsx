import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useQueueActions } from '../hooks/useQueueActions';
import { FavoriteButton } from './FavoriteButton';
import { ConfirmModal } from './Modals';
import { playTrack } from './Player';
import { Icons } from './Icons';
import type { OwnPlaylist } from './AddToPlaylistModal';

interface PageResult<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
}

interface PlaylistTrack {
    id: string | number;
    playlist_track_id: string | number;
    position?: number;
    title: string;
    duration?: number;
    hires?: boolean;
    performer?: { name?: string };
    album?: { id?: string | number; title?: string; image?: { small?: string; thumbnail?: string } };
}

interface PlaylistDetails extends OwnPlaylist {
    is_owner: boolean;
    can_add_tracks: boolean;
    tracks: PageResult<PlaylistTrack>;
}

const PAGE_SIZE = 100;

const coverOfPlaylist = (playlist: OwnPlaylist) =>
    playlist.images300?.[0] || playlist.image_rectangle?.[0] || '';

const formatDuration = (seconds?: number) =>
    seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';

/* ------------------------------------------------------------------ */
/* Detail                                                               */
/* ------------------------------------------------------------------ */

const PlaylistDetail: React.FC<{ playlistId: string; onBack: () => void; onChanged: () => void }> = ({
    playlistId,
    onBack,
    onChanged
}) => {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const { navigate } = useNavigation();
    const { addToQueue } = useQueueActions();

    const [details, setDetails] = useState<PlaylistDetails | null>(null);
    const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [confirm, setConfirm] = useState<'delete' | 'unfollow' | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(
        async (offset: number) => {
            setLoading(true);
            setError('');
            try {
                const page = await apiJson<PlaylistDetails>(
                    `/api/me/playlists/${playlistId}?limit=${PAGE_SIZE}&offset=${offset}`
                );
                setDetails(page);
                setTracks((prev) => (offset === 0 ? page.tracks.items : [...prev, ...page.tracks.items]));
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setLoading(false);
            }
        },
        [playlistId]
    );

    useEffect(() => {
        void load(0);
    }, [load]);

    const startEdit = () => {
        if (!details) return;
        setName(details.name);
        setDescription(details.description ?? '');
        setEditing(true);
    };

    const saveEdit = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            const updated = await apiJson<OwnPlaylist>(`/api/me/playlists/${playlistId}`, {
                method: 'PATCH',
                body: { name: name.trim(), description }
            });
            setDetails((prev) => (prev ? { ...prev, name: updated.name, description: updated.description ?? description } : prev));
            setEditing(false);
            onChanged();
            showToast(t('msg_playlist_saved'), 'success');
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            setBusy(false);
        }
    };

    const removeTrack = async (track: PlaylistTrack) => {
        setBusy(true);
        try {
            await apiJson(`/api/me/playlists/${playlistId}/tracks`, {
                method: 'DELETE',
                body: { playlistTrackIds: [String(track.playlist_track_id)] }
            });
            setTracks((prev) => prev.filter((entry) => entry.playlist_track_id !== track.playlist_track_id));
            setDetails((prev) =>
                prev ? { ...prev, tracks_count: Math.max(0, (prev.tracks_count ?? 1) - 1) } : prev
            );
            onChanged();
            showToast(t('msg_track_removed'), 'success');
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleConfirm = async () => {
        const action = confirm;
        setConfirm(null);
        if (!action) return;
        setBusy(true);
        try {
            if (action === 'delete') {
                await apiJson(`/api/me/playlists/${playlistId}`, { method: 'DELETE' });
                showToast(t('msg_playlist_deleted'), 'success');
            } else {
                await apiJson(`/api/me/playlists/${playlistId}/follow`, { method: 'DELETE' });
                showToast(t('msg_playlist_unfollowed'), 'success');
            }
            onChanged();
            onBack();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            setBusy(false);
        }
    };

    const backButton = (
        <button className="btn secondary" onClick={onBack} style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icons.ArrowLeft width={16} height={16} /> {t('action_back')}
        </button>
    );

    if (error && !details) {
        return (
            <div>
                {backButton}
                <div className="empty-state">
                    <h3>{t('msg_playlist_failed')}</h3>
                    <p>{error}</p>
                </div>
            </div>
        );
    }

    if (!details) {
        return (
            <div>
                {backButton}
                <div style={{ color: 'var(--text-secondary)' }}>{t('msg_loading')}</div>
            </div>
        );
    }

    const cover = coverOfPlaylist(details);
    const hasMore = tracks.length < details.tracks.total;

    return (
        <div>
            {backButton}
            <div className="album-header">
                {cover ? (
                    <img src={cover} className="album-header-cover" alt="" />
                ) : (
                    <div className="album-header-cover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-hover)' }}>
                        <Icons.Playlist width={64} height={64} style={{ opacity: 0.4 }} />
                    </div>
                )}
                <div className="album-header-info">
                    {editing ? (
                        <form onSubmit={saveEdit} className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480, margin: 0 }}>
                            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required aria-label={t('label_name')} />
                            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} aria-label={t('label_description')} style={{ background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border)', borderRadius: 14, padding: '12px 16px', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }} />
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{t('action_save')}</button>
                                <button type="button" className="btn secondary" onClick={() => setEditing(false)}>{t('action_cancel')}</button>
                            </div>
                        </form>
                    ) : (
                        <>
                            <div className="album-header-title">{details.name}</div>
                            {!details.is_owner && details.owner?.name && (
                                <div className="album-header-artist">{details.owner.name}</div>
                            )}
                            <div className="album-header-meta">
                                {details.tracks_count ?? details.tracks.total} {t('label_tracks')}
                                {' • '}
                                {details.is_public ? t('label_public') : t('label_private')}
                                {details.description && (
                                    <>
                                        <br />
                                        {details.description}
                                    </>
                                )}
                            </div>
                        </>
                    )}
                    {!editing && (
                        <div style={{ marginTop: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            <button className="btn primary" onClick={() => addToQueue('playlist', playlistId)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Icons.Download width={16} height={16} /> {t('action_download')}
                            </button>
                            {details.is_owner ? (
                                <>
                                    <button className="btn secondary" onClick={startEdit} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Icons.Edit width={16} height={16} /> {t('action_edit')}
                                    </button>
                                    <button className="btn danger" onClick={() => setConfirm('delete')} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Icons.Trash width={16} height={16} /> {t('action_delete')}
                                    </button>
                                </>
                            ) : (
                                <button className="btn secondary" onClick={() => setConfirm('unfollow')} disabled={busy}>
                                    {t('action_unfollow')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <div className="track-list">
                {tracks.length === 0 && !loading && (
                    <div className="empty-state"><p>{t('msg_playlist_empty')}</p></div>
                )}
                {tracks.map((track, index) => {
                    const artistName = track.performer?.name || '';
                    const cover = track.album?.image?.small || track.album?.image?.thumbnail || '';
                    return (
                        <div key={String(track.playlist_track_id)} className="track-item">
                            <div className="track-number">{track.position ?? index + 1}</div>
                            <div
                                className="track-title"
                                style={{ cursor: track.album?.id ? 'pointer' : 'default', minWidth: 0 }}
                                onClick={() => track.album?.id && navigate('album', { id: String(track.album.id) })}
                            >
                                {track.title}
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                    {[artistName, track.album?.title].filter(Boolean).join(' • ')}
                                </div>
                            </div>
                            <div className="track-duration">{formatDuration(track.duration)}</div>
                            <div className="track-actions">
                                <button className="btn-track-dl" title={t('action_download')} aria-label={t('action_download')} onClick={() => addToQueue('track', String(track.id))}>
                                    <Icons.Download width={14} height={14} />
                                </button>
                                <button className="btn-track-dl" title={t('action_play')} aria-label={t('action_play')} onClick={() => playTrack(String(track.id), track.title, artistName, cover, track.album?.id ? String(track.album.id) : undefined, tracks)}>
                                    <Icons.Play width={14} height={14} />
                                </button>
                                <FavoriteButton kind="track" id={String(track.id)} />
                                {details.is_owner && (
                                    <button className="btn-track-dl" title={t('action_remove_from_playlist')} aria-label={t('action_remove_from_playlist')} disabled={busy} onClick={() => removeTrack(track)}>
                                        <Icons.Trash width={14} height={14} />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {hasMore && (
                <div className="pagination">
                    <button disabled={loading} onClick={() => load(tracks.length)}>
                        {loading ? t('msg_loading') : t('action_load_more')}
                    </button>
                </div>
            )}

            <ConfirmModal
                isOpen={confirm !== null}
                title={confirm === 'delete' ? t('title_delete_playlist') : t('action_unfollow')}
                message={(confirm === 'delete' ? t('msg_confirm_delete_playlist') : t('msg_confirm_unfollow_playlist')).replace('{name}', details.name)}
                onConfirm={handleConfirm}
                onCancel={() => setConfirm(null)}
            />
        </div>
    );
};

/* ------------------------------------------------------------------ */
/* List                                                                 */
/* ------------------------------------------------------------------ */

export const MyPlaylistsView: React.FC = () => {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const [playlists, setPlaylists] = useState<OwnPlaylist[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [newPublic, setNewPublic] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const page = await apiJson<PageResult<OwnPlaylist>>('/api/me/playlists?limit=500');
            setPlaylists(page.items);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const create = async (event: React.FormEvent) => {
        event.preventDefault();
        const name = newName.trim();
        if (!name) return;
        try {
            const result = await apiJson<{ playlist: OwnPlaylist }>('/api/me/playlists', {
                method: 'POST',
                body: { name, isPublic: newPublic }
            });
            showToast(`${t('msg_playlist_created')}: ${result.playlist.name}`, 'success');
            setNewName('');
            setNewPublic(false);
            setCreating(false);
            void load();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        }
    };

    if (selected) {
        return (
            <div id="view-my-playlists" className="view-section active">
                <PlaylistDetail playlistId={selected} onBack={() => setSelected(null)} onChanged={() => void load()} />
            </div>
        );
    }

    const owned = playlists.filter((playlist) => playlist.is_owner);
    const followed = playlists.filter((playlist) => !playlist.is_owner);

    const renderGrid = (items: OwnPlaylist[]) => (
        <div className="results-grid">
            {items.map((playlist) => {
                const cover = coverOfPlaylist(playlist);
                return (
                    <div key={String(playlist.id)} className="grid-item" onClick={() => setSelected(String(playlist.id))}>
                        <div className="grid-cover-container">
                            {cover ? (
                                <img src={cover} className="grid-cover" alt="" loading="lazy" />
                            ) : (
                                <div className="grid-cover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Icons.Playlist width={48} height={48} style={{ opacity: 0.2 }} />
                                </div>
                            )}
                        </div>
                        <div className="grid-info">
                            <div className="grid-title" title={playlist.name}>{playlist.name}</div>
                            <div className="grid-artist">
                                {playlist.tracks_count ?? 0} {t('label_tracks')}
                                {!playlist.is_owner && playlist.owner?.name ? ` • ${playlist.owner.name}` : ''}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    return (
        <div id="view-my-playlists" className="view-section active">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>{t('title_my_playlists')}</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn secondary" onClick={() => void load()} title={t('action_refresh')} aria-label={t('action_refresh')}>
                        <Icons.Refresh width={14} height={14} />
                    </button>
                    <button className="btn primary" onClick={() => setCreating((value) => !value)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icons.Plus width={16} height={16} /> {t('action_new_playlist')}
                    </button>
                </div>
            </div>

            {creating && (
                <form onSubmit={create} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
                    <div className="form-group" style={{ flex: 1, minWidth: 200, margin: 0 }}>
                        <input
                            autoFocus
                            value={newName}
                            maxLength={200}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder={t('placeholder_new_playlist')}
                            aria-label={t('placeholder_new_playlist')}
                        />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                        <input type="checkbox" checked={newPublic} onChange={(e) => setNewPublic(e.target.checked)} />
                        {t('label_public')}
                    </label>
                    <button type="submit" className="btn primary" disabled={!newName.trim()}>{t('action_create')}</button>
                </form>
            )}

            {error && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Warning width={48} height={48} /></div>
                    <h3>{t('msg_playlists_failed')}</h3>
                    <p>{error}</p>
                </div>
            )}

            {!error && loading && playlists.length === 0 && <div style={{ color: 'var(--text-secondary)' }}>{t('msg_loading')}</div>}

            {!error && !loading && playlists.length === 0 && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Playlist width={48} height={48} /></div>
                    <h3>{t('msg_no_own_playlists')}</h3>
                </div>
            )}

            {owned.length > 0 && renderGrid(owned)}

            {followed.length > 0 && (
                <>
                    <h4 style={{ margin: '28px 0 12px' }}>{t('title_followed_playlists')}</h4>
                    {renderGrid(followed)}
                </>
            )}
        </div>
    );
};

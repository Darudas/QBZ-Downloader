import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useQueueActions } from '../hooks/useQueueActions';
import { useFavoritesStore } from '../stores/favoritesStore';
import { useLatestRequest } from '../hooks/useLatestRequest';
import { appendPage } from '../utils/lists';
import { FavoriteButton } from './FavoriteButton';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { ConfirmModal } from './Modals';
import { playTrack } from './Player';
import { Icons } from './Icons';

type FavoriteTab = 'albums' | 'tracks' | 'artists';

interface Image {
    small?: string;
    thumbnail?: string;
    medium?: string;
    large?: string;
}

export interface FavoriteItem {
    id: string | number;
    title?: string;
    name?: string;
    duration?: number;
    hires?: boolean;
    artist?: { name?: string };
    performer?: { name?: string };
    album?: { id?: string | number; title?: string; image?: Image };
    image?: Image;
    picture?: Image | string;
}

interface PageResult<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
}

interface DownloadResult {
    queued: number;
    deduped: number;
    skipped: number;
    failed: number;
}

const PAGE_SIZE = 50;

const coverOf = (item: FavoriteItem): string => {
    const image = item.image ?? item.album?.image;
    if (image) return image.small || image.thumbnail || image.medium || image.large || '';
    return typeof item.picture === 'string' ? item.picture : item.picture?.medium || item.picture?.small || '';
};

const formatDuration = (seconds?: number) =>
    seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';

export const FavoritesView: React.FC = () => {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const { navigate } = useNavigation();
    const { addToQueue } = useQueueActions();
    const loadFavoriteIds = useFavoritesStore((state) => state.load);

    const [tab, setTab] = useState<FavoriteTab>('albums');
    const [items, setItems] = useState<FavoriteItem[]>([]);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [confirmDownload, setConfirmDownload] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [playlistTarget, setPlaylistTarget] = useState<{ trackIds?: string[]; albumId?: string; label: string } | null>(null);

    const beginRequest = useLatestRequest();

    const loadPage = useCallback(
        async (type: FavoriteTab, offset: number) => {
            // A tab switch or refresh supersedes a slower earlier request.
            const isLatest = beginRequest();
            setLoading(true);
            setError('');
            try {
                const page = await apiJson<PageResult<FavoriteItem>>(
                    `/api/favorites?type=${type}&limit=${PAGE_SIZE}&offset=${offset}`
                );
                if (!isLatest()) return;
                setItems((prev) => appendPage(offset === 0 ? [] : prev, page.items));
                setTotal(page.total);
                setHasMore(page.has_more);
            } catch (err) {
                if (!isLatest()) return;
                setError(err instanceof Error ? err.message : String(err));
                if (offset === 0) setItems([]);
            } finally {
                if (isLatest()) setLoading(false);
            }
        },
        [beginRequest]
    );

    useEffect(() => {
        void loadFavoriteIds(true);
    }, [loadFavoriteIds]);

    useEffect(() => {
        setItems([]);
        setTotal(0);
        setHasMore(false);
        void loadPage(tab, 0);
    }, [tab, loadPage]);

    // A heart click on this page removes the item from Qobuz; drop it from the list too.
    const favoriteIds = useFavoritesStore((state) => state[tab]);
    const loadedIds = useFavoritesStore((state) => state.loaded);
    const visible = loadedIds ? items.filter((item) => favoriteIds.has(String(item.id))) : items;

    const handleDownloadAll = async () => {
        setConfirmDownload(false);
        setDownloading(true);
        try {
            const result = await apiJson<DownloadResult>('/api/favorites/download', {
                method: 'POST',
                body: { type: tab === 'artists' ? 'all' : tab }
            });
            showToast(
                `${t('msg_favorites_queued')}: ${result.queued} · ${t('label_skipped')}: ${result.skipped + result.deduped}` +
                    (result.failed ? ` · ${t('label_failed')}: ${result.failed}` : ''),
                result.failed ? 'info' : 'success'
            );
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            setDownloading(false);
        }
    };

    const openItem = (item: FavoriteItem) => {
        if (tab === 'albums') navigate('album', { id: String(item.id) });
        else if (tab === 'artists') navigate('artist', { id: String(item.id) });
        else if (item.album?.id) navigate('album', { id: String(item.album.id) });
    };

    const tabs: { id: FavoriteTab; label: string }[] = [
        { id: 'albums', label: t('label_albums') },
        { id: 'tracks', label: t('label_tracks') },
        { id: 'artists', label: t('label_artists') }
    ];

    return (
        <div id="view-favorites" className="view-section active">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
                <div className="search-types" role="tablist">
                    {tabs.map((entry) => (
                        <button
                            key={entry.id}
                            role="tab"
                            aria-selected={tab === entry.id}
                            className={`type-btn ${tab === entry.id ? 'active' : ''}`}
                            onClick={() => setTab(entry.id)}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                        {total} {tabs.find((entry) => entry.id === tab)?.label}
                    </span>
                    <button className="btn secondary" onClick={() => loadPage(tab, 0)} title={t('action_refresh')} aria-label={t('action_refresh')}>
                        <Icons.Refresh width={14} height={14} />
                    </button>
                    {tab !== 'artists' && (
                        <button
                            className="btn primary"
                            disabled={downloading || total === 0}
                            onClick={() => setConfirmDownload(true)}
                            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                        >
                            <Icons.Download width={14} height={14} /> {t('action_download_all_missing')}
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Warning width={48} height={48} /></div>
                    <h3>{t('msg_favorites_failed')}</h3>
                    <p>{error}</p>
                </div>
            )}

            {!error && !loading && visible.length === 0 && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Heart width={48} height={48} /></div>
                    <h3>{t('msg_no_favorites')}</h3>
                    <p>{t('msg_no_favorites_hint')}</p>
                </div>
            )}

            <div className="track-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {visible.map((item) => {
                    const id = String(item.id);
                    const title = item.title || item.name || 'Unknown';
                    const artistName = item.artist?.name || item.performer?.name || '';
                    const cover = coverOf(item);
                    const subtitle =
                        tab === 'tracks' ? [artistName, item.album?.title].filter(Boolean).join(' • ') : artistName;
                    return (
                        <div
                            key={id}
                            className="track-item"
                            onClick={() => openItem(item)}
                            style={{ cursor: 'pointer', padding: '10px 16px', borderRadius: 8 }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 0 }}>
                                {cover ? (
                                    <img src={cover} alt="" loading="lazy" style={{ width: 44, height: 44, borderRadius: tab === 'artists' ? '50%' : 4, objectFit: 'cover', flexShrink: 0 }} />
                                ) : (
                                    <div style={{ width: 44, height: 44, borderRadius: 4, background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <Icons.Library width={20} height={20} style={{ opacity: 0.5 }} />
                                    </div>
                                )}
                                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
                                    {subtitle && (
                                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>
                                    )}
                                </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                {tab !== 'artists' && item.hires && (
                                    <div className="hires-badge hires" style={{ position: 'static', margin: 0, fontSize: 10, padding: '2px 6px' }}>HI-RES</div>
                                )}
                                {tab === 'tracks' && (
                                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatDuration(item.duration)}</span>
                                )}
                                <div className="track-actions">
                                    {tab !== 'artists' && (
                                        <button
                                            className="btn-track-dl"
                                            title={t('action_download')}
                                            aria-label={t('action_download')}
                                            onClick={(e) => { e.stopPropagation(); void addToQueue(tab === 'albums' ? 'album' : 'track', id); }}
                                        >
                                            <Icons.Download width={14} height={14} />
                                        </button>
                                    )}
                                    {tab === 'tracks' && (
                                        <button
                                            className="btn-track-dl"
                                            title={t('action_play')}
                                            aria-label={t('action_play')}
                                            onClick={(e) => { e.stopPropagation(); playTrack(id, title, artistName, cover, item.album?.id ? String(item.album.id) : undefined, visible); }}
                                        >
                                            <Icons.Play width={14} height={14} />
                                        </button>
                                    )}
                                    {tab !== 'artists' && (
                                        <button
                                            className="btn-track-dl"
                                            title={t('title_add_to_playlist')}
                                            aria-label={t('title_add_to_playlist')}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setPlaylistTarget(
                                                    tab === 'albums' ? { albumId: id, label: title } : { trackIds: [id], label: title }
                                                );
                                            }}
                                        >
                                            <Icons.ListPlus width={14} height={14} />
                                        </button>
                                    )}
                                    <FavoriteButton kind={tab === 'albums' ? 'album' : tab === 'tracks' ? 'track' : 'artist'} id={id} />
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {hasMore && !error && (
                <div className="pagination">
                    <button disabled={loading} onClick={() => loadPage(tab, items.length)}>
                        {loading ? t('msg_loading') : t('action_load_more')}
                    </button>
                </div>
            )}

            <ConfirmModal
                isOpen={confirmDownload}
                title={t('action_download_all_missing')}
                message={t('msg_confirm_download_favorites').replace('{count}', String(total))}
                onConfirm={handleDownloadAll}
                onCancel={() => setConfirmDownload(false)}
            />

            <AddToPlaylistModal
                isOpen={playlistTarget !== null}
                onClose={() => setPlaylistTarget(null)}
                {...(playlistTarget?.trackIds ? { trackIds: playlistTarget.trackIds } : {})}
                {...(playlistTarget?.albumId ? { albumId: playlistTarget.albumId } : {})}
                {...(playlistTarget ? { label: playlistTarget.label } : {})}
            />
        </div>
    );
};

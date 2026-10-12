import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useQueueActions } from '../hooks/useQueueActions';
import { useLatestRequest } from '../hooks/useLatestRequest';
import { appendPage } from '../utils/lists';
import { activationProps } from '../utils/a11y';
import { FavoriteButton } from './FavoriteButton';
import { ConfirmModal } from './Modals';
import { Icons } from './Icons';
import {
    albumArtist,
    albumCover,
    albumTitle,
    errorMessage,
    formatDuration,
    isHiRes,
    type PageResult,
    type QobuzAlbumItem,
    type QobuzTrackItem
} from '../utils/qobuzItems';

type PurchaseTab = 'albums' | 'tracks';
type PurchaseItem = QobuzAlbumItem & QobuzTrackItem;

const PAGE_SIZE = 50;
interface DownloadResult {
    queued: number;
    deduped: number;
    skipped: number;
    failed: number;
}

export const PurchasesView: React.FC = () => {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const { navigate } = useNavigation();
    const { addToQueue } = useQueueActions();

    const [tab, setTab] = useState<PurchaseTab>('albums');
    const [items, setItems] = useState<PurchaseItem[]>([]);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [confirmAll, setConfirmAll] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

    const beginRequest = useLatestRequest();

    const loadPage = useCallback(async (type: PurchaseTab, offset: number) => {
        // A tab switch or refresh supersedes a slower earlier request.
        const isLatest = beginRequest();
        setLoading(true);
        setError('');
        try {
            const page = await apiJson<PageResult<PurchaseItem>>(
                `/api/purchases?type=${type}&limit=${PAGE_SIZE}&offset=${offset}`
            );
            if (!isLatest()) return;
            setItems((prev) => appendPage(offset === 0 ? [] : prev, page.items));
            setTotal(page.total ?? offset + page.items.length);
            setHasMore(page.has_more);
        } catch (err) {
            if (!isLatest()) return;
            setError(errorMessage(err));
            if (offset === 0) setItems([]);
        } finally {
            if (isLatest()) setLoading(false);
        }
    }, [beginRequest]);

    useEffect(() => {
        setItems([]);
        setTotal(0);
        setHasMore(false);
        void loadPage(tab, 0);
    }, [tab, loadPage]);

    /**
     * Queues every purchase of the current tab on the server, which skips
     * tracks that are already in the library.
     */
    const downloadAll = async () => {
        setConfirmAll(false);
        setProgress({ done: 0, total: total });
        try {
            const result = await apiJson<DownloadResult>('/api/purchases/download', {
                method: 'POST',
                body: { type: tab }
            });
            const skipped = result.skipped + result.deduped;
            showToast(
                `${t('msg_purchases_queued')}: ${result.queued} · ${t('label_skipped')}: ${skipped}` +
                    (result.failed ? ` · ${t('label_failed')}: ${result.failed}` : ''),
                result.failed ? 'info' : 'success'
            );
        } catch (err) {
            showToast(errorMessage(err), 'error');
        } finally {
            setProgress(null);
        }
    };

    const openItem = (item: PurchaseItem) => {
        if (tab === 'albums') navigate('album', { id: String(item.id) });
        else if (item.album?.id) navigate('album', { id: String(item.album.id) });
    };

    const tabs: { id: PurchaseTab; label: string }[] = [
        { id: 'albums', label: t('label_albums') },
        { id: 'tracks', label: t('label_tracks') }
    ];
    const busy = progress !== null;

    return (
        <div id="view-purchases" className="view-section active">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
                <div className="search-types" role="tablist">
                    {tabs.map((entry) => (
                        <button
                            key={entry.id}
                            role="tab"
                            aria-selected={tab === entry.id}
                            className={`type-btn ${tab === entry.id ? 'active' : ''}`}
                            onClick={() => setTab(entry.id)}
                            disabled={busy}
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
                    <button
                        className="btn primary"
                        disabled={busy || total === 0}
                        onClick={() => setConfirmAll(true)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                        <Icons.Download width={14} height={14} />
                        {progress ? t('msg_queuing') : t('action_download_all')}
                    </button>
                </div>
            </div>

            {error && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Warning width={48} height={48} /></div>
                    <h3>{t('msg_purchases_failed')}</h3>
                    <p>{error}</p>
                </div>
            )}

            {!error && !loading && items.length === 0 && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Purchases width={48} height={48} /></div>
                    <h3>{t('msg_no_purchases')}</h3>
                </div>
            )}

            <div className="track-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {items.map((item) => {
                    const id = String(item.id);
                    const isAlbum = tab === 'albums';
                    const title = albumTitle(item);
                    const artist = isAlbum ? albumArtist(item) : item.performer?.name || albumArtist(item.album ?? { id: '' });
                    const cover = albumCover(isAlbum ? item : item.album);
                    const subtitle = isAlbum ? artist : [artist, item.album?.title].filter(Boolean).join(' • ');
                    const openable = isAlbum || Boolean(item.album?.id);
                    return (
                        <div
                            key={id}
                            className="track-item"
                            {...(openable ? activationProps(() => openItem(item), title) : {})}
                            style={{ cursor: openable ? 'pointer' : 'default', padding: '10px 16px', borderRadius: 8 }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 0 }}>
                                {cover ? (
                                    <img src={cover} alt="" loading="lazy" style={{ width: 44, height: 44, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
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
                                {isHiRes(item) && (
                                    <div className="hires-badge hires" style={{ position: 'static', margin: 0, fontSize: 10, padding: '2px 6px' }}>HI-RES</div>
                                )}
                                {!isAlbum && (
                                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatDuration(item.duration)}</span>
                                )}
                                <div className="track-actions">
                                    <button
                                        className="btn-track-dl"
                                        title={t('action_download')}
                                        aria-label={t('action_download')}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void addToQueue(isAlbum ? 'album' : 'track', id);
                                        }}
                                    >
                                        <Icons.Download width={14} height={14} />
                                    </button>
                                    <FavoriteButton kind={isAlbum ? 'album' : 'track'} id={id} />
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
                isOpen={confirmAll}
                title={t('action_download_all')}
                message={t('msg_confirm_download_purchases').replace('{count}', String(total))}
                onConfirm={downloadAll}
                onCancel={() => setConfirmAll(false)}
            />
        </div>
    );
};

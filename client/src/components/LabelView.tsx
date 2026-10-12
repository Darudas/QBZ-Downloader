import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useLatestRequest } from '../hooks/useLatestRequest';
import { appendPage } from '../utils/lists';
import { AlbumGrid } from './AlbumGrid';
import { Icons } from './Icons';
import { errorMessage, type PageResult, type QobuzAlbumItem, type QobuzImage } from '../utils/qobuzItems';

interface LabelInfo {
    id: string | number;
    name?: string;
    description?: string | null;
    albums_count?: number;
    image?: QobuzImage | null;
}

interface LabelPage {
    label: LabelInfo;
    albums: PageResult<QobuzAlbumItem>;
}

const PAGE_SIZE = 40;

/** Qobuz label descriptions can contain markup; show them as plain text. */
const plainText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export const LabelView: React.FC = () => {
    const { t } = useLanguage();
    const { navData, goBack } = useNavigation();
    const labelId = navData?.id ? String(navData.id) : '';

    const [label, setLabel] = useState<LabelInfo | null>(null);
    const [albums, setAlbums] = useState<QobuzAlbumItem[]>([]);
    const [total, setTotal] = useState<number | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [showFull, setShowFull] = useState(false);

    const beginRequest = useLatestRequest();

    const load = useCallback(
        async (offset: number) => {
            // Opening another label supersedes a slower request for the previous one.
            const isLatest = beginRequest();
            if (!labelId) return;
            setLoading(true);
            setError('');
            try {
                const page = await apiJson<LabelPage>(`/api/label/${encodeURIComponent(labelId)}?limit=${PAGE_SIZE}&offset=${offset}`);
                if (!isLatest()) return;
                setLabel(page.label);
                setAlbums((prev) => appendPage(offset === 0 ? [] : prev, page.albums.items));
                setTotal(page.albums.total ?? page.label.albums_count ?? null);
                setHasMore(page.albums.has_more);
            } catch (err) {
                if (!isLatest()) return;
                setError(errorMessage(err));
            } finally {
                if (isLatest()) setLoading(false);
            }
        },
        [labelId, beginRequest]
    );

    useEffect(() => {
        setLabel(null);
        setAlbums([]);
        setShowFull(false);
        void load(0);
    }, [load]);

    const backButton = (
        <button className="btn secondary" onClick={() => goBack('discover')} style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icons.ArrowLeft width={16} height={16} /> {t('action_back')}
        </button>
    );

    if (!labelId) {
        return (
            <div id="view-label" className="view-section active">
                {backButton}
                <div className="empty-state"><h3>{t('msg_no_label')}</h3></div>
            </div>
        );
    }

    if (error && !label) {
        return (
            <div id="view-label" className="view-section active">
                {backButton}
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Warning width={48} height={48} /></div>
                    <h3>{t('msg_label_failed')}</h3>
                    <p>{error}</p>
                </div>
            </div>
        );
    }

    if (!label) {
        return (
            <div id="view-label" className="view-section active">
                {backButton}
                <div style={{ color: 'var(--text-secondary)' }}>{t('msg_loading')}</div>
            </div>
        );
    }

    const description = label.description ? plainText(label.description) : '';
    const longDescription = description.length > 400;
    const cover = label.image?.large || label.image?.medium || label.image?.small || '';

    return (
        <div id="view-label" className="view-section active">
            {backButton}
            <div className="album-header">
                {cover ? (
                    <img src={cover} className="album-header-cover" alt="" />
                ) : (
                    <div className="album-header-cover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-hover)' }}>
                        <Icons.Tag width={64} height={64} style={{ opacity: 0.4 }} />
                    </div>
                )}
                <div className="album-header-info">
                    <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)' }}>{t('label_label')}</div>
                    <div className="album-header-title">{label.name}</div>
                    <div className="album-header-meta">
                        {total ?? albums.length} {t('label_albums')}
                        {description && (
                            <>
                                <br />
                                {longDescription && !showFull ? `${description.slice(0, 400)}…` : description}
                                {longDescription && (
                                    <button
                                        onClick={() => setShowFull((value) => !value)}
                                        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600, marginLeft: 6 }}
                                    >
                                        {showFull ? t('action_read_less') : t('action_read_more')}
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {albums.length === 0 && !loading && <div className="empty-state"><p>{t('msg_no_label_albums')}</p></div>}

            <AlbumGrid albums={albums} />

            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

            {hasMore && (
                <div className="pagination">
                    <button disabled={loading} onClick={() => load(albums.length)}>
                        {loading ? t('msg_loading') : t('action_load_more')}
                    </button>
                </div>
            )}
        </div>
    );
};

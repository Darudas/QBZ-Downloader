import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useLatestRequest } from '../hooks/useLatestRequest';
import { appendPage } from '../utils/lists';
import { AlbumGrid } from './AlbumGrid';
import { FavoriteButton } from './FavoriteButton';
import { Icons } from './Icons';
import {
    artistName,
    artistPicture,
    errorMessage,
    releaseYear,
    type PageResult,
    type QobuzAlbumItem,
    type QobuzArtistItem
} from '../utils/qobuzItems';

const sectionTitle: React.CSSProperties = {
    fontSize: 24,
    margin: 0
};
const sectionHeader: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 20,
    borderBottom: '1px solid var(--border)',
    paddingBottom: 10
};

/* ------------------------------------------------------------------ */
/* Similar artists                                                      */
/* ------------------------------------------------------------------ */

interface SimilarArtistsProps {
    artistId: string;
    /** Shown when the dedicated endpoint fails (the artist payload may carry its own list). */
    fallback?: QobuzArtistItem[];
}

/** Horizontal row of similar artists from `/api/artist/:id/similar`. */
export const SimilarArtistsRow: React.FC<SimilarArtistsProps> = ({ artistId, fallback }) => {
    const { t } = useLanguage();
    const { navigate } = useNavigation();
    const [artists, setArtists] = useState<QobuzArtistItem[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        setArtists(null);
        apiJson<PageResult<QobuzArtistItem>>(`/api/artist/${encodeURIComponent(artistId)}/similar?limit=20`)
            .then((page) => {
                if (!cancelled) setArtists(page.items ?? []);
            })
            .catch(() => {
                if (!cancelled) setArtists([]);
            });
        return () => {
            cancelled = true;
        };
    }, [artistId]);

    const shown = artists && artists.length > 0 ? artists : fallback ?? [];
    if (shown.length === 0) return null;

    return (
        <section style={{ marginBottom: 40 }} aria-label={t('title_similar_artists')}>
            <div style={sectionHeader}>
                <h2 style={sectionTitle}>{t('title_similar_artists')}</h2>
            </div>
            <div style={{ display: 'flex', gap: 20, overflowX: 'auto', paddingBottom: 8 }}>
                {shown.map((artist) => {
                    const id = String(artist.id);
                    const name = artistName(artist);
                    const picture = artistPicture(artist);
                    return (
                        <div
                            key={id}
                            role="button"
                            tabIndex={0}
                            onClick={() => navigate('artist', { id })}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') navigate('artist', { id });
                            }}
                            style={{ width: 120, flexShrink: 0, cursor: 'pointer', textAlign: 'center' }}
                        >
                            {picture ? (
                                <img src={picture} alt="" loading="lazy" style={{ width: 120, height: 120, borderRadius: '50%', objectFit: 'cover' }} />
                            ) : (
                                <div style={{ width: 120, height: 120, borderRadius: '50%', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Icons.Mic width={36} height={36} style={{ opacity: 0.3 }} />
                                </div>
                            )}
                            <div style={{ marginTop: 8, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={name}>
                                {name}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
                                <FavoriteButton kind="artist" id={id} size={12} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
};

/* ------------------------------------------------------------------ */
/* Discography                                                          */
/* ------------------------------------------------------------------ */

/** Mirrors QOBUZ_ARTIST_RELEASE_TYPES in src/constants.ts. */
const RELEASE_TYPES = ['all', 'album', 'live', 'compilation', 'epSingle', 'other', 'download', 'composer'] as const;
type ReleaseType = (typeof RELEASE_TYPES)[number];

const RELEASES_PAGE = 50;

const releaseTypeKey = (type: string) => `release_type_${type.replace(/([A-Z])/g, '_$1').toLowerCase()}`;

/** Complete discography from `/api/artist/:id/releases` with a release type filter. */
export const ArtistDiscography: React.FC<{ artistId: string }> = ({ artistId }) => {
    const { t } = useLanguage();
    const [releaseType, setReleaseType] = useState<ReleaseType>('all');
    const [releases, setReleases] = useState<QobuzAlbumItem[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const beginRequest = useLatestRequest();

    const load = useCallback(
        async (offset: number) => {
            // A new release type (or artist) supersedes a slower earlier request.
            const isLatest = beginRequest();
            setLoading(true);
            setError('');
            try {
                const page = await apiJson<PageResult<QobuzAlbumItem>>(
                    `/api/artist/${encodeURIComponent(artistId)}/releases?release_type=${releaseType}` +
                        `&sort=release_date&order=desc&limit=${RELEASES_PAGE}&offset=${offset}`
                );
                if (!isLatest()) return;
                setReleases((prev) => appendPage(offset === 0 ? [] : prev, page.items ?? []));
                setHasMore(page.has_more);
            } catch (err) {
                if (!isLatest()) return;
                setError(errorMessage(err));
                if (offset === 0) setReleases([]);
            } finally {
                if (isLatest()) setLoading(false);
            }
        },
        [artistId, releaseType, beginRequest]
    );

    useEffect(() => {
        void load(0);
    }, [load]);

    /** Qobuz may return release types we have no label for; show those as they come. */
    const typeLabel = (type: string) => {
        const key = releaseTypeKey(type);
        const label = t(key);
        return label === key ? type : label;
    };
    const subtitle = (album: QobuzAlbumItem) =>
        [releaseYear(album), album.release_type ? typeLabel(album.release_type) : ''].filter(Boolean).join(' • ');

    return (
        <section style={{ marginBottom: 40 }} aria-label={t('title_discography')}>
            <div style={sectionHeader}>
                <h2 style={sectionTitle}>{t('title_discography')}</h2>
                <div className="form-group" style={{ margin: 0, minWidth: 180 }}>
                    <select
                        value={releaseType}
                        aria-label={t('label_release_type')}
                        onChange={(e) => setReleaseType(e.target.value as ReleaseType)}
                    >
                        {RELEASE_TYPES.map((type) => (
                            <option key={type} value={type}>{t(releaseTypeKey(type))}</option>
                        ))}
                    </select>
                </div>
            </div>

            {error && <p style={{ color: 'var(--text-secondary)' }}>{t('msg_discography_failed')}: {error}</p>}
            {!error && loading && releases.length === 0 && <div style={{ color: 'var(--text-secondary)' }}>{t('msg_loading')}</div>}
            {!error && !loading && releases.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>{t('msg_no_releases')}</p>}

            <AlbumGrid albums={releases} subtitle={subtitle} />

            {hasMore && !error && (
                <div className="pagination">
                    <button disabled={loading} onClick={() => load(releases.length)}>
                        {loading ? t('msg_loading') : t('action_load_more')}
                    </button>
                </div>
            )}
        </section>
    );
};

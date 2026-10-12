import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../utils/api';
import { useToast } from '../contexts/ToastContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useQueueActions } from '../hooks/useQueueActions';
import { AlbumGrid } from './AlbumGrid';
import { Icons } from './Icons';
import {
    errorMessage,
    playlistCover,
    type PageResult,
    type QobuzAlbumItem,
    type QobuzPlaylistItem
} from '../utils/qobuzItems';

/** Mirrors QOBUZ_FEATURED_ALBUM_TYPES in src/constants.ts. */
const FEATURED_ALBUM_TYPES = [
    'new-releases',
    'new-releases-full',
    'recent-releases',
    'press-awards',
    'editor-picks',
    'most-streamed',
    'best-sellers',
    'most-featured',
    'ideal-discography',
    'qobuzissims',
    'harmonia-mundi',
    'universal-classic',
    'universal-jazz',
    'universal-jeunesse',
    'universal-chanson'
] as const;
type FeaturedAlbumType = (typeof FEATURED_ALBUM_TYPES)[number];

const FEATURED_PLAYLIST_TYPES = ['editor-picks', 'last-created'] as const;
type FeaturedPlaylistType = (typeof FEATURED_PLAYLIST_TYPES)[number];

interface Genre {
    id: string | number;
    name: string;
}

interface GenreListResponse {
    genres?: { items?: Genre[] };
}

const ALBUM_PAGE = 24;
const PLAYLIST_PAGE = 12;

/** `discover_album_new_releases`, `discover_playlist_editor_picks`, ... */
const typeKey = (scope: 'album' | 'playlist', type: string) => `discover_${scope}_${type.replace(/-/g, '_')}`;

export const DiscoverView: React.FC = () => {
    const { t } = useLanguage();
    const { showToast } = useToast();
    const { addToQueue } = useQueueActions();

    const [albumType, setAlbumType] = useState<FeaturedAlbumType>('new-releases');
    const [genreId, setGenreId] = useState('');
    const [genres, setGenres] = useState<Genre[]>([]);

    const [albums, setAlbums] = useState<QobuzAlbumItem[]>([]);
    const [albumsMore, setAlbumsMore] = useState(false);
    const [albumsLoading, setAlbumsLoading] = useState(false);
    const [albumsError, setAlbumsError] = useState('');

    const [playlistType, setPlaylistType] = useState<FeaturedPlaylistType>('editor-picks');
    const [playlists, setPlaylists] = useState<QobuzPlaylistItem[]>([]);
    const [playlistsMore, setPlaylistsMore] = useState(false);
    const [playlistsLoading, setPlaylistsLoading] = useState(false);
    const [playlistsError, setPlaylistsError] = useState('');
    const [followed, setFollowed] = useState<Set<string>>(new Set());
    const [following, setFollowing] = useState<string | null>(null);

    useEffect(() => {
        // The genre filter is optional: without a Qobuz login the list simply stays empty.
        apiJson<GenreListResponse>('/api/genres')
            .then((data) => setGenres(data?.genres?.items ?? []))
            .catch(() => setGenres([]));
    }, []);

    const genreQuery = genreId ? `&genre_id=${encodeURIComponent(genreId)}` : '';

    const loadAlbums = useCallback(
        async (offset: number) => {
            setAlbumsLoading(true);
            setAlbumsError('');
            try {
                const page = await apiJson<PageResult<QobuzAlbumItem>>(
                    `/api/discover/albums?type=${albumType}${genreQuery}&limit=${ALBUM_PAGE}&offset=${offset}`
                );
                setAlbums((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
                setAlbumsMore(page.has_more);
            } catch (err) {
                setAlbumsError(errorMessage(err));
                if (offset === 0) setAlbums([]);
            } finally {
                setAlbumsLoading(false);
            }
        },
        [albumType, genreQuery]
    );

    const loadPlaylists = useCallback(
        async (offset: number) => {
            setPlaylistsLoading(true);
            setPlaylistsError('');
            try {
                const page = await apiJson<PageResult<QobuzPlaylistItem>>(
                    `/api/discover/playlists?type=${playlistType}${genreQuery}&limit=${PLAYLIST_PAGE}&offset=${offset}`
                );
                setPlaylists((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
                setPlaylistsMore(page.has_more);
            } catch (err) {
                setPlaylistsError(errorMessage(err));
                if (offset === 0) setPlaylists([]);
            } finally {
                setPlaylistsLoading(false);
            }
        },
        [playlistType, genreQuery]
    );

    useEffect(() => {
        void loadAlbums(0);
    }, [loadAlbums]);

    useEffect(() => {
        void loadPlaylists(0);
    }, [loadPlaylists]);

    const follow = async (playlist: QobuzPlaylistItem) => {
        const id = String(playlist.id);
        setFollowing(id);
        try {
            await apiJson(`/api/me/playlists/${id}/follow`, { method: 'POST' });
            setFollowed((prev) => new Set(prev).add(id));
            showToast(`${t('msg_playlist_followed')}: ${playlist.name ?? id}`, 'success');
        } catch (err) {
            showToast(errorMessage(err), 'error');
        } finally {
            setFollowing(null);
        }
    };

    const sectionHeader: React.CSSProperties = {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        marginBottom: 16
    };
    const selectGroup: React.CSSProperties = { margin: 0, minWidth: 180 };

    return (
        <div id="view-discover" className="view-section active">
            <div style={sectionHeader}>
                <h3 style={{ margin: 0 }}>{t('title_featured_albums')}</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="form-group" style={selectGroup}>
                        <select
                            value={albumType}
                            aria-label={t('label_featured_type')}
                            onChange={(e) => setAlbumType(e.target.value as FeaturedAlbumType)}
                        >
                            {FEATURED_ALBUM_TYPES.map((type) => (
                                <option key={type} value={type}>{t(typeKey('album', type))}</option>
                            ))}
                        </select>
                    </div>
                    {genres.length > 0 && (
                        <div className="form-group" style={selectGroup}>
                            <select value={genreId} aria-label={t('label_genre')} onChange={(e) => setGenreId(e.target.value)}>
                                <option value="">{t('label_all_genres')}</option>
                                {genres.map((genre) => (
                                    <option key={String(genre.id)} value={String(genre.id)}>{genre.name}</option>
                                ))}
                            </select>
                        </div>
                    )}
                    <button className="btn secondary" onClick={() => loadAlbums(0)} title={t('action_refresh')} aria-label={t('action_refresh')}>
                        <Icons.Refresh width={14} height={14} />
                    </button>
                </div>
            </div>

            {albumsError && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Warning width={48} height={48} /></div>
                    <h3>{t('msg_discover_failed')}</h3>
                    <p>{albumsError}</p>
                </div>
            )}
            {!albumsError && albumsLoading && albums.length === 0 && (
                <div style={{ color: 'var(--text-secondary)' }}>{t('msg_loading')}</div>
            )}
            {!albumsError && !albumsLoading && albums.length === 0 && (
                <div className="empty-state"><p>{t('msg_no_featured')}</p></div>
            )}

            <AlbumGrid albums={albums} />

            {albumsMore && !albumsError && (
                <div className="pagination">
                    <button disabled={albumsLoading} onClick={() => loadAlbums(albums.length)}>
                        {albumsLoading ? t('msg_loading') : t('action_load_more')}
                    </button>
                </div>
            )}

            <div style={{ ...sectionHeader, marginTop: 36 }}>
                <h3 style={{ margin: 0 }}>{t('title_featured_playlists')}</h3>
                <div className="search-types" role="tablist">
                    {FEATURED_PLAYLIST_TYPES.map((type) => (
                        <button
                            key={type}
                            role="tab"
                            aria-selected={playlistType === type}
                            className={`type-btn ${playlistType === type ? 'active' : ''}`}
                            onClick={() => setPlaylistType(type)}
                        >
                            {t(typeKey('playlist', type))}
                        </button>
                    ))}
                </div>
            </div>

            {playlistsError && (
                <div className="empty-state">
                    <div className="empty-icon"><Icons.Warning width={48} height={48} /></div>
                    <h3>{t('msg_discover_failed')}</h3>
                    <p>{playlistsError}</p>
                </div>
            )}
            {!playlistsError && !playlistsLoading && playlists.length === 0 && (
                <div className="empty-state"><p>{t('msg_no_featured')}</p></div>
            )}

            <div className="results-grid">
                {playlists.map((playlist) => {
                    const id = String(playlist.id);
                    const cover = playlistCover(playlist);
                    const isFollowed = followed.has(id);
                    return (
                        <div key={id} className="grid-item" style={{ cursor: 'default' }}>
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
                                    {playlist.owner?.name ? ` • ${playlist.owner.name}` : ''}
                                </div>
                            </div>
                            <div className="grid-actions">
                                <button
                                    className="grid-action-btn"
                                    title={t('action_download')}
                                    aria-label={t('action_download')}
                                    onClick={() => void addToQueue('playlist', id)}
                                >
                                    <Icons.Download width={14} height={14} />
                                </button>
                                <button
                                    className="grid-action-btn"
                                    title={isFollowed ? t('label_following') : t('action_follow')}
                                    aria-label={isFollowed ? t('label_following') : t('action_follow')}
                                    disabled={isFollowed || following === id}
                                    style={isFollowed ? { color: 'var(--accent)' } : undefined}
                                    onClick={() => void follow(playlist)}
                                >
                                    {isFollowed ? <Icons.Check width={14} height={14} /> : <Icons.Plus width={14} height={14} />}
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {playlistsMore && !playlistsError && (
                <div className="pagination">
                    <button disabled={playlistsLoading} onClick={() => loadPlaylists(playlists.length)}>
                        {playlistsLoading ? t('msg_loading') : t('action_load_more')}
                    </button>
                </div>
            )}
        </div>
    );
};

import React from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useQueueActions } from '../hooks/useQueueActions';
import { FavoriteButton } from './FavoriteButton';
import { Icons } from './Icons';
import { albumArtist, albumCover, albumTitle, isHiRes, releaseYear, type QobuzAlbumItem } from '../utils/qobuzItems';

interface AlbumGridProps {
    albums: QobuzAlbumItem[];
    /** Second line under the title; defaults to the album artist. */
    subtitle?: (album: QobuzAlbumItem) => string;
    /** Extra buttons rendered before the heart. */
    extraActions?: (album: QobuzAlbumItem) => React.ReactNode;
}

/** Album cards in the search-results grid style: open on click, download and heart actions. */
export const AlbumGrid: React.FC<AlbumGridProps> = ({ albums, subtitle, extraActions }) => {
    const { t } = useLanguage();
    const { navigate } = useNavigation();
    const { addToQueue } = useQueueActions();

    return (
        <div className="results-grid">
            {albums.map((album) => {
                const id = String(album.id);
                const title = albumTitle(album);
                const cover = albumCover(album, 'large');
                const hires = isHiRes(album);
                const secondLine = subtitle
                    ? subtitle(album)
                    : [albumArtist(album), releaseYear(album)].filter(Boolean).join(' • ');
                return (
                    <div key={id} className="grid-item" onClick={() => navigate('album', { id })}>
                        <div className="grid-cover-container">
                            {cover ? (
                                <img src={cover} className="grid-cover" alt="" loading="lazy" />
                            ) : (
                                <div className="grid-cover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Icons.Library width={48} height={48} style={{ opacity: 0.2 }} />
                                </div>
                            )}
                            <div className="grid-cover-overlay">
                                <span style={{ color: 'white', fontWeight: 'bold' }}>{t('action_view')}</span>
                            </div>
                            <div className={`grid-badge-quality ${hires ? 'hires' : ''}`}>{hires ? 'HI-RES' : 'CD'}</div>
                        </div>
                        <div className="grid-info">
                            <div className="grid-title" title={title}>{title}</div>
                            <div className="grid-artist" title={secondLine}>{secondLine}</div>
                        </div>
                        <div className="grid-actions">
                            <button
                                className="grid-action-btn"
                                title={t('action_download')}
                                aria-label={t('action_download')}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void addToQueue('album', id);
                                }}
                            >
                                <Icons.Download width={14} height={14} />
                            </button>
                            {extraActions?.(album)}
                            <FavoriteButton kind="album" id={id} className="grid-action-btn" />
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

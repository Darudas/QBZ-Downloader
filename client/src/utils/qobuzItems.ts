/**
 * Helpers for the raw Qobuz objects the library routes return
 * (`/api/discover/*`, `/api/label/:id`, `/api/purchases`, `/api/artist/:id/releases`).
 * Field names differ a little between endpoints, so every accessor is defensive.
 */

export interface PageResult<T> {
    items: T[];
    /** `null` when the server cannot know the total (artist releases). */
    total: number | null;
    offset: number;
    limit: number;
    has_more: boolean;
}

export interface QobuzImage {
    thumbnail?: string;
    small?: string;
    medium?: string;
    large?: string;
    back?: string | null;
}

/** `artist.name` is a string on albums and `{ display }` on artist release lists. */
type NameField = string | { display?: string } | undefined;

export interface QobuzAlbumItem {
    id: string | number;
    title?: string;
    version?: string | null;
    hires?: boolean;
    hires_streamable?: boolean;
    maximum_bit_depth?: number;
    maximum_sampling_rate?: number;
    audio_info?: { maximum_bit_depth?: number; maximum_sampling_rate?: number };
    release_date_original?: string;
    released_at?: number;
    dates?: { original?: string };
    release_type?: string;
    tracks_count?: number;
    artist?: { id?: string | number; name?: NameField };
    label?: { id?: string | number; name?: string };
    genre?: { id?: string | number; name?: string };
    image?: QobuzImage;
}

export interface QobuzTrackItem {
    id: string | number;
    title?: string;
    version?: string | null;
    duration?: number;
    hires?: boolean;
    performer?: { id?: string | number; name?: string };
    album?: QobuzAlbumItem;
}

export interface QobuzArtistItem {
    id: string | number;
    name?: NameField;
    albums_count?: number;
    image?: QobuzImage | null;
    picture?: string | null;
    images?: { portrait?: { hash?: string; format?: string } };
}

export interface QobuzPlaylistItem {
    id: string | number;
    name?: string;
    description?: string;
    tracks_count?: number;
    owner?: { id?: string | number; name?: string };
    images300?: string[];
    images150?: string[];
    image_rectangle?: string[];
    is_owner?: boolean;
}

const nameOf = (value: NameField): string =>
    typeof value === 'string' ? value : value?.display ?? '';

export const albumTitle = (album: QobuzAlbumItem): string => {
    const title = album.title || 'Unknown';
    return album.version ? `${title} (${album.version})` : title;
};

export const albumArtist = (album: QobuzAlbumItem): string => nameOf(album.artist?.name);

export const artistName = (artist: QobuzArtistItem): string => nameOf(artist.name);

export const albumCover = (album: QobuzAlbumItem | undefined, size: 'small' | 'large' = 'small'): string => {
    const image = album?.image;
    if (!image) return '';
    return size === 'large'
        ? image.large || image.medium || image.small || image.thumbnail || ''
        : image.small || image.medium || image.thumbnail || image.large || '';
};

export const artistPicture = (artist: QobuzArtistItem): string => {
    if (artist.image) return artist.image.medium || artist.image.small || artist.image.large || '';
    if (artist.picture) return artist.picture;
    const portrait = artist.images?.portrait;
    if (portrait?.hash) {
        return `https://static.qobuz.com/images/artists/covers/medium/${portrait.hash}.${portrait.format || 'jpg'}`;
    }
    return '';
};

export const playlistCover = (playlist: QobuzPlaylistItem): string =>
    playlist.images300?.[0] || playlist.image_rectangle?.[0] || playlist.images150?.[0] || '';

export const isHiRes = (album: QobuzAlbumItem): boolean =>
    Boolean(album.hires || album.hires_streamable || (album.audio_info?.maximum_bit_depth ?? 0) > 16);

export const releaseYear = (album: QobuzAlbumItem): string => {
    const date = album.release_date_original || album.dates?.original;
    if (date) return date.slice(0, 4);
    if (album.released_at) return String(new Date(album.released_at * 1000).getUTCFullYear());
    return '';
};

export const formatDuration = (seconds?: number): string =>
    seconds ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '';

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

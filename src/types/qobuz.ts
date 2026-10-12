/**
 * Qobuz API types. This file must stay type-only: the client re-exports it with
 * `export type *` (client/src/types/qobuz.ts).
 */

/** Envelope returned by every QobuzAPI method. */
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

/** A Qobuz list page. `limit` is what the server echoed (it may cap silently). */
export interface Paginated<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
}

export type SearchType = 'albums' | 'tracks' | 'artists' | 'playlists';
export type FavoriteType = 'albums' | 'tracks' | 'artists';
export type PurchaseType = 'albums' | 'tracks';
export type PlaylistFilter = 'owner' | 'subscriber' | 'owner,subscriber';

export type FeaturedAlbumType =
    | 'new-releases'
    | 'new-releases-full'
    | 'recent-releases'
    | 'press-awards'
    | 'editor-picks'
    | 'most-streamed'
    | 'best-sellers'
    | 'most-featured'
    | 'ideal-discography'
    | 'qobuzissims'
    | 'harmonia-mundi'
    | 'universal-classic'
    | 'universal-jazz'
    | 'universal-jeunesse'
    | 'universal-chanson';

export type FeaturedPlaylistType = 'editor-picks' | 'last-created';

export type ArtistReleaseType =
    | 'all'
    | 'album'
    | 'live'
    | 'compilation'
    | 'epSingle'
    | 'other'
    | 'download'
    | 'composer';
export type ArtistReleaseSort = 'release_date' | 'relevant' | 'release_date_by_priority';
export type SortOrder = 'asc' | 'desc';

export interface Artist {
    id: number | string;
    name: string;
    albums_count?: number;
    image?: { small?: string; medium?: string; large?: string };
    [key: string]: unknown;
}

export interface ArtistDetails extends Artist {
    albums?: {
        items: Album[];
        total: number;
        offset: number;
        limit: number;
    };
    tracks?: {
        items: Track[];
        total: number;
    };
    biography?: { en?: string; id?: string; [key: string]: string | undefined } | string;
    similar_artists?: { items: Artist[] };
    already_downloaded?: boolean;
}

export interface PlaylistOwner {
    id: number | string;
    name: string;
}

export interface Playlist {
    id: number | string;
    name: string;
    description?: string;
    tracks: {
        items: Track[];
        total: number;
        offset?: number;
        limit?: number;
    };
    owner?: PlaylistOwner;
    tracks_count?: number;
    is_public?: boolean;
    is_collaborative?: boolean;
    is_featured?: boolean;
    users_count?: number;
    /** Total duration in seconds. */
    duration?: number;
    images?: string[];
    images150?: string[];
    images300?: string[];
    image_rectangle?: string[];
    image_rectangle_mini?: string[];
    /** Unix timestamps (seconds). */
    created_at?: number;
    updated_at?: number;
    public_at?: number | false;
    subscribed_since?: number;
    genres?: { id?: number | string; name?: string; [key: string]: unknown }[];
}

/** A track entry inside a playlist; `playlist_track_id` identifies the entry (can exceed 2^31). */
export interface PlaylistTrack extends Track {
    playlist_track_id: number | string;
    position?: number;
}

/** A playlist as returned by list endpoints: track items are usually absent. */
export type PlaylistListItem = Omit<Playlist, 'tracks'> & { tracks?: Playlist['tracks'] };

/** One page of a playlist (playlist/get with offset/limit), entries keep `playlist_track_id`. */
export type PlaylistPage = Omit<Playlist, 'tracks'> & { tracks: Paginated<PlaylistTrack> };

export interface Album {
    id: string | number;
    title: string;
    artist: Artist;
    label?: { name: string; id?: number | string };
    genre?: { name: string; id?: number | string };
    duration: number;
    tracks_count: number;
    released_at?: number;
    description?: string;
    image?: {
        small?: string;
        thumbnail?: string;
        medium?: string;
        large?: string;
        extralarge?: string;
        mega?: string;
        [key: string]: unknown;
    };
    hires: boolean;
    hires_streamable?: boolean;
    maximum_bit_depth?: number;
    maximum_sampling_rate?: number;
    goodies?: unknown[];
    tracks?: {
        items: Track[];
        total?: number;
        offset?: number;
        limit?: number;
    };
    media_count?: number;
    genres_list?: (string | { name: string })[];
    credits?: { role?: string; name?: string }[];
    copyright?: string;
    upc?: string;
    catalog_number?: string;
    release_type?: string;
    release_date_original?: string;
    already_downloaded?: boolean;
    [key: string]: unknown;
}

export interface Track {
    id: string | number;
    title: string;
    artist?: Artist;
    performer?: {
        id?: number | string;
        name: string;
        image?: { small?: string; medium?: string; large?: string };
    };
    album?: Album;
    duration: number;
    hires: boolean;
    track_number: number;
    maximum_sampling_rate?: number;
    maximum_bit_depth?: number;
    hires_streamable?: boolean;
    media_number?: number;
    already_downloaded?: boolean;
    performers?: string;
    parental_warning?: boolean;
    streamable?: boolean;
    composer?: { name: string; id?: string | number };
    isrc?: string;
    version?: string;
    lyrics?: {
        sync?: string;
        text?: string;
        copyright?: string;
        writer?: string;
    };
    [key: string]: unknown;
}

export interface LastUpdateTimestamps {
    favorite?: number;
    favorite_album?: number;
    favorite_artist?: number;
    favorite_track?: number;
    favorite_label?: number;
    playlist?: number;
    purchase?: number;
    [key: string]: number | undefined;
}

export interface LastUpdate {
    last_update: LastUpdateTimestamps;
}

export interface UserInfo {
    id: string | number;
    email: string;
    login?: string;
    display_name?: string;
    firstname?: string | null;
    lastname?: string | null;
    avatar?: string | null;
    country?: string;
    country_code: string;
    zone?: string;
    store?: string;
    subscription?: {
        offer: string;
        periodicity?: string;
        start_date?: string;
        end_date?: string;
        period_end_date?: string;
        is_canceled?: boolean;
    } | null;
    hires_streaming: boolean;
    credential?: {
        id?: number | string;
        label?: string;
        description?: string;
        parameters?: {
            hires_streaming?: boolean;
            lossless_streaming?: boolean;
            hires_purchases_streaming?: boolean;
            mobile_streaming?: boolean;
            offline_streaming?: boolean;
            short_label?: string;
            [key: string]: unknown;
        };
    };
    last_update?: LastUpdateTimestamps;
}

export interface DownloadResultSummary {
    success: boolean;
    title?: string;
    name?: string;
    artist?: string;
    totalTracks?: number;
    completedTracks?: number;
    failedTracks?: number;
}

/** A catalog/search bucket. Qobuz normally sends total/offset/limit with every bucket. */
export interface SearchBucket<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
}

export interface SearchResults {
    query?: string;
    albums?: SearchBucket<Album>;
    tracks?: SearchBucket<Track>;
    artists?: SearchBucket<Artist>;
    playlists?: SearchBucket<PlaylistListItem>;
    [key: string]: unknown;
}

export interface LyricsResult {
    success: boolean;
    source?: string;
    syncedLyrics?: string | boolean | null;
    plainLyrics?: string | null;
    parsedLyrics?: unknown[] | null;
    syltFormat?: unknown[] | null;
    synced?: string | null;
    unsynced?: string | null;
    copyright?: string | null;
    writer?: string | null;
    error?: string;
    [key: string]: unknown;
}

export interface FileUrlData {
    url: string;
    format_id: number;
    quality_verified?: boolean;
    bit_depth?: number;
    sampling_rate?: number;
    mime_type?: string;
    duration?: number;
    sample?: boolean;
    restrictions?: unknown;
    md5_hash?: string;
}

export interface QobuzUserRef {
    id: number | string;
    login?: string;
}

export interface UserFavorites {
    user?: QobuzUserRef;
    albums?: Paginated<Album>;
    tracks?: Paginated<Track>;
    artists?: Paginated<Artist>;
}

/** favorite/getUserFavoriteIds, normalized: album ids are strings, others numbers. */
export interface FavoriteIds {
    albums: string[];
    tracks: number[];
    artists: number[];
    labels?: number[];
    articles?: unknown[];
    awards?: unknown[];
}

export interface UserPlaylists {
    user?: QobuzUserRef;
    playlists: Paginated<PlaylistListItem>;
}

export interface PurchasedAlbum extends Album {
    purchased_at?: number;
}

export interface PurchasedTrack extends Track {
    purchased_at?: number;
}

export interface Purchases {
    user?: QobuzUserRef;
    albums?: Paginated<PurchasedAlbum>;
    tracks?: Paginated<PurchasedTrack>;
}

export interface PurchaseIds {
    user?: QobuzUserRef;
    albums: { total: number; items: { id: string }[] };
    tracks: { total: number; items: { id: number | string; bought?: boolean }[] };
}

export interface Label {
    id: number | string;
    name: string;
    slug?: string;
    albums_count?: number;
    description?: string | null;
    image?: string | { small?: string; medium?: string; large?: string; [key: string]: unknown } | null;
    albums?: Paginated<Album>;
    [key: string]: unknown;
}

export interface FeaturedAlbums {
    albums: Paginated<Album>;
}

export interface FeaturedPlaylists {
    playlists: Paginated<PlaylistListItem>;
}

export interface SimilarArtists {
    artists: Paginated<Artist>;
}

/** artist/getReleasesList item: note `artist.name` is an object and there is no `total`. */
export interface ArtistRelease {
    id: string;
    title: string;
    version?: string | null;
    release_type?: string;
    tracks_count?: number;
    duration?: number;
    parental_warning?: boolean;
    dates?: { download?: string; original?: string; stream?: string };
    audio_info?: {
        maximum_bit_depth?: number;
        maximum_sampling_rate?: number;
        maximum_channel_count?: number;
    };
    rights?: {
        purchasable?: boolean;
        streamable?: boolean;
        downloadable?: boolean;
        hires_streamable?: boolean;
        hires_purchasable?: boolean;
    };
    artist?: { id: number | string; name: { display: string } | string };
    image?: { small?: string; thumbnail?: string; large?: string; [key: string]: unknown };
    label?: { id?: number | string; name?: string };
    genre?: { id?: number | string; name?: string; path?: number[] };
    tracks?: { has_more?: boolean; items: Track[] };
    [key: string]: unknown;
}

/** Generic write acknowledgement, e.g. `{"status":"success"}`. */
export interface StatusResponse {
    status?: string;
    code?: number;
    message?: string;
    [key: string]: unknown;
}

export interface ArtistReleases {
    has_more: boolean;
    items: ArtistRelease[];
}

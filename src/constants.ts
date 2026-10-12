import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type {
    ArtistReleaseSort,
    ArtistReleaseType,
    FavoriteType,
    FeaturedAlbumType,
    FeaturedPlaylistType,
    PlaylistFilter,
    PurchaseType,
    SearchType,
    SortOrder
} from './types/qobuz.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

/**
 * Regexes for Qobuz share/store URLs. Prefer `parseQobuzUrl()` from
 * `utils/validator.ts`, which also validates the host; these remain for
 * quick matching. They accept open.qobuz.com/play.qobuz.com links without a
 * locale and www.qobuz.com/<locale>/... store links.
 */
export const URL_PATTERNS = {
    TRACK: /qobuz\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?track\/(?:[^/?#]+\/)*(\d{1,20})\/?(?:[?#]|$)/i,
    ALBUM: /qobuz\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?album\/(?:[^/?#]+\/)*([a-z0-9]{1,40})\/?(?:[?#]|$)/i,
    ARTIST: /qobuz\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:artist|interpreter)\/(?:[^/?#]+\/)*(\d{1,20})\/?(?:[?#]|$)/i,
    PLAYLIST: /qobuz\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlists?\/(?:[^/?#]+\/)*(\d{1,20})\/?(?:[?#]|$)/i,
    LABEL: /qobuz\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?label\/(?:[^/?#]+\/)*(\d{1,20})\/?(?:[?#]|$)/i,
    NUMERIC_ID: /^\d+$/
};

/** Hosts accepted for Qobuz links: the apex domain or any subdomain of it. */
export const QOBUZ_DOMAIN = 'qobuz.com';

/** Path keyword (first segment after the optional locale) → entity type. */
export type QobuzUrlType = 'track' | 'album' | 'artist' | 'playlist' | 'label';

export const QOBUZ_URL_SEGMENT_TYPES: Readonly<Record<string, QobuzUrlType>> = {
    track: 'track',
    album: 'album',
    artist: 'artist',
    interpreter: 'artist',
    playlist: 'playlist',
    playlists: 'playlist',
    label: 'label'
};

/** Qobuz album ids are alphanumeric strings (UPC-like or opaque). */
export const QOBUZ_ALBUM_ID_PATTERN = /^[A-Za-z0-9]{1,40}$/;

/** Track, artist, playlist and label ids are positive integers. */
export const QOBUZ_NUMERIC_ID_PATTERN = /^\d{1,20}$/;

/** Store locale segment such as `us-en`, `fr-fr` or `en`. */
export const QOBUZ_LOCALE_SEGMENT_PATTERN = /^[a-z]{2}(?:-[a-z]{2})?$/i;

/** Allowed values for Qobuz list/search parameters (validated before any request). */
export const QOBUZ_SEARCH_TYPES = ['albums', 'tracks', 'artists', 'playlists'] as const satisfies readonly SearchType[];
export const QOBUZ_FAVORITE_TYPES = ['albums', 'tracks', 'artists'] as const satisfies readonly FavoriteType[];
export const QOBUZ_PURCHASE_TYPES = ['albums', 'tracks'] as const satisfies readonly PurchaseType[];
export const QOBUZ_PLAYLIST_FILTERS = [
    'owner,subscriber',
    'owner',
    'subscriber'
] as const satisfies readonly PlaylistFilter[];
export const QOBUZ_FEATURED_ALBUM_TYPES = [
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
] as const satisfies readonly FeaturedAlbumType[];
export const QOBUZ_FEATURED_PLAYLIST_TYPES = [
    'editor-picks',
    'last-created'
] as const satisfies readonly FeaturedPlaylistType[];
export const QOBUZ_ARTIST_RELEASE_TYPES = [
    'all',
    'album',
    'live',
    'compilation',
    'epSingle',
    'other',
    'download',
    'composer'
] as const satisfies readonly ArtistReleaseType[];
export const QOBUZ_ARTIST_RELEASE_SORTS = [
    'release_date',
    'relevant',
    'release_date_by_priority'
] as const satisfies readonly ArtistReleaseSort[];
export const QOBUZ_SORT_ORDERS = ['desc', 'asc'] as const satisfies readonly SortOrder[];

/** Server-side page size caps. */
export const QOBUZ_MAX_PAGE_LIMIT = 500;
export const QOBUZ_MAX_SIMILAR_ARTISTS_LIMIT = 100;
export const QOBUZ_MAX_RELEASES_LIMIT = 100;

export const APP_VERSION = packageJson.version;



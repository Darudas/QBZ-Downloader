export {
    QOBUZ_ARTIST_RELEASE_SORTS as ARTIST_RELEASE_SORTS,
    QOBUZ_ARTIST_RELEASE_TYPES as ARTIST_RELEASE_TYPES,
    QOBUZ_FAVORITE_TYPES as FAVORITE_TYPES,
    QOBUZ_FEATURED_ALBUM_TYPES as FEATURED_ALBUM_TYPES,
    QOBUZ_FEATURED_PLAYLIST_TYPES as FEATURED_PLAYLIST_TYPES,
    QOBUZ_PLAYLIST_FILTERS as PLAYLIST_FILTERS,
    QOBUZ_PURCHASE_TYPES as PURCHASE_TYPES,
    QOBUZ_SEARCH_TYPES as SEARCH_TYPES,
    QOBUZ_SORT_ORDERS as SORT_ORDERS
} from '../../constants.js';

/** Default and maximum page size of library list operations. */
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 500;
export const MAX_SIMILAR_ARTISTS_LIMIT = 100;
export const MAX_ARTIST_RELEASES_LIMIT = 100;
export const MAX_LIST_OFFSET = 1_000_000;

/** Ids per favorite/create|delete request. */
export const FAVORITES_WRITE_CHUNK = 100;
/** Ids per type accepted by one add/remove/check favorites call. */
export const MAX_FAVORITE_IDS_PER_TYPE = 500;

/** Tracks per playlist/addTracks request (keeps requests small, like other clients). */
export const PLAYLIST_ADD_CHUNK = 50;
/** Entries per playlist/deleteTracks request. */
export const PLAYLIST_REMOVE_CHUNK = 100;
/** Tracks accepted by one create/add/remove playlist call. */
export const MAX_PLAYLIST_TRACKS_PER_CALL = 1000;
/** Page size and cap used when scanning a playlist to resolve track ids. */
export const PLAYLIST_SCAN_PAGE = 500;
export const PLAYLIST_SCAN_MAX_TRACKS = 10_000;

export const PLAYLIST_NAME_MAX = 200;
export const PLAYLIST_DESCRIPTION_MAX = 1000;
export const MAX_RESOLVE_URL_LENGTH = 2048;

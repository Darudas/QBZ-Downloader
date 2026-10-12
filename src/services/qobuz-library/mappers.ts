/**
 * Pure mappers from raw Qobuz objects to compact summaries shared by the REST
 * API and the MCP tools. They never throw on odd input, never include large
 * blobs, and cap free text coming from Qobuz.
 */

export interface PageResult<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
}

export interface EntityRef {
    id: string | null;
    name: string | null;
}

export interface AlbumSummary {
    type: 'album';
    id: string;
    title: string;
    version: string | null;
    artist: EntityRef;
    release_date: string | null;
    year: number | null;
    release_type: string | null;
    duration: number | null;
    tracks_count: number | null;
    hires: boolean;
    hires_streamable: boolean;
    streamable: boolean | null;
    parental_warning: boolean;
    max_bit_depth: number | null;
    max_sampling_rate: number | null;
    image: string | null;
    genre: string | null;
    label: EntityRef | null;
    upc: string | null;
}

export interface TrackSummary {
    type: 'track';
    id: string;
    title: string;
    version: string | null;
    artist: EntityRef;
    album: { id: string | null; title: string | null; image: string | null } | null;
    duration: number | null;
    track_number: number | null;
    disc_number: number | null;
    isrc: string | null;
    release_date: string | null;
    year: number | null;
    hires: boolean;
    hires_streamable: boolean;
    streamable: boolean | null;
    parental_warning: boolean;
    max_bit_depth: number | null;
    max_sampling_rate: number | null;
    genre: string | null;
    label: EntityRef | null;
    /** Only for playlist entries: the id `playlist/deleteTracks` needs. */
    playlist_track_id?: string;
    position?: number;
}

export interface ArtistSummary {
    type: 'artist';
    id: string;
    name: string;
    albums_count: number | null;
    image: string | null;
}

export interface PlaylistSummary {
    type: 'playlist';
    id: string;
    name: string;
    description: string | null;
    owner: EntityRef | null;
    is_owner?: boolean;
    tracks_count: number | null;
    duration: number | null;
    is_public: boolean | null;
    is_collaborative: boolean | null;
    users_count: number | null;
    image: string | null;
    created_at: string | null;
    updated_at: string | null;
}

export interface LabelSummary {
    type: 'label';
    id: string;
    name: string;
    albums_count: number | null;
    description: string | null;
    image: string | null;
}

export const MAX_SUMMARY_TEXT_LENGTH = 300;

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function str(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

function num(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
}

function bool(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function idOf(value: unknown): string | null {
    return str(value);
}

/** Strip HTML tags/entities, collapse whitespace and cap the length. */
export function capText(value: unknown, max: number = MAX_SUMMARY_TEXT_LENGTH): string | null {
    if (typeof value !== 'string') return null;
    const text = value
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return null;
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

function nameOf(value: unknown): string | null {
    if (typeof value === 'string') return str(value);
    const record = asRecord(value);
    return str(record.display) ?? str(record.name);
}

function entityRef(value: unknown): EntityRef | null {
    const record = asRecord(value);
    const id = idOf(record.id);
    const name = nameOf(record.name);
    if (id === null && name === null) return null;
    return { id, name };
}

function imageUrl(value: unknown): string | null {
    if (typeof value === 'string') return str(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = imageUrl(item);
            if (url) return url;
        }
        return null;
    }
    const record = asRecord(value);
    return (
        str(record.large) ??
        str(record.extralarge) ??
        str(record.medium) ??
        str(record.mega) ??
        str(record.small) ??
        str(record.thumbnail) ??
        null
    );
}

function dateFromUnix(value: unknown): string | null {
    const seconds = num(value);
    if (seconds === null || seconds <= 0) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function releaseDateOf(record: Raw): string | null {
    const dates = asRecord(record.dates);
    const explicit =
        str(record.release_date_original) ?? str(dates.original) ?? str(record.release_date_download);
    if (explicit) return explicit.slice(0, 10);
    const fromUnix = dateFromUnix(record.released_at);
    return fromUnix ? fromUnix.slice(0, 10) : null;
}

function yearOf(releaseDate: string | null): number | null {
    if (!releaseDate) return null;
    const year = Number(releaseDate.slice(0, 4));
    return Number.isInteger(year) && year > 0 ? year : null;
}

function genreOf(record: Raw): string | null {
    const genre = nameOf(record.genre);
    if (genre) return genre;
    if (Array.isArray(record.genres_list) && record.genres_list.length > 0) {
        return nameOf(record.genres_list[0]);
    }
    return null;
}

export function toAlbumSummary(raw: unknown): AlbumSummary {
    const album = asRecord(raw);
    const audio = asRecord(album.audio_info);
    const rights = asRecord(album.rights);
    const releaseDate = releaseDateOf(album);
    const bitDepth = num(album.maximum_bit_depth) ?? num(audio.maximum_bit_depth);
    const samplingRate = num(album.maximum_sampling_rate) ?? num(audio.maximum_sampling_rate);
    const hiresStreamable = bool(album.hires_streamable) ?? bool(rights.hires_streamable) ?? false;
    return {
        type: 'album',
        id: idOf(album.id) ?? '',
        title: str(album.title) ?? '',
        version: str(album.version),
        artist: entityRef(album.artist) ?? { id: null, name: null },
        release_date: releaseDate,
        year: yearOf(releaseDate),
        release_type: str(album.release_type) ?? str(album.product_type),
        duration: num(album.duration),
        tracks_count: num(album.tracks_count),
        hires: bool(album.hires) ?? (bitDepth !== null && bitDepth > 16),
        hires_streamable: hiresStreamable,
        streamable: bool(album.streamable) ?? bool(rights.streamable),
        parental_warning: bool(album.parental_warning) ?? false,
        max_bit_depth: bitDepth,
        max_sampling_rate: samplingRate,
        image: imageUrl(album.image),
        genre: genreOf(album),
        label: entityRef(album.label),
        upc: str(album.upc)
    };
}

export function toTrackSummary(raw: unknown): TrackSummary {
    const track = asRecord(raw);
    const album = asRecord(track.album);
    const hasAlbum = Object.keys(album).length > 0;
    const artist = entityRef(track.performer) ?? entityRef(track.artist) ?? entityRef(album.artist);
    const releaseDate = releaseDateOf(track) ?? (hasAlbum ? releaseDateOf(album) : null);
    const bitDepth = num(track.maximum_bit_depth);
    const summary: TrackSummary = {
        type: 'track',
        id: idOf(track.id) ?? '',
        title: str(track.title) ?? '',
        version: str(track.version),
        artist: artist ?? { id: null, name: null },
        album: hasAlbum
            ? { id: idOf(album.id), title: str(album.title), image: imageUrl(album.image) }
            : null,
        duration: num(track.duration),
        track_number: num(track.track_number),
        disc_number: num(track.media_number),
        isrc: str(track.isrc),
        release_date: releaseDate,
        year: yearOf(releaseDate),
        hires: bool(track.hires) ?? (bitDepth !== null && bitDepth > 16),
        hires_streamable: bool(track.hires_streamable) ?? false,
        streamable: bool(track.streamable),
        parental_warning: bool(track.parental_warning) ?? false,
        max_bit_depth: bitDepth,
        max_sampling_rate: num(track.maximum_sampling_rate),
        genre: hasAlbum ? genreOf(album) : null,
        label: hasAlbum ? entityRef(album.label) : null
    };
    const playlistTrackId = idOf(track.playlist_track_id);
    if (playlistTrackId !== null) summary.playlist_track_id = playlistTrackId;
    const position = num(track.position);
    if (position !== null) summary.position = position;
    return summary;
}

export function toArtistSummary(raw: unknown): ArtistSummary {
    const artist = asRecord(raw);
    const images = asRecord(artist.images);
    return {
        type: 'artist',
        id: idOf(artist.id) ?? '',
        name: nameOf(artist.name) ?? '',
        albums_count: num(artist.albums_count),
        image: imageUrl(artist.image) ?? imageUrl(artist.picture) ?? imageUrl(images.portrait)
    };
}

/**
 * @param currentUserId when given, `is_owner` is computed from `owner.id`.
 */
export function toPlaylistSummary(raw: unknown, currentUserId?: string | number | null): PlaylistSummary {
    const playlist = asRecord(raw);
    const owner = entityRef(playlist.owner);
    const summary: PlaylistSummary = {
        type: 'playlist',
        id: idOf(playlist.id) ?? '',
        name: str(playlist.name) ?? '',
        description: capText(playlist.description),
        owner,
        tracks_count: num(playlist.tracks_count) ?? num(asRecord(playlist.tracks).total),
        duration: num(playlist.duration),
        is_public: bool(playlist.is_public),
        is_collaborative: bool(playlist.is_collaborative),
        users_count: num(playlist.users_count),
        image:
            imageUrl(playlist.images300) ??
            imageUrl(playlist.images150) ??
            imageUrl(playlist.images) ??
            imageUrl(playlist.image_rectangle) ??
            imageUrl(playlist.image),
        created_at: dateFromUnix(playlist.created_at),
        updated_at: dateFromUnix(playlist.updated_at)
    };
    if (typeof playlist.is_owner === 'boolean') {
        summary.is_owner = playlist.is_owner;
    } else if (currentUserId !== undefined && currentUserId !== null && String(currentUserId) !== '') {
        summary.is_owner = !!owner?.id && owner.id === String(currentUserId);
    }
    return summary;
}

export function toLabelSummary(raw: unknown): LabelSummary {
    const label = asRecord(raw);
    return {
        type: 'label',
        id: idOf(label.id) ?? '',
        name: nameOf(label.name) ?? '',
        albums_count: num(label.albums_count),
        description: capText(label.description),
        image: imageUrl(label.image)
    };
}

/**
 * Build a page result. `has_more` is derived from `total` and the effective
 * page size rather than the number of items returned: Qobuz may return fewer
 * items than `limit` (server-side de-duplication) while more pages exist.
 * An empty page always ends the listing. When `total` is unknown, a full page
 * means there may be more.
 */
export function paginate<T>(
    items: readonly T[],
    total: number | null | undefined,
    offset: number,
    limit: number
): PageResult<T> {
    const list = Array.isArray(items) ? [...items] : [];
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
    const requestedLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : list.length || 1;
    const effectiveLimit = Math.max(requestedLimit, list.length);
    const seen = safeOffset + list.length;
    const knownTotal =
        typeof total === 'number' && Number.isFinite(total) && total >= 0 ? Math.trunc(total) : null;

    if (knownTotal === null) {
        return {
            items: list,
            total: seen,
            offset: safeOffset,
            limit: effectiveLimit,
            has_more: list.length > 0 && list.length >= requestedLimit
        };
    }

    const resolvedTotal = Math.max(knownTotal, seen);
    return {
        items: list,
        total: resolvedTotal,
        offset: safeOffset,
        limit: effectiveLimit,
        has_more: list.length > 0 && safeOffset + effectiveLimit < resolvedTotal
    };
}

/** Map every item of a page, keeping the paging fields. */
export function mapPage<T, U>(page: PageResult<T>, mapper: (item: T) => U): PageResult<U> {
    return { ...page, items: page.items.map(mapper) };
}

/**
 * Next offset for a server-side paging loop: advance by the page size the
 * server echoed (it may cap `limit` silently); fall back to the item count.
 */
export function nextOffset(
    page: { offset?: unknown; limit?: unknown; items?: readonly unknown[] },
    requestedOffset: number,
    requestedLimit: number
): number {
    const echoedOffset = num(page.offset);
    const echoedLimit = num(page.limit);
    const base = echoedOffset !== null && echoedOffset >= 0 ? echoedOffset : requestedOffset;
    const count = Array.isArray(page.items) ? page.items.length : 0;
    const step = echoedLimit !== null && echoedLimit > 0 ? echoedLimit : count || requestedLimit;
    return base + step;
}

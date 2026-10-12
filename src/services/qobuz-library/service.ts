import { qobuzApi, type QobuzAPI } from '../../api/qobuz.js';
import {
    APIError,
    ForbiddenError,
    NotFoundError,
    ValidationError,
    toSafeErrorPayload,
    type SafeErrorPayload
} from '../../utils/errors.js';
import {
    eventBus,
    EVENTS,
    type QobuzFavoritesUpdatedEvent,
    type QobuzPlaylistAction,
    type QobuzPlaylistsUpdatedEvent
} from '../../utils/events.js';
import { logger } from '../../utils/logger.js';
import { parseQobuzUrl, type QobuzUrlType } from '../../utils/validator.js';
import type {
    Album,
    ApiResponse,
    Artist,
    ArtistRelease,
    ArtistReleaseSort,
    ArtistReleaseType,
    FavoriteType,
    FeaturedAlbumType,
    FeaturedPlaylistType,
    Label,
    PlaylistFilter,
    PlaylistListItem,
    PlaylistPage,
    PlaylistTrack,
    PurchasedAlbum,
    PurchasedTrack,
    PurchaseType,
    SortOrder,
    Track
} from '../../types/qobuz.js';
import {
    DEFAULT_LIST_LIMIT,
    FAVORITES_WRITE_CHUNK,
    MAX_ARTIST_RELEASES_LIMIT,
    MAX_LIST_LIMIT,
    MAX_PLAYLIST_TRACKS_PER_CALL,
    MAX_RESOLVE_URL_LENGTH,
    MAX_SIMILAR_ARTISTS_LIMIT,
    PLAYLIST_ADD_CHUNK,
    PLAYLIST_REMOVE_CHUNK,
    PLAYLIST_SCAN_MAX_TRACKS,
    PLAYLIST_SCAN_PAGE
} from './constants.js';
import {
    addTracksInputSchema,
    albumIdSchema,
    artistReleaseSortSchema,
    artistReleaseTypeSchema,
    createPlaylistInputSchema,
    favoriteIdsInputSchema,
    favoriteTypeSchema,
    featuredAlbumTypeSchema,
    featuredPlaylistTypeSchema,
    normalizePage,
    numericIdSchema,
    parseInput,
    playlistFilterSchema,
    purchaseTypeSchema,
    removeTracksInputSchema,
    sortOrderSchema,
    updatePlaylistInputSchema,
    type PageOptions
} from './schemas.js';
import {
    paginate,
    toAlbumSummary,
    toArtistSummary,
    toLabelSummary,
    toPlaylistSummary,
    toTrackSummary,
    type AlbumSummary,
    type ArtistSummary,
    type LabelSummary,
    type PageResult,
    type PlaylistSummary,
    type TrackSummary
} from './mappers.js';
import { z } from 'zod';

/** The QobuzAPI surface this service needs (lets tests pass a stub). */
export type QobuzLibraryApi = Pick<
    QobuzAPI,
    | 'userId'
    | 'getUserInfo'
    | 'getAlbum'
    | 'getTrack'
    | 'getArtist'
    | 'getAlbumTrackIds'
    | 'getUserFavorites'
    | 'getUserFavoriteIds'
    | 'addFavorites'
    | 'removeFavorites'
    | 'getUserPlaylists'
    | 'getPlaylistPage'
    | 'createPlaylist'
    | 'updatePlaylist'
    | 'deletePlaylist'
    | 'addTracksToPlaylist'
    | 'removeTracksFromPlaylist'
    | 'subscribePlaylist'
    | 'unsubscribePlaylist'
    | 'getUserPurchases'
    | 'getUserPurchaseIds'
    | 'getFeaturedAlbums'
    | 'getFeaturedPlaylists'
    | 'getLabel'
    | 'getSimilarArtists'
    | 'getArtistReleases'
>;

export interface EventSink {
    emit(event: string, payload: unknown): boolean;
}

export interface FavoriteItemMap {
    albums: Album;
    tracks: Track;
    artists: Artist;
}

export interface FavoriteIdSets {
    albums: string[];
    tracks: string[];
    artists: string[];
}

export interface FavoriteIdsQuery {
    albumIds?: ReadonlyArray<string>;
    trackIds?: ReadonlyArray<string | number>;
    artistIds?: ReadonlyArray<string | number>;
}

export interface FavoriteCheckResult {
    albums: Record<string, boolean>;
    tracks: Record<string, boolean>;
    artists: Record<string, boolean>;
}

export interface FavoritesMutationResult {
    action: 'add' | 'remove';
    album_ids: string[];
    track_ids: string[];
    artist_ids: string[];
    /** Number of ids sent to Qobuz. */
    count: number;
}

export type OwnedPlaylist = PlaylistListItem & { is_owner: boolean };

export type PlaylistDetails = Omit<PlaylistPage, 'tracks'> & {
    is_owner: boolean;
    /** Owner, or a public collaborative playlist. */
    can_add_tracks: boolean;
    tracks: PageResult<PlaylistTrack>;
};

export interface CreatePlaylistInput {
    name: string;
    description?: string;
    isPublic?: boolean;
    isCollaborative?: boolean;
    trackIds?: ReadonlyArray<string | number>;
    albumId?: string;
}

export interface CreatePlaylistResult {
    playlist: OwnedPlaylist;
    added: number;
    requested: number;
    /** Set when the playlist was created but adding its tracks failed. */
    error?: SafeErrorPayload;
}

export interface UpdatePlaylistInput {
    name?: string;
    description?: string;
    isPublic?: boolean;
    isCollaborative?: boolean;
}

export interface AddTracksInput {
    trackIds?: ReadonlyArray<string | number>;
    albumId?: string;
    allowDuplicates?: boolean;
}

export interface AddTracksResult {
    playlist_id: string;
    /** Tracks actually added (from the playlist track count when Qobuz reports it). */
    added: number;
    /** Tracks sent after album expansion and de-duplication. */
    requested: number;
    tracks_count: number | null;
}

export interface RemoveTracksInput {
    playlistTrackIds?: ReadonlyArray<string | number>;
    trackIds?: ReadonlyArray<string | number>;
}

export interface RemoveTracksResult {
    playlist_id: string;
    /** Playlist entries removed. */
    removed: number;
    requested: number;
    not_found_track_ids: string[];
    /** True when a large playlist could not be scanned completely. */
    truncated: boolean;
}

export interface FollowResult {
    playlist_id: string;
    name: string | null;
    following: boolean;
}

export interface DeletePlaylistResult {
    playlist_id: string;
    name: string | null;
    deleted: true;
}

export interface FeaturedQuery extends PageOptions {
    genreId?: string | number;
}

export interface LabelPage {
    label: Omit<Label, 'albums'>;
    albums: PageResult<Album>;
}

export interface ArtistReleasesQuery extends PageOptions {
    releaseType?: ArtistReleaseType | ReadonlyArray<ArtistReleaseType>;
    sort?: ArtistReleaseSort;
    order?: SortOrder;
}

/** Releases are paged with `has_more` only: `total` is null when unknown. */
export interface ArtistReleasesPage {
    items: ArtistRelease[];
    total: number | null;
    offset: number;
    limit: number;
    has_more: boolean;
}

export interface AccountInfo {
    id: string;
    login: string | null;
    display_name: string | null;
    country: string | null;
    subscription: {
        offer: string | null;
        periodicity: string | null;
        end_date: string | null;
    } | null;
    credential_label: string | null;
    streaming: {
        hires: boolean;
        lossless: boolean;
    };
}

export interface ResolvedUrl {
    type: QobuzUrlType;
    id: string;
    url: string;
    summary?: AlbumSummary | TrackSummary | ArtistSummary | PlaylistSummary | LabelSummary;
}

const urlInputSchema = z.string().trim().min(1, 'is required').max(MAX_RESOLVE_URL_LENGTH);

function unwrap<T>(response: ApiResponse<T>, fallback: string): T {
    if (!response || !response.success || response.data === undefined || response.data === null) {
        throw new APIError(response?.error || fallback, null);
    }
    return response.data;
}

function dedupe(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function chunk<T>(values: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
    return out;
}

function withoutTracks<T extends { tracks?: unknown }>(value: T): Omit<T, 'tracks'> {
    const copy: Partial<T> = { ...value };
    delete copy.tracks;
    return copy as Omit<T, 'tracks'>;
}

function trackCountOf(playlist: { tracks_count?: unknown; tracks?: { total?: unknown } } | null | undefined): number | null {
    if (typeof playlist?.tracks_count === 'number') return playlist.tracks_count;
    if (typeof playlist?.tracks?.total === 'number') return playlist.tracks.total;
    return null;
}

/**
 * High-level, validated Qobuz library operations shared by the REST routes
 * and the MCP tools. Every input is validated (ValidationError on bad input),
 * writes check playlist ownership locally before calling Qobuz, and every
 * write emits an EVENTS.QOBUZ_LIBRARY event. Outputs use snake_case keys.
 */
export class QobuzLibraryService {
    constructor(
        private readonly api: QobuzLibraryApi = qobuzApi,
        private readonly events: EventSink = eventBus
    ) {}

    private currentUserId(): string {
        return String(this.api.userId ?? '').trim();
    }

    private isOwner(playlist: { owner?: { id?: unknown } | null } | null | undefined): boolean {
        const userId = this.currentUserId();
        const ownerId = playlist?.owner?.id;
        return !!userId && ownerId !== undefined && ownerId !== null && String(ownerId) === userId;
    }

    private emitFavorites(payload: QobuzFavoritesUpdatedEvent): void {
        this.events.emit(EVENTS.QOBUZ_LIBRARY.FAVORITES_UPDATED, payload);
    }

    private emitPlaylists(action: QobuzPlaylistAction, playlistId: string): void {
        const payload: QobuzPlaylistsUpdatedEvent = { action, playlistId };
        this.events.emit(EVENTS.QOBUZ_LIBRARY.PLAYLISTS_UPDATED, payload);
    }

    private parsePlaylistId(value: unknown): string {
        return parseInput(numericIdSchema, value, 'playlist id');
    }

    private async loadPlaylistHead(playlistId: string, limit = 1): Promise<PlaylistPage> {
        const page = unwrap(
            await this.api.getPlaylistPage(playlistId, limit, 0),
            `Playlist ${playlistId} could not be loaded`
        );
        if (page.id === undefined || page.id === null) {
            throw new NotFoundError(`Playlist ${playlistId} was not found`);
        }
        return page;
    }

    private async expandAlbum(albumId: string): Promise<string[]> {
        const ids = unwrap(await this.api.getAlbumTrackIds(albumId), `Album ${albumId} could not be loaded`);
        if (ids.length === 0) {
            throw new NotFoundError(`Album ${albumId} has no tracks available`);
        }
        return ids;
    }

    // --------------------------------------------------------------
    // Favorites
    // --------------------------------------------------------------

    async listFavorites<T extends FavoriteType>(
        type: T,
        options: PageOptions = {}
    ): Promise<PageResult<FavoriteItemMap[T]>> {
        const favoriteType = parseInput(favoriteTypeSchema, type, 'favorite type') as T;
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const data = unwrap(await this.api.getUserFavorites(favoriteType, limit, offset), 'Could not load favorites');
        const bucket = data[favoriteType] as
            | { items?: FavoriteItemMap[T][]; total?: number; limit?: number }
            | undefined;
        return paginate(bucket?.items ?? [], bucket?.total, offset, bucket?.limit ?? limit);
    }

    /** Favorite ids as strings (cached per user for 60s by the API layer). */
    async getFavoriteIds(): Promise<FavoriteIdSets> {
        const data = unwrap(await this.api.getUserFavoriteIds(), 'Could not load favorite ids');
        return {
            albums: (data.albums ?? []).map(String),
            tracks: (data.tracks ?? []).map(String),
            artists: (data.artists ?? []).map(String)
        };
    }

    async checkFavorites(query: FavoriteIdsQuery): Promise<FavoriteCheckResult> {
        const parsed = parseInput(favoriteIdsInputSchema, query ?? {}, 'favorite ids');
        const albumIds = dedupe(parsed.albumIds ?? []);
        const trackIds = dedupe(parsed.trackIds ?? []);
        const artistIds = dedupe(parsed.artistIds ?? []);
        if (albumIds.length + trackIds.length + artistIds.length === 0) {
            throw new ValidationError('Provide at least one album, track or artist id');
        }

        const favorites = await this.getFavoriteIds();
        const lookup = (ids: string[], known: string[]) => {
            const set = new Set(known);
            return Object.fromEntries(ids.map((id) => [id, set.has(id)]));
        };
        return {
            albums: lookup(albumIds, favorites.albums),
            tracks: lookup(trackIds, favorites.tracks),
            artists: lookup(artistIds, favorites.artists)
        };
    }

    addFavorites(input: FavoriteIdsQuery): Promise<FavoritesMutationResult> {
        return this.mutateFavorites('add', input);
    }

    removeFavorites(input: FavoriteIdsQuery): Promise<FavoritesMutationResult> {
        return this.mutateFavorites('remove', input);
    }

    private async mutateFavorites(
        action: 'add' | 'remove',
        input: FavoriteIdsQuery
    ): Promise<FavoritesMutationResult> {
        const parsed = parseInput(favoriteIdsInputSchema, input ?? {}, 'favorite ids');
        const albumIds = dedupe(parsed.albumIds ?? []);
        const trackIds = dedupe(parsed.trackIds ?? []);
        const artistIds = dedupe(parsed.artistIds ?? []);
        const entries: Array<['albumIds' | 'trackIds' | 'artistIds', string]> = [
            ...albumIds.map((id) => ['albumIds', id] as ['albumIds', string]),
            ...trackIds.map((id) => ['trackIds', id] as ['trackIds', string]),
            ...artistIds.map((id) => ['artistIds', id] as ['artistIds', string])
        ];
        if (entries.length === 0) {
            throw new ValidationError('Provide at least one album, track or artist id');
        }

        const applied: QobuzFavoritesUpdatedEvent = { action, albumIds: [], trackIds: [], artistIds: [] };
        try {
            for (const part of chunk(entries, FAVORITES_WRITE_CHUNK)) {
                const ids = { albumIds: [] as string[], trackIds: [] as string[], artistIds: [] as string[] };
                for (const [key, id] of part) ids[key].push(id);
                const response =
                    action === 'add' ? await this.api.addFavorites(ids) : await this.api.removeFavorites(ids);
                unwrap(response, `Could not ${action} favorites`);
                applied.albumIds.push(...ids.albumIds);
                applied.trackIds.push(...ids.trackIds);
                applied.artistIds.push(...ids.artistIds);
            }
        } catch (error) {
            const done = applied.albumIds.length + applied.trackIds.length + applied.artistIds.length;
            if (done > 0) {
                logger.warn(
                    `Favorites ${action} stopped after ${done} of ${entries.length} ids were applied`,
                    'QOBUZ_LIBRARY'
                );
            }
            throw error;
        } finally {
            if (applied.albumIds.length + applied.trackIds.length + applied.artistIds.length > 0) {
                this.emitFavorites(applied);
            }
        }

        return {
            action,
            album_ids: albumIds,
            track_ids: trackIds,
            artist_ids: artistIds,
            count: entries.length
        };
    }

    // --------------------------------------------------------------
    // Playlists
    // --------------------------------------------------------------

    async listUserPlaylists(
        options: PageOptions & { filter?: PlaylistFilter } = {}
    ): Promise<PageResult<OwnedPlaylist>> {
        const filter = parseInput(playlistFilterSchema, options.filter ?? 'owner,subscriber', 'playlist filter');
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const data = unwrap(
            await this.api.getUserPlaylists({ filter, limit, offset }),
            'Could not load playlists'
        );
        const items = (data.playlists?.items ?? []).map((playlist) => ({
            ...playlist,
            is_owner: this.isOwner(playlist)
        }));
        return paginate(items, data.playlists?.total, offset, data.playlists?.limit ?? limit);
    }

    /** One page of a playlist; entries carry `playlist_track_id` and a 1-based `position`. */
    async getPlaylist(playlistId: string | number, options: PageOptions = {}): Promise<PlaylistDetails> {
        const id = this.parsePlaylistId(playlistId);
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const page = unwrap(await this.api.getPlaylistPage(id, limit, offset), `Playlist ${id} could not be loaded`);
        if (page.id === undefined || page.id === null) {
            throw new NotFoundError(`Playlist ${id} was not found`);
        }
        const tracks = page.tracks ?? { items: [], total: 0, offset, limit };
        const pageOffset = typeof tracks.offset === 'number' ? tracks.offset : offset;
        const items = (tracks.items ?? []).map((track, index) => ({
            ...track,
            position: typeof track.position === 'number' ? track.position : pageOffset + index + 1
        }));
        const isOwner = this.isOwner(page);
        return {
            ...page,
            is_owner: isOwner,
            can_add_tracks: isOwner || (page.is_public === true && page.is_collaborative === true),
            tracks: paginate(items, tracks.total, offset, tracks.limit ?? limit)
        };
    }

    async createPlaylist(input: CreatePlaylistInput): Promise<CreatePlaylistResult> {
        const parsed = parseInput(createPlaylistInputSchema, input, 'playlist');
        const isPublic = parsed.isPublic === true;
        if (parsed.isCollaborative === true && !isPublic) {
            throw new ValidationError('A collaborative playlist must be public (set isPublic: true)');
        }

        let trackIds = [...(parsed.trackIds ?? [])];
        if (parsed.albumId) {
            trackIds.push(...(await this.expandAlbum(parsed.albumId)));
        }
        trackIds = dedupe(trackIds);
        if (trackIds.length > MAX_PLAYLIST_TRACKS_PER_CALL) {
            throw new ValidationError(
                `Too many tracks: at most ${MAX_PLAYLIST_TRACKS_PER_CALL} per call (got ${trackIds.length})`
            );
        }

        const created = unwrap(
            await this.api.createPlaylist({
                name: parsed.name,
                description: parsed.description ?? '',
                isPublic,
                isCollaborative: isPublic && parsed.isCollaborative === true
            }),
            'Could not create the playlist'
        );
        if (created.id === undefined || created.id === null || String(created.id) === '') {
            throw new APIError('Qobuz did not return the id of the new playlist', null);
        }
        const playlistId = String(created.id);
        this.emitPlaylists('create', playlistId);

        const result: CreatePlaylistResult = {
            playlist: { ...created, is_owner: true },
            added: 0,
            requested: trackIds.length
        };
        if (trackIds.length === 0) return result;

        try {
            const { sent, last } = await this.sendTrackChunks(playlistId, trackIds, true);
            result.added = sent;
            const count = trackCountOf(last);
            if (count !== null) result.playlist = { ...result.playlist, tracks_count: count };
        } catch (error) {
            logger.warn(
                `Playlist ${playlistId} was created but adding its tracks failed: ${toSafeErrorPayload(error).message}`,
                'QOBUZ_LIBRARY'
            );
            result.error = toSafeErrorPayload(error);
        } finally {
            if (result.added > 0) this.emitPlaylists('add_tracks', playlistId);
        }
        return result;
    }

    private async sendTrackChunks(
        playlistId: string,
        trackIds: readonly string[],
        noDuplicate: boolean,
        onChunk?: (count: number) => void
    ): Promise<{ sent: number; last: PlaylistListItem | null }> {
        let sent = 0;
        let last: PlaylistListItem | null = null;
        for (const part of chunk(trackIds, PLAYLIST_ADD_CHUNK)) {
            last = unwrap(
                await this.api.addTracksToPlaylist(playlistId, part, noDuplicate),
                'Could not add tracks to the playlist'
            );
            sent += part.length;
            onChunk?.(sent);
        }
        return { sent, last };
    }

    /**
     * Owner-only. Reads the playlist first and always sends name and
     * description, so fields not in the patch are never cleared. Never sends
     * track ids.
     */
    async updatePlaylist(playlistId: string | number, patch: UpdatePlaylistInput): Promise<OwnedPlaylist> {
        const id = this.parsePlaylistId(playlistId);
        const parsed = parseInput(updatePlaylistInputSchema, patch ?? {}, 'playlist update');
        const current = await this.loadPlaylistHead(id);
        if (!this.isOwner(current)) {
            throw new ForbiddenError('Only the owner can edit this playlist');
        }

        const isPublic = parsed.isPublic ?? current.is_public === true;
        const requestedCollaborative = parsed.isCollaborative ?? current.is_collaborative === true;
        if (parsed.isCollaborative === true && !isPublic) {
            throw new ValidationError('A collaborative playlist must be public (set isPublic: true)');
        }
        const isCollaborative = isPublic && requestedCollaborative;
        const name = parsed.name ?? current.name;
        const description = parsed.description ?? current.description ?? '';

        const response = unwrap(
            await this.api.updatePlaylist(id, { name, description, isPublic, isCollaborative }),
            'Could not update the playlist'
        );
        this.emitPlaylists('update', id);

        const merged: PlaylistListItem = {
            ...withoutTracks(current),
            name,
            description,
            is_public: isPublic,
            is_collaborative: isCollaborative
        };
        const fromServer =
            response && typeof response === 'object' && response.id !== undefined && response.id !== null
                ? withoutTracks(response)
                : {};
        return { ...merged, ...fromServer, is_owner: true };
    }

    /** Owner-only and irreversible. */
    async deletePlaylist(playlistId: string | number): Promise<DeletePlaylistResult> {
        const id = this.parsePlaylistId(playlistId);
        const current = await this.loadPlaylistHead(id);
        if (!this.isOwner(current)) {
            throw new ForbiddenError('Only the owner can delete this playlist');
        }
        unwrap(await this.api.deletePlaylist(id), 'Could not delete the playlist');
        this.emitPlaylists('delete', id);
        return { playlist_id: id, name: current.name ?? null, deleted: true };
    }

    /** Allowed for the owner, or on a public collaborative playlist. Chunked by 50. */
    async addTracks(playlistId: string | number, input: AddTracksInput): Promise<AddTracksResult> {
        const id = this.parsePlaylistId(playlistId);
        const parsed = parseInput(addTracksInputSchema, input ?? {}, 'tracks');
        const current = await this.loadPlaylistHead(id);
        const allowed =
            this.isOwner(current) || (current.is_public === true && current.is_collaborative === true);
        if (!allowed) {
            throw new ForbiddenError(
                'Tracks can only be added to your own playlists or to public collaborative playlists'
            );
        }

        const allowDuplicates = parsed.allowDuplicates === true;
        let trackIds = [...(parsed.trackIds ?? [])];
        if (parsed.albumId) {
            trackIds.push(...(await this.expandAlbum(parsed.albumId)));
        }
        if (!allowDuplicates) trackIds = dedupe(trackIds);
        if (trackIds.length > MAX_PLAYLIST_TRACKS_PER_CALL) {
            throw new ValidationError(
                `Too many tracks: at most ${MAX_PLAYLIST_TRACKS_PER_CALL} per call (got ${trackIds.length})`
            );
        }

        const before = trackCountOf(current);
        let sent = 0;
        let last: PlaylistListItem | null = null;
        try {
            const outcome = await this.sendTrackChunks(id, trackIds, !allowDuplicates, (count) => {
                sent = count;
            });
            last = outcome.last;
        } finally {
            if (sent > 0) this.emitPlaylists('add_tracks', id);
        }

        const after = trackCountOf(last);
        const added = before !== null && after !== null ? Math.max(0, after - before) : sent;
        return { playlist_id: id, added, requested: trackIds.length, tracks_count: after };
    }

    /**
     * Owner-only. Track ids are resolved to `playlist_track_id`s by paging the
     * playlist (every occurrence is removed); entry ids are used as given.
     */
    async removeTracks(playlistId: string | number, input: RemoveTracksInput): Promise<RemoveTracksResult> {
        const id = this.parsePlaylistId(playlistId);
        const parsed = parseInput(removeTracksInputSchema, input ?? {}, 'tracks');
        const trackIds = dedupe(parsed.trackIds ?? []);
        const entryIds = new Set<string>(parsed.playlistTrackIds ?? []);

        const first = await this.loadPlaylistHead(id, trackIds.length > 0 ? PLAYLIST_SCAN_PAGE : 1);
        if (!this.isOwner(first)) {
            throw new ForbiddenError('Only the owner can remove tracks from this playlist');
        }

        let truncated = false;
        const notFound: string[] = [];
        if (trackIds.length > 0) {
            const wanted = new Set(trackIds);
            const found = new Set<string>();
            const collect = (items: PlaylistTrack[]) => {
                for (const item of items) {
                    const trackId = item?.id !== undefined && item.id !== null ? String(item.id) : '';
                    const entryId =
                        item?.playlist_track_id !== undefined && item.playlist_track_id !== null
                            ? String(item.playlist_track_id)
                            : '';
                    if (trackId && entryId && wanted.has(trackId)) {
                        entryIds.add(entryId);
                        found.add(trackId);
                    }
                }
            };

            let page = first.tracks;
            let scanned = page?.items?.length ?? 0;
            collect(page?.items ?? []);
            const total = typeof page?.total === 'number' ? page.total : scanned;
            let offset = scanned;
            while (offset < total && (page?.items?.length ?? 0) > 0) {
                if (scanned >= PLAYLIST_SCAN_MAX_TRACKS) {
                    truncated = true;
                    break;
                }
                const next = unwrap(
                    await this.api.getPlaylistPage(id, PLAYLIST_SCAN_PAGE, offset),
                    `Playlist ${id} could not be loaded`
                );
                page = next.tracks;
                const items = page?.items ?? [];
                collect(items);
                scanned += items.length;
                offset += items.length;
            }
            notFound.push(...trackIds.filter((trackId) => !found.has(trackId)));
        }

        const toRemove = [...entryIds];
        let removed = 0;
        try {
            for (const part of chunk(toRemove, PLAYLIST_REMOVE_CHUNK)) {
                unwrap(
                    await this.api.removeTracksFromPlaylist(id, part),
                    'Could not remove tracks from the playlist'
                );
                removed += part.length;
            }
        } finally {
            if (removed > 0) this.emitPlaylists('remove_tracks', id);
        }

        return {
            playlist_id: id,
            removed,
            requested: (parsed.playlistTrackIds?.length ?? 0) + trackIds.length,
            not_found_track_ids: notFound,
            truncated
        };
    }

    async followPlaylist(playlistId: string | number): Promise<FollowResult> {
        return this.setFollowing(playlistId, true);
    }

    async unfollowPlaylist(playlistId: string | number): Promise<FollowResult> {
        return this.setFollowing(playlistId, false);
    }

    private async setFollowing(playlistId: string | number, follow: boolean): Promise<FollowResult> {
        const id = this.parsePlaylistId(playlistId);
        const current = await this.loadPlaylistHead(id);
        if (this.isOwner(current)) {
            throw new ValidationError(
                follow ? 'You cannot follow your own playlist' : 'You cannot unfollow your own playlist'
            );
        }
        const response = follow ? await this.api.subscribePlaylist(id) : await this.api.unsubscribePlaylist(id);
        unwrap(response, `Could not ${follow ? 'follow' : 'unfollow'} the playlist`);
        this.emitPlaylists(follow ? 'follow' : 'unfollow', id);
        return { playlist_id: id, name: current.name ?? null, following: follow };
    }

    // --------------------------------------------------------------
    // Purchases
    // --------------------------------------------------------------

    async listPurchases(
        type: PurchaseType,
        options: PageOptions = {}
    ): Promise<PageResult<PurchasedAlbum | PurchasedTrack>> {
        const purchaseType = parseInput(purchaseTypeSchema, type, 'purchase type');
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const data = unwrap(
            await this.api.getUserPurchases(purchaseType, limit, offset),
            'Could not load purchases'
        );
        const bucket = data[purchaseType];
        const items: Array<PurchasedAlbum | PurchasedTrack> = bucket?.items ?? [];
        return paginate(items, bucket?.total, offset, bucket?.limit ?? limit);
    }

    async getPurchaseIds(): Promise<{ albums: string[]; tracks: string[] }> {
        const data = unwrap(await this.api.getUserPurchaseIds(), 'Could not load purchases');
        const ids = (items: Array<{ id?: unknown }> | undefined) =>
            dedupe(
                (items ?? [])
                    .map((item) => (item?.id === undefined || item.id === null ? '' : String(item.id)))
                    .filter(Boolean)
            );
        return { albums: ids(data.albums?.items), tracks: ids(data.tracks?.items) };
    }

    // --------------------------------------------------------------
    // Discovery
    // --------------------------------------------------------------

    private parseGenreId(value: unknown): string | undefined {
        if (value === undefined || value === null || value === '') return undefined;
        return parseInput(numericIdSchema, value, 'genre id');
    }

    async getFeaturedAlbums(type: FeaturedAlbumType, options: FeaturedQuery = {}): Promise<PageResult<Album>> {
        const featuredType = parseInput(featuredAlbumTypeSchema, type, 'featured album type');
        const genreId = this.parseGenreId(options.genreId);
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const data = unwrap(
            await this.api.getFeaturedAlbums(featuredType, { ...(genreId ? { genreId } : {}), limit, offset }),
            'Could not load featured albums'
        );
        return paginate(data.albums?.items ?? [], data.albums?.total, offset, data.albums?.limit ?? limit);
    }

    async getFeaturedPlaylists(
        type: FeaturedPlaylistType,
        options: FeaturedQuery = {}
    ): Promise<PageResult<PlaylistListItem>> {
        const featuredType = parseInput(featuredPlaylistTypeSchema, type, 'featured playlist type');
        const genreId = this.parseGenreId(options.genreId);
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const data = unwrap(
            await this.api.getFeaturedPlaylists(featuredType, { ...(genreId ? { genreId } : {}), limit, offset }),
            'Could not load featured playlists'
        );
        return paginate(
            data.playlists?.items ?? [],
            data.playlists?.total,
            offset,
            data.playlists?.limit ?? limit
        );
    }

    async getLabel(labelId: string | number, options: PageOptions = {}): Promise<LabelPage> {
        const id = parseInput(numericIdSchema, labelId, 'label id');
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const data = unwrap(await this.api.getLabel(id, limit, offset), `Label ${id} could not be loaded`);
        const { albums, ...label } = data;
        return {
            label,
            albums: paginate(albums?.items ?? [], albums?.total ?? label.albums_count, offset, albums?.limit ?? limit)
        };
    }

    async getSimilarArtists(artistId: string | number, options: PageOptions = {}): Promise<PageResult<Artist>> {
        const id = parseInput(numericIdSchema, artistId, 'artist id');
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_SIMILAR_ARTISTS_LIMIT);
        const data = unwrap(
            await this.api.getSimilarArtists(id, limit, offset),
            `Similar artists of ${id} could not be loaded`
        );
        return paginate(data.artists?.items ?? [], data.artists?.total, offset, data.artists?.limit ?? limit);
    }

    async getArtistReleases(
        artistId: string | number,
        options: ArtistReleasesQuery = {}
    ): Promise<ArtistReleasesPage> {
        const id = parseInput(numericIdSchema, artistId, 'artist id');
        const releaseType =
            options.releaseType === undefined
                ? undefined
                : parseInput(
                      z.union([artistReleaseTypeSchema, z.array(artistReleaseTypeSchema).min(1).max(8)]),
                      options.releaseType,
                      'release type'
                  );
        const sort = options.sort === undefined ? undefined : parseInput(artistReleaseSortSchema, options.sort, 'sort');
        const order = options.order === undefined ? undefined : parseInput(sortOrderSchema, options.order, 'order');
        const { limit, offset } = normalizePage(options, DEFAULT_LIST_LIMIT, MAX_ARTIST_RELEASES_LIMIT);
        const data = unwrap(
            await this.api.getArtistReleases(id, {
                ...(releaseType !== undefined ? { releaseType } : {}),
                ...(sort !== undefined ? { sort } : {}),
                ...(order !== undefined ? { order } : {}),
                limit,
                offset
            }),
            `Releases of artist ${id} could not be loaded`
        );
        const items = data.items ?? [];
        const hasMore = data.has_more === true;
        return {
            items,
            total: hasMore ? null : offset + items.length,
            offset,
            limit,
            has_more: hasMore
        };
    }

    // --------------------------------------------------------------
    // Account & URLs
    // --------------------------------------------------------------

    /** Only non-sensitive account fields (no email, no token, no credentials). */
    async getAccountInfo(): Promise<AccountInfo> {
        const user = unwrap(await this.api.getUserInfo(), 'Could not load the Qobuz account');
        const parameters = user.credential?.parameters ?? {};
        const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
        return {
            id: String(user.id ?? ''),
            login: text(user.login),
            display_name: text(user.display_name) ?? text(user.login),
            country: text(user.country_code) ?? text(user.country),
            subscription: user.subscription
                ? {
                      offer: text(user.subscription.offer),
                      periodicity: text(user.subscription.periodicity),
                      end_date: text(user.subscription.period_end_date) ?? text(user.subscription.end_date)
                  }
                : null,
            credential_label: text(user.credential?.label),
            streaming: {
                hires: parameters.hires_streaming === true || user.hires_streaming === true,
                lossless: parameters.lossless_streaming === true || parameters.hires_streaming === true
            }
        };
    }

    /**
     * Resolve a Qobuz link to `{type, id}`. With `details`, also fetch the
     * entity and attach its compact summary.
     */
    async resolveUrl(url: string, options: { details?: boolean } = {}): Promise<ResolvedUrl> {
        const text = parseInput(urlInputSchema, url, 'url');
        const parsed = parseQobuzUrl(text);
        if (!parsed) {
            throw new ValidationError(
                'Not a recognised Qobuz link (expected a track, album, artist, playlist or label URL on qobuz.com)'
            );
        }
        const result: ResolvedUrl = { type: parsed.type, id: parsed.id, url: text };
        if (!options.details) return result;

        switch (parsed.type) {
            case 'album': {
                const albumId = parseInput(albumIdSchema, parsed.id, 'album id');
                result.summary = toAlbumSummary(unwrap(await this.api.getAlbum(albumId), 'Album not found'));
                break;
            }
            case 'track':
                result.summary = toTrackSummary(unwrap(await this.api.getTrack(parsed.id), 'Track not found'));
                break;
            case 'artist':
                result.summary = toArtistSummary(
                    unwrap(await this.api.getArtist(parsed.id, 0, 1, 0, 1), 'Artist not found')
                );
                break;
            case 'playlist':
                result.summary = toPlaylistSummary(
                    unwrap(await this.api.getPlaylistPage(parsed.id, 1, 0), 'Playlist not found'),
                    this.currentUserId()
                );
                break;
            case 'label':
                result.summary = toLabelSummary(unwrap(await this.api.getLabel(parsed.id, 1, 0), 'Label not found'));
                break;
        }
        return result;
    }
}

export const qobuzLibraryService = new QobuzLibraryService();

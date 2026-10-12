import { z } from 'zod';
import { ValidationError } from '../../utils/errors.js';
import { QOBUZ_ALBUM_ID_PATTERN } from '../../constants.js';
import {
    ARTIST_RELEASE_SORTS,
    ARTIST_RELEASE_TYPES,
    FAVORITE_TYPES,
    FEATURED_ALBUM_TYPES,
    FEATURED_PLAYLIST_TYPES,
    MAX_FAVORITE_IDS_PER_TYPE,
    MAX_LIST_OFFSET,
    MAX_PLAYLIST_TRACKS_PER_CALL,
    PLAYLIST_DESCRIPTION_MAX,
    PLAYLIST_FILTERS,
    PLAYLIST_NAME_MAX,
    PURCHASE_TYPES,
    SORT_ORDERS
} from './constants.js';

/** Qobuz album id: alphanumeric string (e.g. `0075679933652`, `p0d55tt7gv3lc`). */
export const albumIdSchema = z
    .string()
    .trim()
    .regex(QOBUZ_ALBUM_ID_PATTERN, 'must be an alphanumeric Qobuz album id (1-40 characters)');

/**
 * Track/artist/playlist/label/genre id or `playlist_track_id`: a positive
 * integer given as number or digit string, normalized to a digit string. No
 * int32 limit (playlist_track_id exceeds 2^31).
 */
export const numericIdSchema = z
    .union([
        z.number().int().positive(),
        z.string().trim().regex(/^\d{1,20}$/, 'must be a positive integer id')
    ])
    .transform((value) => String(value).replace(/^0+/, ''))
    .refine((value) => value.length > 0, 'must be a positive integer id');

export const favoriteTypeSchema = z.enum(FAVORITE_TYPES);
export const purchaseTypeSchema = z.enum(PURCHASE_TYPES);
export const playlistFilterSchema = z.enum(PLAYLIST_FILTERS);
export const featuredAlbumTypeSchema = z.enum(FEATURED_ALBUM_TYPES);
export const featuredPlaylistTypeSchema = z.enum(FEATURED_PLAYLIST_TYPES);
export const artistReleaseTypeSchema = z.enum(ARTIST_RELEASE_TYPES);
export const artistReleaseSortSchema = z.enum(ARTIST_RELEASE_SORTS);
export const sortOrderSchema = z.enum(SORT_ORDERS);

const favoriteIdListShape = {
    albumIds: z.array(albumIdSchema).max(MAX_FAVORITE_IDS_PER_TYPE).optional(),
    trackIds: z.array(numericIdSchema).max(MAX_FAVORITE_IDS_PER_TYPE).optional(),
    artistIds: z.array(numericIdSchema).max(MAX_FAVORITE_IDS_PER_TYPE).optional()
};

export const favoriteIdsInputSchema = z.object(favoriteIdListShape);
export type FavoriteIdsInputParsed = z.output<typeof favoriteIdsInputSchema>;

const playlistTrackIdList = z.array(numericIdSchema).max(MAX_PLAYLIST_TRACKS_PER_CALL);

export const createPlaylistInputSchema = z.object({
    name: z.string().trim().min(1, 'is required').max(PLAYLIST_NAME_MAX),
    description: z.string().max(PLAYLIST_DESCRIPTION_MAX).optional(),
    isPublic: z.boolean().optional(),
    isCollaborative: z.boolean().optional(),
    trackIds: playlistTrackIdList.optional(),
    albumId: albumIdSchema.optional()
});

export const updatePlaylistInputSchema = z
    .object({
        name: z.string().trim().min(1, 'cannot be empty').max(PLAYLIST_NAME_MAX).optional(),
        description: z.string().max(PLAYLIST_DESCRIPTION_MAX).optional(),
        isPublic: z.boolean().optional(),
        isCollaborative: z.boolean().optional()
    })
    .refine(
        (patch) => Object.values(patch).some((value) => value !== undefined),
        'Provide at least one of name, description, isPublic, isCollaborative'
    );

export const addTracksInputSchema = z
    .object({
        trackIds: playlistTrackIdList.optional(),
        albumId: albumIdSchema.optional(),
        allowDuplicates: z.boolean().optional()
    })
    .refine(
        (input) => (input.trackIds?.length ?? 0) > 0 || input.albumId !== undefined,
        'Provide trackIds or albumId'
    );

export const removeTracksInputSchema = z
    .object({
        playlistTrackIds: playlistTrackIdList.optional(),
        trackIds: playlistTrackIdList.optional()
    })
    .refine(
        (input) => (input.playlistTrackIds?.length ?? 0) + (input.trackIds?.length ?? 0) > 0,
        'Provide playlistTrackIds or trackIds'
    );

/** Validate `input` with `schema`, throwing a ValidationError (400) on failure. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, label = 'input'): z.output<S> {
    const result = schema.safeParse(input);
    if (!result.success) {
        throw ValidationError.fromZod(result.error, `Invalid ${label}`);
    }
    return result.data;
}

function toFiniteNumber(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
    if (!Number.isFinite(n)) {
        throw new ValidationError(`Invalid ${field}: must be a number`, [
            { path: field, message: 'must be a number' }
        ]);
    }
    return Math.trunc(n);
}

export interface PageOptions {
    limit?: number | string;
    offset?: number | string;
}

/**
 * Lenient paging: numbers or numeric strings are clamped into range
 * (limit 1..max, offset 0..1e6); anything non-numeric is a ValidationError.
 */
export function normalizePage(
    options: PageOptions | undefined,
    defaultLimit: number,
    maxLimit: number
): { limit: number; offset: number } {
    const limit = toFiniteNumber(options?.limit, 'limit');
    const offset = toFiniteNumber(options?.offset, 'offset');
    return {
        limit: Math.min(maxLimit, Math.max(1, limit ?? defaultLimit)),
        offset: Math.min(MAX_LIST_OFFSET, Math.max(0, offset ?? 0))
    };
}

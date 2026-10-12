import { create } from 'zustand';
import { apiJson } from '../utils/api';

export type FavoriteKind = 'album' | 'track' | 'artist';

interface FavoriteIds {
    albums: string[];
    tracks: string[];
    artists: string[];
}

const bucketOf: Record<FavoriteKind, keyof FavoriteIds> = {
    album: 'albums',
    track: 'tracks',
    artist: 'artists'
};

const bodyKeyOf: Record<FavoriteKind, 'albumIds' | 'trackIds' | 'artistIds'> = {
    album: 'albumIds',
    track: 'trackIds',
    artist: 'artistIds'
};

interface FavoritesState {
    albums: Set<string>;
    tracks: Set<string>;
    artists: Set<string>;
    loaded: boolean;
    loading: boolean;
    /** Ids currently being written, so a heart cannot be double-clicked. */
    pending: Set<string>;
    load: (force?: boolean) => Promise<void>;
    isFavorite: (kind: FavoriteKind, id: string | number) => boolean;
    /**
     * Optimistically flips the favorite and writes it to Qobuz. Rolls back and
     * rethrows when the server refuses. Returns the new state.
     */
    toggle: (kind: FavoriteKind, id: string | number) => Promise<boolean>;
}

const pendingKey = (kind: FavoriteKind, id: string) => `${kind}:${id}`;

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
    albums: new Set(),
    tracks: new Set(),
    artists: new Set(),
    loaded: false,
    loading: false,
    pending: new Set(),

    load: async (force = false) => {
        const state = get();
        if (state.loading || (state.loaded && !force)) return;
        set({ loading: true });
        try {
            const ids = await apiJson<FavoriteIds>('/api/favorites/ids');
            set({
                albums: new Set(ids.albums ?? []),
                tracks: new Set(ids.tracks ?? []),
                artists: new Set(ids.artists ?? []),
                loaded: true
            });
        } catch (err) {
            // No Qobuz login or offline: hearts simply show as empty.
            console.warn('Could not load favorites', err);
        } finally {
            set({ loading: false });
        }
    },

    isFavorite: (kind, id) => get()[bucketOf[kind]].has(String(id)),

    toggle: async (kind, rawId) => {
        const id = String(rawId);
        const key = pendingKey(kind, id);
        if (get().pending.has(key)) return get().isFavorite(kind, id);

        const bucket = bucketOf[kind];
        const wasFavorite = get()[bucket].has(id);
        const apply = (favorite: boolean) =>
            set((state) => {
                const next = new Set(state[bucket]);
                if (favorite) next.add(id);
                else next.delete(id);
                return { [bucket]: next } as Pick<FavoritesState, typeof bucket>;
            });

        apply(!wasFavorite);
        set((state) => ({ pending: new Set(state.pending).add(key) }));
        try {
            await apiJson('/api/favorites', {
                method: wasFavorite ? 'DELETE' : 'POST',
                body: { [bodyKeyOf[kind]]: [id] }
            });
            return !wasFavorite;
        } catch (err) {
            apply(wasFavorite);
            throw err;
        } finally {
            set((state) => {
                const next = new Set(state.pending);
                next.delete(key);
                return { pending: next };
            });
        }
    }
}));

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

/** The running load; concurrent callers share it. */
let inflight: Promise<void> | null = null;
/** Identifies the newest load, so a superseded one cannot clear its state. */
let loadRun = 0;
/** Set when `load(true)` is called while a load runs. */
let reloadQueued = false;
/** Bumped by every local change; `lastToggle` maps `kind:id` to its latest bump. */
let toggleSeq = 0;
const lastToggle = new Map<string, number>();

export const useFavoritesStore = create<FavoritesState>((set, get) => {
    /**
     * Fetches the ids and replaces the sets, except for ids toggled while the
     * request ran or still being written: the server snapshot may predate
     * those writes, so their local state wins.
     */
    const fetchIds = async () => {
        const startSeq = toggleSeq;
        const pendingAtStart = new Set(get().pending);
        try {
            const ids = await apiJson<FavoriteIds>('/api/favorites/ids');
            set((state) => {
                const keepLocal = new Set([...pendingAtStart, ...state.pending]);
                for (const [key, seq] of lastToggle) {
                    if (seq > startSeq) keepLocal.add(key);
                    else lastToggle.delete(key);
                }
                const next = {
                    albums: new Set((ids.albums ?? []).map(String)),
                    tracks: new Set((ids.tracks ?? []).map(String)),
                    artists: new Set((ids.artists ?? []).map(String))
                };
                for (const key of keepLocal) {
                    const separator = key.indexOf(':');
                    const bucket = bucketOf[key.slice(0, separator) as FavoriteKind];
                    const id = key.slice(separator + 1);
                    if (state[bucket].has(id)) next[bucket].add(id);
                    else next[bucket].delete(id);
                }
                return { ...next, loaded: true };
            });
        } catch (err) {
            // No Qobuz login or offline: hearts simply show as empty.
            console.warn('Could not load favorites', err);
        }
    };

    return {
        albums: new Set(),
        tracks: new Set(),
        artists: new Set(),
        loaded: false,
        loading: false,
        pending: new Set(),

        load: (force = false) => {
            // `loading` mirrors `inflight`; a store reset (tests) clears it and starts afresh.
            if (inflight && get().loading) {
                // A forced reload requested during a load (e.g. after an account
                // change) must not be dropped: it runs once the current one ends.
                if (force) reloadQueued = true;
                return inflight;
            }
            if (get().loaded && !force) return Promise.resolve();

            set({ loading: true });
            reloadQueued = false;
            const run = ++loadRun;
            inflight = (async () => {
                try {
                    do {
                        reloadQueued = false;
                        await fetchIds();
                    } while (reloadQueued && run === loadRun);
                } finally {
                    if (run === loadRun) {
                        inflight = null;
                        set({ loading: false });
                    }
                }
            })();
            return inflight;
        },

        isFavorite: (kind, id) => get()[bucketOf[kind]].has(String(id)),

        toggle: async (kind, rawId) => {
            const id = String(rawId);
            const key = pendingKey(kind, id);
            if (get().pending.has(key)) return get().isFavorite(kind, id);

            const bucket = bucketOf[kind];
            const wasFavorite = get()[bucket].has(id);
            const apply = (favorite: boolean) => {
                lastToggle.set(key, ++toggleSeq);
                set((state) => {
                    const next = new Set(state[bucket]);
                    if (favorite) next.add(id);
                    else next.delete(id);
                    return { [bucket]: next } as Pick<FavoritesState, typeof bucket>;
                });
            };

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
    };
});

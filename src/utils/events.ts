import { EventEmitter } from 'events';

/**
 * Global event bus for inter-service communication.
 * Useful for decoupled communication between backend logic and Electron main process.
 */
class EventBus extends EventEmitter {
    private static instance: EventBus;

    private constructor() {
        super();
        this.setMaxListeners(20);
    }

    static getInstance(): EventBus {
        if (!EventBus.instance) {
            EventBus.instance = new EventBus();
        }
        return EventBus.instance;
    }
}

export const eventBus = EventBus.getInstance();

export const EVENTS = {
    DOWNLOAD: {
        PROGRESS: 'download:progress'
    },
    SETTINGS: {
        UPDATED: 'settings:updated'
    },
    QOBUZ_LIBRARY: {
        /** Payload: QobuzFavoritesUpdatedEvent */
        FAVORITES_UPDATED: 'qobuz-library:favorites-updated',
        /** Payload: QobuzPlaylistsUpdatedEvent */
        PLAYLISTS_UPDATED: 'qobuz-library:playlists-updated'
    }
} as const;

export interface QobuzFavoritesUpdatedEvent {
    action: 'add' | 'remove';
    albumIds: string[];
    trackIds: string[];
    artistIds: string[];
}

export type QobuzPlaylistAction =
    | 'create'
    | 'update'
    | 'delete'
    | 'add_tracks'
    | 'remove_tracks'
    | 'follow'
    | 'unfollow';

export interface QobuzPlaylistsUpdatedEvent {
    action: QobuzPlaylistAction;
    playlistId: string;
}

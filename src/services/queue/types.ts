export type QualityOption = number | 'ask' | 'min' | 'max';

/** Every content type the queue can hold. Keep in sync with DOWNLOAD_TYPES. */
export const DOWNLOAD_TYPES = ['track', 'album', 'playlist', 'artist', 'label'] as const;
export type DownloadType = (typeof DOWNLOAD_TYPES)[number];

/**
 * Types that expand into several downloads. Artists and labels do not download
 * anything themselves: the processor enqueues one album item per release.
 */
export type BatchDownloadType = Exclude<DownloadType, 'track'>;

export type SearchCategory = 'tracks' | 'albums' | 'artists' | 'playlists';

export type QueueItemStatus =
    | 'pending'
    | 'downloading'
    | 'processing'
    | 'uploading'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled';

/** Statuses of an item that is waiting for or holding a processing slot. */
export const LIVE_QUEUE_STATUSES: readonly QueueItemStatus[] = [
    'pending',
    'downloading',
    'processing',
    'uploading'
];

/** Statuses of an item whose task is currently running. */
export const ACTIVE_QUEUE_STATUSES: readonly QueueItemStatus[] = [
    'downloading',
    'processing',
    'uploading'
];

export const QUEUE_PRIORITIES = ['low', 'normal', 'high'] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export interface QueueItemMetadata {
    source?: string;
    batchId?: string;
    albumId?: string;
    artistId?: string;
    labelId?: string;
    playlistId?: string;
    /** Queue id of the artist/label item that expanded into this item. */
    parentQueueId?: string;
    batchFiles?: string[];
    /** Set only by server-side code (library upgrade); never taken from a request. */
    isUpgrade?: boolean;
    oldFilePath?: string;
    libraryFileId?: string | number;
    /** Re-download even when the target file already exists. */
    forceRedownload?: boolean;
    [key: string]: string | number | boolean | string[] | undefined | null;
}

export interface QueueItem {
    id: string;
    type: DownloadType;
    contentId: string | number;
    quality: number;
    status: QueueItemStatus;
    priority: QueuePriority;
    progress: number;
    title?: string;
    artist?: string;
    album?: string;
    error?: string;
    filePath?: string;
    addedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    retryCount: number;
    maxRetries: number;
    metadata?: QueueItemMetadata;
    /**
     * True while a failed item waits for its automatic retry. Not persisted:
     * the retry timer does not survive a restart, so neither does the flag.
     */
    awaitingRetry?: boolean;
}

export interface QueueStats {
    total: number;
    pending: number;
    downloading: number;
    processing: number;
    completed: number;
    partial: number;
    failed: number;
    cancelled: number;
}

export interface QueueAddOptions {
    title?: string;
    priority?: QueuePriority;
    maxRetries?: number;
    metadata?: QueueItemMetadata;
}

/** Result of {@link DownloadQueue.addWithResult}. */
export interface QueueAddResult {
    item: QueueItem;
    /** True when a live item for the same content already existed and was returned instead. */
    deduped: boolean;
}

export type QueueMutationFailure = 'not_found' | 'invalid_state' | 'duplicate';

/** Outcome of a queue mutation that can be refused (retry, cancel, priority change). */
export type QueueMutationResult =
    | { ok: true; item: QueueItem }
    | { ok: false; reason: QueueMutationFailure; item?: QueueItem; message: string };

export interface DownloadRequest {
    id: string | number;
    type: DownloadType;
    quality: number;
    url?: string;
    priority?: QueuePriority;
}

export interface InfoResult {
    type: DownloadType;
    id: string | number;
    title: string;
    artist?: string;
    tracksCount?: number;
    releaseDate?: string;
    coverUrl?: string;
}

export interface QueueFailOptions {
    /** The processor will requeue the item automatically after a back-off. */
    willRetry?: boolean;
}

export type QueueEvents = {
    'item:added': (item: QueueItem) => void;
    'item:started': (item: QueueItem) => void;
    'item:progress': (item: QueueItem, progress: number) => void;
    'item:completed': (item: QueueItem) => void;
    /** Emitted on every failed attempt; `item.awaitingRetry` tells whether it is terminal. */
    'item:failed': (item: QueueItem, error: string, options: QueueFailOptions) => void;
    'item:cancelled': (item: QueueItem) => void;
    'item:retried': (item: QueueItem) => void;
    'item:removed': (item: QueueItem) => void;
    'item:updated': (item: QueueItem) => void;
    'queue:empty': () => void;
    'queue:paused': () => void;
    'queue:resumed': () => void;
    [key: string]: (...args: never[]) => void;
};

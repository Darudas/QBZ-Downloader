import { EventEmitter } from 'events';
import {
    ACTIVE_QUEUE_STATUSES,
    DownloadType,
    LIVE_QUEUE_STATUSES,
    QueueAddOptions,
    QueueAddResult,
    QueueFailOptions,
    QueueItem,
    QueueItemMetadata,
    QueueItemStatus,
    QueueMutationResult,
    QueuePriority,
    QueueStats
} from './types.js';
import { generateQueueId, isDownloadType, isQueuePriority, QueueRequestError } from './utils.js';
import { checkUpgradeSource } from './upgrade-guard.js';
import { logger } from '../../utils/logger.js';
import { databaseService } from '../database/index.js';
import { eventBus, EVENTS } from '../../utils/events.js';
import { CONFIG, normalizeDownloadQuality } from '../../config.js';

const PRIORITY_ORDER: Record<QueuePriority, number> = { high: 0, normal: 1, low: 2 };

/** Statuses a user can send back to the queue with {@link DownloadQueue.retry}. */
const RETRYABLE_STATUSES: readonly QueueItemStatus[] = ['failed', 'cancelled', 'partial'];

/** Statuses whose priority still matters (now, or after a retry). */
const PRIORITY_EDITABLE_STATUSES: readonly QueueItemStatus[] = [
    'pending',
    'failed',
    'cancelled',
    'partial'
];

const CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TITLE_LENGTH = 300;
const MAX_RETRIES_LIMIT = 10;

const isLive = (status: QueueItemStatus): boolean => LIVE_QUEUE_STATUSES.includes(status);
const isActive = (status: QueueItemStatus): boolean => ACTIVE_QUEUE_STATUSES.includes(status);

function normalizeContentId(contentId: unknown): string {
    const value =
        typeof contentId === 'number' && Number.isFinite(contentId)
            ? String(contentId)
            : typeof contentId === 'string'
              ? contentId.trim()
              : '';
    if (!CONTENT_ID_PATTERN.test(value)) {
        throw new QueueRequestError('Invalid content id', 400, 'INVALID_ID');
    }
    return value;
}

function normalizeTitle(title: unknown): string | undefined {
    if (typeof title !== 'string') return undefined;
    const trimmed = title.trim();
    return trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : undefined;
}

function stripUpgradeFields(metadata: QueueItemMetadata): QueueItemMetadata {
    const rest: QueueItemMetadata = { ...metadata };
    delete rest.isUpgrade;
    delete rest.oldFilePath;
    delete rest.libraryFileId;
    return rest;
}

export class DownloadQueue {
    private items: Map<string, QueueItem> = new Map();
    private processing: Set<string> = new Set();
    private maxConcurrent: number;
    private paused: boolean = false;
    private eventEmitter: EventEmitter = new EventEmitter();

    constructor(maxConcurrent: number = 2) {
        this.maxConcurrent = maxConcurrent;
        // Batch trackers, the processor and the dashboard all listen here.
        this.eventEmitter.setMaxListeners(50);
    }

    /**
     * Adds an item, or returns the live item already queued for the same
     * content. Kept for existing callers; prefer {@link addWithResult} when
     * the caller needs to know whether the add was deduplicated.
     */
    add(
        type: DownloadType,
        contentId: string | number,
        quality: number | string,
        options: QueueAddOptions = {}
    ): QueueItem {
        return this.addWithResult(type, contentId, quality, options).item;
    }

    /**
     * Adds an item to the queue.
     *
     * Throws {@link QueueRequestError} (status 400) for an unknown type,
     * priority or malformed content id, and for upgrade metadata whose old
     * file is not a scanned file inside the managed library folders.
     *
     * When a live item (pending, running, or failed and waiting for its
     * automatic retry) already exists for the same type and content id, no
     * second item is created: two live items for the same content download into
     * the same output path concurrently and interleave their writes. That
     * existing item is returned with `deduped: true`; an explicit higher
     * priority is applied to it while it is still pending.
     */
    addWithResult(
        type: DownloadType,
        contentId: string | number,
        quality: number | string,
        options: QueueAddOptions = {}
    ): QueueAddResult {
        if (!isDownloadType(type)) {
            throw new QueueRequestError(
                `Unsupported queue item type: ${String(type).slice(0, 40)}`,
                400,
                'INVALID_TYPE'
            );
        }
        if (options.priority !== undefined && !isQueuePriority(options.priority)) {
            throw new QueueRequestError(
                'Invalid priority (expected low, normal or high)',
                400,
                'INVALID_PRIORITY'
            );
        }
        const normalizedId = normalizeContentId(contentId);

        const existing = this.findLive(type, normalizedId);
        if (existing) {
            if (
                options.priority &&
                existing.status === 'pending' &&
                PRIORITY_ORDER[options.priority] < PRIORITY_ORDER[existing.priority]
            ) {
                this.applyPriority(existing, options.priority);
            }
            logger.debug(`Queue: ${type} ${normalizedId} already queued (${existing.id})`);
            return { item: existing, deduped: true };
        }

        const metadata = this.prepareMetadata(type, options.metadata);
        const maxRetries =
            typeof options.maxRetries === 'number' && Number.isInteger(options.maxRetries)
                ? Math.min(MAX_RETRIES_LIMIT, Math.max(0, options.maxRetries))
                : 3;

        const id = generateQueueId();
        const item: QueueItem = {
            id,
            type,
            contentId: normalizedId,
            quality: normalizeDownloadQuality(quality, CONFIG.quality.default),
            status: 'pending',
            priority: options.priority ?? 'normal',
            progress: 0,
            title: normalizeTitle(options.title),
            addedAt: new Date(),
            retryCount: 0,
            maxRetries,
            metadata
        };

        this.items.set(id, item);
        databaseService.addQueueItem(item);

        this.emit('item:added', item);
        logger.debug(`Queue: Added ${type} ${normalizedId} (${id})`);

        return { item, deduped: false };
    }

    /**
     * Upgrade metadata makes the processor delete `oldFilePath` after a
     * successful download, so it is only accepted for tracks and only when the
     * path is a scanned library file inside the managed folders.
     */
    private prepareMetadata(
        type: DownloadType,
        metadata: QueueItemMetadata | undefined
    ): QueueItemMetadata | undefined {
        if (!metadata) return undefined;
        if (metadata.isUpgrade !== true) {
            return metadata.oldFilePath !== undefined ? stripUpgradeFields(metadata) : metadata;
        }
        if (type !== 'track') {
            throw new QueueRequestError(
                'Only track items can be library upgrades',
                400,
                'INVALID_UPGRADE_SOURCE'
            );
        }
        const check = checkUpgradeSource(metadata.oldFilePath, { requireExists: true });
        if (!check.ok) {
            throw new QueueRequestError(
                `Upgrade rejected: ${check.reason}`,
                400,
                'INVALID_UPGRADE_SOURCE'
            );
        }
        return { ...metadata };
    }

    getNext(): QueueItem | null {
        if (this.paused) return null;
        return this.getOrderedPending()[0] || null;
    }

    private getOrderedPending(): QueueItem[] {
        return Array.from(this.items.values())
            .filter((item) => item.status === 'pending')
            .sort((a, b) => {
                const priorityDiff =
                    (PRIORITY_ORDER[a.priority] ?? PRIORITY_ORDER.normal) -
                    (PRIORITY_ORDER[b.priority] ?? PRIORITY_ORDER.normal);
                if (priorityDiff !== 0) return priorityDiff;
                return a.addedAt.getTime() - b.addedAt.getTime();
            });
    }

    dequeue(): QueueItem | null {
        if (this.paused) return null;
        if (this.processing.size >= this.maxConcurrent) return null;

        const item = this.getNext();
        if (item) {
            const success = this.startItem(item.id);
            if (success) {
                return item;
            }
            // If starting failed (someone else got it), try the next one
            return this.dequeue();
        }
        return null;
    }

    startItem(id: string): boolean {
        const item = this.items.get(id);
        if (!item || item.status !== 'pending') return false;

        // Final concurrency guard
        if (this.processing.size >= this.maxConcurrent) return false;

        item.status = 'downloading';
        item.startedAt = new Date();
        this.processing.add(id);

        databaseService.updateQueueItemStatus(id, 'downloading', item.progress);

        this.emit('item:started', item);
        logger.debug(`Queue: Started ${id}`);

        return true;
    }

    updateProgress(id: string, progress: number, status?: QueueItemStatus): void {
        const item = this.items.get(id);
        // Progress from a task that was cancelled, failed or already finished
        // must not flip the item back to a running status.
        if (!item || !isActive(item.status)) return;

        item.progress = Math.min(100, Math.max(0, progress));
        if (status && item.status !== status) {
            item.status = status;

            // If status changed to a finished state, remove from processing
            if (!isActive(status)) {
                this.processing.delete(id);
            }
        }
        databaseService.updateQueueItemStatus(id, item.status, item.progress);
        this.emit('item:progress', item, progress);
        this.emitGlobalProgress();
    }

    updateItemDetails(id: string, details: { title?: string; artist?: string; album?: string }): void {
        const item = this.items.get(id);
        if (!item) return;

        const title = normalizeTitle(details.title);
        if (title) item.title = title;
        if (details.artist) item.artist = details.artist;
        if (details.album) item.album = details.album;

        databaseService.addQueueItem(item);
        this.emit('item:progress', item, item.progress);
    }

    /**
     * Merges processor bookkeeping (batch file lists, fan-out counts) into the
     * item metadata. Upgrade fields can only be set through
     * {@link addWithResult}, where they are validated.
     */
    updateMetadata(id: string, metadata: Partial<QueueItemMetadata>): void {
        const item = this.items.get(id);
        if (!item) return;

        const update: Partial<QueueItemMetadata> = { ...metadata };
        delete update.isUpgrade;
        delete update.oldFilePath;
        delete update.libraryFileId;

        item.metadata = {
            ...(item.metadata || {}),
            ...update
        } as QueueItemMetadata;

        databaseService.addQueueItem(item);
        this.emit('item:progress', item, item.progress);
    }

    updateQuality(id: string, quality: number | string): void {
        const item = this.items.get(id);
        if (!item) return;

        item.quality = normalizeDownloadQuality(quality, item.quality);
        databaseService.addQueueItem(item);
        this.emit('item:progress', item, item.progress);
    }

    complete(id: string, filePath?: string): void {
        this.finish(id, 'completed', filePath);
    }

    completePartial(id: string, filePath?: string): void {
        this.finish(id, 'partial', filePath);
    }

    private finish(id: string, status: 'completed' | 'partial', filePath?: string): void {
        const item = this.items.get(id);
        // A task that finishes after the user cancelled it keeps the
        // cancelled status: the user asked for it to stop.
        if (!item || item.status === 'cancelled') return;

        item.status = status;
        item.progress = 100;
        item.completedAt = new Date();
        item.awaitingRetry = false;
        if (filePath) item.filePath = filePath;
        this.processing.delete(id);

        databaseService.addQueueItem(item);

        this.emit('item:completed', item);
        logger.debug(
            status === 'completed' ? `Queue: Completed ${id}` : `Queue: Completed with errors ${id}`
        );

        this.checkQueueEmpty();
    }

    /**
     * Marks an attempt as failed and increments `retryCount`. Pass
     * `willRetry: true` when the processor is going to requeue the item: the
     * item is then still live (deduplication matches it) and listeners can tell
     * the failure is not terminal from `item.awaitingRetry`.
     */
    fail(id: string, error: string, options: QueueFailOptions = {}): void {
        const item = this.items.get(id);
        if (!item || item.status === 'cancelled') return;

        const willRetry = options.willRetry === true;
        item.error = error;
        item.retryCount++;
        item.status = 'failed';
        item.completedAt = new Date();
        item.awaitingRetry = willRetry;
        this.processing.delete(id);
        databaseService.addQueueItem(item);

        this.emit('item:failed', item, error, { willRetry });
        if (willRetry) {
            logger.debug(`Queue: Attempt failed for ${id}, retry scheduled: ${error}`);
        } else {
            logger.error(`Queue: Failed ${id}: ${error}`);
        }

        this.checkQueueEmpty();
    }

    /**
     * Automatic retry after a failed attempt. Keeps `retryCount`. Refused for
     * a running item and when another live item for the same content exists.
     */
    requeue(id: string): boolean {
        const item = this.items.get(id);
        if (!item || this.processing.has(id) || isLive(item.status)) return false;
        if (item.status === 'cancelled') return false;
        if (this.findLive(item.type, item.contentId, id)) return false;

        this.resetForQueue(item);

        databaseService.addQueueItem(item);
        this.emit('item:added', item);
        logger.debug(`Queue: Re-queued ${id} (Retry ${item.retryCount}/${item.maxRetries})`);
        return true;
    }

    /**
     * User retry: sends a failed, cancelled or partially completed item back
     * to the queue with a fresh retry budget.
     */
    retry(id: string): QueueMutationResult {
        const item = this.items.get(id);
        if (!item) return { ok: false, reason: 'not_found', message: 'Queue item not found' };

        if (!RETRYABLE_STATUSES.includes(item.status) || this.processing.has(id)) {
            return {
                ok: false,
                reason: 'invalid_state',
                item,
                message: isLive(item.status)
                    ? 'Item is already queued or downloading'
                    : `Item with status "${item.status}" cannot be retried`
            };
        }

        const duplicate = this.findLive(item.type, item.contentId, id);
        if (duplicate) {
            return {
                ok: false,
                reason: 'duplicate',
                item: duplicate,
                message: `This content is already queued (${duplicate.id})`
            };
        }

        item.retryCount = 0;
        this.resetForQueue(item);

        databaseService.addQueueItem(item);
        this.emit('item:retried', item);
        this.emit('item:added', item);
        logger.debug(`Queue: Retrying ${id}`);
        return { ok: true, item };
    }

    /** Retries every failed item; returns how many went back to the queue. */
    retryAllFailed(): number {
        let count = 0;
        for (const item of Array.from(this.items.values())) {
            if (item.status === 'failed' && this.retry(item.id).ok) count++;
        }
        return count;
    }

    setPriority(id: string, priority: QueuePriority): QueueMutationResult {
        if (!isQueuePriority(priority)) {
            throw new QueueRequestError(
                'Invalid priority (expected low, normal or high)',
                400,
                'INVALID_PRIORITY'
            );
        }
        const item = this.items.get(id);
        if (!item) return { ok: false, reason: 'not_found', message: 'Queue item not found' };
        if (!PRIORITY_EDITABLE_STATUSES.includes(item.status)) {
            return {
                ok: false,
                reason: 'invalid_state',
                item,
                message: `Priority cannot be changed while the item is ${item.status}`
            };
        }

        this.applyPriority(item, priority);
        return { ok: true, item };
    }

    private applyPriority(item: QueueItem, priority: QueuePriority): void {
        if (item.priority === priority) return;
        item.priority = priority;
        databaseService.addQueueItem(item);
        this.emit('item:updated', item);
        this.emit('item:progress', item, item.progress);
    }

    private resetForQueue(item: QueueItem): void {
        item.status = 'pending';
        item.progress = 0;
        item.error = undefined;
        item.startedAt = undefined;
        item.completedAt = undefined;
        item.awaitingRetry = false;
    }

    getPendingItems(): QueueItem[] {
        return Array.from(this.items.values()).filter((item) => item.status === 'pending');
    }

    get(id: string): QueueItem | undefined {
        return this.items.get(id);
    }

    /**
     * Cancels a pending or running item, or one waiting for its automatic
     * retry. The item stays in the queue with status `cancelled` (so it can be
     * retried) and `item:cancelled` is emitted; a cancellation is not a
     * failure and does not trigger error notifications.
     */
    cancelWithResult(id: string): QueueMutationResult {
        const item = this.items.get(id);
        if (!item) return { ok: false, reason: 'not_found', message: 'Queue item not found' };

        const cancellable = isLive(item.status) || (item.status === 'failed' && item.awaitingRetry);
        if (!cancellable) {
            return {
                ok: false,
                reason: 'invalid_state',
                item,
                message: `Item with status "${item.status}" cannot be cancelled`
            };
        }

        this.processing.delete(id);
        item.status = 'cancelled';
        item.error = 'Cancelled by user';
        item.completedAt = new Date();
        item.awaitingRetry = false;

        databaseService.addQueueItem(item);
        this.emit('item:cancelled', item);
        logger.debug(`Queue: Cancelled ${id}`);

        this.checkQueueEmpty();
        return { ok: true, item };
    }

    cancel(id: string): boolean {
        return this.cancelWithResult(id).ok;
    }

    remove(id: string): boolean {
        const item = this.items.get(id);
        if (!item) return false;

        if (this.processing.has(id)) {
            return false;
        }

        this.deleteItem(item);
        return true;
    }

    private deleteItem(item: QueueItem): void {
        this.items.delete(item.id);
        databaseService.removeQueueItem(item.id);
        this.emit('item:removed', item);
    }

    clearCompleted(): number {
        let count = 0;
        for (const item of Array.from(this.items.values())) {
            if (
                item.status === 'completed' ||
                item.status === 'partial' ||
                item.status === 'failed' ||
                item.status === 'cancelled'
            ) {
                this.deleteItem(item);
                count++;
            }
        }
        return count;
    }

    clearPending(): number {
        let count = 0;
        for (const item of Array.from(this.items.values())) {
            if (item.status === 'pending') {
                this.deleteItem(item);
                count++;
            }
        }
        this.checkQueueEmpty();
        return count;
    }

    clear(): number {
        let count = 0;
        for (const item of Array.from(this.items.values())) {
            if (!this.processing.has(item.id) && !isActive(item.status)) {
                this.deleteItem(item);
                count++;
            }
        }
        this.checkQueueEmpty();

        return count;
    }

    getAll(): QueueItem[] {
        return Array.from(this.items.values());
    }

    getByStatus(status: QueueItemStatus): QueueItem[] {
        return Array.from(this.items.values()).filter((item) => item.status === status);
    }

    getStats(): QueueStats {
        const items = Array.from(this.items.values());
        const count = (...statuses: QueueItemStatus[]) =>
            items.filter((i) => statuses.includes(i.status)).length;
        return {
            total: items.length,
            pending: count('pending'),
            downloading: count('downloading'),
            processing: count('processing', 'uploading'),
            completed: count('completed'),
            partial: count('partial'),
            failed: count('failed'),
            cancelled: count('cancelled')
        };
    }

    /** 1-based position among pending items in processing order, or -1. */
    getPosition(id: string): number {
        const index = this.getOrderedPending().findIndex((item) => item.id === id);
        return index >= 0 ? index + 1 : -1;
    }

    hasPending(): boolean {
        return Array.from(this.items.values()).some((item) => item.status === 'pending');
    }

    isProcessing(): boolean {
        return this.processing.size > 0;
    }

    pause(): void {
        this.paused = true;
        this.emit('queue:paused');
        logger.debug('Queue: Paused');
    }

    resume(): void {
        this.paused = false;
        this.emit('queue:resumed');
        logger.debug('Queue: Resumed');
    }

    isPaused(): boolean {
        return this.paused;
    }

    setMaxConcurrent(max: number): void {
        this.maxConcurrent = Math.max(1, max);
    }

    getMaxConcurrent(): number {
        return this.maxConcurrent;
    }

    /**
     * The live item for this content: pending, running, or failed and
     * waiting for its automatic retry.
     */
    findLive(
        type: DownloadType,
        contentId: string | number,
        excludeId?: string
    ): QueueItem | undefined {
        const wanted = contentId.toString();
        return Array.from(this.items.values()).find(
            (item) =>
                item.id !== excludeId &&
                item.type === type &&
                item.contentId.toString() === wanted &&
                (isLive(item.status) || (item.status === 'failed' && item.awaitingRetry === true))
        );
    }

    hasContent(type: DownloadType, contentId: string | number): boolean {
        return this.findLive(type, contentId) !== undefined;
    }

    private checkQueueEmpty(): void {
        if (!this.hasPending() && !this.isProcessing()) {
            this.emit('queue:empty');
            eventBus.emit(EVENTS.DOWNLOAD.PROGRESS, -1);
        }
    }

    private emitGlobalProgress(): void {
        const items = Array.from(this.items.values());
        const activeItems = items.filter(i => i.status === 'downloading' || i.status === 'processing');

        if (activeItems.length === 0) {
            eventBus.emit(EVENTS.DOWNLOAD.PROGRESS, -1);
            return;
        }

        const totalProgress = activeItems.reduce((acc, curr) => acc + curr.progress, 0);
        const averageProgress = totalProgress / activeItems.length / 100;

        eventBus.emit(EVENTS.DOWNLOAD.PROGRESS, averageProgress);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
        this.eventEmitter.on(event, listener as (...args: unknown[]) => void);
        return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
        return this.eventEmitter.emit(event, ...args);
    }

    off(event: string, listener: (...args: unknown[]) => void): this {
        this.eventEmitter.off(event, listener as (...args: unknown[]) => void);
        return this;
    }

    getItems(): QueueItem[] {
        return Array.from(this.items.values());
    }

    async load(): Promise<void> {
        try {
            const persistedItems = databaseService.getQueueItems() as unknown as QueueItem[];
            for (const item of persistedItems) {
                // A config import reloads the queue while downloads run; the
                // in-memory copy of a running item is the authoritative one.
                if (this.processing.has(item.id)) continue;

                let dirty = false;
                if (isActive(item.status)) {
                    item.status = 'pending';
                    item.progress = 0;
                    databaseService.updateQueueItemStatus(item.id, 'pending', 0);
                }
                // Older versions queued whatever type a request named (batch
                // imports even queued Spotify ids); those can never run.
                if (!isDownloadType(item.type) && item.status !== 'failed') {
                    item.status = 'failed';
                    item.error = 'Unsupported queue item type';
                    dirty = true;
                }
                if (!isQueuePriority(item.priority)) {
                    item.priority = 'normal';
                    dirty = true;
                }
                if (item.metadata === null) {
                    item.metadata = undefined;
                }
                if (item.metadata?.isUpgrade === true) {
                    const check =
                        item.type === 'track'
                            ? checkUpgradeSource(item.metadata.oldFilePath)
                            : ({ ok: false, reason: 'not a track' } as const);
                    if (!check.ok) {
                        logger.warn(
                            `Queue: Dropping upgrade flag from ${item.id}: ${check.reason}`,
                            'QUEUE'
                        );
                        item.metadata = stripUpgradeFields(item.metadata);
                        dirty = true;
                    }
                }
                item.awaitingRetry = false;
                item.quality = normalizeDownloadQuality(item.quality, CONFIG.quality.default);
                if (dirty) databaseService.addQueueItem(item);
                this.items.set(item.id, item);
            }
            logger.info(`Queue: Loaded ${persistedItems.length} items from database`, 'QUEUE');
        } catch (error) {
            logger.error(`Queue: Failed to load from database: ${error}`, 'QUEUE');
        }
    }
}

export const downloadQueue = new DownloadQueue(2);

import type Database from 'better-sqlite3';
import { CONFIG } from '../config.js';
import { eventBus, EVENTS } from '../utils/events.js';
import { validateEnvironment } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { databaseService } from './database/index.js';
import { downloadActionsService } from './download-actions.js';
import {
    MAX_FAVORITES_PER_DOWNLOAD,
    queueLibraryIds,
    type LibraryDownloadKind,
    type LibraryIdsQueueResult
} from './favorites-download.js';
import { notificationService } from './notifications.js';
import { qobuzLibraryService } from './qobuz-library/index.js';
import { settingsService } from './settings.js';

/**
 * Favorites auto-download: every `intervalHours` the favorite album/track ids
 * of the Qobuz account are compared with the ids seen before, and favorites
 * that are new since the last check are queued for download.
 *
 * Baseline: the first check for an account and type (and the first check
 * after auto-download is switched on) only records the current favorites as
 * known and downloads nothing. Downloading the whole existing list is what
 * "Download all favorites" (`downloadFavorites`) is for.
 *
 * Known ids live in two small SQLite tables created on first use (see
 * {@link SqliteFavoritesSyncStore}), not in settings: the list can hold
 * thousands of ids, and settings are cached in memory, mirrored into
 * process.env and included in config exports.
 */

export const FAVORITES_SYNC_SOURCE = 'favorites-sync';
export const FAVORITES_SYNC_KINDS: readonly LibraryDownloadKind[] = ['albums', 'tracks'];
export const MIN_FAVORITES_SYNC_INTERVAL_HOURS = 1;
export const MAX_FAVORITES_SYNC_INTERVAL_HOURS = 168;
export const DEFAULT_FAVORITES_SYNC_INTERVAL_HOURS = 6;
/** Delay before a check that is already due when the app starts or the setting changes. */
export const FAVORITES_SYNC_STARTUP_DELAY_MS = 30_000;

const HOUR_MS = 60 * 60 * 1000;

export interface FavoritesSyncSettings {
    autoDownload: boolean;
    types: LibraryDownloadKind[];
    intervalHours: number;
}

/**
 * Reads the favorites auto-download settings. Same shape as the planned
 * `CONFIG.favorites` getter; switch to it once that exists.
 */
export function readFavoritesSyncSettings(): FavoritesSyncSettings {
    const enabled = String(settingsService.get('FAVORITES_AUTO_DOWNLOAD') ?? '').trim().toLowerCase();
    const rawTypes = settingsService.get('FAVORITES_AUTO_DOWNLOAD_TYPES');
    const types =
        rawTypes === undefined
            ? [...FAVORITES_SYNC_KINDS]
            : FAVORITES_SYNC_KINDS.filter((kind) =>
                  rawTypes
                      .split(',')
                      .map((part) => part.trim().toLowerCase())
                      .includes(kind)
              );
    const hours = Number.parseInt(String(settingsService.get('FAVORITES_SYNC_INTERVAL_HOURS') ?? ''), 10);
    return {
        autoDownload: enabled === 'true' || enabled === '1',
        types,
        intervalHours:
            Number.isFinite(hours) &&
            hours >= MIN_FAVORITES_SYNC_INTERVAL_HOURS &&
            hours <= MAX_FAVORITES_SYNC_INTERVAL_HOURS
                ? hours
                : DEFAULT_FAVORITES_SYNC_INTERVAL_HOURS
    };
}

/* ------------------------------------------------------------------ */
/* Store                                                                */
/* ------------------------------------------------------------------ */

export interface FavoritesSyncStore {
    /** True once a baseline was recorded for this account and type. */
    hasBaseline(userId: string, kind: LibraryDownloadKind): boolean;
    /** Replaces the known ids with `ids` and marks the baseline as recorded. */
    recordBaseline(userId: string, kind: LibraryDownloadKind, ids: string[], at: string): void;
    getKnown(userId: string, kind: LibraryDownloadKind): Set<string>;
    addKnown(userId: string, kind: LibraryDownloadKind, ids: string[], at: string): void;
    markSynced(userId: string, kind: LibraryDownloadKind, at: string): void;
    /** Latest check time of this account over the given types (ISO), or null. */
    getLastSyncAt(userId: string, kinds: readonly LibraryDownloadKind[]): string | null;
    /** Forgets the baseline of an account, so the next check records a new one. */
    clearBaseline(userId: string): void;
}

/** SQLite store; the tables are created on first use (no schema migration needed). */
export class SqliteFavoritesSyncStore implements FavoritesSyncStore {
    private ready = false;

    constructor(private readonly getDb: () => Database.Database = () => databaseService.getDb()) {}

    private db(): Database.Database {
        const db = this.getDb();
        if (!this.ready) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS favorites_sync_state (
                    user_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    baseline_at TEXT NOT NULL,
                    last_sync_at TEXT,
                    PRIMARY KEY (user_id, kind)
                );
                CREATE TABLE IF NOT EXISTS favorites_sync_known (
                    user_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, kind, item_id)
                );
            `);
            this.ready = true;
        }
        return db;
    }

    hasBaseline(userId: string, kind: LibraryDownloadKind): boolean {
        return Boolean(
            this.db().prepare('SELECT 1 FROM favorites_sync_state WHERE user_id = ? AND kind = ?').get(userId, kind)
        );
    }

    recordBaseline(userId: string, kind: LibraryDownloadKind, ids: string[], at: string): void {
        const db = this.db();
        db.transaction(() => {
            db.prepare('DELETE FROM favorites_sync_known WHERE user_id = ? AND kind = ?').run(userId, kind);
            this.insertKnown(db, userId, kind, ids, at);
            db.prepare(
                `INSERT INTO favorites_sync_state (user_id, kind, baseline_at, last_sync_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, kind) DO UPDATE SET baseline_at = excluded.baseline_at,
                    last_sync_at = excluded.last_sync_at`
            ).run(userId, kind, at, at);
        })();
    }

    getKnown(userId: string, kind: LibraryDownloadKind): Set<string> {
        const rows = this.db()
            .prepare('SELECT item_id FROM favorites_sync_known WHERE user_id = ? AND kind = ?')
            .all(userId, kind) as Array<{ item_id: string }>;
        return new Set(rows.map((row) => row.item_id));
    }

    addKnown(userId: string, kind: LibraryDownloadKind, ids: string[], at: string): void {
        const db = this.db();
        db.transaction(() => this.insertKnown(db, userId, kind, ids, at))();
    }

    private insertKnown(
        db: Database.Database,
        userId: string,
        kind: LibraryDownloadKind,
        ids: string[],
        at: string
    ): void {
        const insert = db.prepare(
            'INSERT OR IGNORE INTO favorites_sync_known (user_id, kind, item_id, first_seen_at) VALUES (?, ?, ?, ?)'
        );
        for (const id of ids) insert.run(userId, kind, id, at);
    }

    markSynced(userId: string, kind: LibraryDownloadKind, at: string): void {
        this.db()
            .prepare('UPDATE favorites_sync_state SET last_sync_at = ? WHERE user_id = ? AND kind = ?')
            .run(at, userId, kind);
    }

    getLastSyncAt(userId: string, kinds: readonly LibraryDownloadKind[]): string | null {
        if (kinds.length === 0) return null;
        const row = this.db()
            .prepare(
                `SELECT MAX(last_sync_at) AS last FROM favorites_sync_state
                 WHERE user_id = ? AND kind IN (${kinds.map(() => '?').join(',')})`
            )
            .get(userId, ...kinds) as { last: string | null } | undefined;
        return row?.last ?? null;
    }

    clearBaseline(userId: string): void {
        const db = this.db();
        db.transaction(() => {
            db.prepare('DELETE FROM favorites_sync_known WHERE user_id = ?').run(userId);
            db.prepare('DELETE FROM favorites_sync_state WHERE user_id = ?').run(userId);
        })();
    }
}

/* ------------------------------------------------------------------ */
/* Service                                                              */
/* ------------------------------------------------------------------ */

export interface FavoritesSyncResult {
    /** ISO time of this check. */
    checkedAt: string;
    /** Types checked (from the settings). */
    types: LibraryDownloadKind[];
    /** Types for which this check only recorded the baseline (nothing downloaded). */
    baselineRecorded: LibraryDownloadKind[];
    /** Favorites that were new since the last check, per type. */
    newFavorites: Record<LibraryDownloadKind, number>;
    queued: number;
    deduped: number;
    skipped: number;
    failed: number;
}

export interface FavoritesSyncStatus extends FavoritesSyncSettings {
    running: boolean;
    credentialsConfigured: boolean;
    lastSyncAt: string | null;
    /** When the next scheduled check runs (ISO), null when none is scheduled. */
    nextSyncAt: string | null;
}

export interface FavoritesSyncDeps {
    store: FavoritesSyncStore;
    readSettings: () => FavoritesSyncSettings;
    hasCredentials: () => boolean;
    userId: () => string;
    getFavoriteIds: () => Promise<Record<LibraryDownloadKind, string[]>>;
    /** Throws when downloads cannot be queued (missing credentials). */
    ensureReady: () => void;
    queue: (kind: LibraryDownloadKind, ids: string[], source: string) => Promise<LibraryIdsQueueResult>;
    notify: (queued: number) => void;
    now: () => number;
}

const defaultDeps = (): FavoritesSyncDeps => ({
    store: new SqliteFavoritesSyncStore(),
    readSettings: readFavoritesSyncSettings,
    hasCredentials: () => validateEnvironment(false).valid,
    userId: () => String(CONFIG.credentials.userId || ''),
    getFavoriteIds: async () => {
        const ids = await qobuzLibraryService.getFavoriteIds();
        return { albums: ids.albums, tracks: ids.tracks };
    },
    ensureReady: () => downloadActionsService.ensureReady(),
    queue: (kind, ids, source) => queueLibraryIds(kind, ids, undefined, source),
    notify: (queued) => {
        notificationService.info(
            'New favorites',
            `Queued ${queued} new favorite${queued === 1 ? '' : 's'} for download.`
        );
    },
    now: () => Date.now()
});

const SETTINGS_KEYS = ['FAVORITES_AUTO_DOWNLOAD', 'FAVORITES_AUTO_DOWNLOAD_TYPES', 'FAVORITES_SYNC_INTERVAL_HOURS'];

export class FavoritesSyncService {
    private deps: FavoritesSyncDeps | null;
    private timer: NodeJS.Timeout | null = null;
    private nextRunAt: number | null = null;
    private running: Promise<FavoritesSyncResult> | null = null;
    private started = false;
    private lastEnabled = false;
    private readonly onSettingsUpdated = (payload: unknown) => this.handleSettingsUpdated(payload);

    constructor(deps?: Partial<FavoritesSyncDeps>) {
        // Built lazily so importing this module never touches the database.
        this.deps = deps ? { ...defaultDeps(), ...deps } : null;
    }

    private get d(): FavoritesSyncDeps {
        if (!this.deps) this.deps = defaultDeps();
        return this.deps;
    }

    /**
     * Starts scheduling. Safe to call without credentials: checks are skipped
     * until they are configured (credential changes reschedule).
     */
    start(): void {
        if (this.started) return;
        this.started = true;
        this.lastEnabled = this.safeSettings().autoDownload;
        eventBus.on(EVENTS.SETTINGS.UPDATED, this.onSettingsUpdated);
        this.reschedule();
        if (this.lastEnabled) logger.info('Favorites auto-download: active', 'FAVORITES');
    }

    stop(): void {
        this.started = false;
        eventBus.off(EVENTS.SETTINGS.UPDATED, this.onSettingsUpdated);
        this.clearTimer();
    }

    getStatus(): FavoritesSyncStatus {
        const settings = this.safeSettings();
        const userId = this.d.userId();
        let lastSyncAt: string | null = null;
        try {
            lastSyncAt = userId ? this.d.store.getLastSyncAt(userId, settings.types) : null;
        } catch {
            lastSyncAt = null;
        }
        return {
            ...settings,
            running: this.running !== null,
            credentialsConfigured: this.d.hasCredentials(),
            lastSyncAt,
            nextSyncAt: this.nextRunAt === null ? null : new Date(this.nextRunAt).toISOString()
        };
    }

    /**
     * Checks for new favorites now, whether or not auto-download is enabled,
     * for the configured types. Returns the running check when one is already
     * in progress. Throws when Qobuz credentials are missing.
     */
    async syncNow(): Promise<FavoritesSyncResult> {
        this.d.ensureReady();
        const result = await this.runExclusive();
        this.reschedule();
        return result;
    }

    private runExclusive(): Promise<FavoritesSyncResult> {
        if (this.running) return this.running;
        const run = this.check().finally(() => {
            this.running = null;
        });
        this.running = run;
        return run;
    }

    private async check(): Promise<FavoritesSyncResult> {
        const { store } = this.d;
        const settings = this.d.readSettings();
        const userId = this.d.userId();
        const checkedAt = new Date(this.d.now()).toISOString();
        const result: FavoritesSyncResult = {
            checkedAt,
            types: settings.types,
            baselineRecorded: [],
            newFavorites: { albums: 0, tracks: 0 },
            queued: 0,
            deduped: 0,
            skipped: 0,
            failed: 0
        };
        if (!userId || settings.types.length === 0) return result;

        const favorites = await this.d.getFavoriteIds();
        for (const kind of settings.types) {
            const current = (favorites[kind] ?? []).map(String);
            if (!store.hasBaseline(userId, kind)) {
                store.recordBaseline(userId, kind, current, checkedAt);
                result.baselineRecorded.push(kind);
                continue;
            }

            const known = store.getKnown(userId, kind);
            // Newly seen ids beyond the cap stay unknown and are picked up next time.
            const fresh = current.filter((id) => !known.has(id)).slice(0, MAX_FAVORITES_PER_DOWNLOAD);
            result.newFavorites[kind] = fresh.length;
            if (fresh.length > 0) {
                const queued = await this.d.queue(kind, fresh, FAVORITES_SYNC_SOURCE);
                result.queued += queued.queued;
                result.deduped += queued.deduped;
                result.skipped += queued.skipped;
                result.failed += queued.failed;
                // Ids that failed to queue stay unknown, so the next check retries them.
                const failed = new Set(queued.failedIds);
                store.addKnown(userId, kind, fresh.filter((id) => !failed.has(id)), checkedAt);
            }
            store.markSynced(userId, kind, checkedAt);
        }

        if (result.baselineRecorded.length > 0) {
            logger.info(
                `Favorites auto-download: baseline recorded for ${result.baselineRecorded.join(', ')}`,
                'FAVORITES'
            );
        }
        if (result.queued > 0) {
            logger.info(`Favorites auto-download: queued ${result.queued} new favorite(s)`, 'FAVORITES');
            this.d.notify(result.queued);
        }
        return result;
    }

    /** Scheduled tick: skipped (not failed) while disabled or without credentials. */
    private async tick(): Promise<void> {
        this.timer = null;
        this.nextRunAt = null;
        try {
            if (this.safeSettings().autoDownload && this.d.hasCredentials()) {
                await this.runExclusive();
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`Favorites auto-download check failed: ${message}`, 'FAVORITES');
        } finally {
            // A failed check waits a full interval too, instead of retrying in a tight loop.
            const settings = this.safeSettings();
            if (this.started && settings.autoDownload && this.d.hasCredentials()) {
                this.scheduleIn(settings.intervalHours * HOUR_MS);
            }
        }
    }

    private reschedule(): void {
        this.clearTimer();
        if (!this.started) return;
        const settings = this.safeSettings();
        if (!settings.autoDownload || !this.d.hasCredentials()) return;

        const interval = settings.intervalHours * HOUR_MS;
        let last: string | null = null;
        try {
            const userId = this.d.userId();
            last = userId ? this.d.store.getLastSyncAt(userId, settings.types) : null;
        } catch {
            last = null;
        }
        const lastMs = last ? Date.parse(last) : Number.NaN;
        const due = Number.isFinite(lastMs) ? lastMs + interval - this.d.now() : 0;
        this.scheduleIn(Math.min(interval, Math.max(FAVORITES_SYNC_STARTUP_DELAY_MS, due)));
    }

    private scheduleIn(delayMs: number): void {
        this.clearTimer();
        this.nextRunAt = this.d.now() + delayMs;
        this.timer = setTimeout(() => void this.tick(), delayMs);
        this.timer.unref?.();
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.nextRunAt = null;
    }

    private handleSettingsUpdated(payload: unknown): void {
        const keys = (payload as { keys?: unknown } | undefined)?.keys;
        const list = Array.isArray(keys) ? keys.map(String) : null;
        // Unknown payloads re-evaluate; otherwise only our keys and credentials matter.
        if (list && !list.some((key) => SETTINGS_KEYS.includes(key) || key.startsWith('QOBUZ_'))) return;

        const enabled = this.safeSettings().autoDownload;
        if (enabled && !this.lastEnabled) {
            // Switching auto-download on must not download what is already a favorite.
            try {
                const userId = this.d.userId();
                if (userId) this.d.store.clearBaseline(userId);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`Favorites auto-download: could not reset baseline: ${message}`, 'FAVORITES');
            }
            logger.info('Favorites auto-download enabled; the next check records a baseline', 'FAVORITES');
        }
        this.lastEnabled = enabled;
        this.reschedule();
    }

    private safeSettings(): FavoritesSyncSettings {
        try {
            return this.d.readSettings();
        } catch {
            return {
                autoDownload: false,
                types: [...FAVORITES_SYNC_KINDS],
                intervalHours: DEFAULT_FAVORITES_SYNC_INTERVAL_HOURS
            };
        }
    }
}

export const favoritesSyncService = new FavoritesSyncService();

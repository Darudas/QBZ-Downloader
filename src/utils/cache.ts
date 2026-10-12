import { LRUCache } from 'lru-cache';
import { logger } from './logger.js';
import { eventBus, EVENTS } from './events.js';

/** Every cache key holding data of the logged-in Qobuz user starts with this prefix. */
export const USER_CACHE_PREFIX = 'u:';

/** Settings whose change means "a different Qobuz user (or session) is active". */
export const QOBUZ_IDENTITY_SETTING_KEYS: readonly string[] = [
    'QOBUZ_USER_AUTH_TOKEN',
    'QOBUZ_USER_ID',
    'QOBUZ_ACTIVE_ACCOUNT_ID'
];

class CacheService {
    private cache: LRUCache<string, NonNullable<unknown>>;

    constructor(maxSize: number = 1000) {
        this.cache = new LRUCache<string, NonNullable<unknown>>({
            max: maxSize,
            ttl: 1000 * 60 * 60, // 1 hour default, overridden per entry in set()
            // Reads must not extend the lifetime: hot keys would otherwise never expire.
            updateAgeOnGet: false
        });
        logger.debug('Cache service initialized (LRU)');
    }

    /**
     * Returns a deep copy of the cached value so callers can decorate the result
     * (e.g. `already_downloaded`) without mutating what other requests see.
     */
    get(key: string): unknown | null {
        const value = this.cache.get(key);
        if (value === undefined) return null;
        try {
            return structuredClone(value);
        } catch {
            // Not cloneable (functions, class instances with private state):
            // nothing in the app stores such values, so drop the entry.
            this.cache.delete(key);
            return null;
        }
    }

    set(key: string, value: unknown, ttlSeconds: number = 3600): void {
        if (value === undefined || value === null) {
            this.cache.delete(key);
            return;
        }
        this.cache.set(key, value, {
            ttl: Math.max(1, ttlSeconds) * 1000
        });
    }

    delete(key: string): boolean {
        const hadKey = this.cache.has(key);
        this.cache.delete(key);
        return hadKey;
    }

    /** Delete every key starting with `prefix`. Returns the number of deleted keys. */
    deleteByPrefix(prefix: string): number {
        if (!prefix) return 0;
        const keys: string[] = [];
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) keys.push(key);
        }
        for (const key of keys) this.cache.delete(key);
        return keys.length;
    }

    clear(): void {
        this.cache.clear();
    }

    size(): number {
        return this.cache.size;
    }
}

export const cacheService = new CacheService();

/** Drop every user-scoped Qobuz entry (favorites, playlists, purchases, account). */
export function clearUserScopedCache(): number {
    const removed = cacheService.deleteByPrefix(USER_CACHE_PREFIX);
    if (removed > 0) {
        logger.debug(`Cleared ${removed} user-scoped Qobuz cache entries`, 'CACHE');
    }
    return removed;
}

function touchesQobuzIdentity(payload: unknown): boolean {
    const keys = (payload as { keys?: unknown } | null | undefined)?.keys;
    if (!Array.isArray(keys)) return false;
    return keys.some((key) => typeof key === 'string' && QOBUZ_IDENTITY_SETTING_KEYS.includes(key));
}

eventBus.on(EVENTS.SETTINGS.UPDATED, (payload: unknown) => {
    if (touchesQobuzIdentity(payload)) {
        clearUserScopedCache();
    }
});

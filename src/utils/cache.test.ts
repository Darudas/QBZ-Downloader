import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheService, clearUserScopedCache, QOBUZ_IDENTITY_SETTING_KEYS, USER_CACHE_PREFIX } from './cache.js';
import { eventBus, EVENTS } from './events.js';

vi.mock('./logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

describe('CacheService', () => {
    beforeEach(() => {
        cacheService.clear();
        vi.useRealTimers();
    });

    it('returns null for missing keys and stores values', () => {
        expect(cacheService.get('missing')).toBeNull();
        cacheService.set('k', { a: 1 });
        expect(cacheService.get('k')).toEqual({ a: 1 });
        expect(cacheService.size()).toBe(1);
    });

    it('returns a deep clone so callers cannot mutate cached objects', () => {
        cacheService.set('album:1', { id: 1, tracks: { items: [{ id: 't1' }] } });

        const first = cacheService.get('album:1') as { already_downloaded?: boolean; tracks: { items: Array<{ id: string; flag?: boolean }> } };
        first.already_downloaded = true;
        first.tracks.items[0]!.flag = true;

        expect(cacheService.get('album:1')).toEqual({ id: 1, tracks: { items: [{ id: 't1' }] } });
    });

    it('does not extend the TTL on reads', async () => {
        // lru-cache captures performance.now at import time, so fake timers
        // cannot move its clock; use a 1s TTL and real time instead.
        cacheService.set('hot', 'value', 1);

        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(cacheService.get('hot')).toBe('value');
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(cacheService.get('hot')).toBeNull();
    });

    it('treats setting null/undefined as a delete', () => {
        cacheService.set('k', 'v');
        cacheService.set('k', null);
        expect(cacheService.get('k')).toBeNull();
        expect(cacheService.size()).toBe(0);
    });

    it('deletes keys by prefix and reports the count', () => {
        cacheService.set('u:1:fav:ids', [1]);
        cacheService.set('u:1:fav:list:albums:0:50', {});
        cacheService.set('u:1:playlists:list:owner:0:50', {});
        cacheService.set('album:1', {});

        expect(cacheService.deleteByPrefix('u:1:fav:')).toBe(2);
        expect(cacheService.get('u:1:fav:ids')).toBeNull();
        expect(cacheService.get('u:1:playlists:list:owner:0:50')).toEqual({});
        expect(cacheService.get('album:1')).toEqual({});
        expect(cacheService.deleteByPrefix('')).toBe(0);
        expect(cacheService.size()).toBe(2);
    });

    it('delete reports whether the key existed', () => {
        cacheService.set('k', 1);
        expect(cacheService.delete('k')).toBe(true);
        expect(cacheService.delete('k')).toBe(false);
    });
});

describe('user-scoped cache invalidation', () => {
    beforeEach(() => {
        cacheService.clear();
        cacheService.set(`${USER_CACHE_PREFIX}1:fav:ids`, [1]);
        cacheService.set(`${USER_CACHE_PREFIX}2:playlists:list:owner:0:50`, {});
        cacheService.set('track:9', { id: 9 });
    });

    it('clearUserScopedCache removes every u: key only', () => {
        expect(clearUserScopedCache()).toBe(2);
        expect(cacheService.get('track:9')).toEqual({ id: 9 });
        expect(cacheService.size()).toBe(1);
    });

    it.each(QOBUZ_IDENTITY_SETTING_KEYS)('clears user data when %s changes (account switch)', (key) => {
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['THEME', key] });
        expect(cacheService.get(`${USER_CACHE_PREFIX}1:fav:ids`)).toBeNull();
        expect(cacheService.get(`${USER_CACHE_PREFIX}2:playlists:list:owner:0:50`)).toBeNull();
        expect(cacheService.get('track:9')).toEqual({ id: 9 });
    });

    it('keeps user data for unrelated settings updates and odd payloads', () => {
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: ['DOWNLOADS_PATH'] });
        eventBus.emit(EVENTS.SETTINGS.UPDATED, undefined);
        eventBus.emit(EVENTS.SETTINGS.UPDATED, { keys: 'QOBUZ_USER_ID' });
        expect(cacheService.size()).toBe(3);
    });
});

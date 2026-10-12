import { describe, it, expect } from 'vitest';
import { DashboardSessionStore, parseTrustProxy } from './session-store.js';

describe('DashboardSessionStore', () => {
    it('accepts its own tokens only for the password they were created with', () => {
        const store = new DashboardSessionStore();
        const token = store.create('pw');
        expect(store.isValid(token, 'pw')).toBe(true);
        expect(store.isValid(token, 'other')).toBe(false);
        // A mismatch ends the session for good.
        expect(store.isValid(token, 'pw')).toBe(false);
        expect(store.isValid('made-up', 'pw')).toBe(false);
        expect(store.isValid(undefined, 'pw')).toBe(false);
    });

    it('expires idle sessions and extends active ones', () => {
        const store = new DashboardSessionStore(1000);
        const token = store.create('pw', 0);
        expect(store.isValid(token, 'pw', 900)).toBe(true);
        expect(store.isValid(token, 'pw', 1800)).toBe(true);
        expect(store.isValid(token, 'pw', 3000)).toBe(false);
    });

    it('stays bounded', () => {
        const store = new DashboardSessionStore(60_000, 3);
        const first = store.create('pw', 0);
        for (let i = 0; i < 5; i++) store.create('pw', 1);
        expect(store.size).toBeLessThanOrEqual(3);
        expect(store.isValid(first, 'pw', 2)).toBe(false);
    });
});

describe('parseTrustProxy', () => {
    it('parses booleans, hop counts and address lists', () => {
        expect(parseTrustProxy(undefined)).toBeUndefined();
        expect(parseTrustProxy('')).toBeUndefined();
        expect(parseTrustProxy('false')).toBeUndefined();
        expect(parseTrustProxy('TRUE')).toBe(true);
        expect(parseTrustProxy('1')).toBe(1);
        expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    });
});

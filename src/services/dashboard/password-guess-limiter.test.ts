import { describe, expect, it } from 'vitest';
import { PasswordGuessLimiter } from './password-guess-limiter.js';

describe('PasswordGuessLimiter', () => {
    it('blocks after the maximum number of distinct wrong passwords', () => {
        const limiter = new PasswordGuessLimiter(3, 1000);
        limiter.recordFailure('a', 'one', 0);
        limiter.recordFailure('a', 'one', 0);
        limiter.recordFailure('a', 'two', 0);
        expect(limiter.isBlocked('a', 0)).toBe(false);

        limiter.recordFailure('a', 'three', 0);
        expect(limiter.isBlocked('a', 0)).toBe(true);
        expect(limiter.isBlocked('b', 0)).toBe(false);
        expect(limiter.retryAfterSeconds('a', 400)).toBe(1);
    });

    it('unblocks when the window has passed', () => {
        const limiter = new PasswordGuessLimiter(1, 1000);
        limiter.recordFailure('a', 'x', 0);
        expect(limiter.isBlocked('a', 999)).toBe(true);
        expect(limiter.isBlocked('a', 1000)).toBe(false);
        expect(limiter.retryAfterSeconds('a', 1000)).toBe(0);
    });

    it('keeps memory bounded', () => {
        const limiter = new PasswordGuessLimiter(1, 1000, 2);
        limiter.recordFailure('a', 'x', 0);
        limiter.recordFailure('b', 'x', 0);
        limiter.recordFailure('c', 'x', 0);
        expect(limiter.isBlocked('a', 0)).toBe(false);
        expect(limiter.isBlocked('b', 0)).toBe(true);
        expect(limiter.isBlocked('c', 0)).toBe(true);
    });
});

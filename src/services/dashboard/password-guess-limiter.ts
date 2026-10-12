import crypto from 'crypto';

/**
 * Bounds dashboard-password guessing on every protected route, not only on
 * the login endpoint: each /api request accepts the password in x-password
 * (or the session cookie), so the general request limiter was the only bound.
 *
 * It counts *distinct* wrong passwords per client within a fixed window. A
 * browser tab that keeps sending the same stale password after a password
 * change therefore uses up one guess, not one per request, and cannot lock its
 * user out; an attacker trying passwords is stopped after `maxGuesses`. Once
 * blocked, every password-carrying request from that client is refused until
 * the window ends, including one with the right password; otherwise the
 * answer would still reveal which guess was correct.
 */
export class PasswordGuessLimiter {
    private readonly entries = new Map<string, { resetAt: number; guesses: Set<string> }>();

    constructor(
        private readonly maxGuesses = 20,
        private readonly windowMs = 15 * 60 * 1000,
        private readonly maxClients = 10_000
    ) {}

    isBlocked(client: string, now = Date.now()): boolean {
        const entry = this.liveEntry(client, now);
        return entry !== undefined && entry.guesses.size >= this.maxGuesses;
    }

    recordFailure(client: string, password: string, now = Date.now()): void {
        let entry = this.liveEntry(client, now);
        if (!entry) {
            if (this.entries.size >= this.maxClients) this.prune(now);
            entry = { resetAt: now + this.windowMs, guesses: new Set() };
            this.entries.set(client, entry);
        }
        if (entry.guesses.size >= this.maxGuesses) return;
        entry.guesses.add(crypto.createHash('sha256').update(password).digest('hex'));
    }

    /** Seconds until `client` may try again (0 when not blocked). */
    retryAfterSeconds(client: string, now = Date.now()): number {
        const entry = this.liveEntry(client, now);
        return entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
    }

    private liveEntry(client: string, now: number) {
        const entry = this.entries.get(client);
        if (entry && entry.resetAt <= now) {
            this.entries.delete(client);
            return undefined;
        }
        return entry;
    }

    /** Drop expired entries; if still full, drop the oldest so memory stays bounded. */
    private prune(now: number): void {
        for (const [client, entry] of this.entries) {
            if (entry.resetAt <= now) this.entries.delete(client);
        }
        while (this.entries.size >= this.maxClients) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }
}

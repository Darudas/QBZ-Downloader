import crypto from 'crypto';

/**
 * Random login sessions for the dashboard.
 *
 * The password guess limiter is keyed by client address. Behind a reverse
 * proxy, or on Docker Desktop where every request arrives from the gateway,
 * all users share one address, so an attacker's wrong guesses would lock out
 * everyone. A browser that already logged in therefore gets a random session
 * token; requests carrying a valid token skip the password check and the
 * limiter. Tokens cannot be guessed, so this does not reopen password guessing.
 *
 * Each session remembers a fingerprint of the password it was created with,
 * so changing the dashboard password ends every session. Sessions live in
 * memory only: after a restart the browser falls back to the password it
 * keeps in the tab and gets a new token.
 */
export class DashboardSessionStore {
    private readonly sessions = new Map<string, { fingerprint: string; expiresAt: number }>();

    constructor(
        private readonly ttlMs = 7 * 24 * 60 * 60 * 1000,
        private readonly maxSessions = 1000
    ) {}

    create(password: string, now = Date.now()): string {
        if (this.sessions.size >= this.maxSessions) this.prune(now);
        const token = crypto.randomBytes(32).toString('base64url');
        this.sessions.set(token, { fingerprint: fingerprint(password), expiresAt: now + this.ttlMs });
        return token;
    }

    /** True when `token` is a live session created with the current `password`. Extends it. */
    isValid(token: string | undefined, password: string, now = Date.now()): boolean {
        if (!token) return false;
        const session = this.sessions.get(token);
        if (!session) return false;
        if (session.expiresAt <= now || session.fingerprint !== fingerprint(password)) {
            this.sessions.delete(token);
            return false;
        }
        session.expiresAt = now + this.ttlMs;
        return true;
    }

    revoke(token: string | undefined): void {
        if (token) this.sessions.delete(token);
    }

    get size(): number {
        return this.sessions.size;
    }

    /** Drop expired sessions; if still full, drop the oldest so memory stays bounded. */
    private prune(now: number): void {
        for (const [token, session] of this.sessions) {
            if (session.expiresAt <= now) this.sessions.delete(token);
        }
        while (this.sessions.size >= this.maxSessions) {
            const oldest = this.sessions.keys().next().value;
            if (oldest === undefined) break;
            this.sessions.delete(oldest);
        }
    }
}

function fingerprint(password: string): string {
    return crypto.createHash('sha256').update(`qbz-session:${password}`).digest('hex');
}

/** Parses a `trust proxy` value from the TRUST_PROXY environment variable. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
    const value = raw?.trim();
    if (!value) return undefined;
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return undefined;
    if (/^\d+$/.test(value)) return Number(value);
    // A comma-separated list of addresses/subnets or names like 'loopback'.
    return value;
}

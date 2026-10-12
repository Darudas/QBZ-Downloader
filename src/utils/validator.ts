import { logger } from './logger.js';
import {
    QOBUZ_ALBUM_ID_PATTERN,
    QOBUZ_DOMAIN,
    QOBUZ_LOCALE_SEGMENT_PATTERN,
    QOBUZ_NUMERIC_ID_PATTERN,
    QOBUZ_URL_SEGMENT_TYPES,
    type QobuzUrlType
} from '../constants.js';

export type { QobuzUrlType } from '../constants.js';

export interface ParsedQobuzUrl {
    type: QobuzUrlType;
    /** Album ids are alphanumeric; every other id is a string of digits. */
    id: string;
}

const MAX_PARSE_URL_LENGTH = 2048;

function toUrl(input: string): URL | null {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > MAX_PARSE_URL_LENGTH) return null;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        return new URL(candidate);
    } catch {
        return null;
    }
}

function hostMatches(hostname: string, domain: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    const expected = domain.toLowerCase();
    return host === expected || host.endsWith(`.${expected}`);
}

/** True for qobuz.com and its subdomains (exact match, not a substring check). */
export function isQobuzHost(hostname: string): boolean {
    return hostMatches(hostname, QOBUZ_DOMAIN);
}

/**
 * Parse a Qobuz link into `{type, id}`. Supports
 * `open.qobuz.com/<type>/<id>`, `play.qobuz.com/<type>/<id>` and store links
 * `www.qobuz.com/<locale>/<type>/<slug...>/<id>` for tracks, albums, artists
 * (`/artist/` or `/interpreter/`), playlists and labels. Scheme-less input
 * (`open.qobuz.com/album/...`) is accepted. Returns null for anything else,
 * including look-alike hosts such as `qobuz.com.evil.example`.
 */
export function parseQobuzUrl(url: string): ParsedQobuzUrl | null {
    if (typeof url !== 'string') return null;
    const parsed = toUrl(url);
    if (!parsed) return null;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    if (!isQobuzHost(parsed.hostname)) return null;

    let segments: string[];
    try {
        segments = parsed.pathname
            .split('/')
            .filter(Boolean)
            .map((segment) => decodeURIComponent(segment));
    } catch {
        return null;
    }

    const isKeyword = (segment: string | undefined) =>
        segment !== undefined && Object.hasOwn(QOBUZ_URL_SEGMENT_TYPES, segment.toLowerCase());

    if (
        segments.length >= 2 &&
        QOBUZ_LOCALE_SEGMENT_PATTERN.test(segments[0]!) &&
        isKeyword(segments[1])
    ) {
        segments.shift();
    }

    const keyword = segments[0];
    if (!isKeyword(keyword) || segments.length < 2) return null;
    const type = QOBUZ_URL_SEGMENT_TYPES[keyword!.toLowerCase()]!;
    const id = segments[segments.length - 1]!;

    if (type === 'album') {
        return QOBUZ_ALBUM_ID_PATTERN.test(id) ? { type, id } : null;
    }

    if (!QOBUZ_NUMERIC_ID_PATTERN.test(id) || /^0+$/.test(id)) return null;
    return { type, id: id.replace(/^0+/, '') };
}

export interface UrlValidationResult {
    valid: boolean;
    type?: string;
    id?: string;
    error?: string;
}

export interface QueryValidationResult {
    valid: boolean;
    sanitized?: string;
    error?: string;
}

export interface ValidatorConfig {
    maxQueryLength: number;
    maxUrlLength: number;
    allowedHosts: string[];
    strictMode: boolean;
}

const DEFAULT_CONFIG: ValidatorConfig = {
    maxQueryLength: 200,
    maxUrlLength: 500,
    allowedHosts: ['qobuz.com', 'play.qobuz.com', 'open.qobuz.com', 'www.qobuz.com'],
    strictMode: true
};

export class InputValidator {
    private config: ValidatorConfig;

    private readonly SPOTIFY_PATH_PATTERN =
        /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(album|track|playlist)\/([a-zA-Z0-9]+)\/?$/i;

    private readonly DANGEROUS_PATTERNS = [
        /<script/i,
        /javascript:/i,
        /data:/i,
        /vbscript:/i,
        /on\w+\s*=/i,
        /&#/,
        /%3C/i,
        /%3E/i
    ];

    constructor(config: Partial<ValidatorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    validateUrl(url: string): UrlValidationResult {
        if (!url || typeof url !== 'string') {
            return { valid: false, error: 'URL is required' };
        }

        url = url.trim();
        if (url.length > this.config.maxUrlLength) {
            return { valid: false, error: 'URL is too long' };
        }

        for (const pattern of this.DANGEROUS_PATTERNS) {
            if (pattern.test(url)) {
                logger.warn(
                    `Validator: Dangerous pattern detected in URL: ${url.substring(0, 50)}`
                );
                return { valid: false, error: 'Invalid URL format' };
            }
        }

        const mentionsSupportedSite = url.includes('qobuz.com') || url.includes('spotify.com');
        const parsedUrl = toUrl(url);
        if (!parsedUrl) {
            return {
                valid: false,
                error: mentionsSupportedSite ? 'Invalid URL format' : 'Not a supported URL (Qobuz/Spotify)'
            };
        }

        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
            return { valid: false, error: 'Invalid protocol' };
        }

        const host = parsedUrl.hostname.toLowerCase();
        const isQobuz = isQobuzHost(host);
        const isSpotify = hostMatches(host, 'spotify.com');

        if (!isQobuz && !isSpotify) {
            return {
                valid: false,
                error: mentionsSupportedSite ? 'Invalid domain' : 'Not a supported URL (Qobuz/Spotify)'
            };
        }

        if (this.config.strictMode) {
            const allowedHosts = [...this.config.allowedHosts, 'open.spotify.com', 'spotify.com'];
            if (!allowedHosts.some((allowed) => hostMatches(host, allowed))) {
                return { valid: false, error: 'Invalid domain' };
            }
        }

        if (isQobuz) {
            const parsed = parseQobuzUrl(url);
            if (!parsed) return { valid: false, error: 'Could not parse URL' };
            return { valid: true, type: parsed.type, id: parsed.id };
        }

        const spotifyMatch = parsedUrl.pathname.match(this.SPOTIFY_PATH_PATTERN);
        if (!spotifyMatch) return { valid: false, error: 'Could not parse URL' };

        const id = spotifyMatch[2]!;
        if (!this.isValidId(id)) {
            return { valid: false, error: 'Invalid ID format' };
        }
        return { valid: true, type: `spotify_${spotifyMatch[1]!.toLowerCase()}`, id };
    }

    validateQuery(query: string): QueryValidationResult {
        if (!query || typeof query !== 'string') {
            return { valid: false, error: 'Query is required' };
        }

        query = query.trim();

        if (query.length === 0) {
            return { valid: false, error: 'Query cannot be empty' };
        }
        if (query.length > this.config.maxQueryLength) {
            return {
                valid: false,
                error: `Query too long (max ${this.config.maxQueryLength} chars)`
            };
        }
        if (query.length < 2) {
            return { valid: false, error: 'Query too short (min 2 chars)' };
        }

        for (const pattern of this.DANGEROUS_PATTERNS) {
            if (pattern.test(query)) {
                logger.warn(`Validator: Dangerous pattern in query: ${query.substring(0, 30)}`);
                return { valid: false, error: 'Invalid query format' };
            }
        }

        const sanitized = query
            .replace(/[<>'"\\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (sanitized.length === 0) {
            return { valid: false, error: 'Query contains only invalid characters' };
        }

        return { valid: true, sanitized };
    }

    validateQuality(quality: number | string): boolean {
        const validQualities = [5, 6, 7, 27];

        if (typeof quality === 'string') {
            if (quality === 'ask' || quality === 'min' || quality === 'max') {
                return true;
            }
            quality = parseInt(quality, 10);
        }

        return !isNaN(quality) && validQualities.includes(quality);
    }

    isValidId(id: string | number): boolean {
        if (id === undefined || id === null) return false;

        const strId = String(id);

        if (!/^[a-zA-Z0-9]+$/.test(strId)) return false;
        if (strId.length < 1 || strId.length > 50) return false;

        return true;
    }

    sanitizeForDisplay(str: string): string {
        if (!str || typeof str !== 'string') return '';

        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    isValidUserId(userId: string | number): boolean {
        if (userId === undefined || userId === null) return false;

        const strId = String(userId);

        if (!/^\d+$/.test(strId)) return false;
        if (strId.length < 1 || strId.length > 20) return false;

        return true;
    }
}

export const inputValidator = new InputValidator();

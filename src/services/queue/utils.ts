import { QobuzError } from '../../utils/errors.js';
import { DOWNLOAD_TYPES, DownloadType, QUEUE_PRIORITIES, QueuePriority } from './types.js';

export function generateQueueId(): string {
    return `q_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function isDownloadType(value: unknown): value is DownloadType {
    return typeof value === 'string' && (DOWNLOAD_TYPES as readonly string[]).includes(value);
}

export function isQueuePriority(value: unknown): value is QueuePriority {
    return typeof value === 'string' && (QUEUE_PRIORITIES as readonly string[]).includes(value);
}

/**
 * A refused queue or download request. Extends QobuzError so the dashboard
 * error middleware and the MCP error wrapper surface the message (it never
 * contains secrets) and `statusCode` picks the HTTP status.
 */
export class QueueRequestError extends QobuzError {
    readonly statusCode: number;

    constructor(message: string, statusCode = 400, code = 'INVALID_REQUEST') {
        super(message, code);
        this.name = 'QueueRequestError';
        this.statusCode = statusCode;
    }
}

/** Qobuz format ids: 5 = MP3 320, 6 = FLAC 16/44.1, 7 = FLAC 24/≤96, 27 = FLAC 24/≤192. */
export const VALID_QUALITIES = [5, 6, 7, 27] as const;

const isValidQuality = (value: number): boolean =>
    (VALID_QUALITIES as readonly number[]).includes(value);

/**
 * Strict quality parsing for API input: 5, 6, 7 or 27 (number or numeric
 * string), 'max' (27) or 'min' (5). Missing, empty or 'ask' resolves to
 * `fallback` (the configured default; 27 when that is not valid either).
 * Anything else throws a 400 instead of being silently replaced.
 */
export function resolveQualityStrict(value: unknown, fallback: unknown): number {
    const resolveFallback = (): number => {
        const parsed = typeof fallback === 'string' ? fallback.trim().toLowerCase() : fallback;
        if (parsed === 'max') return 27;
        if (parsed === 'min') return 5;
        const numeric = Number(parsed);
        return isValidQuality(numeric) ? numeric : 27;
    };

    if (value === undefined || value === null) return resolveFallback();
    if (typeof value === 'number') {
        if (isValidQuality(value)) return value;
    } else if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed || trimmed === 'ask') return resolveFallback();
        if (trimmed === 'max') return 27;
        if (trimmed === 'min') return 5;
        const parsed = Number(trimmed);
        if (isValidQuality(parsed)) return parsed;
    }
    throw new QueueRequestError(
        'Invalid quality (expected 5, 6, 7, 27, "max" or "min")',
        400,
        'VALIDATION_ERROR'
    );
}

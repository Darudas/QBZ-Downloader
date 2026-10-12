export class QobuzError extends Error {
    code: string;
    constructor(message: string, code = 'UNKNOWN_ERROR') {
        super(message);
        this.name = 'QobuzError';
        this.code = code;
    }
}

/**
 * Qobuz rejected the user credentials (HTTP 401) or no user is logged in.
 * Only this error marks the stored token as invalid.
 */
export class AuthenticationError extends QobuzError {
    readonly statusCode: number = 401;
    constructor(message = 'Authentication failed. Please check your credentials.') {
        super(message, 'AUTH_ERROR');
        this.name = 'AuthenticationError';
    }
}

/** An error returned by (or while talking to) the Qobuz API. */
export class APIError extends QobuzError {
    statusCode: number | null;
    constructor(message: string, statusCode: number | null = null, code = 'API_ERROR') {
        super(message, code);
        this.name = 'APIError';
        this.statusCode = statusCode;
    }
}

/**
 * HTTP 403 from Qobuz: the credentials are valid but the action is not allowed
 * (region or subscription restriction, someone else's playlist, ...). It does
 * NOT invalidate the stored token.
 */
export class ForbiddenError extends APIError {
    constructor(message = 'Qobuz refused access to this resource.') {
        super(message, 403, 'FORBIDDEN');
        this.name = 'ForbiddenError';
    }
}

/** HTTP 404 from Qobuz, or a resource the app looked for and could not find. */
export class NotFoundError extends APIError {
    constructor(message = 'The requested Qobuz resource was not found.') {
        super(message, 404, 'NOT_FOUND');
        this.name = 'NotFoundError';
    }
}

/** HTTP 429 from Qobuz after the retry budget was used up. */
export class RateLimitError extends APIError {
    retryAfterMs: number | null;
    constructor(
        message = 'Qobuz rate limit reached. Please try again later.',
        retryAfterMs: number | null = null
    ) {
        super(message, 429, 'RATE_LIMITED');
        this.name = 'RateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * Build the right error class for a Qobuz HTTP status (or a `code` found in a
 * `{"status":"error"}` body). `statusCode` null means "no response".
 */
export function createApiError(
    statusCode: number | null | undefined,
    message: string,
    retryAfterMs: number | null = null
): QobuzError {
    const text = message && message.trim() ? message.trim() : '';
    switch (statusCode) {
        case 401:
            return new AuthenticationError(text || undefined);
        case 403:
            return new ForbiddenError(text || undefined);
        case 404:
            return new NotFoundError(text || undefined);
        case 429:
            return new RateLimitError(text || undefined, retryAfterMs);
        default:
            return new APIError(text || 'API Error', statusCode ?? null);
    }
}

export interface ValidationIssue {
    path: string;
    message: string;
}

interface ZodLikeIssue {
    path: ReadonlyArray<PropertyKey>;
    message: string;
}

/** Bad input supplied by a caller (REST body/query or MCP tool arguments). */
export class ValidationError extends QobuzError {
    readonly statusCode: number = 400;
    readonly issues: ValidationIssue[];

    constructor(message: string, issues: ValidationIssue[] = []) {
        super(message, 'VALIDATION_ERROR');
        this.name = 'ValidationError';
        this.issues = issues;
    }

    /** Build a ValidationError from a zod error (structurally typed: no zod import needed). */
    static fromZod(error: { issues: ReadonlyArray<ZodLikeIssue> }, prefix = 'Invalid input'): ValidationError {
        const issues: ValidationIssue[] = error.issues.slice(0, 20).map((issue) => ({
            path: issue.path.map((part) => String(part)).join('.'),
            message: issue.message
        }));
        const summary = issues
            .slice(0, 5)
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join('; ');
        return new ValidationError(summary ? `${prefix}: ${summary}` : prefix, issues);
    }
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

export interface SafeErrorPayload {
    message: string;
    code: string;
    /** HTTP status the REST layer should answer with. */
    statusCode: number;
}

const GENERIC_ERROR_MESSAGE = 'An unexpected error occurred.';
const MAX_SAFE_MESSAGE_LENGTH = 500;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PATTERNS: RegExp[] = [
    /\b(user_auth_token|app_id|app_secret|request_sig|token|password|secret|api_key)=([^&\s"']+)/gi,
    /\b(x-user-auth-token|x-app-id|authorization)\s*[:=]\s*("?)[^\s",;]+\2/gi
];

/** Strip anything that looks like a credential from an error message and cap its length. */
export function sanitizeErrorMessage(message: string): string {
    let sanitized = message.replace(BEARER_PATTERN, 'Bearer [redacted]');
    for (const pattern of SECRET_PATTERNS) {
        sanitized = sanitized.replace(pattern, (_match, key: string) => `${key}=[redacted]`);
    }
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    if (sanitized.length > MAX_SAFE_MESSAGE_LENGTH) {
        sanitized = `${sanitized.slice(0, MAX_SAFE_MESSAGE_LENGTH - 1)}…`;
    }
    return sanitized;
}

function readStatusCode(error: object): number | null {
    const value = (error as { statusCode?: unknown }).statusCode;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function isZodLikeError(error: unknown): error is Error & { issues: ZodLikeIssue[] } {
    return (
        error instanceof Error &&
        error.name === 'ZodError' &&
        Array.isArray((error as { issues?: unknown }).issues)
    );
}

/**
 * Map an upstream/app status to the status our own HTTP API should answer with.
 * - A Qobuz 401 is answered with 502: the dashboard client treats any 401 as
 *   "dashboard session expired" and would lock the UI.
 * - A Qobuz 429 is answered with 503 (the dashboard client swallows 429s).
 * - Qobuz 5xx / no response become 502 (bad gateway).
 */
function toHttpStatus(error: QobuzError, status: number | null): number {
    const upstream = error instanceof APIError || error instanceof AuthenticationError;
    if (status === null) return upstream ? 502 : 500;
    if (status === 401) return upstream ? 502 : 401;
    if (status === 429) return upstream ? 503 : 429;
    if (status >= 400 && status < 500) return status;
    if (status >= 500 && status < 600) return upstream ? 502 : status;
    return 500;
}

/**
 * Convert any thrown value into a payload that is safe to send to a client
 * (REST error middleware, MCP tool errors). Never includes axios internals,
 * request configs, headers or stack traces. Errors that are not QobuzError
 * subclasses get a generic message: log them server-side instead.
 */
export function toSafeErrorPayload(error: unknown): SafeErrorPayload {
    if (isZodLikeError(error) && !(error instanceof QobuzError)) {
        return toSafeErrorPayload(ValidationError.fromZod(error));
    }

    if (error instanceof QobuzError) {
        const message = sanitizeErrorMessage(error.message || '') || GENERIC_ERROR_MESSAGE;
        return {
            message,
            code: error.code || 'UNKNOWN_ERROR',
            statusCode: toHttpStatus(error, readStatusCode(error))
        };
    }

    return { message: GENERIC_ERROR_MESSAGE, code: 'INTERNAL_ERROR', statusCode: 500 };
}

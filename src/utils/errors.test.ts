import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    APIError,
    AuthenticationError,
    ForbiddenError,
    NotFoundError,
    QobuzError,
    RateLimitError,
    ValidationError,
    createApiError,
    getErrorMessage,
    sanitizeErrorMessage,
    toSafeErrorPayload
} from './errors.js';

describe('error classes', () => {
    it('gives AuthenticationError statusCode 401 and keeps it out of APIError', () => {
        const error = new AuthenticationError();
        expect(error).toBeInstanceOf(QobuzError);
        expect(error).not.toBeInstanceOf(APIError);
        expect(error).toMatchObject({ statusCode: 401, code: 'AUTH_ERROR', name: 'AuthenticationError' });
    });

    it('defines Forbidden/NotFound/RateLimit as APIError subclasses', () => {
        const forbidden = new ForbiddenError();
        const notFound = new NotFoundError('gone');
        const limited = new RateLimitError(undefined, 2000);

        expect(forbidden).toBeInstanceOf(APIError);
        expect(forbidden).toMatchObject({ statusCode: 403, code: 'FORBIDDEN', name: 'ForbiddenError' });
        expect(notFound).toBeInstanceOf(APIError);
        expect(notFound).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'gone' });
        expect(limited).toBeInstanceOf(APIError);
        expect(limited).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED', retryAfterMs: 2000 });
    });

    it('keeps the APIError constructor backwards compatible', () => {
        const error = new APIError('boom', 502);
        expect(error).toMatchObject({ message: 'boom', statusCode: 502, code: 'API_ERROR' });
        expect(new APIError('x').statusCode).toBeNull();
    });

    it('creates ValidationError with status 400 and structured issues', () => {
        const error = new ValidationError('bad', [{ path: 'name', message: 'required' }]);
        expect(error).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR', issues: [{ path: 'name' }] });
    });

    it('builds a ValidationError from a zod error', () => {
        const result = z.object({ name: z.string().min(1), ids: z.array(z.number()) }).safeParse({
            name: '',
            ids: ['x']
        });
        expect(result.success).toBe(false);
        if (result.success) return;

        const error = ValidationError.fromZod(result.error, 'Invalid playlist');

        expect(error.message).toMatch(/^Invalid playlist: /);
        expect(error.message).toContain('name:');
        expect(error.issues.map((issue) => issue.path)).toEqual(['name', 'ids.0']);
    });

    it('returns messages for any thrown value', () => {
        expect(getErrorMessage(new Error('x'))).toBe('x');
        expect(getErrorMessage('plain')).toBe('plain');
    });
});

describe('createApiError', () => {
    it.each([
        [401, AuthenticationError],
        [403, ForbiddenError],
        [404, NotFoundError],
        [429, RateLimitError]
    ])('maps %i to %s', (status, cls) => {
        expect(createApiError(status, 'msg')).toBeInstanceOf(cls);
    });

    it('falls back to APIError carrying the status (or null)', () => {
        expect(createApiError(500, 'oops')).toMatchObject({ statusCode: 500, message: 'oops' });
        expect(createApiError(null, '')).toMatchObject({ statusCode: null, message: 'API Error' });
        expect(createApiError(undefined, 'x')).toBeInstanceOf(APIError);
    });

    it('uses class defaults for empty messages', () => {
        expect(createApiError(403, '  ').message).toBe(new ForbiddenError().message);
        expect((createApiError(429, '', 5000) as RateLimitError).retryAfterMs).toBe(5000);
    });
});

describe('sanitizeErrorMessage', () => {
    it('redacts credentials in query strings, headers and bearer tokens', () => {
        const message =
            'GET /track/get?track_id=1&user_auth_token=SECRET1&app_id=SECRET2 failed; ' +
            'X-User-Auth-Token: SECRET3 Authorization: Bearer SECRET4.abc';
        const sanitized = sanitizeErrorMessage(message);

        expect(sanitized).not.toMatch(/SECRET[1-4]/);
        expect(sanitized).toContain('user_auth_token=[redacted]');
        expect(sanitized).toContain('track_id=1');
    });

    it('caps very long messages', () => {
        const sanitized = sanitizeErrorMessage('a'.repeat(2000));
        expect(sanitized.length).toBe(500);
        expect(sanitized.endsWith('…')).toBe(true);
    });
});

describe('toSafeErrorPayload', () => {
    it('passes through validation, forbidden and not-found statuses', () => {
        expect(toSafeErrorPayload(new ValidationError('bad id'))).toEqual({
            message: 'bad id',
            code: 'VALIDATION_ERROR',
            statusCode: 400
        });
        expect(toSafeErrorPayload(new ForbiddenError('not yours'))).toEqual({
            message: 'not yours',
            code: 'FORBIDDEN',
            statusCode: 403
        });
        expect(toSafeErrorPayload(new NotFoundError())).toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });

    it('never answers with 401 for an upstream Qobuz auth failure (it would lock the dashboard)', () => {
        expect(toSafeErrorPayload(new AuthenticationError('User authentication is required'))).toEqual({
            message: 'User authentication is required',
            code: 'AUTH_ERROR',
            statusCode: 502
        });
    });

    it('maps upstream rate limits to 503 and upstream 5xx / no response to 502', () => {
        expect(toSafeErrorPayload(new RateLimitError())).toMatchObject({ code: 'RATE_LIMITED', statusCode: 503 });
        expect(toSafeErrorPayload(new APIError('Bad gateway', 500))).toMatchObject({ statusCode: 502 });
        expect(toSafeErrorPayload(new APIError('timeout of 30000ms exceeded'))).toMatchObject({
            code: 'API_ERROR',
            statusCode: 502
        });
        expect(toSafeErrorPayload(new APIError('Invalid argument', 400))).toMatchObject({ statusCode: 400 });
    });

    it('honours statusCode on app-level QobuzError subclasses', () => {
        class ConflictError extends QobuzError {
            readonly statusCode = 409;
            constructor() {
                super('Already queued', 'CONFLICT');
            }
        }
        expect(toSafeErrorPayload(new ConflictError())).toEqual({
            message: 'Already queued',
            code: 'CONFLICT',
            statusCode: 409
        });
        expect(toSafeErrorPayload(new QobuzError('plain'))).toEqual({
            message: 'plain',
            code: 'UNKNOWN_ERROR',
            statusCode: 500
        });
    });

    it('hides everything about non-Qobuz errors, including axios internals', () => {
        const axiosLike = Object.assign(new Error('Request failed user_auth_token=SECRET'), {
            config: { params: { user_auth_token: 'SECRET', app_id: 'APP' }, headers: { 'X-User-Auth-Token': 'SECRET' } },
            response: { status: 500, data: { message: 'x' } }
        });
        const payload = toSafeErrorPayload(axiosLike);

        expect(payload).toEqual({ message: 'An unexpected error occurred.', code: 'INTERNAL_ERROR', statusCode: 500 });
        expect(JSON.stringify(payload)).not.toContain('SECRET');
        expect(toSafeErrorPayload('string')).toMatchObject({ code: 'INTERNAL_ERROR' });
        expect(toSafeErrorPayload(undefined)).toMatchObject({ statusCode: 500 });
    });

    it('sanitizes credentials that slipped into a QobuzError message', () => {
        const payload = toSafeErrorPayload(new APIError('failed ?user_auth_token=SECRET', 400));
        expect(payload.message).not.toContain('SECRET');
    });

    it('maps raw zod errors to validation payloads', () => {
        const result = z.object({ limit: z.number() }).safeParse({ limit: 'x' });
        if (result.success) throw new Error('expected failure');
        expect(toSafeErrorPayload(result.error)).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    });
});

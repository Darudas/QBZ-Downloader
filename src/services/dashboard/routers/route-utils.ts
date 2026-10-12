import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { getErrorMessage, toSafeErrorPayload, ValidationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

/**
 * Small helpers shared by the download, catalog and batch routers: zod
 * parsing that throws a 400 ValidationError, and a router-level error handler
 * that always answers JSON (`{ error, code }`), never Express's HTML page.
 */

/** Parse `value` with `schema`; throws a ValidationError (HTTP 400) listing the issues. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, what = 'request'): z.infer<S> {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw ValidationError.fromZod(result.error, `Invalid ${what}`);
    }
    return result.data;
}

export const parseBody = <S extends z.ZodType>(schema: S, body: unknown): z.infer<S> =>
    parseInput(schema, body ?? {}, 'request body');

export const parseQuery = <S extends z.ZodType>(schema: S, query: unknown): z.infer<S> =>
    parseInput(schema, query ?? {}, 'query parameters');

export const parseParams = <S extends z.ZodType>(schema: S, params: unknown): z.infer<S> =>
    parseInput(schema, params ?? {}, 'path parameters');

/**
 * Router-level error middleware. Express 5 forwards rejected promises from
 * async handlers here. QobuzError subclasses (validation, queue and Qobuz API
 * errors) keep their message and status; anything else becomes a generic 500
 * and is logged server-side only.
 */
export function routeErrorHandler(scope: string) {
    return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
        if (res.headersSent) {
            next(error);
            return;
        }
        const payload = toSafeErrorPayload(error);
        if (payload.statusCode >= 500) {
            logger.error(`${scope} route error: ${getErrorMessage(error)}`, 'API');
        }
        res.status(payload.statusCode).json({ error: payload.message, code: payload.code });
    };
}

import express, { Router, Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer } from './server.js';
import {
    generateMcpToken,
    getMcpPermissions,
    getMcpTokenStatus,
    isMcpEnabled,
    MCP_PERMISSION_GROUPS,
    revokeMcpToken,
    setMcpConfig,
    verifyMcpToken
} from './token.js';
import { logger } from '../utils/logger.js';

const rpcError = (res: Response, status: number, code: number, message: string): void => {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};

/**
 * The public MCP endpoint. Mounted before the global body parser and outside
 * the dashboard password middleware: the bearer token is the only credential
 * and it is required in every mode (desktop, no dashboard password, LAN).
 */
export function createMcpEndpoint(): Router {
    const router = Router();
    const handler = createMcpHandler(() => buildMcpServer(getMcpPermissions()), {
        onerror: (error: Error) => logger.warn(`MCP transport error: ${error.message}`, 'MCP')
    });
    const nodeHandler = toNodeHandler(handler);

    router.use(
        rateLimit({
            windowMs: 5 * 60 * 1000,
            max: 600,
            standardHeaders: true,
            legacyHeaders: false,
            handler: (_req, res) => rpcError(res, 429, -32000, 'Too many requests')
        })
    );

    router.use((_req: Request, res: Response, next: NextFunction) => {
        if (!isMcpEnabled()) return rpcError(res, 404, -32000, 'MCP is disabled');
        next();
    });

    // A browser page must never reach the endpoint, even with GET (the global
    // CSRF guard only checks state-changing methods).
    router.use((req: Request, res: Response, next: NextFunction) => {
        const origin = req.headers.origin;
        if (!origin) return next();
        try {
            if (new URL(origin).host === req.headers.host) return next();
        } catch {
            /* fall through */
        }
        rpcError(res, 403, -32000, 'Forbidden origin');
    });

    const authFailures = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        skipSuccessfulRequests: true,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => rpcError(res, 429, -32000, 'Too many failed authentication attempts')
    });

    router.use(authFailures, (req: Request, res: Response, next: NextFunction) => {
        const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        if (!match || !verifyMcpToken(match[1])) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="qbz-mcp"');
            return rpcError(res, 401, -32001, 'Unauthorized');
        }
        next();
    });

    router.use(express.json({ limit: '1mb' }));
    router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (!err) return next();
        rpcError(res, 400, -32700, 'Parse error');
    });

    router.all('/', (req: Request, res: Response) => {
        void nodeHandler(req, res, req.body).catch((error: unknown) => {
            logger.error(`MCP request failed: ${(error as Error).message}`, 'MCP');
            if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
        });
    });

    return router;
}

/** Dashboard management routes (/api/mcp/*), behind the dashboard password. */
export function createMcpAdminRouter(): Router {
    const router = Router();

    const status = () => ({
        enabled: isMcpEnabled(),
        permissions: getMcpPermissions(),
        available_permissions: ['read', ...MCP_PERMISSION_GROUPS],
        token: getMcpTokenStatus(),
        endpoint_path: '/mcp'
    });

    router.get('/status', (_req, res) => {
        res.json(status());
    });

    router.post('/config', (req: Request, res: Response) => {
        const enabled = req.body?.enabled;
        const permissions = req.body?.permissions;
        if (enabled !== undefined && typeof enabled !== 'boolean') {
            res.status(400).json({ error: 'enabled must be a boolean' });
            return;
        }
        if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((p) => typeof p !== 'string'))) {
            res.status(400).json({ error: 'permissions must be an array of strings' });
            return;
        }
        setMcpConfig({ enabled, permissions });
        res.json(status());
    });

    // The plaintext token is returned only here, once.
    router.post('/token', (_req, res) => {
        const { token, createdAt } = generateMcpToken();
        logger.info('MCP token generated', 'MCP');
        res.json({ token, created_at: createdAt });
    });

    router.delete('/token', (_req, res) => {
        revokeMcpToken();
        logger.info('MCP token revoked', 'MCP');
        res.json({ success: true });
    });

    return router;
}

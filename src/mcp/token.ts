import crypto from 'crypto';
import { settingsService } from '../services/settings.js';

/**
 * MCP access control state. The bearer token is shown to the user once and
 * only its SHA-256 is stored (MCP_TOKEN_HASH, an encrypted setting that is
 * never mirrored into process.env). Headless installs can instead pass
 * QBZ_MCP_TOKEN (32+ chars) in the environment; it is never stored.
 */

export const MCP_PERMISSION_GROUPS = ['library', 'download', 'manage', 'destructive'] as const;
export type McpPermissionGroup = (typeof MCP_PERMISSION_GROUPS)[number] | 'read';
export const DEFAULT_MCP_PERMISSIONS: McpPermissionGroup[] = ['library', 'download', 'manage'];

const MIN_ENV_TOKEN_LENGTH = 32;

const sha256 = (value: string): Buffer => crypto.createHash('sha256').update(value).digest();

export function isMcpEnabled(): boolean {
    return settingsService.get('MCP_ENABLED') === 'true';
}

export function getMcpPermissions(): McpPermissionGroup[] {
    const raw = settingsService.get('MCP_PERMISSIONS');
    if (raw === undefined) return ['read', ...DEFAULT_MCP_PERMISSIONS];
    const groups = raw
        .split(',')
        .map((g) => g.trim())
        .filter((g): g is (typeof MCP_PERMISSION_GROUPS)[number] =>
            (MCP_PERMISSION_GROUPS as readonly string[]).includes(g)
        );
    return ['read', ...Array.from(new Set(groups))];
}

export function setMcpConfig(config: { enabled?: boolean; permissions?: string[] }): void {
    const values: Record<string, string> = {};
    if (config.enabled !== undefined) values.MCP_ENABLED = String(config.enabled);
    if (config.permissions !== undefined) {
        const valid = config.permissions.filter((g) =>
            (MCP_PERMISSION_GROUPS as readonly string[]).includes(g)
        );
        values.MCP_PERMISSIONS = Array.from(new Set(valid)).join(',');
    }
    if (Object.keys(values).length > 0) settingsService.setMany(values);
}

function envToken(): string | undefined {
    const value = process.env.QBZ_MCP_TOKEN;
    return value && value.length >= MIN_ENV_TOKEN_LENGTH ? value : undefined;
}

export function getMcpTokenStatus(): { configured: boolean; createdAt: string | null; fromEnv: boolean } {
    const hash = settingsService.get('MCP_TOKEN_HASH');
    return {
        configured: Boolean(hash) || Boolean(envToken()),
        createdAt: settingsService.get('MCP_TOKEN_CREATED_AT') || null,
        fromEnv: Boolean(envToken())
    };
}

/** Creates (or rotates) the token. The plaintext is returned exactly once. */
export function generateMcpToken(): { token: string; createdAt: string } {
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    settingsService.setMany({
        MCP_TOKEN_HASH: sha256(token).toString('hex'),
        MCP_TOKEN_CREATED_AT: createdAt
    });
    return { token, createdAt };
}

export function revokeMcpToken(): void {
    settingsService.setMany({ MCP_TOKEN_HASH: '', MCP_TOKEN_CREATED_AT: '' });
}

/** Constant-time check of a presented bearer token. */
export function verifyMcpToken(presented: string | undefined): boolean {
    if (!presented) return false;
    const presentedHash = sha256(presented);

    const storedHex = settingsService.get('MCP_TOKEN_HASH');
    if (storedHex && /^[0-9a-f]{64}$/.test(storedHex)) {
        if (crypto.timingSafeEqual(presentedHash, Buffer.from(storedHex, 'hex'))) return true;
    }

    const fromEnv = envToken();
    if (fromEnv && crypto.timingSafeEqual(presentedHash, sha256(fromEnv))) return true;

    return false;
}

/**
 * Allowed values of list/range settings, shared by CONFIG (src/config.ts) and
 * the settings validation (src/services/settings-schema.ts). Kept free of
 * imports so tests that mock config.js partially still get the real values.
 */

export const MCP_CONFIG_PERMISSIONS = ['library', 'download', 'manage', 'destructive'] as const;
export type McpConfigPermission = (typeof MCP_CONFIG_PERMISSIONS)[number];

export const FAVORITES_AUTO_DOWNLOAD_TYPES = ['albums', 'tracks'] as const;
export type FavoritesAutoDownloadType = (typeof FAVORITES_AUTO_DOWNLOAD_TYPES)[number];

export const FAVORITES_SYNC_INTERVAL_RANGE = { min: 1, max: 168 } as const;

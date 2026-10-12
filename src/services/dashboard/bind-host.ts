import { CONFIG } from '../../config.js';

/**
 * The address the dashboard server is actually listening on. It can differ
 * from DASHBOARD_HOST: start() falls back to loopback when a network bind is
 * requested without a password. Kept outside DashboardService so routers can
 * ask without importing the server (which imports the routers).
 */
let boundHost: string | null = null;

export function setDashboardBoundHost(host: string | null): void {
    boundHost = host;
}

/** The listening address, or the configured one before the server has started. */
export function getDashboardBindHost(): string {
    return boundHost ?? (CONFIG.dashboard.host || '127.0.0.1');
}

/** Loopback addresses are reachable from this machine only. */
export function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
    return (
        normalized === 'localhost' ||
        normalized === '::1' ||
        normalized === '127.0.0.1' ||
        normalized.startsWith('127.')
    );
}

/**
 * True when the dashboard is reachable from the network, i.e. the dashboard
 * password is the only thing protecting it. Desktop mode always binds loopback
 * and authenticates through the Electron shell.
 */
export function isDashboardNetworkExposed(): boolean {
    if (process.env.QBZ_DESKTOP === '1') return false;
    return !isLoopbackHost(getDashboardBindHost());
}

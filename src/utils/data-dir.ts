import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Where the app keeps its state: the SQLite database, the encryption key for
 * the credentials stored in it, and the resume/legacy history files.
 *
 * This used to be `<cwd>/data`, separately for the database and the key.
 * Starting the app from another directory then opened (or created) a
 * different database, or found the database but generated a fresh key, and
 * every stored credential "decrypted" to its ciphertext. The location is now
 * resolved once, in this order:
 *
 * 1. `QBZ_DATA_DIR`, when set (relative values resolve against the cwd).
 * 2. Desktop mode (`QBZ_DESKTOP=1`): `<cwd>/data`. The Electron shell chdirs
 *    into its runtime folder (userData, portable folder or the checkout)
 *    before it loads the backend, so this is already stable there.
 * 3. `<app root>/data`, where the app root is the folder holding `src/` or
 *    `dist/` (the checkout, `/app` in Docker). Same as before for anyone who
 *    starts the app from its own folder, which is what the docs describe.
 * 4. Backward compatibility: when (3) holds no database or key yet but
 *    `<cwd>/data` does, that folder keeps being used and a warning explains
 *    how to make it permanent. Nothing is moved or copied, so no existing
 *    install loses its data; the database and its key always come from the
 *    same folder.
 */

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATE_FILES = ['qbz.db', '.secret.key'];

export type DataDirSource = 'env' | 'desktop' | 'app' | 'legacy-cwd';

export interface DataDirResolution {
    dir: string;
    source: DataDirSource;
    /** Human-readable notes about ignored or legacy locations. */
    warnings: string[];
}

const hasState = (dir: string, exists: (p: string) => boolean): boolean =>
    STATE_FILES.some((name) => exists(path.join(dir, name)));

const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function resolveDataDir(
    options: {
        env?: NodeJS.ProcessEnv;
        cwd?: string;
        appRoot?: string;
        exists?: (p: string) => boolean;
    } = {}
): DataDirResolution {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const appRoot = options.appRoot ?? APP_ROOT;
    const exists = options.exists ?? fs.existsSync;

    const explicit = env.QBZ_DATA_DIR?.trim();
    if (explicit) return { dir: path.resolve(cwd, explicit), source: 'env', warnings: [] };

    const cwdData = path.resolve(cwd, 'data');
    if (env.QBZ_DESKTOP === '1') return { dir: cwdData, source: 'desktop', warnings: [] };

    const appData = path.resolve(appRoot, 'data');
    if (samePath(appData, cwdData)) return { dir: appData, source: 'app', warnings: [] };

    if (hasState(appData, exists)) {
        const warnings = hasState(cwdData, exists)
            ? [
                  `Ignoring app data in ${cwdData} (current directory); using ${appData}. ` +
                      'Set QBZ_DATA_DIR to choose the folder explicitly.'
              ]
            : [];
        return { dir: appData, source: 'app', warnings };
    }

    if (hasState(cwdData, exists)) {
        return {
            dir: cwdData,
            source: 'legacy-cwd',
            warnings: [
                `Using app data from ${cwdData} because the app folder ${appData} has none. ` +
                    `Set QBZ_DATA_DIR=${cwdData} (or move the folder to ${appData}) so it is found from any directory.`
            ]
        };
    }

    return { dir: appData, source: 'app', warnings: [] };
}

let cached: DataDirResolution | null = null;

/** The data directory for this process, resolved on first use. */
export function getDataDir(): string {
    if (!cached) {
        cached = resolveDataDir();
        // console, not the logger: this runs while the logger and settings
        // are still being set up and must not import them.
        for (const warning of cached.warnings) console.warn(`[DATA] ${warning}`);
    }
    return cached.dir;
}

/** Tests only: forget the cached resolution. */
export function resetDataDirForTests(): void {
    cached = null;
}

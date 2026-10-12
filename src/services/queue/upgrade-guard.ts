import fs from 'fs';
import path from 'path';
import { isPathWithinManagedRoots } from '../../utils/paths.js';
import { databaseService } from '../database/index.js';

/**
 * Checks for the file a library upgrade replaces. An upgrade deletes its old
 * file once the better copy is on disk, so the path must never come from a
 * request: it has to be a file the library scanner indexed, inside a folder
 * the app manages. The queue checks this when an upgrade is enqueued or loaded
 * from the database, and the processor checks it again right before deleting.
 */

export type UpgradeSourceCheck = { ok: true } | { ok: false; reason: string };

export interface UpgradeSourceCheckOptions {
    /** Also require the path to be an existing regular file (needed before deleting it). */
    requireExists?: boolean;
}

export function checkUpgradeSource(
    filePath: unknown,
    options: UpgradeSourceCheckOptions = {}
): UpgradeSourceCheck {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        return { ok: false, reason: 'no old file path' };
    }
    if (filePath.includes('\0')) {
        return { ok: false, reason: 'invalid old file path' };
    }
    if (!isPathWithinManagedRoots(filePath)) {
        return { ok: false, reason: 'old file is outside the managed library folders' };
    }

    let indexed: unknown;
    try {
        indexed = databaseService.getLibraryFileByPath(filePath);
    } catch {
        return { ok: false, reason: 'library index is unavailable' };
    }
    if (!indexed) {
        return { ok: false, reason: 'old file is not a scanned library file' };
    }

    if (options.requireExists) {
        try {
            if (!fs.statSync(filePath).isFile()) {
                return { ok: false, reason: 'old file is not a regular file' };
            }
        } catch {
            return { ok: false, reason: 'old file no longer exists' };
        }
    }

    return { ok: true };
}

const normalizeForCompare = (filePath: string): string => {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * True when both paths name the same file: equal after resolution, equal real
 * paths, or the same inode. Deleting the "old" file when it is the new one
 * would destroy the upgrade that just finished.
 */
export function isSameFile(left: string, right: string): boolean {
    if (normalizeForCompare(left) === normalizeForCompare(right)) return true;

    try {
        if (normalizeForCompare(fs.realpathSync(left)) === normalizeForCompare(fs.realpathSync(right))) {
            return true;
        }
    } catch {
        // One of the files does not exist; fall through to the inode check.
    }

    try {
        const a = fs.statSync(left);
        const b = fs.statSync(right);
        return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
    } catch {
        return false;
    }
}

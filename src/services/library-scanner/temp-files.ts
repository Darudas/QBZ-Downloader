import path from 'path';

/**
 * Names of the in-flight files the downloader leaves next to a track
 * (see DownloadService in src/services/download.ts):
 *
 * - `<name>.qbz-part<.ext>`               staging file of a running or interrupted download
 * - `<name>.qbz-replace-<ms>[-<n>]<.ext>` replacement written before an upgrade swaps it in
 * - `<name>.qbz-backup-<ms><.ext>`        original moved aside during that swap
 *
 * They keep the audio extension, so without this check the scanner indexes
 * them, reports them as duplicates of the real track and a duplicate
 * resolution may delete the wrong file. The tagger's own temp files end in
 * `.tmp`/`.bak`/`.txt`/`.jpg` and never match an audio extension.
 */
const TEMP_DOWNLOAD_FILE = /\.qbz-(?:part|replace-\d+(?:-\d+)?|backup-\d+)(?:\.[^.]+)?$/i;

export function isTemporaryDownloadFile(filePath: string): boolean {
    return TEMP_DOWNLOAD_FILE.test(path.basename(filePath));
}

/** True when `filePath` is `directory` itself or lies below it (after resolving both). */
export function isPathInsideDirectory(filePath: string, directory: string): boolean {
    const target = path.resolve(filePath);
    const root = path.resolve(directory);
    if (target === root) return true;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return process.platform === 'win32'
        ? target.toLowerCase().startsWith(prefix.toLowerCase())
        : target.startsWith(prefix);
}

import path from 'path';

/**
 * True for the root of the system volume: `/` on POSIX, the system drive
 * (`%SystemDrive%`, usually `C:\`) on Windows. Using it as the download or
 * library folder would make every file of the operating system a "managed"
 * file that the library routes may delete or overwrite.
 *
 * Other volume roots are allowed on purpose: a dedicated music drive (`D:\`)
 * or a NAS share (`\\nas\music`) is a normal place for a library.
 *
 * No other imports, so settings validation can use it without cycles.
 */
export function isSystemRoot(
    dir: string,
    platform: NodeJS.Platform = process.platform,
    systemDrive: string = process.env.SystemDrive || 'C:'
): boolean {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const resolved = p.resolve(dir);
    if (p.parse(resolved).root !== resolved) return false;
    if (platform !== 'win32') return true;
    if (resolved.startsWith('\\\\')) return false; // UNC share root
    return resolved.slice(0, 2).toUpperCase() === systemDrive.slice(0, 2).toUpperCase();
}

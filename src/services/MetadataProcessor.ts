import path from 'path';
import { Metadata } from './metadata.js';
import { CONFIG } from '../config.js';
import { logger } from '../utils/logger.js';

export function sanitizeFilename(name: string, maxLength: number = 128): string {
    if (!name) return 'Unknown';
    const sanitized = name
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/&/g, 'and')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+|\.+$/g, '');

    // Truncate while ensuring we don't end up with an empty string
    return sanitized.substring(0, maxLength).trim() || 'Unknown';
}

export function applyTemplate(template: string, metadata: Metadata, quality: number): string {
    const qualityName = CONFIG.quality.formats[quality]?.name || 'FLAC';
    let result = template;

    logger.debug(
        `Processing template: "${template}" for ${metadata.artist} - ${metadata.title}`,
        'META'
    );

    const discNumber = Number(metadata.discNumber) || 1;
    const totalDiscs = Number(metadata.totalDiscs) || 1;

    const data: Record<string, string> = {
        artist: metadata.artist || 'Unknown Artist',
        albumArtist: metadata.albumArtist || metadata.artist || 'Unknown Artist',
        album: metadata.album || 'Unknown Album',
        title: metadata.title || 'Unknown Title',
        year: metadata.year?.toString() || 'Unknown',
        quality: qualityName,
        format: qualityName,
        track_number: metadata.trackNumber?.toString().padStart(2, '0') || '01',
        tracknumber: metadata.trackNumber?.toString().padStart(2, '0') || '01',
        track: metadata.trackNumber?.toString().padStart(2, '0') || '01',
        disc: discNumber.toString(),
        disc_number: discNumber.toString(),
        discnumber: discNumber.toString(),
        total_discs: totalDiscs.toString(),
        totaldiscs: totalDiscs.toString(),
        // Resolves to an empty string on single-disc releases so one folder
        // template works for both: "{albumArtist}/{album}/{disc_folder}"
        // yields "Artist/Album" for a single disc and "Artist/Album/CD2" for
        // a multi-disc set, without stranding an empty path segment.
        disc_folder: totalDiscs > 1 ? `CD${discNumber}` : ''
    };

    for (const [key, value] of Object.entries(data)) {
        // Deliberately-empty values must stay empty; sanitizeFilename maps
        // falsy input to "Unknown", which would create an "Unknown" folder.
        const sanitizedValue = value === '' ? '' : sanitizeFilename(String(value));
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\{${escapedKey}\\}`, 'gi');

        const newResult = result.replace(regex, sanitizedValue);
        if (newResult !== result) {
            logger.debug(`Replaced {${key}} with "${sanitizedValue}"`, 'META');
            result = newResult;
        }
    }

    return result;
}

/** Characters that never belong in a path segment (ASCII control characters). */
const stripControlChars = (value: string): string =>
    Array.from(value)
        .filter((char) => {
            const code = char.charCodeAt(0);
            return code >= 0x20 && code !== 0x7f;
        })
        .join('');

/** "." and ".." (and Windows' "..." which it trims to "..") would walk the tree. */
const isDotSegment = (segment: string): boolean => /^\.+$/.test(segment.trim());

/**
 * Turn a rendered folder template into path segments that stay below the
 * download root, whatever the template or the Qobuz metadata contains:
 * leading separators (absolute paths), drive letters and "."/".." segments are
 * dropped (a drive-relative "C:x" is left to assertWithinBase, which refuses
 * it on Windows). Metadata values are already stripped of separators by
 * sanitizeFilename; this also covers the template's literal text.
 */
export function toContainedSegments(rendered: string): string[] {
    return stripControlChars(rendered)
        .split(/[/\\]/)
        .filter((segment, index) => !(index === 0 && /^[A-Za-z]:$/.test(segment)))
        .filter((segment) => segment.trim() !== '' && !isDotSegment(segment));
}

export function buildFolderPath(metadata: Metadata, quality: number): string {
    const rendered = applyTemplate(CONFIG.download.folderStructure, metadata, quality);
    // A placeholder may render empty on purpose ({disc_folder} on a single-disc
    // release), which would otherwise leave an empty segment and a stray
    // separator in the path.
    return toContainedSegments(rendered).join(path.sep);
}

export function buildFilename(metadata: Metadata, quality: number): string {
    const format = CONFIG.quality.formats[quality] || CONFIG.quality.formats[27]!;
    const ext = format.extension || 'flac';
    // The file name is one segment: separators from the template would point
    // into folders that were never created (or outside the album folder).
    const rendered = stripControlChars(
        applyTemplate(CONFIG.download.fileNaming, metadata, quality)
    ).replace(/[/\\]/g, '-');
    const filename = rendered.trim() === '' || isDotSegment(rendered) ? 'Unknown' : rendered;
    return filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
}

/**
 * Throws unless `basePath/folderPath/filename` resolves inside `basePath`.
 * Last line of defence after the template sanitising above.
 */
export function assertWithinBase(basePath: string, ...segments: string[]): void {
    const base = path.resolve(basePath);
    const target = path.resolve(base, ...segments);
    const relative = path.relative(base, target);
    const escapes =
        relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (!escapes) return;
    throw new Error('Refusing to write outside the download folder');
}

/**
 * Ensures that the total path (base + folder + file) does not exceed Windows path limits (260 chars).
 * If it does, it intelligently truncates components while preserving extensions and essential info.
 */
export function ensurePathSafety(
    basePath: string,
    folderPath: string,
    filename: string
): { folder: string; file: string } {
    const MAX_TOTAL_PATH = 255;
    const currentTotal = path.join(basePath, folderPath, filename).length;

    if (currentTotal <= MAX_TOTAL_PATH) {
        assertWithinBase(basePath, folderPath, filename);
        return { folder: folderPath, file: filename };
    }

    let overLimit = currentTotal - MAX_TOTAL_PATH;
    let newFilename = filename;

    // 1. Try truncating the filename first (but keep extension)
    const ext = path.extname(filename);
    const nameOnly = path.basename(filename, ext);

    if (nameOnly.length > 20) {
        const toCut = Math.min(overLimit, nameOnly.length - 10);
        newFilename = nameOnly.substring(0, nameOnly.length - toCut).trim() + ext;
        overLimit -= toCut;
    }

    let newFolder = folderPath;
    // 2. If still over, truncate folder components (prioritizing the deepest folder, usually album)
    if (overLimit > 0) {
        const parts = folderPath.split(/[/\\]/);
        for (let i = parts.length - 1; i >= 0 && overLimit > 0; i--) {
            const part = parts[i]!;
            if (part.length > 10) {
                const toCut = Math.min(overLimit, part.length - 5);
                parts[i] = part.substring(0, part.length - toCut).trim();
                overLimit -= toCut;
            }
        }
        // Truncation could leave a segment of dots only ("..").
        newFolder = parts.filter((part) => part.trim() !== '' && !isDotSegment(part)).join(path.sep);
    }

    logger.warn(`Path too long (${currentTotal} chars). Truncated to fit limit.`, 'PROCESSOR');
    assertWithinBase(basePath, newFolder, newFilename);
    return { folder: newFolder, file: newFilename };
}